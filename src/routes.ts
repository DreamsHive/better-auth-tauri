import { APIError, createAuthEndpoint } from "better-auth/api";
import { HIDE_METADATA, getAuthStateVerificationIdentifier } from "better-auth";
import * as z from "zod";

/** The part of a configured OAuth provider the proxy needs. */
interface AuthorizationProvider {
  id: string;
  createAuthorizationURL: (data: {
    state: string;
    codeVerifier: string;
    redirectURI: string;
  }) => URL | Promise<URL>;
}

const providerOrigins = new WeakMap<AuthorizationProvider, string>();

/**
 * The origin a provider sends users to, read from a URL it builds. Only
 * successes are cached, so a provider that fails once is asked again on the
 * next request.
 */
async function getProviderAuthorizationOrigin(
  provider: AuthorizationProvider,
  baseURL: string,
): Promise<string | null> {
  const cached = providerOrigins.get(provider);
  if (cached) return cached;
  try {
    const url = await provider.createAuthorizationURL({
      state: "state",
      codeVerifier: "code-verifier",
      redirectURI: `${baseURL}/callback/${provider.id}`,
    });
    providerOrigins.set(provider, url.origin);
    return url.origin;
  } catch {
    return null;
  }
}

/**
 * Parses `authorizationURL` and rejects anything that cannot be a provider's
 * authorization endpoint: non-HTTPS, a fragment, or this server itself.
 */
function parseAuthorizationURL(value: string, baseURL: string): URL | null {
  if (value.includes("#")) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.origin === new URL(baseURL).origin) {
    return null;
  }
  return url;
}

const invalidAuthorizationURL = () =>
  new APIError("BAD_REQUEST", { message: "Invalid authorizationURL" });

/**
 * Server-side proxy that plants the OAuth CSRF state cookie in the system
 * browser's cookie jar *before* redirecting to the provider's authorization
 * URL. Without this, Better Auth's callback state-vs-cookie check fails in
 * the Tauri flow because the state cookie was set on the `/sign-in/social`
 * response inside the Tauri webview — a different cookie jar from the one
 * the system browser uses for the actual OAuth dance.
 *
 * The endpoint is public, so it only acts on a request a legitimate sign-in
 * could produce. `authorizationURL` must be an HTTPS URL without a fragment
 * on the authorization origin of a configured social or generic OAuth
 * provider, and must carry a `state`. Anything else is refused with a 400,
 * without setting a cookie or redirecting.
 *
 * Two modes, matching the Expo plugin:
 *
 * 1. `oauthState` query param present → plant it as a plain `oauth_state`
 *    cookie (10 min TTL). Used with cookie-stored OAuth state, where the
 *    client re-seeds the encrypted state cookie it received. Nothing is
 *    signed.
 *
 * 2. `oauthState` absent → plant the URL's `state` as a signed `state`
 *    cookie (5 min TTL). Used with database-stored OAuth state. The cookie
 *    signature is an HMAC under the application secret, so only a state this
 *    server issued and that has not expired is signed.
 *
 * Endpoint is hidden from the Better Auth route docs — it's an internal
 * detail of the Tauri plugin flow.
 */
export const tauriAuthorizationProxy = createAuthEndpoint(
  "/tauri-authorization-proxy",
  {
    method: "GET",
    query: z.object({
      authorizationURL: z.string(),
      oauthState: z.string().optional(),
    }),
    metadata: HIDE_METADATA,
  },
  async (ctx) => {
    const { oauthState, authorizationURL } = ctx.query;
    const { baseURL, socialProviders, internalAdapter } = ctx.context;

    const url = parseAuthorizationURL(authorizationURL, baseURL);
    const state = url?.searchParams.get("state");
    if (!url || !state) throw invalidAuthorizationURL();

    const origins = await Promise.all(
      socialProviders.map((provider) =>
        getProviderAuthorizationOrigin(provider, baseURL),
      ),
    );
    if (!origins.includes(url.origin)) throw invalidAuthorizationURL();

    if (oauthState) {
      const oauthStateCookie = ctx.context.createAuthCookie("oauth_state", {
        maxAge: 600,
      });
      ctx.setCookie(
        oauthStateCookie.name,
        oauthState,
        oauthStateCookie.attributes,
      );
      return ctx.redirect(url.href);
    }

    const issued = await internalAdapter.findVerificationValue(
      getAuthStateVerificationIdentifier(state),
    );
    if (!issued || new Date(issued.expiresAt).getTime() <= Date.now()) {
      throw invalidAuthorizationURL();
    }

    const stateCookie = ctx.context.createAuthCookie("state", { maxAge: 300 });
    await ctx.setSignedCookie(
      stateCookie.name,
      state,
      ctx.context.secret,
      stateCookie.attributes,
    );
    return ctx.redirect(url.href);
  },
);
