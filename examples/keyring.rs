//! Drop-in reference for src-tauri/src/keyring.rs.
//!
//! Requires the `keyring` crate:
//!   cargo add keyring --features apple-native,windows-native,linux-native-sync-persistent

use keyring::Entry;
use serde::Serialize;

#[derive(Debug, Serialize)]
pub struct KeyringError {
    pub message: String,
}

impl From<keyring::Error> for KeyringError {
    fn from(err: keyring::Error) -> Self {
        Self {
            message: err.to_string(),
        }
    }
}

#[tauri::command]
pub fn keyring_get(service: String, key: String) -> Result<Option<String>, KeyringError> {
    let entry = Entry::new(&service, &key)?;
    match entry.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(err) => Err(err.into()),
    }
}

#[tauri::command]
pub fn keyring_set(service: String, key: String, value: String) -> Result<(), KeyringError> {
    let entry = Entry::new(&service, &key)?;
    entry.set_password(&value)?;
    Ok(())
}

#[tauri::command]
pub fn keyring_delete(service: String, key: String) -> Result<(), KeyringError> {
    let entry = Entry::new(&service, &key)?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(err) => Err(err.into()),
    }
}
