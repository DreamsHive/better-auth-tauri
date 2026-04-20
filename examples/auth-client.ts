// Drop-in reference — copy into your Tauri app's client setup.
// Framework-agnostic core; swap `better-auth/vue` for /react, /solid, etc.

import { createAuthClient } from "better-auth/vue";
import { tauriClient } from "@dreamshive/better-auth-tauri/client";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { invoke, isTauri } from "@tauri-apps/api/core";

// OS-keychain storage adapter. Requires the Rust commands from
// `examples/keyring.rs` to be registered in your `lib.rs`.
const SERVICE = "com.yourapp.session";

// Note: the plugin only calls these methods inside a Tauri runtime — in
// a plain browser the plugin skips its Tauri-specific code paths and
// lets the browser handle cookies natively. No localStorage fallback
// needed.
const keyringStorage = {
  getItem: (key: string) =>
    invoke<string | null>("keyring_get", { service: SERVICE, key }),
  setItem: (key: string, value: string) =>
    invoke<void>("keyring_set", { service: SERVICE, key, value }),
};

export const authClient = createAuthClient({
  baseURL: "https://auth.example.com",
  basePath: "/",
  cookiePrefix: "yourapp",
  fetchOptions: {
    // Always go through tauriFetch in Tauri — the native fetch()
    // drops our smuggled `x-tauri-cookie` header and hits CORS.
    customFetchImpl: (...params) =>
      isTauri() ? tauriFetch(...params) : fetch(...params),
  },
  plugins: [
    tauriClient({
      scheme: "yourapp", // must match tauri.conf.json
      cookiePrefix: "yourapp", // must match your server's cookie prefix
      storage: keyringStorage,
    }),
  ],
});
