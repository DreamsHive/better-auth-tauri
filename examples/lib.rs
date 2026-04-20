// Drop-in reference for src-tauri/src/lib.rs.

use tauri::{Emitter, Manager};

mod keyring;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Custom commands exposing the OS keychain to the webview.
        // See `examples/keyring.rs`.
        .invoke_handler(tauri::generate_handler![
            keyring::keyring_get,
            keyring::keyring_set,
            keyring::keyring_delete,
        ])
        // Single-instance MUST be registered first. When macOS routes a
        // `yourapp://` deep link to the bundle while an instance is
        // already running, this callback forwards the URL to the
        // existing window instead of spawning a second one.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
            for arg in argv.iter().skip(1) {
                if arg.starts_with("yourapp://") {
                    // `@tauri-apps/plugin-deep-link`'s JS `onOpenUrl`
                    // subscribes to this event.
                    let _ = app.emit("deep-link://new-url", vec![arg.clone()]);
                }
            }
        }))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_http::init())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
