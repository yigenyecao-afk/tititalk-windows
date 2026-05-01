//! Disk-backed cache of `/api/license/check` so a flaky-network morning
//! doesn't knock Pro users back to free behavior. Mirrors macOS
//! `LicenseCache.swift` — same 7-day grace window, same JSON shape.
//!
//! Stored at `%APPDATA%\TiTiTalk\license_cache.json`.

use std::path::PathBuf;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

const GRACE_SECS: i64 = 7 * 86400;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct LicenseInfo {
    pub plan: String, // "free" | "pro_annual" | "pro_lifetime"
    pub valid: bool,
    pub expires_at: Option<String>,
    pub device_count: i32,
    pub device_limit: i32,
    pub checked_at: String, // ISO8601, server-stamped
}

fn cache_path() -> PathBuf {
    let mut p = dirs::config_dir().unwrap_or_else(|| PathBuf::from("."));
    p.push("TiTiTalk");
    let _ = std::fs::create_dir_all(&p);
    p.push("license_cache.json");
    p
}

pub fn load() -> Option<LicenseInfo> {
    let path = cache_path();
    let raw = std::fs::read_to_string(&path).ok()?;
    // Permissive — corrupt JSON returns None so a bad file becomes
    // "no cache" instead of breaking bootstrap.
    serde_json::from_str(&raw).ok()
}

pub fn save(info: &LicenseInfo) {
    let path = cache_path();
    match serde_json::to_string(info) {
        Ok(s) => {
            if let Err(e) = std::fs::write(&path, s) {
                log::warn!("LicenseCache.save failed: {e}");
            }
        }
        Err(e) => log::warn!("LicenseCache.save serialize: {e}"),
    }
}

pub fn clear() {
    let path = cache_path();
    let _ = std::fs::remove_file(path);
}

/// True iff `checked_at` parses AND is within 7 days of `now`. Spec
/// frames grace as a safety net — on parse failure we return true so a
/// server stamping a different ISO8601 dialect doesn't permanently lock
/// out the user.
pub fn is_within_grace(info: &LicenseInfo, now: DateTime<Utc>) -> bool {
    let parsed = DateTime::parse_from_rfc3339(&info.checked_at)
        .map(|d| d.with_timezone(&Utc));
    let checked = match parsed {
        Ok(d) => d,
        Err(_) => {
            log::warn!(
                "LicenseCache: unparseable checked_at '{}' — assuming in-grace",
                info.checked_at
            );
            return true;
        }
    };
    (now - checked).num_seconds() <= GRACE_SECS
}
