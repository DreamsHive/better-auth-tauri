import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { genericOAuth } from "better-auth/plugins";
import { describe, expect, it, vi } from "vitest";
import { tauri } from "../src/index";

/*
 * Drives `/tauri-authorization-proxy` through a real `betterAuth` instance
 * (memory adapter, `tauri()`, a social and a generic OAuth provider). The
 * generic provider exchanges codes and reads profiles through in-process
 * functions, so complete sign-ins run without any network access.
 */

const ORIGIN = "https://auth.example.test";
const API = `${ORIGIN}/api/auth`;
const APP_ORIGIN = "myapp://";
const APP_CALLBACK = "myapp://auth/callback";
const GITHUB_AUTHORIZE = "https://github.com/login/oauth/authorize";
const ACME_AUTHORIZE = "https://id.acme.test/oauth/authorize";

type Row = Record<string, unknown>;

interface AuthSetup {
  cookiePrefix?: string;
  storeStateStrategy?: "database" | "cookie";
  /** Adds Google set up for ID token sign-in only (no client secret). */
  idTokenOnlyGoogle?: boolean;
}

function createAuth({
  cookiePrefix,
  storeStateStrategy,
  idTokenOnlyGoogle,
}: AuthSetup = {}) {
  const db: Record<"user" | "session" | "account" | "verification", Row[]> = {
    user: [],
    session: [],
    account: [],
    verification: [],
  };
  const auth = betterAuth({
    baseURL: ORIGIN,
    secret: "test-secret-0123456789abcdefghijklmnop",
    database: memoryAdapter(db),
    trustedOrigins: [APP_ORIGIN],
    account: { storeStateStrategy: storeStateStrategy ?? "database" },
    advanced: { cookiePrefix },
    socialProviders: {
      github: { clientId: "github-client", clientSecret: "github-secret" },
      ...(idTokenOnlyGoogle ? { google: { clientId: "google-client" } } : {}),
    },
    plugins: [
      tauri(),
      genericOAuth({
        config: [
          {
            providerId: "acme",
            clientId: "acme-client",
            clientSecret: "acme-secret",
            authorizationUrl: ACME_AUTHORIZE,
            tokenUrl: "https://id.acme.test/oauth/token",
            getToken: async () => ({
              accessToken: "acme-access-token",
              tokenType: "Bearer",
            }),
            getUserInfo: async () => ({
              id: "acme-user-1",
              email: "dev@example.test",
              emailVerified: true,
              name: "Dev",
            }),
          },
        ],
      }),
    ],
  });
  return { auth, db };
}

type Auth = ReturnType<typeof createAuth>["auth"];

/** `name=value` pairs from a response's Set-Cookie headers. */
function cookiePairs(response: Response): Map<string, string> {
  const pairs = new Map<string, string>();
  for (const header of response.headers.getSetCookie()) {
    const [pair = ""] = header.split(";");
    const separator = pair.indexOf("=");
    pairs.set(pair.slice(0, separator), pair.slice(separator + 1));
  }
  return pairs;
}

const cookieHeader = (pairs: Map<string, string>) =>
  [...pairs].map(([name, value]) => `${name}=${value}`).join("; ");

/**
 * Starts an OAuth flow the way `tauriClient` does: from the app's webview,
 * with `tauri-origin` and the redirect disabled. Returns the provider URL and
 * the cookies the webview received (never shared with the system browser).
 */
async function startFromApp(
  auth: Auth,
  path: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
) {
  const response = await auth.handler(
    new Request(`${API}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "tauri-origin": APP_ORIGIN,
        ...headers,
      },
      body: JSON.stringify({
        callbackURL: APP_CALLBACK,
        disableRedirect: true,
        ...body,
      }),
    }),
  );
  expect(response.status).toBe(200);
  const { url } = (await response.json()) as { url: string };
  return { authorizationURL: new URL(url), appCookies: cookiePairs(response) };
}

const startSocial = (auth: Auth) =>
  startFromApp(auth, "/sign-in/social", { provider: "github" });

/**
 * Generic OAuth providers are merged into the social provider list, so they
 * start at `/sign-in/social` and return to `/callback/:id`.
 */
const startGeneric = (auth: Auth) =>
  startFromApp(auth, "/sign-in/social", { provider: "acme" });

/** The system browser opening the proxy URL `tauriClient` builds. */
const proxy = (auth: Auth, query: Record<string, string>) =>
  auth.handler(
    new Request(
      `${API}/tauri-authorization-proxy?${new URLSearchParams(query)}`,
    ),
  );

/** The provider sending the system browser back to the generic callback. */
const acmeCallback = (auth: Auth, state: string, browserCookies: string) =>
  auth.handler(
    new Request(
      `${API}/callback/acme?${new URLSearchParams({ code: "code", state })}`,
      { headers: { cookie: browserCookies } },
    ),
  );

/** Follows the deep link back into the app and asks for the session. */
async function sessionFromDeepLink(auth: Auth, callback: Response) {
  expect(callback.status).toBe(302);
  const deepLink = new URL(callback.headers.get("location") ?? "");
  expect(`${deepLink.protocol}//${deepLink.host}${deepLink.pathname}`).toBe(
    APP_CALLBACK,
  );
  const bridged = deepLink.searchParams.get("cookie") ?? "";
  const sessionCookie = bridged.match(/(?:^|, )([^=;, ]+session_token=[^;]+)/)?.[1];
  expect(sessionCookie).toBeDefined();
  const response = await auth.handler(
    new Request(`${API}/get-session`, {
      headers: { "x-tauri-cookie": sessionCookie ?? "" },
    }),
  );
  return {
    sessionCookie: sessionCookie ?? "",
    session: (await response.json()) as { user: { email: string } } | null,
  };
}

/** A refusal must neither plant a cookie nor send the browser anywhere. */
function expectRefused(response: Response) {
  expect(response.status).toBe(400);
  expect(response.headers.get("location")).toBeNull();
  expect(response.headers.getSetCookie()).toEqual([]);
}

const ISSUED_SHAPE_BUT_NEVER_ISSUED = "a".repeat(32);

describe("tauriAuthorizationProxy: signing mode (database state)", () => {
  it("signs a state this server issued and completes a generic OAuth sign-in into the app", async () => {
    const { auth } = createAuth();
    const { authorizationURL } = await startGeneric(auth);
    const state = authorizationURL.searchParams.get("state") ?? "";

    const proxied = await proxy(auth, {
      authorizationURL: authorizationURL.href,
    });

    expect(proxied.status).toBe(302);
    expect(proxied.headers.get("location")).toBe(authorizationURL.href);
    const browser = cookiePairs(proxied);
    expect(browser.get("__Secure-better-auth.state")).toMatch(
      new RegExp(`^${state}\\.`),
    );
    const callback = await acmeCallback(auth, state, cookieHeader(browser));
    const { session } = await sessionFromDeepLink(auth, callback);
    expect(session?.user.email).toBe("dev@example.test");
  });

  it("signs a state issued for a social provider", async () => {
    const { auth } = createAuth();
    const { authorizationURL } = await startSocial(auth);
    expect(authorizationURL.origin).toBe(new URL(GITHUB_AUTHORIZE).origin);

    const proxied = await proxy(auth, {
      authorizationURL: authorizationURL.href,
    });

    expect(proxied.status).toBe(302);
    expect(proxied.headers.get("location")).toBe(authorizationURL.href);
    expect(cookiePairs(proxied).has("__Secure-better-auth.state")).toBe(true);
  });

  it("signs a state issued by an account-link request made with the app's session", async () => {
    const { auth } = createAuth();
    const first = await startGeneric(auth);
    const firstState = first.authorizationURL.searchParams.get("state") ?? "";
    const signedIn = await acmeCallback(
      auth,
      firstState,
      cookieHeader(
        cookiePairs(
          await proxy(auth, { authorizationURL: first.authorizationURL.href }),
        ),
      ),
    );
    const { sessionCookie } = await sessionFromDeepLink(auth, signedIn);

    const { authorizationURL } = await startFromApp(
      auth,
      "/link-social",
      { provider: "github" },
      { "x-tauri-cookie": sessionCookie },
    );
    const proxied = await proxy(auth, {
      authorizationURL: authorizationURL.href,
    });

    expect(proxied.status).toBe(302);
    expect(proxied.headers.get("location")).toBe(authorizationURL.href);
    expect(cookiePairs(proxied).has("__Secure-better-auth.state")).toBe(true);
  });

  it("uses the configured cookie prefix for the signed state cookie", async () => {
    const { auth } = createAuth({ cookiePrefix: "myapp" });
    const { authorizationURL } = await startGeneric(auth);
    const state = authorizationURL.searchParams.get("state") ?? "";

    const proxied = await proxy(auth, {
      authorizationURL: authorizationURL.href,
    });
    const browser = cookiePairs(proxied);

    expect([...browser.keys()]).toEqual(["__Secure-myapp.state"]);
    const callback = await acmeCallback(auth, state, cookieHeader(browser));
    const { sessionCookie, session } = await sessionFromDeepLink(auth, callback);
    expect(sessionCookie.startsWith("__Secure-myapp.session_token=")).toBe(true);
    expect(session?.user.email).toBe("dev@example.test");
  });

  it.each([
    ["a value shaped like an issued state", ISSUED_SHAPE_BUT_NEVER_ISSUED],
    ["an arbitrary token-like value", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0"],
  ])("refuses to sign %s this server never issued", async (_, state) => {
    const { auth } = createAuth();

    const response = await proxy(auth, {
      authorizationURL: `${GITHUB_AUTHORIZE}?client_id=github-client&state=${state}`,
    });

    expectRefused(response);
  });

  it("refuses an issued state that has expired", async () => {
    const { auth, db } = createAuth();
    const { authorizationURL } = await startGeneric(auth);
    for (const row of db.verification) {
      row.expiresAt = new Date(Date.now() - 1_000);
    }

    expectRefused(await proxy(auth, { authorizationURL: authorizationURL.href }));
  });

  it("refuses a state that a completed sign-in already consumed", async () => {
    const { auth } = createAuth();
    const { authorizationURL } = await startGeneric(auth);
    const state = authorizationURL.searchParams.get("state") ?? "";
    const browser = cookiePairs(
      await proxy(auth, { authorizationURL: authorizationURL.href }),
    );
    expect((await acmeCallback(auth, state, cookieHeader(browser))).status).toBe(
      302,
    );

    expectRefused(await proxy(auth, { authorizationURL: authorizationURL.href }));
  });

  it("refuses a provider URL without a state", async () => {
    const { auth } = createAuth();

    expectRefused(
      await proxy(auth, {
        authorizationURL: `${GITHUB_AUTHORIZE}?client_id=github-client`,
      }),
    );
  });
});

describe("tauriAuthorizationProxy: redirect target", () => {
  const rewrites: Array<[string, (url: URL) => string]> = [
    ["an unconfigured host", (url) => `https://evil.example.test${url.pathname}${url.search}`],
    ["a look-alike host", (url) => `https://id.acme.test.evil.example.test${url.pathname}${url.search}`],
    ["a provider host on another port", (url) => `https://id.acme.test:8443${url.pathname}${url.search}`],
    ["plain http", (url) => url.href.replace("https:", "http:")],
    ["this auth server", (url) => `${API}/sign-out${url.search}`],
    ["a URL with a fragment", (url) => `${url.href}#fragment`],
    ["a non-URL", () => "not a url"],
    ["a script URL", () => "javascript:alert(1)//?state=x"],
  ];

  it.each(rewrites)(
    "refuses %s even with an issued state",
    async (_, rewrite) => {
      const { auth } = createAuth();
      const { authorizationURL } = await startGeneric(auth);

      expectRefused(
        await proxy(auth, { authorizationURL: rewrite(authorizationURL) }),
      );
    },
  );

  it.each(rewrites)(
    "refuses %s in stored-state mode",
    async (_, rewrite) => {
      const { auth } = createAuth();
      const { authorizationURL } = await startGeneric(auth);

      expectRefused(
        await proxy(auth, {
          authorizationURL: rewrite(authorizationURL),
          oauthState: "stored-state",
        }),
      );
    },
  );
});

describe("tauriAuthorizationProxy: stored-state mode (cookie state)", () => {
  it("re-seeds the stored state unsigned and completes a sign-in into the app", async () => {
    const { auth } = createAuth({
      cookiePrefix: "myapp",
      storeStateStrategy: "cookie",
    });
    const { authorizationURL, appCookies } = await startGeneric(auth);
    const state = authorizationURL.searchParams.get("state") ?? "";
    const oauthState = appCookies.get("__Secure-myapp.oauth_state") ?? "";
    expect(oauthState).not.toBe("");

    const proxied = await proxy(auth, {
      authorizationURL: authorizationURL.href,
      oauthState,
    });

    expect(proxied.status).toBe(302);
    expect(proxied.headers.get("location")).toBe(authorizationURL.href);
    const browser = cookiePairs(proxied);
    expect([...browser]).toEqual([["__Secure-myapp.oauth_state", oauthState]]);
    const callback = await acmeCallback(auth, state, cookieHeader(browser));
    const { session } = await sessionFromDeepLink(auth, callback);
    expect(session?.user.email).toBe("dev@example.test");
  });

  it("plants the stored state for a configured social provider without signing anything", async () => {
    const { auth } = createAuth();

    const proxied = await proxy(auth, {
      authorizationURL: `${GITHUB_AUTHORIZE}?client_id=github-client&state=${ISSUED_SHAPE_BUT_NEVER_ISSUED}`,
      oauthState: "stored-state",
    });

    expect(proxied.status).toBe(302);
    expect([...cookiePairs(proxied)]).toEqual([
      ["__Secure-better-auth.oauth_state", "stored-state"],
    ]);
  });

  it("refuses a provider URL without a state", async () => {
    const { auth } = createAuth();

    expectRefused(
      await proxy(auth, {
        authorizationURL: `${GITHUB_AUTHORIZE}?client_id=github-client`,
        oauthState: "stored-state",
      }),
    );
  });
});

describe("tauriAuthorizationProxy: provider origins", () => {
  it("asks a provider that cannot build an authorization URL only once", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    try {
      const { auth } = createAuth({ idTokenOnlyGoogle: true });
      const { socialProviders } = await auth.$context;
      const google = socialProviders.find(({ id }) => id === "google");
      if (!google) throw new Error("google provider is not configured");
      const probe = vi.spyOn(google, "createAuthorizationURL");

      for (const _ of [1, 2]) {
        const { authorizationURL } = await startSocial(auth);
        const proxied = await proxy(auth, {
          authorizationURL: authorizationURL.href,
        });
        expect(proxied.status).toBe(302);
        expect(cookiePairs(proxied).has("__Secure-better-auth.state")).toBe(
          true,
        );
      }

      expect(probe).toHaveBeenCalledTimes(1);
      const googleErrors = consoleError.mock.calls.filter(([message]) =>
        String(message).includes("Google"),
      );
      expect(googleErrors).toHaveLength(1);
    } finally {
      consoleError.mockRestore();
    }
  });
});
