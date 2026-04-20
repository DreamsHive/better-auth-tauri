# Examples

Minimal snippets showing how to wire `@dreamshive/better-auth-tauri` into a Tauri desktop app. Each file is a drop-in reference — not a runnable project — so you can copy-paste into your own Tauri app.

## Files

- [`auth-client.ts`](./auth-client.ts) — client-side Better Auth setup with the Tauri plugin + keychain storage adapter.
- [`auth-server.ts`](./auth-server.ts) — server-side Better Auth config registering the Tauri plugin.
- [`tauri.conf.json`](./tauri.conf.json) — the scheme registration your Tauri config needs.
- [`lib.rs`](./lib.rs) — Rust-side plugin initialization including `tauri-plugin-single-instance`.
- [`keyring.rs`](./keyring.rs) — Rust commands exposing the OS keychain to the webview.

## Full example app

For a complete working setup (Nuxt 4 + Tauri v2 + Better Auth + GitHub/GitLab/Bitbucket OAuth), see [sokudo-ide/desktop-app](https://github.com/DreamsHive/sokudo-ide) (the reference implementation used during development of this plugin).
