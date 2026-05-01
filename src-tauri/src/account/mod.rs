//! Account integration umbrella. Public façade for the rest of the
//! Rust crate; holds state, owns the API client, drives the sync
//! engine, exposes Tauri commands via `lib.rs`.
//!
//! Mirrors `TiTiTalkAccount.swift` (singleton on macOS); here we wrap
//! the state in `Arc<RwLock>` and expose `Account` as a clone-friendly
//! handle that we attach to `AppState`.

pub mod api_client;
pub mod auth;
pub mod keystore;
pub mod license;
pub mod sync;

use std::sync::Arc;
use std::time::Duration;

use parking_lot::RwLock;
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::sync::Mutex as AsyncMutex;

use api_client::{ApiClient, ApiError};
use auth::{AuthState, DeviceInfo, QuotaInfo, User};
use license::LicenseInfo;
use sync::{CloudConfigSync, ConflictResolution};

use crate::state::AppState;

type AppStateArc = Arc<AppState>;

/// Snapshot serialised to the frontend on `cmd_account_get_state`.
#[derive(Debug, Clone, Serialize)]
pub struct AccountSnapshot {
    pub state: AuthState,
    pub license: Option<LicenseInfo>,
    pub quota: Option<QuotaInfo>,
}

/// Inner mutable bag — held behind `Arc<RwLock>` for cheap cloning.
struct Inner {
    state: AuthState,
    license: Option<LicenseInfo>,
    quota: Option<QuotaInfo>,
    /// Plan we last saw on the server (for X-User-Plan drift). None
    /// until first /me / first response with the header.
    last_seen_plan: Option<String>,
    /// In-memory only — never written to disk. Spec §4.3.
    access_token: Option<String>,
}

/// Cloneable handle to the global account state. Wraps the API client +
/// the sync engine + shared mutable state.
#[derive(Clone)]
pub struct Account {
    inner: Arc<RwLock<Inner>>,
    /// Refresh single-flight guard. While `Some`, concurrent 401 retries
    /// all wait on the existing task instead of spawning competitors.
    refresh_lock: Arc<AsyncMutex<()>>,
    api: ApiClient,
    sync: Arc<AsyncMutex<Option<Arc<CloudConfigSync>>>>,
    handle: AppHandle,
    app: AppStateArc,
}

impl Account {
    /// Construct + wire. The `ApiClient` callbacks loop back into us via
    /// weak-style `Arc` so the API layer stays decoupled from concrete
    /// state.
    pub fn new(handle: AppHandle, app: AppStateArc) -> Self {
        let inner = Arc::new(RwLock::new(Inner {
            state: AuthState::Unauthenticated,
            license: license::load(),
            quota: None,
            last_seen_plan: None,
            access_token: None,
        }));
        let refresh_lock = Arc::new(AsyncMutex::new(()));

        // Token provider — read access token under read-lock.
        let token_inner = inner.clone();
        let token: api_client::TokenProvider = Arc::new(move || {
            token_inner.read().access_token.clone()
        });

        // Refresh handler — coalesces concurrent callers via the
        // refresh_lock (single-flight). The body re-reads the inner
        // state so a refresh that completed while we were queued is a
        // no-op.
        let refresh_inner = inner.clone();
        let refresh_lock_for_handler = refresh_lock.clone();
        // Intentionally Arc-clone the API client into the closure later
        // — but we don't have it yet (chicken-and-egg). We work around
        // by capturing a `LateApiClient` slot.
        let late_api: Arc<RwLock<Option<ApiClient>>> = Arc::new(RwLock::new(None));
        let late_api_for_handler = late_api.clone();
        let refresh: api_client::RefreshHandler = Arc::new(move || {
            let inner = refresh_inner.clone();
            let lock = refresh_lock_for_handler.clone();
            let late = late_api_for_handler.clone();
            Box::pin(async move {
                let _g = lock.lock().await;
                // After acquiring lock, read current refresh token. If
                // somebody before us already refreshed, the tokens are
                // fresh and we skip.
                let api = match late.read().clone() {
                    Some(a) => a,
                    None => {
                        return Err(ApiError::NotLoggedIn);
                    }
                };
                let refresh_tok = keystore::load_refresh()
                    .filter(|s| !s.is_empty())
                    .ok_or(ApiError::NotLoggedIn)?;
                match auth::perform_refresh(&api, &refresh_tok).await {
                    Ok((access, new_refresh)) => {
                        // Roll the stored refresh per spec §5.1.
                        if let Err(e) = keystore::save_refresh(&new_refresh) {
                            log::warn!("save_refresh after rotation failed: {e}");
                        }
                        inner.write().access_token = Some(access);
                        Ok(())
                    }
                    Err(e) => {
                        // refresh_invalid → wipe + bounce to unauthenticated.
                        if e.code() == Some("refresh_invalid")
                            || e.status() == Some(401)
                        {
                            let _ = keystore::clear();
                            let mut w = inner.write();
                            w.access_token = None;
                            w.state = AuthState::Unauthenticated;
                        }
                        Err(e)
                    }
                }
            })
        });

        // Plan observer — handed to api_client. Captures inner via Arc.
        let plan_inner = inner.clone();
        let plan_late_api = late_api.clone();
        let on_plan: api_client::PlanObserver = Arc::new(move |plan_opt| {
            let plan = match plan_opt.filter(|s| !s.is_empty()) {
                Some(p) => p,
                None => return,
            };
            let mut w = plan_inner.write();
            let last = w.last_seen_plan.clone();
            if last.as_deref() == Some(plan.as_str()) {
                return;
            }
            // Bootstrap (no last) → just record.
            if last.is_none() {
                w.last_seen_plan = Some(plan);
                return;
            }
            // Drift! Refresh license in background.
            log::info!("X-User-Plan changed ({:?} → {}) — refreshing license", last, plan);
            w.last_seen_plan = Some(plan);
            drop(w);
            let api_for_drift = plan_late_api.read().clone();
            let inner = plan_inner.clone();
            if let Some(api) = api_for_drift {
                tauri::async_runtime::spawn(async move {
                    if let Ok(lic) = auth::fetch_license(&api).await {
                        license::save(&lic);
                        inner.write().license = Some(lic);
                    }
                });
            }
        });

        let api = ApiClient::new(token, refresh, on_plan, auth::client_version());
        // Plug the late slot now that we have the real client.
        *late_api.write() = Some(api.clone());

        Account {
            inner,
            refresh_lock,
            api,
            sync: Arc::new(AsyncMutex::new(None)),
            handle,
            app,
        }
    }

    pub fn snapshot(&self) -> AccountSnapshot {
        let g = self.inner.read();
        AccountSnapshot {
            state: g.state.clone(),
            license: g.license.clone(),
            quota: g.quota.clone(),
        }
    }

    /// True iff the user has paid the ¥49 「专业版」 unlock. Read from
    /// `User.pro_unlocked_at` inside the authenticated state. Used as the
    /// gate for local Whisper engine + BYOK menu.
    pub fn is_pro_unlocked(&self) -> bool {
        let g = self.inner.read();
        match &g.state {
            auth::AuthState::Authenticated { user } => user.pro_unlocked_at.is_some(),
            _ => false,
        }
    }

    /// Read access token (for ASR proxy + future authed direct calls).
    pub fn access_token(&self) -> Option<String> {
        self.inner.read().access_token.clone()
    }

    /// Forward an X-User-Plan header observation. Mirrors what the api_client
    /// PlanObserver closure does — call sites that talk to tititalk.com via
    /// reqwest directly (e.g. ASR multipart upload in asr.rs) use this so
    /// the drift detector still fires and triggers a license refresh.
    /// Idempotent: same plan as last seen → no-op.
    pub async fn observe_plan_header(&self, plan_opt: Option<String>) {
        let plan = match plan_opt.filter(|s| !s.is_empty()) {
            Some(p) => p,
            None => return,
        };
        let last = {
            let w = self.inner.read();
            w.last_seen_plan.clone()
        };
        if last.as_deref() == Some(plan.as_str()) { return; }
        let needs_refresh = last.is_some(); // bootstrap (no last) → just record
        self.inner.write().last_seen_plan = Some(plan.clone());
        if !needs_refresh { return; }
        log::info!("X-User-Plan drift ({:?} → {}) — refreshing license", last, plan);
        if let Ok(lic) = auth::fetch_license(&self.api).await {
            license::save(&lic);
            self.inner.write().license = Some(lic);
            self.emit_state();
        }
    }

    /// Called once at app launch. Try to swap a stored refresh for an
    /// access token; on success load /me and start sync. Failure is
    /// silent — user will see logged-out state and can hit Login.
    pub async fn bootstrap(&self) {
        let stored = keystore::load_refresh();
        let Some(refresh) = stored.filter(|s| !s.is_empty()) else {
            return;
        };
        // Direct-call into perform_refresh (skip the single-flight
        // mutex; nobody else can be racing us here).
        match auth::perform_refresh(&self.api, &refresh).await {
            Ok((access, new_refresh)) => {
                if let Err(e) = keystore::save_refresh(&new_refresh) {
                    log::warn!("bootstrap save_refresh: {e}");
                }
                self.inner.write().access_token = Some(access);
                if let Err(e) = self.load_me_and_start_sync().await {
                    log::info!("bootstrap loadMe failed: {e}");
                }
            }
            Err(e) => {
                log::info!("bootstrap refresh failed: {e}; clearing");
                let _ = keystore::clear();
            }
        }
        // Schedule a periodic license re-check every 24h.
        let me = self.clone();
        tauri::async_runtime::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(24 * 3600)).await;
                let auth = me.inner.read().state.clone();
                if matches!(auth, AuthState::Authenticated { .. }) {
                    if let Ok(lic) = auth::fetch_license(&me.api).await {
                        license::save(&lic);
                        me.inner.write().license = Some(lic);
                        let snap = me.snapshot();
                        let _ = me.handle.emit("account-state", &snap);
                    }
                }
            }
        });
    }

    /// Kick off /api/auth/desktop/init → open browser → wait for callback.
    pub async fn start_login(&self) -> Result<(), String> {
        match auth::desktop_init(&self.api).await {
            Ok((session_id, auth_url, expires_in)) => {
                self.inner.write().state = AuthState::Authenticating {
                    session_id: session_id.clone(),
                };
                self.emit_state();
                // Open browser. tauri-plugin-shell's opener accepts the URL.
                if let Err(e) = open::that(&auth_url) {
                    log::warn!("opener failed: {e} (URL was {auth_url})");
                }
                // Schedule timeout — if still authenticating with the same
                // session_id when expires_in passes, transition to error.
                let me = self.clone();
                let sid_for_timeout = session_id.clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(Duration::from_secs(expires_in.max(60) as u64))
                        .await;
                    let mut w = me.inner.write();
                    if let AuthState::Authenticating { session_id: cur } = &w.state {
                        if cur == &sid_for_timeout {
                            w.state = AuthState::Error {
                                message: format!(
                                    "登录超时（{} 分钟未完成），请重新发起。",
                                    expires_in / 60
                                ),
                            };
                            drop(w);
                            me.emit_state();
                        }
                    }
                });
                Ok(())
            }
            Err(e) => {
                let msg = if e.code() == Some("device_limit_reached") {
                    "已绑定 3 台设备，请先在 https://tititalk.com/dashboard/devices 解绑一台".into()
                } else {
                    format!("登录启动失败：{e}")
                };
                self.inner.write().state = AuthState::Error { message: msg.clone() };
                self.emit_state();
                Err(msg)
            }
        }
    }

    /// Called from the deep-link handler on `tititalk://auth/callback?...`.
    /// Validates session_id matches the in-flight one, persists tokens,
    /// loads /me. Bad shapes are silently ignored (anti-DoS).
    pub async fn handle_auth_callback(&self, url: &str) {
        let (session_id, access, refresh) = match auth::parse_callback(url) {
            Ok(x) => x,
            Err(e) => {
                log::warn!("auth-callback ignored: {e}");
                return;
            }
        };
        // Anti-CSRF: must currently be in `.authenticating(<sid>)`.
        let expected = match &self.inner.read().state {
            AuthState::Authenticating { session_id } => session_id.clone(),
            _ => {
                log::warn!("auth-callback: ignored — not awaiting login");
                return;
            }
        };
        if expected != session_id {
            log::warn!("auth-callback: session_id mismatch");
            self.inner.write().state = AuthState::Error {
                message: "登录会话不匹配，请重新发起登录".into(),
            };
            self.emit_state();
            return;
        }
        if let Err(e) = keystore::save_refresh(&refresh) {
            log::warn!("save_refresh on callback failed: {e}");
        }
        self.inner.write().access_token = Some(access);
        if let Err(e) = self.load_me_and_start_sync().await {
            self.inner.write().state = AuthState::Error {
                message: format!("拉取用户信息失败：{e}"),
            };
            self.emit_state();
        }
    }

    async fn load_me_and_start_sync(&self) -> Result<(), ApiError> {
        let user: User = auth::fetch_me(&self.api).await?;
        {
            let mut w = self.inner.write();
            w.last_seen_plan = Some(user.plan.clone());
            w.state = AuthState::Authenticated { user };
        }
        self.emit_state();
        // Background license + quota.
        self.refresh_license_and_quota_in_background();
        // Start sync.
        let sync = Arc::new(CloudConfigSync::new(
            self.api.clone(),
            self.app.clone(),
            self.handle.clone(),
        ));
        *self.sync.lock().await = Some(sync.clone());
        let s = sync.clone();
        tauri::async_runtime::spawn(async move {
            s.bootstrap_reconcile().await;
        });
        Ok(())
    }

    pub fn refresh_license_and_quota_in_background(&self) {
        let me = self.clone();
        tauri::async_runtime::spawn(async move {
            if let Ok(lic) = auth::fetch_license(&me.api).await {
                license::save(&lic);
                me.inner.write().license = Some(lic);
            }
            if let Ok(q) = auth::fetch_quota(&me.api).await {
                me.inner.write().quota = Some(q);
            }
            me.emit_state();
        });
    }

    pub async fn logout(&self) {
        let refresh = keystore::load_refresh();
        // Stop sync first so its in-flight tasks don't see a cleared state.
        if let Some(s) = self.sync.lock().await.take() {
            s.stop().await;
        }
        let _ = keystore::clear();
        license::clear();
        {
            let mut w = self.inner.write();
            w.access_token = None;
            w.license = None;
            w.quota = None;
            w.last_seen_plan = None;
            w.state = AuthState::Unauthenticated;
        }
        self.emit_state();
        if let Some(r) = refresh.filter(|s| !s.is_empty()) {
            let api = self.api.clone();
            tauri::async_runtime::spawn(async move {
                auth::logout_remote(&api, &r).await;
            });
        }
    }

    pub async fn list_devices(&self) -> Result<Vec<DeviceInfo>, String> {
        auth::list_devices(&self.api)
            .await
            .map_err(|e| e.to_string())
    }

    pub async fn unbind_device(&self, device_id: i64) -> Result<(), String> {
        auth::unbind_device(&self.api, device_id)
            .await
            .map_err(|e| e.to_string())
    }

    pub async fn resolve_conflict(&self, action: ConflictResolution) {
        let s = self.sync.lock().await.clone();
        if let Some(s) = s {
            s.resolve_conflict(action).await;
        }
    }

    /// Hook for the settings-save command — schedules a debounced PUT.
    pub async fn on_settings_changed(&self) {
        let s = self.sync.lock().await.clone();
        if let Some(s) = s {
            s.schedule_put();
        }
    }

    fn emit_state(&self) {
        let snap = self.snapshot();
        if let Err(e) = self.handle.emit("account-state", &snap) {
            log::warn!("emit account-state failed: {e}");
        }
    }

    /// Suppress unused warning — used by hotkey thread / ASR boundary in
    /// future for free-tier gating. Kept as the public predicate.
    #[allow(dead_code)]
    pub fn can_use_cloud(&self) -> bool {
        let g = self.inner.read();
        auth::can_use_cloud(&g.state, &g.license, &g.quota)
    }
}

// Tiny shim — `open` crate isn't a dep; we use tauri-plugin-shell. Add
// a thin module-level fn that prefers ShellExt opener but falls back to
// std::process::Command. This keeps the rest of the file decoupled from
// the tauri AppHandle inside async closures.
mod open {
    pub fn that<S: AsRef<str>>(url: S) -> Result<(), String> {
        let url = url.as_ref();
        #[cfg(windows)]
        {
            // `cmd /C start "" "<url>"` is the most reliable Win32 way.
            std::process::Command::new("cmd")
                .args(["/C", "start", "", url])
                .spawn()
                .map(|_| ())
                .map_err(|e| e.to_string())
        }
        #[cfg(target_os = "macos")]
        {
            std::process::Command::new("open")
                .arg(url)
                .spawn()
                .map(|_| ())
                .map_err(|e| e.to_string())
        }
        #[cfg(all(not(windows), not(target_os = "macos")))]
        {
            std::process::Command::new("xdg-open")
                .arg(url)
                .spawn()
                .map(|_| ())
                .map_err(|e| e.to_string())
        }
    }
}

// Re-exports for `lib.rs` — keep the surface narrow.
pub use sync::ConflictResolution as ResolveAction;
