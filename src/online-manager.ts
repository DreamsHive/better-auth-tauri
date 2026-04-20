import type { ClientStore } from "better-auth/client";

/**
 * Refetch the session when the network comes back online. Useful after
 * suspend/resume or a flaky wifi transition — otherwise the session
 * store would keep showing the cached pre-disconnect state until some
 * other request tries (and fails) to reach the server.
 *
 * Uses the browser's standard `online` event, which the Tauri WebView
 * exposes the same way Chrome/Safari do. No Tauri plugin needed — the
 * OS-level network state flows through the webview's navigator.
 *
 * Returns an unlisten function.
 */
export function setupTauriOnlineManager(store: ClientStore): () => void {
  if (typeof window === "undefined") {
    return () => {};
  }

  const handleOnline = () => {
    store.notify("$sessionSignal");
  };

  window.addEventListener("online", handleOnline);

  return () => {
    window.removeEventListener("online", handleOnline);
  };
}
