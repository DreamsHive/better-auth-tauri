import { createAuthMiddleware } from "better-auth/api";
import type { BetterAuthPlugin } from "better-auth";
import { tauriAuthorizationProxy } from "./routes";

export interface TauriOptions {
  /**
   * Disable the origin header override for Tauri requests.
   *
   * Normally the plugin maps the `tauri-origin` header (sent by the client
   * plugin) to the `origin` header so the server's trusted-origin checks
   * accept the custom URI scheme. Set this to `true` if you want to handle
   * origin validation yourself.
   */
  disableOriginOverride?: boolean | undefined;
}

/**
 * Server-side Better Auth plugin for Tauri desktop apps.
 *
 * What it does:
 * 1. Remaps `tauri-origin` → `origin` so the Better Auth CSRF / trusted-origin
 *    check sees a value the server is configured to accept (e.g. `sokudo://`).
 * 2. Intercepts OAuth callback redirects whose `location` targets a non-HTTP
 *    custom scheme (the Tauri app's URI scheme). Before the 302 leaves the
 *    server, it appends the freshly-set `Set-Cookie` header as a `cookie`
 *    query parameter. The Tauri app then reads the cookie out of the
 *    deep-link URL and stores it locally — bridging the browser ↔ app
 *    cookie jars that the OS keeps isolated.
 *
 * Pair this with `tauriClient` from `@dreamshive/better-auth-tauri/client`.
 */
export const tauri = (options?: TauriOptions): BetterAuthPlugin => {
  return {
    id: "tauri",
    init: () => {
      // In development we trust the common tauri dev origin. The real app
      // scheme (e.g. `sokudo://`) should be added explicitly by the host
      // app in its `trustedOrigins` — we don't assume a scheme here.
      const trustedOrigins =
        typeof process !== "undefined" &&
        process.env?.NODE_ENV === "development"
          ? ["tauri://localhost"]
          : [];
      return {
        options: {
          trustedOrigins,
        },
      };
    },
    async onRequest(request, _ctx) {
      const tauriOrigin = request.headers.get("tauri-origin");
      // `Cookie` is a forbidden header name on the client side (browsers
      // / WKWebView strip it before sending), so the client plugin
      // smuggles it as `x-tauri-cookie`. We move it back to `Cookie`
      // here so downstream Better Auth handlers see the session cookie.
      const smuggledCookie = request.headers.get("x-tauri-cookie");

      const shouldRewriteOrigin =
        !options?.disableOriginOverride &&
        !request.headers.get("origin") &&
        !!tauriOrigin;

      if (!shouldRewriteOrigin && !smuggledCookie) return;

      const applyRewrites = (headers: Headers) => {
        if (shouldRewriteOrigin && tauriOrigin) {
          headers.set("origin", tauriOrigin);
        }
        if (smuggledCookie) {
          headers.set("cookie", smuggledCookie);
          headers.delete("x-tauri-cookie");
        }
      };

      try {
        // Prefer in-place mutation (works on Bun, Node, Deno).
        applyRewrites(request.headers);
        return { request };
      } catch {
        // Some runtimes (e.g. Cloudflare Workers) have immutable request
        // headers — fall back to constructing a new Request.
        const newHeaders = new Headers(request.headers);
        applyRewrites(newHeaders);
        return { request: new Request(request, { headers: newHeaders }) };
      }
    },
    hooks: {
      after: [
        {
          matcher(context) {
            return !!(
              context.path?.startsWith("/callback") ||
              context.path?.startsWith("/oauth2/callback") ||
              context.path?.startsWith("/magic-link/verify") ||
              context.path?.startsWith("/verify-email")
            );
          },
          handler: createAuthMiddleware(async (ctx) => {
            const headers = ctx.context.responseHeaders;
            const location = headers?.get("location");
            if (!location) return;

            // Leave Better Auth's own oauth-proxy plugin redirects alone —
            // those go through a separate round-trip we shouldn't rewrite.
            if (location.includes("/oauth-proxy-callback")) return;

            let redirectURL: URL;
            try {
              redirectURL = new URL(location);
            } catch {
              return;
            }

            // Only rewrite redirects going to custom schemes — leave HTTP(S)
            // redirects alone (those are the in-browser / web flow).
            const isHttpRedirect =
              redirectURL.protocol === "http:" ||
              redirectURL.protocol === "https:";
            if (isHttpRedirect) return;

            if (!ctx.context.isTrustedOrigin(location)) return;

            const cookie = headers?.get("set-cookie");
            if (!cookie) return;

            redirectURL.searchParams.set("cookie", cookie);
            ctx.setHeader("location", redirectURL.toString());
          }),
        },
      ],
    },
    endpoints: {
      tauriAuthorizationProxy,
    },
    options,
  } satisfies BetterAuthPlugin;
};

export { PACKAGE_VERSION } from "./version";
export { tauriAuthorizationProxy } from "./routes";
