//! Disk-backed cache of `/api/license/check` so a flaky-network morning
//! doesn't knock Pro users back to free behavior. Mirrors macOS
//! `LicenseCache.swift` — same 7-day grace window, same JSON shape.
//!
//! Stored at `%APPDATA%\TiTiTalk\license_cache.json`.

use std::path::PathBuf;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

/// FIX-26: 两层 grace。
///   • USABILITY — 7 天断网兜底，付费用户云能力不被「掉线一晚」打断
///   • UPGRADE_DETECT — 1 小时窗口，超过则建议 UI 主动 refreshLicense
///     一次（覆盖「用户在 web 续费但本地缓存还显快过期」场景）
const USABILITY_GRACE_SECS: i64 = 7 * 86400;
const UPGRADE_DETECT_WINDOW_SECS: i64 = 3600;

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
    age_seconds(info, now) <= USABILITY_GRACE_SECS
}

/// FIX-26: 缓存陈旧到要主动 refresh license 一次了吗？
/// `true` = 缓存超 1h，UI 进入「即将到期 / 升级提醒」分支前应触发后台
/// refresh，避免「用户已续费但本地缓存还显示快过期」。
/// 与 is_within_grace 解耦：超 1h 仍 < 7d 时 can_use_cloud 仍放行，
/// 只是顺手刷新一次让 UI 准。
#[allow(dead_code)]
pub fn needs_fresh_check_for_upgrade(info: &LicenseInfo, now: DateTime<Utc>) -> bool {
    age_seconds(info, now) > UPGRADE_DETECT_WINDOW_SECS
}

fn age_seconds(info: &LicenseInfo, now: DateTime<Utc>) -> i64 {
    match DateTime::parse_from_rfc3339(&info.checked_at) {
        Ok(d) => (now - d.with_timezone(&Utc)).num_seconds(),
        Err(_) => {
            log::warn!(
                "LicenseCache: unparseable checked_at '{}' — assuming fresh",
                info.checked_at
            );
            0
        }
    }
}
