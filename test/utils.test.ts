import { describe, expect, it } from "vitest";
import {
  createSchemeURL,
  getOrigin,
  isTauriRuntime,
  safeJSONParse,
} from "../src/utils";

describe("createSchemeURL", () => {
  it("strips leading slash from path", () => {
    expect(createSchemeURL("/auth/callback", "sokudo")).toBe(
      "sokudo://auth/callback",
    );
  });

  it("accepts path without leading slash", () => {
    expect(createSchemeURL("auth/callback", "sokudo")).toBe(
      "sokudo://auth/callback",
    );
  });

  it("handles root path", () => {
    expect(createSchemeURL("/", "sokudo")).toBe("sokudo://");
  });

  it("handles empty path", () => {
    expect(createSchemeURL("", "sokudo")).toBe("sokudo://");
  });
});

describe("getOrigin", () => {
  it("returns scheme origin", () => {
    expect(getOrigin("sokudo")).toBe("sokudo://");
  });

  it("works with arbitrary scheme", () => {
    expect(getOrigin("myapp")).toBe("myapp://");
  });
});

describe("isTauriRuntime", () => {
  it("returns false when window is undefined", () => {
    // In a Node test env, window is undefined by default.
    expect(isTauriRuntime()).toBe(false);
  });

  it("detects Tauri via __TAURI_INTERNALS__", () => {
    const originalWindow = (globalThis as Record<string, unknown>).window;
    (globalThis as Record<string, unknown>).window = {
      __TAURI_INTERNALS__: {},
    };
    try {
      expect(isTauriRuntime()).toBe(true);
    } finally {
      (globalThis as Record<string, unknown>).window = originalWindow;
    }
  });

  it("detects Tauri via __TAURI__", () => {
    const originalWindow = (globalThis as Record<string, unknown>).window;
    (globalThis as Record<string, unknown>).window = { __TAURI__: {} };
    try {
      expect(isTauriRuntime()).toBe(true);
    } finally {
      (globalThis as Record<string, unknown>).window = originalWindow;
    }
  });

  it("returns false when window exists without Tauri globals", () => {
    const originalWindow = (globalThis as Record<string, unknown>).window;
    (globalThis as Record<string, unknown>).window = {};
    try {
      expect(isTauriRuntime()).toBe(false);
    } finally {
      (globalThis as Record<string, unknown>).window = originalWindow;
    }
  });
});

describe("safeJSONParse", () => {
  it("returns parsed value for valid JSON", () => {
    expect(safeJSONParse<{ a: number }>('{"a":1}')).toEqual({ a: 1 });
  });

  it("returns null for invalid JSON", () => {
    expect(safeJSONParse("not json")).toBe(null);
  });

  it("returns null for empty string", () => {
    expect(safeJSONParse("")).toBe(null);
  });

  it("returns null for null input", () => {
    expect(safeJSONParse(null)).toBe(null);
  });

  it("returns null for undefined input", () => {
    expect(safeJSONParse(undefined)).toBe(null);
  });
});
