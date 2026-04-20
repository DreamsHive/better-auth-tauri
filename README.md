# @dreamshive/better-auth-tauri

[Better Auth](https://better-auth.com) plugin for [Tauri](https://tauri.app) desktop apps. OAuth happens in the user's **system browser**, not the embedded webview — the session cookie rides back through a custom URI scheme deep link, and every outgoing request in the app is transparently authenticated.

Mirrors the architecture of the official [`@better-auth/expo`](https://github.com/better-auth/better-auth/tree/main/packages/expo) package, adapted for Tauri's browser-style webview.

## Why use this

- **OAuth providers that block embedded webviews still work** (Google's `disallowed_useragent`, enterprise SSO, upcoming Microsoft enforcement).
- **Users reuse their existing browser sessions** — no re-logging-in for github.com / google.com from inside your app.
- **Full address bar + padlock** — users can verify the provider's domain before signing in.
- **Same Better Auth API surface** — you keep using `authClient.signIn.social(...)` and `useSession()` as if nothing changed.

## How it works

```
┌──────────────────┐           ┌────────────────┐         ┌──────────────┐
│  Tauri app       │           │ System browser │         │ Auth service │
│  (WKWebView/     │           │ (Safari/Chrome)│         │              │
│   WebView2)      │           │                │         │              │
└────────┬─────────┘           └────────┬───────┘         └──────┬───────┘
         │ signIn.social()              │                        │
         │ ─────────────────────────────┼───────────────────────>│
         │                              │                        │
         │ <── { url, disableRedirect } ──────────────────────────│
         │                              │                        │
         │ shell.open(url)              │                        │
         │ ────────────────────────────>│                        │
         │                              │ /tauri-authz-proxy     │
         │                              │ ──────────────────────>│
         │                              │ Set-Cookie: state=...  │
         │                              │ <──────────────────────│
         │                              │                        │
         │                              │ github.com OAuth...    │
         │                              │ <─redirect to callback─│
         │                              │ /callback/github       │
         │                              │ ──────────────────────>│
         │                              │                        │
         │                              │ <── 302 sokudo://?cookie=<session>
         │                              │     (after-hook appends cookie
         │                              │     to custom-scheme redirect)
         │                              │                        │
         │ <── OS routes sokudo://  ────│                        │
         │                                                       │
         │ store cookie in OS keychain                           │
         │ inject as `x-tauri-cookie` header on future calls     │
         │ ─────────────────────────────────────────────────────>│
         │                                                       │
         │ <── server plugin rewrites x-tauri-cookie → Cookie ───│
         │     Better Auth validates, returns session           │
```

Two things worth calling out:

1. **`x-tauri-cookie` header smuggling.** The Fetch spec marks `Cookie` as a [forbidden header name](https://fetch.spec.whatwg.org/#forbidden-header-name). Webviews silently drop attempts to set it. We smuggle the session through `x-tauri-cookie` and the **server** plugin rewrites it back to `Cookie` before Better Auth inspects the request.
2. **`disableRedirect: true` auto-injection.** Better Auth's Vue/React client normally navigates `window.location.href` to the OAuth URL — fine in a browser, catastrophic in a single-window Tauri app (the webview takes over with the provider's login page). The client plugin injects `disableRedirect: true` into `/sign-in/social` and `/sign-in/oauth2` requests so the client stays put.

## Installation

```bash
bun add @dreamshive/better-auth-tauri
# or: npm install / pnpm add / yarn add
```

Peer Tauri plugins (install only in the desktop app that consumes the client):

```bash
bun add @tauri-apps/plugin-shell @tauri-apps/plugin-deep-link
cd src-tauri
cargo add tauri-plugin-shell tauri-plugin-deep-link
```

If you want the included focus/online managers to work, you also need:

```bash
bun add @tauri-apps/api   # onFocusChanged lives here
```

## Tauri configuration

### 1. Register your URI scheme

`src-tauri/tauri.conf.json`:

```json
{
  "plugins": {
    "deep-link": {
      "desktop": {
        "schemes": ["yourapp"]
      }
    }
  }
}
```

### 2. Initialize the Rust plugins

`src-tauri/src/lib.rs`:

```rust
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_shell::init())
    .plugin(tauri_plugin_deep_link::init())
    // ... your other plugins
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
```

### 3. Grant permissions

`src-tauri/capabilities/default.json`:

```json
{
  "permissions": [
    "core:default",
    "shell:allow-open",
    "deep-link:default"
  ]
}
```

### 4. (Highly recommended) Add `tauri-plugin-single-instance`

Without this, opening a `yourapp://` deep link from a browser while the Tauri app is already running may spawn a second window instead of reusing the first. Install:

```bash
cd src-tauri
cargo add tauri-plugin-single-instance --features deep-link
```

Register it **before** any other plugin in `lib.rs`:

```rust
use tauri::{Emitter, Manager};

pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
      if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
      }
      for arg in argv.iter().skip(1) {
        if arg.starts_with("yourapp://") {
          let _ = app.emit("deep-link://new-url", vec![arg.clone()]);
        }
      }
    }))
    .plugin(tauri_plugin_shell::init())
    .plugin(tauri_plugin_deep_link::init())
    // ...
}
```

## Server setup (Better Auth backend)

```ts
import { betterAuth } from "better-auth";
import { tauri } from "@dreamshive/better-auth-tauri";

export const auth = betterAuth({
  // ... your existing config
  trustedOrigins: ["yourapp://"],
  plugins: [
    tauri(),
    // ... your other plugins
  ],
});
```

The server plugin:

1. Remaps `tauri-origin` → `origin` so CSRF / trusted-origin checks accept the custom scheme.
2. Rewrites `x-tauri-cookie` → `Cookie` so the session cookie smuggled by the client is visible to Better Auth.
3. Appends `?cookie=<Set-Cookie>` to OAuth redirect URLs targeting custom schemes so the Tauri app can bridge the cookie jar.
4. Exposes a `/tauri-authorization-proxy` endpoint that plants the OAuth `state` cookie in the system browser's jar before redirecting to the provider (prevents callback state mismatch).

### CORS

Your auth server's CORS config must allow the custom headers this plugin sends:

```ts
cors({
  origin: [/* your frontend origins */, "yourapp://"],
  credentials: true,
  allowedHeaders: [
    "Content-Type",
    "Authorization",
    "Cookie",
    "tauri-origin",
    "x-tauri-cookie",
    "x-skip-oauth-proxy",
  ],
})
```

## Client setup

```ts
import { createAuthClient } from "better-auth/vue"; // or /react, /solid, etc.
import { tauriClient } from "@dreamshive/better-auth-tauri/client";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { isTauri } from "@tauri-apps/api/core";

export const authClient = createAuthClient({
  baseURL: "https://auth.example.com",
  fetchOptions: {
    // Always use tauriFetch in Tauri — the webview's native fetch() drops
    // our smuggled headers and hits CORS on custom schemes.
    customFetchImpl: (...args) =>
      isTauri() ? tauriFetch(...args) : fetch(...args),
  },
  plugins: [
    tauriClient({
      scheme: "yourapp",        // must match tauri.conf.json
      cookiePrefix: "yourapp",  // must match your server's cookie prefix
      storage: {
        // See "Secure storage" below — localStorage is dev-only.
        getItem: (k) => localStorage.getItem(k),
        setItem: (k, v) => localStorage.setItem(k, v),
      },
    }),
  ],
});
```

Then use Better Auth normally:

```ts
await authClient.signIn.social({
  provider: "github",
  callbackURL: "/", // auto-rewritten to yourapp:///
});
```

The plugin takes it from there.

## Secure storage

`localStorage` is **not appropriate for production** — any XSS in your Tauri webview can read it directly.

For production, back the `storage` option with an encrypted store. Options, ranked by ergonomics:

### Option A — OS keychain (recommended)

Expose `keyring-rs` via custom Tauri commands. Per-platform native secret store (Apple Keychain, Windows Credential Manager, Secret Service on Linux).

```bash
cd src-tauri
cargo add keyring --features apple-native,windows-native,linux-native-sync-persistent
```

```rust
// src-tauri/src/keyring.rs
use keyring::Entry;

#[tauri::command]
pub fn keyring_get(service: String, key: String) -> Result<Option<String>, String> {
  let entry = Entry::new(&service, &key).map_err(|e| e.to_string())?;
  match entry.get_password() {
    Ok(v) => Ok(Some(v)),
    Err(keyring::Error::NoEntry) => Ok(None),
    Err(e) => Err(e.to_string()),
  }
}

#[tauri::command]
pub fn keyring_set(service: String, key: String, value: String) -> Result<(), String> {
  let entry = Entry::new(&service, &key).map_err(|e| e.to_string())?;
  entry.set_password(&value).map_err(|e| e.to_string())
}
```

Register in `lib.rs`:

```rust
mod keyring;

tauri::Builder::default()
  .invoke_handler(tauri::generate_handler![
    keyring::keyring_get,
    keyring::keyring_set,
  ])
```

And in your client storage adapter:

```ts
import { invoke } from "@tauri-apps/api/core";
const SERVICE = "com.yourapp.session";

const keyringStorage = {
  getItem: (key: string) => invoke<string | null>("keyring_get", { service: SERVICE, key }),
  setItem: (key: string, value: string) => invoke("keyring_set", { service: SERVICE, key, value }),
};
```

### Option B — `tauri-plugin-stronghold`

Official Tauri encrypted vault (IOTA Stronghold). Requires a master passphrase that the app supplies.

### Option C — `@tauri-apps/plugin-store`

On-disk JSON, not encrypted, but lives behind Tauri IPC (not accessible from `document.localStorage`). Marginal improvement over `localStorage`.

## Options

### `tauri(options?)` — server plugin

| Option | Default | Description |
| --- | --- | --- |
| `disableOriginOverride` | `false` | Don't remap `tauri-origin` → `origin`. |

### `tauriClient(options)` — client plugin

| Option | Default | Description |
| --- | --- | --- |
| `scheme` | — (required) | Custom URI scheme registered in `tauri.conf.json`. |
| `storage` | — (required) | Key/value storage adapter. Async methods supported. |
| `storagePrefix` | `"better-auth"` | Prefix for storage keys. |
| `cookiePrefix` | `"better-auth"` | Server cookie-name prefix(es). |
| `disableCache` | `false` | Disable local `/get-session` response cache. |
| `refetchOnWindowFocus` | `true` | Refetch session when the Tauri window regains focus. |
| `refetchOnReconnect` | `true` | Refetch session when the network comes back online. |

## Exports

```ts
// Server
import { tauri, tauriAuthorizationProxy } from "@dreamshive/better-auth-tauri";

// Client
import {
  tauriClient,
  setupTauriFocusManager,   // manual wiring if you disabled auto-setup
  setupTauriOnlineManager,
} from "@dreamshive/better-auth-tauri/client";
```

## macOS dev workflow

Deep-link URI schemes on macOS are registered with Launch Services through the app's `.app` bundle's `Info.plist`. **`tauri dev` does not produce a bundle** — it runs a raw binary which macOS can't route deep links to.

Official Tauri guidance for developing against the deep-link plugin on macOS:

```bash
# Build once (also run after any Rust/plugin/capability change)
bun tauri build --debug
# Open the bundle so Launch Services indexes it
open src-tauri/target/debug/bundle/macos/your-app.app
```

Frontend (Vue/React/Svelte) HMR works fine through the built app if you point `frontendDist` at your dev server:

```json
// src-tauri/tauri.dev.conf.json
{
  "$schema": "../node_modules/@tauri-apps/cli/config.schema.json",
  "build": {
    "frontendDist": "http://localhost:3000",
    "beforeBuildCommand": ""
  }
}
```

```bash
bun tauri build --debug --config src-tauri/tauri.dev.conf.json
```

## Known limitations

- **macOS dev loop requires a bundle** (see above). Windows and Linux don't have this friction.
- **Scheme hijacking** — any app can register itself as a handler for your custom scheme. Production apps with meaningful attack surface should consider Universal Links (macOS) or App Links (Android equivalent).
- **Storage is the caller's responsibility.** This plugin doesn't bundle a secure-storage primitive; you provide the adapter.
- **No SSR support.** Tauri apps are client-only.

## Comparison to `@better-auth/expo`

Feature-for-feature parity on the auth flow, plus two Tauri-specific additions:

| Feature | Expo | Tauri (this) |
| --- | --- | --- |
| OAuth via system browser | ✅ | ✅ |
| Cookie bridge via URL query param | ✅ | ✅ |
| Authorization proxy endpoint for state | ✅ | ✅ |
| Redirect-to-scheme callback rewrite | ✅ | ✅ |
| Sign-out local cleanup | ✅ | ✅ |
| Third-party cookie filter | ✅ | ✅ |
| Focus refetch manager | ✅ (React Query) | ✅ (notifies Better Auth session signal) |
| Online refetch manager | ✅ (React Query) | ✅ (notifies Better Auth session signal) |
| **`x-tauri-cookie` smuggling** | — | ✅ required (browser forbids `Cookie`) |
| **`disableRedirect: true` injection** | — | ✅ required (browser has `window.location`) |

## License

MIT © [Rully Ardiansyah](https://github.com/DreamsHive)
