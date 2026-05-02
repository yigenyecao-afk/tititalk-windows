//! Cloud settings sync per `integration.md §9.6`. Port of
//! `CloudConfigSync.swift`.
//!
//! Owns:
//!   • the local↔cloud round-trip for the server-defined config blob
//!   • a 3s debounce that auto-PUTs after the user stops twiddling settings
//!   • optimistic locking via `If-Match: <last_known_version>`
//!   • surfacing a 412 to the frontend (Tauri event `cloud-config-conflict`)
//!
//! What we DO NOT sync (intentional):
//!   • API keys (per-device secret in DPAPI / config file)
//!   • Hotkey VK / min_hold_ms (host-specific input device)
//!   • engine "qwen"/"openai" choice that lives outside `default_engine`
//!     mapping
//!
//! The 8 server keys map to a subset of `AppConfig` fields:
//!   • `dictionaries`     ↔ `dictionary` (Vec<String>)
//!   • `polish_prompts`   — none yet (server tolerates missing)
//!   • `default_engine`   ↔ `engine`
//!   • `default_language` ↔ `language`
//!   • `default_stylist`  ↔ `stylist_persona`
//!   • `default_persona`  — none yet
//!   • `ui_preferences`   ↔ {auto_insert, also_copy, hotkey_vk, min_hold_ms,
//!                            stylist_enabled, stylist_model}
//!   • `version_schema`   ↔ literal 1

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use tauri::{AppHandle, Emitter};
use tokio::sync::Mutex;

use super::api_client::{ApiClient, ApiError};
use crate::config::AppConfig;
use crate::state::AppState;

type AppStateArc = Arc<AppState>;

pub const SCHEMA_VERSION: i64 = 1;

/// Whitelist of keys the server accepts. Sending anything else → 400.
fn allowed_keys() -> HashSet<&'static str> {
    [
        "version_schema",
        "dictionaries",
        "polish_prompts",
        "default_engine",
        "default_language",
        "default_stylist",
        "default_persona",
        "ui_preferences",
    ]
    .into_iter()
    .collect()
}

#[derive(Debug, Clone, Deserialize)]
pub struct ConfigSyncEnvelope {
    pub version: i64,
    pub config: Map<String, Value>,
    #[allow(dead_code)]
    pub updated_at: Option<String>,
    #[allow(dead_code)]
    pub updated_from_device_id: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ConfigSyncIn {
    pub config: Map<String, Value>,
    pub from_device_id: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ConflictPayload {
    pub local: Map<String, Value>,
    pub cloud: Map<String, Value>,
    pub cloud_version: i64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ConflictResolution {
    KeepLocal,
    UseCloud,
    Merge,
}

/// Internals shared by debounce + PUT coalescer. Held by the Account
/// behind an `Arc<Mutex<_>>`.
#[derive(Default)]
pub struct SyncState {
    /// Last server version. Persisted to disk so a same-device PUT with
    /// no cloud-side changes doesn't always trip 412 after restart.
    pub last_known_version: i64,
    /// Last conflict snapshot we surfaced to the UI, kept here so the
    /// frontend's resolve callback can act on the same payload.
    pub pending_conflict: Option<ConflictPayload>,
    /// Suppresses the next debounce tick — set when WE just wrote settings
    /// from `apply_cloud_to_local`, so the resulting save doesn't
    /// immediately PUT back what we just GOT.
    pub suppress_next_change: bool,
    /// Generation counter — every "settings changed" call bumps this.
    /// The debounce task captures the value at scheduling time and only
    /// fires the PUT if the counter is unchanged when the sleep wakes.
    pub debounce_gen: u64,
    /// Set true while a PUT is in flight (or a debounce is sleeping); a
    /// fast second change while one is pending coalesces into the in-flight
    /// task instead of spawning a competitor.
    pub put_in_flight: bool,
    /// 上次从云端 GET 到的 ui_preferences 完整子 dict —— 缓存它的目的是
    /// 在 PUT 时把本端不认识的子 key（如 mac 端独有的 floating_theme /
    /// launcher_enabled 等）原样保留，避免「Win 改一个 hotkey_mode 就把
    /// Mac 的 floating_pill_enabled 擦掉」这种跨端互踩。
    /// 第一次拿不到（cloud 空 / GET 失败）时为 None，put 走纯本地。
    pub last_cloud_ui_preferences: Option<Map<String, Value>>,
}

#[derive(Clone)]
pub struct CloudConfigSync {
    inner: Arc<Mutex<SyncState>>,
    api: ApiClient,
    app: AppStateArc,
    handle: AppHandle,
}

impl CloudConfigSync {
    pub fn new(api: ApiClient, app: AppStateArc, handle: AppHandle) -> Self {
        let initial = load_version_disk();
        Self {
            inner: Arc::new(Mutex::new(SyncState {
                last_known_version: initial,
                ..Default::default()
            })),
            api,
            app,
            handle,
        }
    }

    /// Called once after a successful login. GET cloud, decide push/pull/skip.
    pub async fn bootstrap_reconcile(&self) {
        let cloud = match self
            .api
            .get::<ConfigSyncEnvelope>("/api/me/sync/config")
            .await
        {
            Ok(c) => c,
            Err(e) => {
                log::info!("CloudConfigSync.bootstrap_reconcile GET failed: {e}");
                self.report_sync_error("配置同步：拉取失败，下次改设置时会自动重试。", &e);
                return;
            }
        };
        // 缓存云端 ui_preferences —— 后续 PUT 用它兜底未知子 key（详见
        // last_cloud_ui_preferences 注释）。
        if let Some(ui) = cloud.config.get("ui_preferences").and_then(|v| v.as_object()) {
            self.inner.lock().await.last_cloud_ui_preferences = Some(ui.clone());
        }
        let cloud_ui = self.inner.lock().await.last_cloud_ui_preferences.clone();
        let local = snapshot_from_config_with_overlay(&self.app.config.read(), cloud_ui.as_ref());

        let last_known = self.inner.lock().await.last_known_version;

        if cloud.version == 0 {
            log::info!("CloudConfigSync: cloud empty, pushing initial local");
            self.put(local, 0).await;
            return;
        }

        if cloud.version == last_known && configs_equal(&local, &cloud.config) {
            return;
        }

        if configs_equal(&local, &cloud.config) {
            self.set_last_known(cloud.version).await;
            return;
        }

        // Real divergence — surface to UI.
        let payload = ConflictPayload {
            local,
            cloud: cloud.config,
            cloud_version: cloud.version,
        };
        {
            let mut g = self.inner.lock().await;
            g.pending_conflict = Some(payload.clone());
        }
        if let Err(e) = self.handle.emit("cloud-config-conflict", &payload) {
            log::warn!("emit cloud-config-conflict failed: {e}");
        }
    }

    /// Called by the settings-save Tauri command after every successful
    /// `cmd_save_config`. Schedules a debounced PUT 3s out.
    pub fn schedule_put(self: &Arc<Self>) {
        let me = self.clone();
        tauri::async_runtime::spawn(async move {
            let gen = {
                let mut g = me.inner.lock().await;
                if g.suppress_next_change {
                    g.suppress_next_change = false;
                    return;
                }
                g.debounce_gen = g.debounce_gen.wrapping_add(1);
                g.debounce_gen
            };
            tokio::time::sleep(Duration::from_secs(3)).await;
            // Was the debounce superseded?
            let cur = me.inner.lock().await.debounce_gen;
            if cur != gen {
                return;
            }
            me.kick_off_put().await;
        });
    }

    /// Fired by debounce. Coalesces with any already-in-flight PUT.
    async fn kick_off_put(self: &Arc<Self>) {
        // If something's in flight, the trailing change is captured by
        // the next debounce tick — just bail.
        {
            let mut g = self.inner.lock().await;
            if g.put_in_flight {
                return;
            }
            g.put_in_flight = true;
        }
        let cloud_ui = self.inner.lock().await.last_cloud_ui_preferences.clone();
        let local = snapshot_from_config_with_overlay(&self.app.config.read(), cloud_ui.as_ref());
        let base = self.inner.lock().await.last_known_version;
        self.put(local, base).await;
        let mut g = self.inner.lock().await;
        g.put_in_flight = false;
    }

    /// PUT with `If-Match`. On 412 → trigger reconcile (which surfaces a
    /// fresh conflict). On 413 (oversize) → log + drop. Other errors →
    /// log + UI notice; next change will retry.
    async fn put(&self, local: Map<String, Value>, base_version: i64) {
        let body = ConfigSyncIn {
            config: local,
            from_device_id: None,
        };
        let res: Result<ConfigSyncEnvelope, ApiError> = self
            .api
            .put(
                "/api/me/sync/config",
                &body,
                &[("If-Match", base_version.to_string())],
            )
            .await;
        match res {
            Ok(env) => self.set_last_known(env.version).await,
            Err(e) => {
                if e.status() == Some(412) || e.code() == Some("version_mismatch") {
                    log::info!("CloudConfigSync.put 412 — reconciling");
                    // Box::pin breaks the type-level recursive `Future<...>`
                    // — without it rustc complains about infinite size.
                    Box::pin(self.bootstrap_reconcile()).await;
                } else if e.status() == Some(413) {
                    log::warn!("CloudConfigSync.put: config exceeds 100KB — dropped");
                    self.report_sync_error(
                        "云端同步：配置超过 100KB（可能是词典过大），暂未同步。",
                        &e,
                    );
                } else {
                    log::info!("CloudConfigSync.put failed: {e}");
                    self.report_sync_error(
                        "云端同步暂时失败，下次改设置时会自动重试。",
                        &e,
                    );
                }
            }
        }
    }

    /// 发 PipelineEvent::Notice 让前端 toast 提示用户「同步出问题了」。
    /// 不复用 force-error banner —— 同步失败下一次改设置就会自动重试，
    /// 不必让用户手动操作。降级到 transient toast。
    fn report_sync_error(&self, msg: &str, e: &ApiError) {
        // 网络断（offline/timeout）噪音太多 —— 静默 log，避免每次设置改都
        // 弹 toast 烦死用户。只对真实业务/服务端错误（4xx 5xx）出 toast。
        if matches!(e, ApiError::Transport(_)) {
            return;
        }
        let _ = self
            .app
            .event_tx
            .send(crate::state::PipelineEvent::Notice {
                message: msg.to_string(),
            });
    }

    async fn force_put(&self, local: Map<String, Value>) {
        let body = ConfigSyncIn {
            config: local,
            from_device_id: None,
        };
        let res: Result<ConfigSyncEnvelope, ApiError> = self
            .api
            .post("/api/me/sync/config/force", &body, true)
            .await;
        match res {
            Ok(env) => {
                log::info!("CloudConfigSync.force_put: cloud overwritten v{}", env.version);
                self.set_last_known(env.version).await;
            }
            Err(e) => log::info!("CloudConfigSync.force_put failed: {e}"),
        }
    }

    /// UI calls this with the user's choice from the conflict dialog.
    pub async fn resolve_conflict(&self, action: ConflictResolution) {
        let snap = match self.inner.lock().await.pending_conflict.clone() {
            Some(s) => s,
            None => {
                log::info!("resolve_conflict called with no pending snapshot");
                return;
            }
        };
        match action {
            ConflictResolution::KeepLocal => {
                let cloud_ui = snap.cloud.get("ui_preferences").and_then(|v| v.as_object()).cloned();
                let local = snapshot_from_config_with_overlay(&self.app.config.read(), cloud_ui.as_ref());
                self.force_put(local).await;
            }
            ConflictResolution::UseCloud => {
                self.apply_cloud_to_local(&snap.cloud).await;
                self.set_last_known(snap.cloud_version).await;
            }
            ConflictResolution::Merge => {
                let merged = merge_configs(&snap.local, &snap.cloud);
                self.apply_cloud_to_local(&merged).await;
                self.put(merged, snap.cloud_version).await;
            }
        }
        // Clear the snapshot — done.
        self.inner.lock().await.pending_conflict = None;
    }

    pub async fn stop(&self) {
        let mut g = self.inner.lock().await;
        g.last_known_version = 0;
        g.pending_conflict = None;
        g.suppress_next_change = false;
        // Wipe persisted version too — next login starts fresh.
        let _ = std::fs::remove_file(version_path());
    }

    async fn set_last_known(&self, v: i64) {
        self.inner.lock().await.last_known_version = v;
        save_version_disk(v);
    }

    /// Apply a cloud dict into `AppConfig` + persist. Sets
    /// `suppress_next_change` so the resulting save doesn't echo back.
    async fn apply_cloud_to_local(&self, cloud: &Map<String, Value>) {
        let mut new_cfg = self.app.config.read().clone();
        apply_cloud_to_config(cloud, &mut new_cfg);
        {
            let mut g = self.inner.lock().await;
            g.suppress_next_change = true;
        }
        if let Err(e) = self.app.replace_config(new_cfg) {
            log::warn!("apply_cloud_to_local: replace_config failed: {e}");
        }
    }
}

// --- snapshot / apply -------------------------------------------------

pub fn snapshot_from_config(cfg: &AppConfig) -> Map<String, Value> {
    snapshot_from_config_with_overlay(cfg, None)
}

/// PUT 时调这个 —— `cloud_ui` 是上次 GET 拿到的云端 ui_preferences 子 dict。
/// 我们把本端已知字段 OVERLAY 到 cloud_ui 上：本端写过的 key 用本端值（覆盖
/// 云端旧值），其他 key（mac 端独有的 floating_pill_enabled / launcher_enabled
/// 等）保留不动。这样 Win PUT 不会把 Mac 的 ui 设置擦掉，反之亦然。
/// `cloud_ui = None` 时（首次同步 / 云端空）走纯本地，行为跟旧代码一致。
pub fn snapshot_from_config_with_overlay(
    cfg: &AppConfig,
    cloud_ui: Option<&Map<String, Value>>,
) -> Map<String, Value> {
    let mut m = Map::new();
    m.insert("version_schema".into(), json!(SCHEMA_VERSION));
    m.insert("dictionaries".into(), json!(cfg.dictionary));
    m.insert("default_engine".into(), json!(cfg.engine));
    m.insert("default_language".into(), json!(cfg.language));
    m.insert("default_stylist".into(), json!(cfg.stylist_persona));
    // 本端已知的所有 ui_preferences 子 key 列表 —— 必须显式列全，否则
    // overlay 时会把这一端「最近本地清空」的字段误判成「未知字段」保留
    // 云端旧值。新增一个 ui 字段时这里也要加一行。
    let local_ui_keys: &[(&str, Value)] = &[
        ("auto_insert",               json!(cfg.auto_insert)),
        ("also_copy",                 json!(cfg.also_copy)),
        ("hotkey_vk",                 json!(cfg.hotkey_vk)),
        ("min_hold_ms",               json!(cfg.min_hold_ms)),
        ("stylist_enabled",           json!(cfg.stylist_enabled)),
        ("stylist_model",             json!(cfg.stylist_model)),
        ("hotkey_mode",               json!(cfg.hotkey_mode)),
        ("hybrid_press_threshold_ms", json!(cfg.hybrid_press_threshold_ms)),
        ("sound_feedback_enabled",    json!(cfg.sound_feedback_enabled)),
        ("sound_feedback_volume",     json!(cfg.sound_feedback_volume)),
        ("history_retention_days",    json!(cfg.history_retention_days)),
        ("history_cleanup_enabled",   json!(cfg.history_cleanup_enabled)),
    ];
    let mut ui_map: Map<String, Value> = match cloud_ui {
        Some(cu) => cu.clone(), // 保留云端所有字段（含 mac 独有的）
        None => Map::new(),
    };
    for (k, v) in local_ui_keys {
        ui_map.insert((*k).to_string(), v.clone());
    }
    m.insert("ui_preferences".into(), Value::Object(ui_map));
    // Drop any keys not on the server whitelist (defensive — none right
    // now, but cheap insurance against future drift).
    let allow = allowed_keys();
    m.retain(|k, _| allow.contains(k.as_str()));
    m
}

pub fn apply_cloud_to_config(cloud: &Map<String, Value>, cfg: &mut AppConfig) {
    if let Some(arr) = cloud.get("dictionaries").and_then(|v| v.as_array()) {
        cfg.dictionary = arr
            .iter()
            .filter_map(|v| v.as_str().map(|s| s.to_string()))
            .collect();
    }
    if let Some(s) = cloud.get("default_engine").and_then(|v| v.as_str()) {
        cfg.engine = s.to_string();
    }
    if let Some(s) = cloud.get("default_language").and_then(|v| v.as_str()) {
        cfg.language = s.to_string();
    }
    if let Some(s) = cloud.get("default_stylist").and_then(|v| v.as_str()) {
        cfg.stylist_persona = s.to_string();
    }
    if let Some(ui) = cloud.get("ui_preferences").and_then(|v| v.as_object()) {
        if let Some(b) = ui.get("auto_insert").and_then(|v| v.as_bool()) {
            cfg.auto_insert = b;
        }
        if let Some(b) = ui.get("also_copy").and_then(|v| v.as_bool()) {
            cfg.also_copy = b;
        }
        if let Some(n) = ui.get("hotkey_vk").and_then(|v| v.as_u64()) {
            cfg.hotkey_vk = n as u32;
        }
        if let Some(n) = ui.get("min_hold_ms").and_then(|v| v.as_u64()) {
            cfg.min_hold_ms = n as u32;
        }
        if let Some(b) = ui.get("stylist_enabled").and_then(|v| v.as_bool()) {
            cfg.stylist_enabled = b;
        }
        if let Some(s) = ui.get("stylist_model").and_then(|v| v.as_str()) {
            cfg.stylist_model = s.to_string();
        }
        // ↓ v0.6 新增字段，老条目可能没有 → 维持本地默认。
        if let Some(s) = ui.get("hotkey_mode").and_then(|v| v.as_str()) {
            // 防御：只接受三个已知值，未知值 fallback push_to_talk
            cfg.hotkey_mode = match s {
                "toggle" | "hybrid" | "push_to_talk" => s.to_string(),
                _ => "push_to_talk".to_string(),
            };
        }
        if let Some(n) = ui.get("hybrid_press_threshold_ms").and_then(|v| v.as_u64()) {
            cfg.hybrid_press_threshold_ms = n as u32;
        }
        if let Some(b) = ui.get("sound_feedback_enabled").and_then(|v| v.as_bool()) {
            cfg.sound_feedback_enabled = b;
        }
        if let Some(f) = ui.get("sound_feedback_volume").and_then(|v| v.as_f64()) {
            cfg.sound_feedback_volume = f.clamp(0.0, 1.0) as f32;
        }
        if let Some(n) = ui.get("history_retention_days").and_then(|v| v.as_u64()) {
            cfg.history_retention_days = n as u32;
        }
        if let Some(b) = ui.get("history_cleanup_enabled").and_then(|v| v.as_bool()) {
            cfg.history_cleanup_enabled = b;
        }
    }
}

// --- merge + equality -------------------------------------------------

pub fn merge_configs(
    local: &Map<String, Value>,
    cloud: &Map<String, Value>,
) -> Map<String, Value> {
    let mut out = cloud.clone();
    // Dictionaries: union (cloud first, then unseen local appended).
    let cloud_dict: Vec<String> = cloud
        .get("dictionaries")
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();
    let local_dict: Vec<String> = local
        .get("dictionaries")
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();
    let mut seen: HashSet<&str> = cloud_dict.iter().map(|s| s.as_str()).collect();
    let mut merged = cloud_dict.clone();
    for w in &local_dict {
        if !seen.contains(w.as_str()) {
            merged.push(w.clone());
            seen.insert(w.as_str());
        }
    }
    out.insert("dictionaries".into(), json!(merged));
    out
}

fn configs_equal(a: &Map<String, Value>, b: &Map<String, Value>) -> bool {
    // Encode with sorted keys for canonical comparison. serde_json's
    // Map preserves insertion order, but on round-trip from server the
    // ordering may differ — canonical bytes are the safe play.
    fn canon(m: &Map<String, Value>) -> Vec<u8> {
        // Sort keys at top level + nested objects.
        fn sort_value(v: &Value) -> Value {
            match v {
                Value::Object(m) => {
                    let mut keys: Vec<&String> = m.keys().collect();
                    keys.sort();
                    let mut sorted = Map::new();
                    for k in keys {
                        sorted.insert(k.clone(), sort_value(&m[k]));
                    }
                    Value::Object(sorted)
                }
                Value::Array(a) => Value::Array(a.iter().map(sort_value).collect()),
                _ => v.clone(),
            }
        }
        serde_json::to_vec(&sort_value(&Value::Object(m.clone()))).unwrap_or_default()
    }
    canon(a) == canon(b)
}

// --- version persistence ---------------------------------------------

fn version_path() -> PathBuf {
    let mut p = dirs::config_dir().unwrap_or_else(|| PathBuf::from("."));
    p.push("TiTiTalk");
    let _ = std::fs::create_dir_all(&p);
    p.push("cloud_version.txt");
    p
}

fn load_version_disk() -> i64 {
    std::fs::read_to_string(version_path())
        .ok()
        .and_then(|s| s.trim().parse::<i64>().ok())
        .unwrap_or(0)
}

fn save_version_disk(v: i64) {
    let _ = std::fs::write(version_path(), v.to_string());
}
