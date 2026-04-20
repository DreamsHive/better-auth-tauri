import { APIError, createAuthEndpoint } from "better-auth/api";
import { HIDE_METADATA } from "better-auth";
import * as z from "zod";

/**
 * Server-side proxy that plants the OAuth CSRF state cookie in the system
 * browser's cookie jar *before* redirecting to the provider's authorization
 * URL. Without this, Better Auth's callback state-vs-cookie check fails in
 * the Tauri flow because the state cookie was set on the `/sign-in/social`
 * response inside the Tauri webview — a different cookie jar from the one
 * the system browser uses for the actual OAuth dance.
 *
 * Two modes, matching the Expo plugin:
 *
 * 1. `oauthState` query param present → plant it as a plain `oauth_state`
 *    cookie (10 min TTL). Used when the client already has a stored state
 *    it wants re-seeded before starting the flow.
 *
 * 2. `oauthState` absent → extract the `state` query param from the
 *    authorization URL and plant it as a signed `state` cookie (5 min
 *    TTL). This is the common path for a fresh OAuth sign-in.
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

    if (oauthState) {
      const oauthStateCookie = ctx.context.createAuthCookie("oauth_state", {
        maxAge: 600,
      });
      ctx.setCookie(
        oauthStateCookie.name,
        oauthState,
        oauthStateCookie.attributes,
      );
      return ctx.redirect(authorizationURL);
    }

    const state = new URL(authorizationURL).searchParams.get("state");
    if (!state) {
      throw new APIError("BAD_REQUEST", {
        message: "authorizationURL is missing required `state` query parameter",
      });
    }

    const stateCookie = ctx.context.createAuthCookie("state", { maxAge: 300 });
    await ctx.setSignedCookie(
      stateCookie.name,
      state,
      ctx.context.secret,
      stateCookie.attributes,
    );
    return ctx.redirect(authorizationURL);
  },
);
