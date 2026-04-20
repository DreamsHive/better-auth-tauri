import type { ClientStore } from "better-auth/client";

/**
 * Refetch Better Auth's session whenever the Tauri window regains focus.
 *
 * Rationale: if the user signs out in another window, or their session
 * expires while the app is backgrounded, we want the next time they come
 * back to the app to reflect reality. Without a focus listener the local
 * session store stays stale until some other request triggers a refresh.
 *
 * Subscribes to `@tauri-apps/api/window#onFocusChanged`. On `focused ===
 * true`, we notify `$sessionSignal` which every `useSession` subscriber
 * listens for — causing them to refetch `/get-session`.
 *
 * Returns an unlisten function. Cleanup is the caller's responsibility
 * (typically the plugin's lifecycle handles this implicitly — when the
 * app quits, the listener dies with the process).
 */
export async function setupTauriFocusManager(
  store: ClientStore,
): Promise<() => void> {
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    const win = getCurrentWindow();
    const unlisten = await win.onFocusChanged(({ payload: focused }) => {
      if (focused) {
        store.notify("$sessionSignal");
      }
    });
    return unlisten;
  } catch {
    // @tauri-apps/api/window isn't available (e.g. running in a plain
    // browser during `bun dev`). Return a no-op cleanup.
    return () => {};
  }
}
