import { describe, expect, it } from "vitest";
import type { BetterAuthClientPlugin } from "better-auth/client";
import { tauriClient } from "../src/client";

describe("tauriClient", () => {
  it("satisfies the Better Auth 1.7 client plugin contract", () => {
    const plugin: BetterAuthClientPlugin = tauriClient({
      scheme: "test-app",
      storage: {
        getItem: () => null,
        setItem: () => {},
      },
    });

    expect(plugin.id).toBe("tauri");
  });
});
