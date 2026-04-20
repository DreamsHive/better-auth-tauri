import { afterEach, describe, expect, it, vi } from "vitest";
import { setupTauriOnlineManager } from "../src/online-manager";

describe("setupTauriOnlineManager", () => {
  afterEach(() => {
    delete (globalThis as Record<string, unknown>).window;
  });

  it("is a no-op when window is undefined", () => {
    const store = { notify: vi.fn() } as unknown as Parameters<
      typeof setupTauriOnlineManager
    >[0];
    const cleanup = setupTauriOnlineManager(store);
    expect(() => cleanup()).not.toThrow();
  });

  it("notifies $sessionSignal on online event", () => {
    const listeners: Record<string, EventListener[]> = {};
    (globalThis as Record<string, unknown>).window = {
      addEventListener(event: string, cb: EventListener) {
        (listeners[event] ??= []).push(cb);
      },
      removeEventListener(event: string, cb: EventListener) {
        listeners[event] = (listeners[event] ?? []).filter((fn) => fn !== cb);
      },
    };

    const notify = vi.fn();
    const store = { notify } as unknown as Parameters<
      typeof setupTauriOnlineManager
    >[0];

    const cleanup = setupTauriOnlineManager(store);

    // Simulate browser firing `online`
    listeners["online"]?.forEach((fn) => fn(new Event("online")));
    expect(notify).toHaveBeenCalledWith("$sessionSignal");

    // Cleanup removes the listener
    cleanup();
    listeners["online"]?.forEach((fn) => fn(new Event("online")));
    expect(notify).toHaveBeenCalledTimes(1);
  });
});
