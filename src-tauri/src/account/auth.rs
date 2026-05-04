//! Desktop OAuth state machine + refresh coalescing. Mirrors
//! `TiTiTalkAccount.swift`. Handles:
//!   • POST /api/auth/desktop/init → open browser → wait for deep-link callback
//!   • POST /api/auth/refresh (single-flight) on 401 retry
//!   • POST /api/auth/logout (best-effort) on user logout
//!   • GET /api/me on successful auth
//!   • observe X-User-Plan drift → trigger /api/license/check
//!
//! The state struct is held inside `Account` (parent) under a `RwLock`.

use std::sync::Arc;

use chrono::Utc;
use serde::{Deserialize, Serialize};

use super::api_client::{ApiClient, ApiError};
use super::license::LicenseInfo;

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AuthState {
    Unauthenticated,
    Authenticating { session_id: String },
    Authenticated { user: User },
    /// `code` 是后端返回的错误码（device_limit_reached / refresh_invalid 等），
    /// 让 UI 能精确决定要不要弹「打开设备管理」之类的 actionable 按钮，而不
    /// 是 `message.contains("dashboard/devices")` 这种脆弱嗅探。
    /// `manage_url` 来自 device_limit_reached detail 里 server 直给的 url；
    /// 没有的错误就是 None。
    Error {
        message: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        code: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        manage_url: Option<String>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct User {
    pub user_id: i64,
    pub username: String,
    pub display_name: Option<String>,
    /// free | pro_annual | pro_flagship | pro_lifetime(legacy)
    pub plan: String,
    pub plan_expires_at: Option<String>,
    /// (api-integration §1.2) ¥49 「专业版」一次性解锁时间戳。
    /// None = 未解锁 → 本地 Whisper 禁用 + BYOK 端点 402；
    /// Some = 永久解锁，与 plan 完全独立加购。
    pub pro_unlocked_at: Option<String>,
    /// (角色身份系统 v1) teacher / doctor / journalist / lawyer / engineer
    /// / product_manager / sales / general。None = 老用户 / 新用户尚未做
    /// onboarding，前端会用全屏 OnboardingRoleSheet 强制选一次（决策 #1）。
    /// 客户端零信任：不传 role 给 polish/asr API（决策 #7 由后端 lookup）。
    pub role: Option<String>,
    pub role_chosen_at: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QuotaInfo {
    pub date: String,
    pub plan: Option<String>,
    /// (api-integration §2.3) token 主口径。display = real ASR token × 2，
    /// 0.1 秒说话 = 1 token。Free 18k/Pro 72k/旗舰 216k per day。
    pub limit_tokens: Option<i64>,
    pub used_tokens: Option<i64>,
    pub remaining_tokens: Option<i64>,
    /// 旧 cents 口径（兼容，新逻辑应优先 token；非 free 档为 None）。
    pub limit_cents: Option<i64>,
    pub used_cents: i64,
    pub remaining_cents: Option<i64>,
    pub call_count: Option<i64>,
    pub reset_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceInfo {
    pub id: i64,
    pub device_name: Option<String>,
    pub machine_uuid: Option<String>,
    pub platform: Option<String>,
    pub last_seen_at: Option<String>,
    pub is_current: Option<bool>,
}

#[derive(Serialize)]
struct DesktopInitReq<'a> {
    device_name: &'a str,
    machine_uuid: &'a str,
    platform: &'a str,
    client_version: &'a str,
}

#[derive(Deserialize)]
struct DesktopInitResp {
    session_id: String,
    auth_url: String,
    expires_in: i64,
}

#[derive(Serialize)]
struct RefreshReq<'a> {
    refresh_token: &'a str,
}

#[derive(Deserialize)]
struct RefreshResp {
    access_token: String,
    refresh_token: String,
    #[allow(dead_code)]
    expires_in: Option<i64>,
}

#[derive(Serialize)]
struct LogoutReq<'a> {
    refresh_token: &'a str,
}

/// Device identity helpers — read once at process startup; cached.
pub fn device_name() -> String {
    hostname::get()
        .ok()
        .and_then(|s| s.into_string().ok())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "Windows PC".to_string())
}

#[cfg(windows)]
pub fn machine_uuid() -> String {
    use windows::core::PCWSTR;
    use windows::Win32::System::Registry::{
        RegCloseKey, RegOpenKeyExW, RegQueryValueExW, HKEY, HKEY_LOCAL_MACHINE, KEY_READ,
        KEY_WOW64_64KEY, REG_VALUE_TYPE,
    };

    fn read() -> Option<String> {
        let subkey: Vec<u16> = "SOFTWARE\\Microsoft\\Cryptography\\\0"
            .encode_utf16()
            .collect();
        let value: Vec<u16> = "MachineGuid\0".encode_utf16().collect();
        let mut hkey = HKEY::default();
        let r = unsafe {
            RegOpenKeyExW(
                HKEY_LOCAL_MACHINE,
                PCWSTR(subkey.as_ptr()),
                0,
                KEY_READ | KEY_WOW64_64KEY,
                &mut hkey,
            )
        };
        if r.is_err() {
            return None;
        }
        let mut buf = vec![0u16; 256];
        let mut size = (buf.len() * 2) as u32;
        let mut kind = REG_VALUE_TYPE(0);
        let r = unsafe {
            RegQueryValueExW(
                hkey,
                PCWSTR(value.as_ptr()),
                None,
                Some(&mut kind),
                Some(buf.as_mut_ptr() as *mut u8),
                Some(&mut size),
            )
        };
        unsafe {
            let _ = RegCloseKey(hkey);
        }
        if r.is_err() {
            return None;
        }
        let chars = (size / 2) as usize;
        let trimmed: Vec<u16> = buf
            .into_iter()
            .take(chars)
            .take_while(|&c| c != 0)
            .collect();
        String::from_utf16(&trimmed).ok().filter(|s| !s.is_empty())
    }

    read().unwrap_or_else(|| {
        // Fallback — stable per-install but not per-machine.
        let mut p = dirs::config_dir().unwrap_or_default();
        p.push("TiTiTalk");
        let _ = std::fs::create_dir_all(&p);
        p.push("machine_uuid.txt");
        if let Ok(s) = std::fs::read_to_string(&p) {
            let s = s.trim().to_string();
            if !s.is_empty() {
                return s;
            }
        }
        let new = uuid::Uuid::new_v4().to_string();
        let _ = std::fs::write(&p, &new);
        new
    })
}

#[cfg(not(windows))]
pub fn machine_uuid() -> String {
    // Dev-only stub for `cargo check` on macOS.
    let mut p = dirs::config_dir().unwrap_or_default();
    p.push("TiTiTalk");
    let _ = std::fs::create_dir_all(&p);
    p.push("machine_uuid.txt");
    if let Ok(s) = std::fs::read_to_string(&p) {
        let s = s.trim().to_string();
        if !s.is_empty() {
            return s;
        }
    }
    let new = uuid::Uuid::new_v4().to_string();
    let _ = std::fs::write(&p, &new);
    new
}

pub fn client_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

// --- Endpoint helpers (called by Account, which holds state) ---------

pub async fn desktop_init(api: &ApiClient) -> Result<(String, String, i64), ApiError> {
    let dev = device_name();
    let mid = machine_uuid();
    let cv = client_version();
    let req = DesktopInitReq {
        device_name: &dev,
        machine_uuid: &mid,
        platform: "windows",
        client_version: &cv,
    };
    let resp: DesktopInitResp = api.post("/api/auth/desktop/init", &req, false).await?;
    Ok((resp.session_id, resp.auth_url, resp.expires_in))
}

pub async fn perform_refresh(
    api: &ApiClient,
    refresh_token: &str,
) -> Result<(String, String), ApiError> {
    let req = RefreshReq { refresh_token };
    let resp: RefreshResp = api.post("/api/auth/refresh", &req, false).await?;
    Ok((resp.access_token, resp.refresh_token))
}

pub async fn logout_remote(api: &ApiClient, refresh_token: &str) {
    let req = LogoutReq { refresh_token };
    // Best-effort — if offline we just leave the server-side refresh to
    // expire on its own (90d).
    let _: Result<serde_json::Value, _> = api.post("/api/auth/logout", &req, false).await;
}

pub async fn fetch_me(api: &ApiClient) -> Result<User, ApiError> {
    api.get("/api/me").await
}

pub async fn fetch_quota(api: &ApiClient) -> Result<QuotaInfo, ApiError> {
    api.get("/api/me/quota").await
}

pub async fn fetch_license(api: &ApiClient) -> Result<LicenseInfo, ApiError> {
    api.get("/api/license/check").await
}

pub async fn list_devices(api: &ApiClient) -> Result<Vec<DeviceInfo>, ApiError> {
    api.get("/api/me/devices").await
}

pub async fn unbind_device(api: &ApiClient, device_id: i64) -> Result<(), ApiError> {
    api.delete(&format!("/api/me/devices/{device_id}")).await
}

/// Parse the deep-link callback URL. Validates scheme + path, returns
/// `(session_id, access, refresh)` on success. Returns `Err` on any
/// shape mismatch — caller logs and ignores (these URLs can be poked by
/// other apps; crashing on bad input would be a DoS).
pub fn parse_callback(url: &str) -> Result<(String, String, String), String> {
    if !url.starts_with("tititalk://") {
        return Err(format!("scheme not tititalk: {url}"));
    }
    if !url.contains("/auth/callback") && !url.contains("//auth/callback") {
        return Err(format!("not a callback URL: {url}"));
    }
    // Find the query string — split at first '?'
    let (_head, qs) = url
        .split_once('?')
        .ok_or_else(|| format!("no query string: {url}"))?;
    let mut sid = None;
    let mut acc = None;
    let mut refr = None;
    for pair in qs.split('&') {
        let mut it = pair.splitn(2, '=');
        let k = it.next().unwrap_or("");
        let v = it.next().unwrap_or("");
        let v = urldecode(v);
        match k {
            "session_id" => sid = Some(v),
            "access" => acc = Some(v),
            "refresh" => refr = Some(v),
            _ => {}
        }
    }
    Ok((
        sid.ok_or("missing session_id")?,
        acc.ok_or("missing access")?,
        refr.ok_or("missing refresh")?,
    ))
}

fn urldecode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(hi), Some(lo)) = (
                hex_nibble(bytes[i + 1]),
                hex_nibble(bytes[i + 2]),
            ) {
                out.push((hi << 4) | lo);
                i += 3;
                continue;
            }
        }
        if bytes[i] == b'+' {
            out.push(b' ');
        } else {
            out.push(bytes[i]);
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn hex_nibble(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

/// Check if a cached license is still within 7-day grace AND, combined
/// with current quota, lets the user make a paid cloud call. Mirrors
/// `canUseCloud` on Mac.
pub fn can_use_cloud(
    state: &AuthState,
    license: &Option<LicenseInfo>,
    quota: &Option<QuotaInfo>,
) -> bool {
    if !matches!(state, AuthState::Authenticated { .. }) {
        return false;
    }
    let lic = match license {
        Some(l) => l,
        // Pre-fetch — let the call through; server will 401/429 if not.
        None => return true,
    };
    if !super::license::is_within_grace(lic, Utc::now()) {
        return false;
    }
    if lic.plan == "pro_lifetime" {
        return true;
    }
    if lic.valid && (lic.plan == "pro_annual" || lic.plan == "pro_flagship") {
        return true;
    }
    // Free tier — gate on remaining quota. Token 优先（新口径），fallback cents。
    if let Some(q) = quota {
        if let Some(rem_t) = q.remaining_tokens {
            return rem_t > 0;
        }
        return q.remaining_cents.unwrap_or(0) > 0;
    }
    true
}

#[allow(dead_code)]
pub fn arc_str(s: String) -> Arc<str> {
    Arc::from(s.into_boxed_str())
}
