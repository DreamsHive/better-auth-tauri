/**
 * Detects whether the current runtime is a Tauri webview.
 * During `vite dev` / `nuxt dev` in a normal browser, the Tauri IPC
 * globals are absent — the client plugin should no-op its desktop
 * branches in that case so the same code works in both environments.
 */
export function isTauriRuntime(): boolean {
  if (typeof window === "undefined") return false;
  return (
    "__TAURI_INTERNALS__" in window ||
    "__TAURI__" in window ||
    "__TAURI_METADATA__" in window
  );
}

/**
 * Build a deep-link URL from a scheme + path.
 * `createSchemeURL("/auth/callback", "sokudo")` → `"sokudo://auth/callback"`
 */
export function createSchemeURL(path: string, scheme: string): string {
  const normalized = path.startsWith("/") ? path.slice(1) : path;
  return `${scheme}://${normalized}`;
}

/**
 * Origin equivalent for a custom scheme, e.g. `sokudo://`.
 * Used for the `tauri-origin` header so the server can validate the request
 * came from a trusted Tauri app build.
 */
export function getOrigin(scheme: string): string {
  return `${scheme}://`;
}

/** Forgiving JSON.parse that never throws. */
export function safeJSONParse<T = unknown>(input: string | null | undefined): T | null {
  if (!input) return null;
  try {
    return JSON.parse(input) as T;
  } catch {
    return null;
  }
}
