//! Account integration umbrella. Public façade for the rest of the
//! Rust crate; holds state, owns the API client, drives the sync
//! engine, exposes Tauri commands via `lib.rs`.
//!
//! Mirrors `TiTiTalkAccount.swift` (singleton on macOS); here we wrap
//! the state in `Arc<RwLock>` and expose `Account` as a clone-friendly
//! handle that we attach to `AppState`.

pub mod api_client;
pub mod auth;
pub mod billing;
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

/// /api/polish 响应。Stylist::polish 在 cloud 路径上拿这个回填 quota。
/// real_input/output_tokens 是 LLM 实际 prompt/completion 计数（用来在 history
/// 里展示真实成本）；cost_tokens 是按 MODEL_DISPLAY_MULT 折算后扣 daily_usage
/// 的口径（跟 ASR 共池）。
#[derive(Debug, Clone, serde::Deserialize)]
pub struct CloudPolishResponse {
    pub polished: String,
    pub model: String,
    pub real_input_tokens: i64,
    pub real_output_tokens: i64,
    pub cost_tokens: i64,
    pub used_tokens: i64,
    pub limit_tokens: i64,
    pub remaining_tokens: i64,
    pub provider: Option<String>,
}

/// Snapshot serialised to the frontend on `cmd_account_get_state`.
#[derive(Debug, Clone, Serialize)]
pub struct AccountSnapshot {
    pub state: AuthState,
    pub license: Option<LicenseInfo>,
    pub quota: Option<QuotaInfo>,
    /// True from process start until `bootstrap()` finishes (success OR
    /// failure). The React-side WelcomeGate uses this to show "正在恢复
    /// 账号…" instead of flashing the login screen at users who have a
    /// stored refresh token waiting to swap.
    pub bootstrap_in_flight: bool,
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
    /// See `AccountSnapshot.bootstrap_in_flight`. Default true so the very
    /// first frontend snapshot reads as "loading" (since `bootstrap()` is
    /// kicked async and may not have set the flag yet by the time React
    /// asks for the initial state).
    bootstrap_in_flight: bool,
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
    /// AppHandle accessor —— state.rs 在 hotkey 路径要召唤主窗口（Notice
    /// 配套），但 state 本身不持 AppHandle。Account 是 state 之外唯一稳定
    /// 持有 handle 的 Arc，借它的 handle 复用即可。pub(crate) 限制可见。
    pub(crate) fn app_handle(&self) -> &AppHandle {
        &self.handle
    }
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
            bootstrap_in_flight: true,
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
            bootstrap_in_flight: g.bootstrap_in_flight,
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

    /// 当前用户 plan（free / pro_annual / pro_flagship / pro_lifetime）。
    /// 未登录时 None。stylist::polish 用它在 cloud 路径上做 free→qwen-flash
    /// 静默降级，避开后端 402 model_pro_locked。
    pub fn current_plan(&self) -> Option<String> {
        let g = self.inner.read();
        match &g.state {
            auth::AuthState::Authenticated { user } => Some(user.plan.clone()),
            _ => None,
        }
    }

    /// /api/polish 服务端代理。Stylist::polish 在 `engine == "tititalk_cloud"`
    /// 走这条路 —— 用户没 BYOK key，付的是平台 token 配额。
    /// 401 走 ApiClient 自带 refresh-then-retry；timeout 30s（client 默认 15s
    /// 不够润色慢路径），plan-tap 也跟正常调用一样自动联动 license 刷新。
    /// 调用成功后把响应里的 used/limit/remaining_tokens 一并写回 inner.quota，
    /// UI 的 quota bar 不必等下一次 /api/me/quota 后台轮询。
    pub async fn cloud_polish(
        &self,
        text: &str,
        persona: &str,
        model: &str,
    ) -> Result<CloudPolishResponse, ApiError> {
        #[derive(serde::Serialize)]
        struct Req<'a> {
            text: &'a str,
            persona: &'a str,
            model: &'a str,
        }
        let req = Req { text, persona, model };
        let resp: CloudPolishResponse = self
            .api
            .post_with_timeout("/api/polish", &req, true, std::time::Duration::from_secs(30))
            .await?;
        // 顺手把 quota 三元组（used / limit / remaining）灌回 inner —— 后续
        // /api/me/quota 后台 refresh 会重写整份 QuotaInfo，这里只是图眼动一下。
        {
            let mut w = self.inner.write();
            let prev = w.quota.clone();
            // (v0.7.3 audit fix) 后端配额按 UTC+8 日切（北京时间），
            // chrono::Utc::now() 在 0:00-8:00 之间会算成「昨天」，
            // optimistic 写入 quota.date 跟下次 /api/me/quota 拉到的真值不一致，
            // UI quota bar 会闪一下错误的日期。改用 UTC+8 计算今天。
            let date = prev
                .as_ref()
                .map(|q| q.date.clone())
                .unwrap_or_else(|| {
                    let utc8 = chrono::FixedOffset::east_opt(8 * 3600)
                        .expect("UTC+8 fixed offset always valid");
                    chrono::Utc::now().with_timezone(&utc8).format("%Y-%m-%d").to_string()
                });
            let plan = prev.as_ref().and_then(|q| q.plan.clone());
            let q = QuotaInfo {
                date,
                plan,
                limit_tokens: Some(resp.limit_tokens),
                used_tokens: Some(resp.used_tokens),
                remaining_tokens: Some(resp.remaining_tokens),
                limit_cents: prev.as_ref().and_then(|q| q.limit_cents),
                used_cents: prev.as_ref().map(|q| q.used_cents).unwrap_or(0),
                remaining_cents: prev.as_ref().and_then(|q| q.remaining_cents),
                call_count: prev.as_ref().and_then(|q| q.call_count),
                reset_at: prev.as_ref().map(|q| q.reset_at.clone()).unwrap_or_default(),
            };
            w.quota = Some(q);
        }
        self.emit_state();
        Ok(resp)
    }

    /// Force a refresh-token swap right now. Used by `asr::tititalk_cloud_transcribe`
    /// to recover from a 401 — that path uses raw reqwest multipart so it can't
    /// piggyback on `ApiClient::send_with_retry`'s automatic 401 → refresh dance.
    /// Skips the single-flight mutex (low-frequency, contention vanishingly
    /// unlikely on the ASR path), but still rolls the refresh token per spec §5.1.
    pub async fn try_refresh_now(&self) -> Result<(), String> {
        let refresh = keystore::load_refresh()
            .filter(|s| !s.is_empty())
            .ok_or_else(|| "无 refresh token，请重新登录".to_string())?;
        match auth::perform_refresh(&self.api, &refresh).await {
            Ok((access, new_refresh)) => {
                if let Err(e) = keystore::save_refresh(&new_refresh) {
                    log::warn!("save_refresh after rotation failed: {e}");
                }
                self.inner.write().access_token = Some(access);
                Ok(())
            }
            Err(e) => {
                if e.code() == Some("refresh_invalid") || e.status() == Some(401) {
                    let _ = keystore::clear();
                    let mut w = self.inner.write();
                    w.access_token = None;
                    w.state = AuthState::Unauthenticated;
                    drop(w);
                    self.emit_state();
                }
                Err(e.friendly_message())
            }
        }
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
    ///
    /// 30s 全局超时：refresh 端点理论上 15s timeout 就该回，但 DNS 阻塞、
    /// 路由黑洞、企业 firewall 静默 drop 等 corner case 会让单次请求超过
    /// reqwest connect_timeout（8s）+ request timeout（15s）的纸面预算。
    /// 这里加一道兜底：30s 还没结束就直接 fail-open（清 refresh + 当作未
    /// 登录），避免 WelcomeGate 永远卡 loader screen。用户能至少看到登录
    /// 按钮去重试。
    pub async fn bootstrap(&self) {
        const BOOTSTRAP_TIMEOUT: Duration = Duration::from_secs(30);
        match tokio::time::timeout(BOOTSTRAP_TIMEOUT, self.bootstrap_inner()).await {
            Ok(()) => {}
            Err(_) => {
                log::warn!("bootstrap timed out after 30s — falling back to logged-out");
                // 不 clear keystore —— 可能只是这次网络抖，下次启动还想用 refresh
                // 重连。flip flag + state 让用户能看到登录按钮。
                self.inner.write().bootstrap_in_flight = false;
                self.emit_state();
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

    /// 实际 bootstrap 流程 —— 拆出来好让外层套 timeout。
    async fn bootstrap_inner(&self) {
        let stored = keystore::load_refresh();
        let Some(refresh) = stored.filter(|s| !s.is_empty()) else {
            // No stored refresh — flip the in-flight flag off so the
            // WelcomeGate stops showing the loader and lets the user
            // click the login button.
            self.inner.write().bootstrap_in_flight = false;
            self.emit_state();
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
        // Whatever path we took above (success / wipe), bootstrap is done.
        // emit_state pushes the new snapshot so the WelcomeGate exits the
        // loader screen.
        self.inner.write().bootstrap_in_flight = false;
        self.emit_state();
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
                                code: Some("login_timeout".into()),
                                manage_url: None,
                            };
                            drop(w);
                            me.emit_state();
                        }
                    }
                });
                Ok(())
            }
            Err(e) => {
                // Prefer server-provided message: device_limit_reached returns
                // "已绑定 3/3 台设备 ..." with the actual counts (flagship is 5,
                // not 3 — hardcoding "3 台" was misleading once flagship users
                // hit the wall).
                let code = e.code().map(String::from);
                let manage_url = e.extra_str("manage_url");
                let msg = if code.as_deref() == Some("device_limit_reached") {
                    let m = e.message();
                    if m.is_empty() {
                        "设备已达上限，请到管理页解绑一台。".into()
                    } else {
                        m.to_string()
                    }
                } else {
                    e.friendly_message()
                };
                self.inner.write().state = AuthState::Error {
                    message: msg.clone(),
                    code,
                    manage_url,
                };
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
                code: Some("session_mismatch".into()),
                manage_url: None,
            };
            self.emit_state();
            return;
        }
        if let Err(e) = keystore::save_refresh(&refresh) {
            log::warn!("save_refresh on callback failed: {e}");
        }
        self.inner.write().access_token = Some(access);
        if let Err(e) = self.load_me_and_start_sync().await {
            // 这里 e 是 ApiError —— 用 friendly_message 消化掉 transport raw 文。
            let code = e.code().map(String::from);
            let manage_url = e.extra_str("manage_url");
            let msg = e.friendly_message();
            self.inner.write().state = AuthState::Error {
                message: format!("拉取用户信息失败：{msg}"),
                code,
                manage_url,
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
            // 3-attempt back-off (0/2/5s). Mirror of Mac. Without retry,
            // a single startup-time blip leaves `license` / `quota` nil,
            // `can_use_cloud()` becomes over-permissive, and the user's
            // first cloud call lands as a scary 402/429 instead of a
            // friendly "loading…" UI state.
            let delays: [u64; 3] = [0, 2, 5];
            for (i, d) in delays.iter().enumerate() {
                if *d > 0 {
                    tokio::time::sleep(Duration::from_secs(*d)).await;
                }
                match auth::fetch_license(&me.api).await {
                    Ok(lic) => {
                        license::save(&lic);
                        me.inner.write().license = Some(lic);
                        break;
                    }
                    Err(e) => log::info!(
                        "license fetch attempt {}/{} failed: {e}",
                        i + 1,
                        delays.len()
                    ),
                }
            }
            for (i, d) in delays.iter().enumerate() {
                if *d > 0 {
                    tokio::time::sleep(Duration::from_secs(*d)).await;
                }
                match auth::fetch_quota(&me.api).await {
                    Ok(q) => {
                        me.inner.write().quota = Some(q);
                        break;
                    }
                    Err(e) => log::info!(
                        "quota fetch attempt {}/{} failed: {e}",
                        i + 1,
                        delays.len()
                    ),
                }
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
        // PIPL：换账号 / 共享 PC 时旧 transcript JSONL 不应让新登录用户看见。
        // remove_file 失败（被占用 / 权限）只 warn，logout 流程不阻塞。
        if let Err(e) = crate::history::clear_all() {
            log::warn!("logout: clear history failed: {e}");
        }
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

    /// Pull the public plan/feature catalog. Used by the upgrade UI to
    /// avoid hardcoding plan codes / prices / features in the client.
    pub async fn fetch_plans(&self) -> Result<billing::PlansCatalog, String> {
        billing::fetch_plans(&self.api).await.map_err(|e| e.friendly_message())
    }

    /// Place a checkout order — server returns pay_url that the UI opens
    /// in the user's browser; UI then polls `get_order` for status.
    pub async fn billing_checkout(&self, plan: &str) -> Result<billing::CheckoutResp, String> {
        billing::checkout(&self.api, plan).await.map_err(|e| e.friendly_message())
    }

    pub async fn billing_get_order(&self, order_id: i64) -> Result<billing::OrderInfo, String> {
        billing::get_order(&self.api, order_id).await.map_err(|e| e.friendly_message())
    }

    /// Refresh /me after a successful checkout so plan/pro_unlocked_at flip
    /// in the UI immediately. Mirrors `loadMe()` on macOS.
    ///
    /// (B6) checkout 成功后单调 reload_me 不够 —— 后端 plan 已变但 quota
    /// 上限还在用旧 plan 计算，UI 看到「升级 Pro 但 quota 还是 18k」诡异
    /// 状态。这里把 license + quota 一并刷，三件套同步。失败 best-effort，
    /// 上层 reload_me 成功就算成功，license/quota 会被周期任务接管。
    pub async fn reload_me(&self) -> Result<(), String> {
        match auth::fetch_me(&self.api).await {
            Ok(user) => {
                self.inner.write().state = AuthState::Authenticated { user };
                self.emit_state();
                // 触发 license + quota 后台刷新（带 3 次重试，0/2/5s）
                self.refresh_license_and_quota_in_background();
                Ok(())
            }
            Err(e) => Err(e.friendly_message()),
        }
    }

    pub async fn list_devices(&self) -> Result<Vec<DeviceInfo>, String> {
        auth::list_devices(&self.api)
            .await
            .map_err(|e| e.friendly_message())
    }

    pub async fn unbind_device(&self, device_id: i64) -> Result<(), String> {
        auth::unbind_device(&self.api, device_id)
            .await
            .map_err(|e| e.friendly_message())
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

    /// 拿到底层 CloudConfigSync —— 仅供 tray graceful_quit 在退出前调
    /// `.stop()` 排空 in-flight PUT。在线时 sync 是 None（用户没登录），
    /// 所以返 Option。
    pub async fn cloud_sync(&self) -> Option<Arc<CloudConfigSync>> {
        self.sync.lock().await.clone()
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
