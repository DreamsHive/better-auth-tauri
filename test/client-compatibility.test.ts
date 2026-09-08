import { describe, expect, it } from "vitest";
import { createAuthClient } from "better-auth/client";
import { tauriClient } from "../src/client";

describe("Better Auth 1.7 client compatibility", () => {
  it("registers the Tauri cookie action on a Better Auth 1.7 client", () => {
    const values = new Map<string, string>();
    const client = createAuthClient({
      baseURL: "https://auth.example.test",
      plugins: [
        tauriClient({
          scheme: "sokudo",
          storage: {
            getItem: (key) => values.get(key) ?? null,
            setItem: (key, value) => {
              values.set(key, value);
            },
          },
        }),
      ],
    });

    expect(typeof client.getCookie).toBe("function");
    expect(typeof client.signOut).toBe("function");
  });
});
