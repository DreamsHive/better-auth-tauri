import { afterEach, describe, expect, it, vi } from "vitest";
import { tauriClient, type TauriClientStorage } from "../src/client";

const openUrlListenerKey = "__better_auth_tauri_test_open_url_listener__";

vi.mock("@tauri-apps/plugin-shell", () => ({
  open: vi.fn(async () => {}),
}));

vi.mock("@tauri-apps/plugin-deep-link", () => ({
  onOpenUrl: vi.fn(async (listener: (urls: string[]) => void) => {
    (globalThis as Record<string, unknown>)[openUrlListenerKey] = listener;
    return () => {};
  }),
}));

type TauriHooks = {
  init: (url: string, options?: Record<string, unknown>) => Promise<unknown>;
  onSuccess: (context: {
    response: Response;
    request: Request;
    data: Record<string, unknown>;
  }) => Promise<void>;
};

function hooks(storage: TauriClientStorage, cookiePrefix = "better-auth"): TauriHooks {
  (globalThis as Record<string, unknown>).window ??= { __TAURI_INTERNALS__: {} };
  const plugin = tauriClient({ scheme: "sokudo", storage, cookiePrefix });
  const fetchPlugin = plugin.fetchPlugins[0];
  if (!fetchPlugin?.init || !fetchPlugin.hooks?.onSuccess) {
    throw new Error("Tauri client did not expose its fetch hooks");
  }
  return {
    init: fetchPlugin.init,
    onSuccess: fetchPlugin.hooks.onSuccess,
  } as unknown as TauriHooks;
}

function context(
  setCookie: string,
  requestCookie = "",
  url = "https://auth.example.test/resource",
) {
  return {
    response: new Response(null, { headers: { "set-cookie": setCookie } }),
    request: new Request(url, {
      headers: requestCookie ? { "x-tauri-cookie": requestCookie } : {},
    }),
    data: {},
  };
}

function jar(values: Record<string, string>): string {
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(values).map(([name, value]) => [name, { value, expires: null }]),
    ),
  );
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>).window;
  delete (globalThis as Record<string, unknown>)[openUrlListenerKey];
});

describe("Tauri client cookie mutations", () => {
  it("serializes concurrent response updates so neither cookie is lost", async () => {
    let value = "{}";
    let blockReads = true;
    let releaseReads: () => void = () => {};
    const readsBlocked = new Promise<void>((resolve) => {
      releaseReads = resolve;
    });
    const storage: TauriClientStorage = {
      async getItem() {
        const snapshot = value;
        if (blockReads) await readsBlocked;
        return snapshot;
      },
      async setItem(_, next) {
        value = next;
      },
    };
    const clientHooks = hooks(storage, "custom");

    const first = clientHooks.onSuccess(context("custom.first=one; Path=/"));
    await flush();
    const second = clientHooks.onSuccess(context("custom.second=two; Path=/"));
    await flush();
    blockReads = false;
    releaseReads();
    await Promise.all([first, second]);

    expect(JSON.parse(value)).toMatchObject({
      "custom.first": { value: "one" },
      "custom.second": { value: "two" },
    });
  });

  it("does not let a delayed unauthenticated response erase a restored secure session", async () => {
    let value = jar({ "__Secure-custom.session_token": "restored" });
    const storage: TauriClientStorage = {
      getItem: () => value,
      setItem: (_, next) => {
        value = next;
      },
    };
    const clientHooks = hooks(storage, "custom");

    await clientHooks.onSuccess(
      context("__Secure-custom.session_token=; Max-Age=0; Path=/"),
    );

    expect(JSON.parse(value)).toMatchObject({
      "__Secure-custom.session_token": { value: "restored" },
    });
  });

  it("does not let a delayed older-session response erase its replacement", async () => {
    let value = jar({ "custom.session_token": "replacement" });
    const storage: TauriClientStorage = {
      getItem: () => value,
      setItem: (_, next) => {
        value = next;
      },
    };
    const clientHooks = hooks(storage, "custom");

    await clientHooks.onSuccess(
      context(
        "custom.session_token=; Max-Age=0; Path=/",
        "custom.session_token=older",
      ),
    );

    expect(JSON.parse(value)).toMatchObject({
      "custom.session_token": { value: "replacement" },
    });
  });

  it("does not let a delayed partial deletion erase one cookie from a paired session", async () => {
    let value = jar({
      "custom.session_token": "replacement-token",
      "custom.session_data": "replacement-data",
    });
    const storage: TauriClientStorage = {
      getItem: () => value,
      setItem: (_, next) => {
        value = next;
      },
    };
    const clientHooks = hooks(storage, "custom");

    await clientHooks.onSuccess(
      context("custom.session_token=; Max-Age=0; Path=/"),
    );

    expect(JSON.parse(value)).toMatchObject({
      "custom.session_token": { value: "replacement-token" },
      "custom.session_data": { value: "replacement-data" },
    });
  });

  it("allows a deletion response sent with the current session to revoke it", async () => {
    let value = jar({ "custom.session_token": "current" });
    const storage: TauriClientStorage = {
      getItem: () => value,
      setItem: (_, next) => {
        value = next;
      },
    };
    const clientHooks = hooks(storage, "custom");

    await clientHooks.onSuccess(
      context(
        "custom.session_token=; Max-Age=0; Path=/",
        "custom.session_token=current",
      ),
    );

    expect(value).toBe("{}");
  });

  it("releases the mutation queue when storage writes fail", async () => {
    let value = "{}";
    let writes = 0;
    const storage: TauriClientStorage = {
      getItem: () => value,
      setItem: (_, next) => {
        writes += 1;
        if (writes === 1) throw new Error("disk unavailable");
        value = next;
      },
    };
    const clientHooks = hooks(storage, "custom");

    await expect(
      clientHooks.onSuccess(context("custom.first=one; Path=/")),
    ).rejects.toThrow("disk unavailable");
    await clientHooks.onSuccess(context("custom.second=two; Path=/"));

    expect(JSON.parse(value)).toMatchObject({ "custom.second": { value: "two" } });
  });

  it("releases the mutation queue when storage reads fail", async () => {
    let value = "{}";
    let reads = 0;
    const storage: TauriClientStorage = {
      getItem: () => {
        reads += 1;
        if (reads === 1) throw new Error("keychain unavailable");
        return value;
      },
      setItem: (_, next) => {
        value = next;
      },
    };
    const clientHooks = hooks(storage, "custom");

    await expect(
      clientHooks.onSuccess(context("custom.first=one; Path=/")),
    ).rejects.toThrow("keychain unavailable");
    await clientHooks.onSuccess(context("custom.second=two; Path=/"));

    expect(JSON.parse(value)).toMatchObject({ "custom.second": { value: "two" } });
  });

  it("does not resurrect an OAuth callback after explicit signout", async () => {
    (globalThis as Record<string, unknown>).window = { __TAURI_INTERNALS__: {} };
    let value = jar({ "custom.session_token": "old" });
    const storage: TauriClientStorage = {
      getItem: () => value,
      setItem: (_, next) => {
        value = next;
      },
    };
    const clientHooks = hooks(storage, "custom");
    const pendingCallback = clientHooks.onSuccess({
      ...context(""),
      request: new Request("https://auth.example.test/sign-in/social"),
      data: { url: "https://provider.example.test/authorize" },
    });
    await vi.waitFor(() => {
      expect((globalThis as Record<string, unknown>)[openUrlListenerKey]).toBeTypeOf("function");
    });
    const onOpenUrl = (globalThis as Record<string, unknown>)[openUrlListenerKey] as
      (urls: string[]) => void;

    await clientHooks.init("https://auth.example.test/sign-out", {});
    onOpenUrl?.([
      `sokudo://callback?cookie=${encodeURIComponent("custom.session_token=new; Path=/")}`,
    ]);
    await pendingCallback;

    expect(value).toBe("{}");
  });

  it("clears the cookie jar and local session cache on explicit signout", async () => {
    const values = new Map<string, string>([
      ["better-auth_cookie", jar({ "custom.session_token": "current" })],
      ["better-auth_session_data", JSON.stringify({ user: { id: "user-1" } })],
    ]);
    const storage: TauriClientStorage = {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => {
        values.set(key, value);
      },
    };
    const clientHooks = hooks(storage, "custom");

    await clientHooks.init("https://auth.example.test/sign-out", {});

    expect(values.get("better-auth_cookie")).toBe("{}");
    expect(values.get("better-auth_session_data")).toBe("{}");
  });

  it("does not restore a stale session response or session cache after signout", async () => {
    const values = new Map<string, string>([
      ["better-auth_cookie", jar({ "custom.session_token": "old" })],
      ["better-auth_session_data", JSON.stringify({ user: { id: "old" } })],
    ]);
    const storage: TauriClientStorage = {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => {
        values.set(key, value);
      },
    };
    const clientHooks = hooks(storage, "custom");

    await clientHooks.init("https://auth.example.test/sign-out", {});
    await clientHooks.onSuccess({
      ...context(
        "custom.session_token=stale; Path=/",
        "custom.session_token=old",
        "https://auth.example.test/get-session",
      ),
      data: { user: { id: "stale" } },
    });

    expect(values.get("better-auth_cookie")).toBe("{}");
    expect(values.get("better-auth_session_data")).toBe("{}");
  });

  it("handles malformed and empty cookie jars safely", async () => {
    let value = "not-json";
    const storage: TauriClientStorage = {
      getItem: () => value,
      setItem: (_, next) => {
        value = next;
      },
    };
    const clientHooks = hooks(storage, "custom");

    await expect(
      clientHooks.onSuccess(context("custom.session_token=fresh; Path=/")),
    ).resolves.toBeUndefined();
    expect(JSON.parse(value)).toMatchObject({ "custom.session_token": { value: "fresh" } });
    await expect(clientHooks.onSuccess(context(""))).resolves.toBeUndefined();
  });
});
