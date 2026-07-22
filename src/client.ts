import type {
  BetterAuthClientPlugin,
  ClientStore,
} from "better-auth/client";
import {
  parseSetCookieHeader,
  SECURE_COOKIE_PREFIX,
  stripSecureCookiePrefix,
} from "better-auth/cookies";
import { createSchemeURL, getOrigin, isTauriRuntime, safeJSONParse } from "./utils";
import { setupTauriFocusManager } from "./focus-manager";
import { setupTauriOnlineManager } from "./online-manager";
import { PACKAGE_VERSION } from "./version";

/* -------------------------------------------------------------------------- */
/*  Types                                                                     */
/* -------------------------------------------------------------------------- */

export interface TauriClientStorage {
  getItem: (key: string) => string | null | Promise<string | null>;
  setItem: (key: string, value: string) => void | Promise<void>;
}

export interface TauriClientOptions {
  /**
   * The custom URI scheme registered for the Tauri app in `tauri.conf.json`
   * under `plugins.deep-link.desktop.schemes`.
   *
   * Example: `"sokudo"` → produces `sokudo://` deep links.
   */
  scheme: string;

  /**
   * Persistent key/value storage for the local cookie jar and session cache.
   * Provide an adapter around `@tauri-apps/plugin-store`, a keychain plugin,
   * or `localStorage` for dev.
   */
  storage: TauriClientStorage;

  /**
   * Prefix for keys written to `storage`.
   * @default "better-auth"
   */
  storagePrefix?: string;

  /**
   * The cookie-name prefix used by the Better Auth server. Used to filter
   * the server's `Set-Cookie` header so third-party cookies (Cloudflare,
   * analytics, etc.) don't trigger session refetches.
   *
   * Pass multiple prefixes if the server sets several (e.g. when you
   * customize cookie names per instance).
   *
   * @default "better-auth"
   */
  cookiePrefix?: string | string[];

  /** Disable the local `/get-session` response cache. */
  disableCache?: boolean;

  /**
   * Refetch the session when the Tauri window regains focus.
   * @default true
   */
  refetchOnWindowFocus?: boolean;

  /**
   * Refetch the session when the network comes back online.
   * @default true
   */
  refetchOnReconnect?: boolean;
}

interface StoredCookie {
  value: string;
  expires: string | null;
}

/* -------------------------------------------------------------------------- */
/*  Cookie jar helpers                                                        */
/* -------------------------------------------------------------------------- */

function getSetCookie(header: string, prevCookie?: string | undefined) {
  const parsed = parseSetCookieHeader(header);
  const toSetCookie = safeJSONParse<Record<string, StoredCookie>>(prevCookie) ?? {};
  parsed.forEach((cookie, key) => {
    const expiresAt = cookie["expires"];
    const maxAge = cookie["max-age"];
    if (maxAge !== undefined && Number(maxAge) <= 0) {
      delete toSetCookie[key];
      return;
    }
    const expires = maxAge
      ? new Date(Date.now() + Number(maxAge) * 1000)
      : expiresAt
        ? new Date(String(expiresAt))
        : null;
    if (expires && expires.getTime() <= Date.now()) {
      delete toSetCookie[key];
      return;
    }
    toSetCookie[key] = {
      value: cookie["value"],
      expires: expires ? expires.toISOString() : null,
    };
  });
  return JSON.stringify(toSetCookie);
}

function getCookie(cookie: string): string {
  const parsed = safeJSONParse<Record<string, StoredCookie>>(cookie) ?? {};
  return Object.entries(parsed).reduce((acc, [key, value]) => {
    if (value.expires && new Date(value.expires) < new Date()) return acc;
    return acc ? `${acc}; ${key}=${value.value}` : `${key}=${value.value}`;
  }, "");
}

function getOAuthStateValue(
  cookieJson: string | null,
  cookiePrefix: string | string[],
): string | null {
  if (!cookieJson) return null;
  const parsed = safeJSONParse<Record<string, StoredCookie>>(cookieJson);
  if (!parsed) return null;

  const prefixes = Array.isArray(cookiePrefix) ? cookiePrefix : [cookiePrefix];
  for (const prefix of prefixes) {
    for (const name of [
      `${SECURE_COOKIE_PREFIX}${prefix}.oauth_state`,
      `${prefix}.oauth_state`,
    ]) {
      const value = parsed?.[name]?.value;
      if (value) return value;
    }
  }
  return null;
}

/** Only notify `$sessionSignal` when the session cookie values actually changed. */
function hasSessionCookieChanged(
  prevCookie: string | null,
  newCookie: string,
): boolean {
  if (!prevCookie) return true;
  try {
    const prev = JSON.parse(prevCookie) as Record<string, StoredCookie>;
    const next = JSON.parse(newCookie) as Record<string, StoredCookie>;
    const keys = new Set<string>();
    for (const k of Object.keys(prev)) {
      if (k.includes("session_token") || k.includes("session_data")) keys.add(k);
    }
    for (const k of Object.keys(next)) {
      if (k.includes("session_token") || k.includes("session_data")) keys.add(k);
    }
    for (const k of keys) {
      if (prev[k]?.value !== next[k]?.value) return true;
    }
    return false;
  } catch {
    return true;
  }
}

/** Is this Set-Cookie header ours, or third-party (Cloudflare, analytics)? */
function hasBetterAuthCookies(
  setCookieHeader: string,
  cookiePrefix: string | string[],
): boolean {
  const cookies = parseSetCookieHeader(setCookieHeader);
  const prefixes = Array.isArray(cookiePrefix) ? cookiePrefix : [cookiePrefix];
  const suffixes = ["session_token", "session_data"];
  for (const name of cookies.keys()) {
    const bare = stripSecureCookiePrefix(name);
    for (const prefix of prefixes) {
      if (prefix) {
        if (bare.startsWith(prefix)) return true;
      } else {
        for (const s of suffixes) if (bare.endsWith(s)) return true;
      }
    }
  }
  return false;
}

/** Some storage backends (keychains) reject `:` in keys. */
function normalizeKey(name: string): string {
  return name.replace(/:/g, "_");
}

function wrapStorage(storage: TauriClientStorage) {
  return {
    async getItem(name: string): Promise<string | null> {
      const v = await storage.getItem(normalizeKey(name));
      return v ?? null;
    },
    async setItem(name: string, value: string): Promise<void> {
      await storage.setItem(normalizeKey(name), value);
    },
  };
}

/* -------------------------------------------------------------------------- */
/*  Deep-link OAuth flow                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Open a URL in the user's default system browser and wait for the
 * `{scheme}://` deep-link callback. Resolves with the full callback URL
 * (which includes `?cookie=...` thanks to the server plugin's `after` hook).
 */
async function openAuthSession(
  urlToOpen: string,
  scheme: string,
): Promise<string> {
  // Peer-deps are resolved lazily so the package can be imported in a
  // non-Tauri context (e.g. `bun dev` in a browser) without a hard failure.
  const [{ open: openShell }, { onOpenUrl }] = await Promise.all([
    import("@tauri-apps/plugin-shell"),
    import("@tauri-apps/plugin-deep-link"),
  ]);

  const callback = new Promise<string>((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(
      () => {
        if (settled) return;
        settled = true;
        reject(new Error("OAuth timed out — no deep-link callback received"));
      },
      5 * 60 * 1000,
    );

    // `onOpenUrl` returns a Promise<UnlistenFn>. We unlisten as soon as we get
    // a URL that matches our scheme so we don't leak event subscriptions.
    const unlistenPromise = onOpenUrl((urls: string[]) => {
      const match = urls.find((u) => u.startsWith(`${scheme}://`));
      if (!match) return;
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      unlistenPromise.then((fn) => fn()).catch(() => {});
      resolve(match);
    });
  });

  await openShell(urlToOpen);
  return callback;
}

/* -------------------------------------------------------------------------- */
/*  Client plugin                                                             */
/* -------------------------------------------------------------------------- */

export const tauriClient = (opts: TauriClientOptions) => {
  if (!opts.scheme) {
    throw new Error(
      "[better-auth-tauri] `scheme` is required. Pass the custom URI scheme " +
        "you registered in tauri.conf.json (e.g. 'sokudo').",
    );
  }

  const storagePrefix = opts.storagePrefix || "better-auth";
  const cookieName = `${storagePrefix}_cookie`;
  const localCacheName = `${storagePrefix}_session_data`;
  const cookiePrefix = opts.cookiePrefix || "better-auth";
  const storage = wrapStorage(opts.storage);
  const scheme = opts.scheme;
  const refetchOnWindowFocus = opts.refetchOnWindowFocus !== false;
  const refetchOnReconnect = opts.refetchOnReconnect !== false;

  let store: ClientStore | null = null;

  return {
    id: "tauri",
    getActions(_, $store) {
      store = $store;

      // Wire up focus + online refetch managers once the store is
      // available. No-op outside Tauri runtime. These fire-and-forget —
      // the subscriptions live for the process lifetime.
      if (isTauriRuntime() && store) {
        if (refetchOnWindowFocus) {
          setupTauriFocusManager(store).catch(() => {});
        }
        if (refetchOnReconnect) {
          setupTauriOnlineManager(store);
        }
      }
      return {
        /**
         * Returns the currently-stored cookie string in the standard
         * `key=value; key2=value2` format — useful if you need to attach it
         * to a custom fetch outside of the Better Auth client.
         */
        getCookie: async () => {
          const raw = await storage.getItem(cookieName);
          return getCookie(raw || "{}");
        },
      };
    },
    fetchPlugins: [
      {
        id: "tauri",
        name: "Tauri",
        hooks: {
          async onSuccess(context) {
            // In a plain-browser dev environment the default cookie flow
            // works fine — skip the deep-link machinery.
            if (!isTauriRuntime()) return;

            const setCookieHeader = context.response.headers.get("set-cookie");
            if (setCookieHeader) {
              if (hasBetterAuthCookies(setCookieHeader, cookiePrefix)) {
                const prev = await storage.getItem(cookieName);
                const next = getSetCookie(setCookieHeader, prev ?? undefined);
                await storage.setItem(cookieName, next);
                if (hasSessionCookieChanged(prev, next)) {
                  store?.notify("$sessionSignal");
                }
              }
            }

            if (
              context.request.url.toString().includes("/get-session") &&
              !opts.disableCache
            ) {
              await storage.setItem(localCacheName, JSON.stringify(context.data));
            }

            // Detect social / generic-oauth sign-in AND account-linking
            // responses that include an authorization URL. We check the URL
            // instead of the `redirect` flag because our init hook sets
            // `disableRedirect: true` on these requests (to stop Better
            // Auth's Vue client from window.location-navigating the Tauri
            // webview), which causes the server to respond with
            // `redirect: false`. The presence of `url` is the reliable
            // signal that this is an OAuth start response.
            //
            // `/oauth2/link` (generic-oauth account linking) has no
            // `disableRedirect` in its body schema and always responds
            // `redirect: true` — the URL-presence check covers it the same
            // way, and we neutralize the redirect below before the base
            // client can navigate the webview.
            const requestURL = context.request.url.toString();
            const isSignInRedirect =
              typeof context.data?.url === "string" &&
              (requestURL.includes("/sign-in/social") ||
                requestURL.includes("/sign-in/oauth2") ||
                requestURL.includes("/link-social") ||
                requestURL.includes("/oauth2/link"));

            if (!isSignInRedirect) return;

            const bodyStr =
              typeof context.request?.body === "string"
                ? context.request.body
                : JSON.stringify(context.request?.body ?? {});
            if (bodyStr.includes("idToken")) return; // silent native flow

            const signInURL = context.data.url as string;

            // Prevent Better Auth's Vue/React client from auto-navigating
            // the Tauri webview to the OAuth URL via window.location.href.
            // On web this is the correct default; in a Tauri webview it
            // would take over the app's own window with the provider's
            // login page. We open the system browser ourselves below.
            context.data.redirect = false;
            context.data.url = undefined;

            // Route the system-browser navigation through the server-side
            // `tauriAuthorizationProxy` endpoint so the OAuth `state` cookie
            // gets planted in the browser's cookie jar before the provider
            // redirect. Without this, Better Auth's callback state check
            // fails because the state cookie was set on the /sign-in/social
            // response inside the Tauri webview — a different cookie jar.
            //
            // If we have a previously-stored `oauth_state` (from an earlier
            // sign-in attempt), forward it to the proxy so it can be
            // re-seeded instead of re-derived from the URL.
            const storedCookieJson = await storage.getItem(cookieName);
            const oauthStateValue = getOAuthStateValue(
              storedCookieJson,
              cookiePrefix,
            );
            const params = new URLSearchParams({
              authorizationURL: signInURL,
            });
            if (oauthStateValue) {
              params.append("oauthState", oauthStateValue);
            }
            const proxyURL = `${context.request.baseURL}/tauri-authorization-proxy?${params.toString()}`;

            try {
              const callbackURL = await openAuthSession(proxyURL, scheme);
              const parsed = new URL(callbackURL);
              const cookie = parsed.searchParams.get("cookie");
              if (!cookie) return;
              const prev = await storage.getItem(cookieName);
              const next = getSetCookie(cookie, prev ?? undefined);
              await storage.setItem(cookieName, next);
              store?.notify("$sessionSignal");
            } catch (err) {
              // Re-throw so the caller of signIn.social() sees the failure.
              throw err;
            }
          },
        },
        async init(url, options) {
          if (!isTauriRuntime()) {
            return { url, options };
          }

          options = options || {};
          options.credentials = "omit";

          // Native ID-token flow (e.g. Sign in with Apple) doesn't need
          // cookie/origin handling — the token is verified server-side.
          const isIdTokenRequest =
            (options.body as Record<string, unknown> | undefined)?.idToken !==
            undefined;

          if (isIdTokenRequest) {
            options.headers = {
              ...options.headers,
              "x-skip-oauth-proxy": "true",
            };
          } else {
            const stored = await storage.getItem(cookieName);
            const cookie = getCookie(stored || "{}");
            options.headers = {
              ...options.headers,
              // "Cookie" is a forbidden header name per the Fetch spec
              // and gets silently dropped by the Headers constructor
              // (which runs inside `new Request(...)` before the request
              // ever reaches Rust / tauriFetch). Smuggle the value under
              // a custom header and let the server plugin rewrite it to
              // "Cookie" inside onRequest — round-trip equivalent.
              ...(cookie ? { "x-tauri-cookie": cookie } : {}),
              "tauri-origin": getOrigin(scheme),
              "x-skip-oauth-proxy": "true",
            };

            // Rewrite any relative callbackURL the caller passed as a path
            // (e.g. "/") to the Tauri-facing custom-scheme deep link, so
            // Better Auth's final redirect lands on our deep-link handler.
            const body = options.body as Record<string, unknown> | undefined;
            if (body) {
              for (const key of [
                "callbackURL",
                "newUserCallbackURL",
                "errorCallbackURL",
              ] as const) {
                const value = body[key];
                if (typeof value === "string" && value.startsWith("/")) {
                  body[key] = createSchemeURL(value, scheme);
                }
              }

              // For social/oauth sign-in routes, force `disableRedirect`
              // so Better Auth's Vue/React client does NOT navigate the
              // Tauri webview to the OAuth provider URL. We open the
              // system browser ourselves in the onSuccess hook below.
              // Without this, the webview takes over with the provider's
              // login page and the user's own app UI is lost.
              if (
                url.includes("/sign-in/social") ||
                url.includes("/sign-in/oauth2") ||
                url.includes("/link-social")
              ) {
                body.disableRedirect = true;
              }
            }

            // Clear local state on sign-out so the app immediately reflects
            // the logged-out state.
            if (url.includes("/sign-out")) {
              await storage.setItem(cookieName, "{}");
              await storage.setItem(localCacheName, "{}");
              store?.atoms?.session?.set({
                ...(store.atoms.session.get() as object),
                data: null,
                error: null,
                isPending: false,
              } as never);
            }
          }

          return { url, options };
        },
      },
    ],
  } satisfies BetterAuthClientPlugin;
};

export { PACKAGE_VERSION } from "./version";
export type { BetterAuthClientPlugin };
export { setupTauriFocusManager } from "./focus-manager";
export { setupTauriOnlineManager } from "./online-manager";
