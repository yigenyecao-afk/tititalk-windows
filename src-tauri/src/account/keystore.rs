//! DPAPI-backed refresh-token store, scoped to the current Windows user
//! (`CRYPTPROTECT_LOCAL_MACHINE = false`). Stored at
//! `%APPDATA%\TiTiTalk\refresh.bin`. Mirrors the role of `KeychainStore`
//! on macOS — the only persisted credential is the long-lived refresh
//! token; the access token is in-memory only (Spec §4.3).
//!
//! DPAPI ciphertexts include their own integrity check; corruption /
//! tamper / cross-user attempt all surface as a `CryptUnprotectData`
//! failure, which we treat as "no token" so a stale file never crashes
//! the app at boot.

use std::path::PathBuf;

#[cfg_attr(not(windows), allow(unused_imports))]
use anyhow::{anyhow, Context, Result};

#[cfg(windows)]
use windows::{
    core::PWSTR,
    Win32::{
        Foundation::LocalFree,
        Security::Cryptography::{CryptProtectData, CryptUnprotectData, CRYPT_INTEGER_BLOB},
    },
};

fn store_path() -> PathBuf {
    let mut p = dirs::config_dir().unwrap_or_else(|| PathBuf::from("."));
    p.push("TiTiTalk");
    let _ = std::fs::create_dir_all(&p);
    p.push("refresh.bin");
    p
}

#[cfg(windows)]
pub fn save_refresh(token: &str) -> Result<()> {
    if token.is_empty() {
        return clear();
    }
    let plaintext = token.as_bytes().to_vec();
    let mut input = CRYPT_INTEGER_BLOB {
        cbData: plaintext.len() as u32,
        pbData: plaintext.as_ptr() as *mut _,
    };
    let mut output = CRYPT_INTEGER_BLOB::default();
    // Description string surfaces in some recovery tools — keep it short
    // and non-secret. flags=0 → user-scoped (per-Windows-user).
    let description = windows::core::HSTRING::from("TiTiTalk refresh token");
    let result = unsafe {
        CryptProtectData(
            &mut input,
            PWSTR(description.as_ptr() as *mut _),
            None,
            None,
            None,
            0,
            &mut output,
        )
    };
    if result.is_err() {
        return Err(anyhow!("CryptProtectData failed: {:?}", result));
    }
    // Copy ciphertext out before LocalFree
    let cipher = unsafe {
        std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec()
    };
    unsafe {
        let _ = LocalFree(windows::Win32::Foundation::HLOCAL(output.pbData as *mut _));
    }
    let path = store_path();
    std::fs::write(&path, &cipher).with_context(|| format!("write {}", path.display()))?;
    Ok(())
}

#[cfg(windows)]
pub fn load_refresh() -> Option<String> {
    let path = store_path();
    let cipher = std::fs::read(&path).ok()?;
    if cipher.is_empty() {
        return None;
    }
    let mut input = CRYPT_INTEGER_BLOB {
        cbData: cipher.len() as u32,
        pbData: cipher.as_ptr() as *mut _,
    };
    let mut output = CRYPT_INTEGER_BLOB::default();
    let result = unsafe {
        CryptUnprotectData(
            &mut input,
            None,
            None,
            None,
            None,
            0,
            &mut output,
        )
    };
    if result.is_err() {
        log::warn!("CryptUnprotectData failed (file may be from another user / corrupted): {:?}", result);
        return None;
    }
    let plain = unsafe {
        std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec()
    };
    unsafe {
        let _ = LocalFree(windows::Win32::Foundation::HLOCAL(output.pbData as *mut _));
    }
    let s = String::from_utf8(plain).ok()?;
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

#[cfg(windows)]
pub fn clear() -> Result<()> {
    let path = store_path();
    if path.exists() {
        std::fs::remove_file(&path).with_context(|| format!("remove {}", path.display()))?;
    }
    Ok(())
}

// --- Non-Windows stubs (cargo check on dev macOS won't fail) ----------

#[cfg(not(windows))]
pub fn save_refresh(_token: &str) -> Result<()> {
    Err(anyhow!("DPAPI keystore only supported on Windows"))
}

#[cfg(not(windows))]
pub fn load_refresh() -> Option<String> {
    None
}

#[cfg(not(windows))]
pub fn clear() -> Result<()> {
    Ok(())
}
