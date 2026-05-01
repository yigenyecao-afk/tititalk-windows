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
                return;
            }
        };
        let local = snapshot_from_config(&self.app.config.read());

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
        let local = snapshot_from_config(&self.app.config.read());
        let base = self.inner.lock().await.last_known_version;
        self.put(local, base).await;
        let mut g = self.inner.lock().await;
        g.put_in_flight = false;
    }

    /// PUT with `If-Match`. On 412 → trigger reconcile (which surfaces a
    /// fresh conflict). On 413 (oversize) → log + drop. Other errors →
    /// log; next change will retry.
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
                } else {
                    log::info!("CloudConfigSync.put failed: {e}");
                }
            }
        }
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
                let local = snapshot_from_config(&self.app.config.read());
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
    let mut m = Map::new();
    m.insert("version_schema".into(), json!(SCHEMA_VERSION));
    m.insert("dictionaries".into(), json!(cfg.dictionary));
    m.insert("default_engine".into(), json!(cfg.engine));
    m.insert("default_language".into(), json!(cfg.language));
    m.insert("default_stylist".into(), json!(cfg.stylist_persona));
    let ui = json!({
        "auto_insert":      cfg.auto_insert,
        "also_copy":        cfg.also_copy,
        "hotkey_vk":        cfg.hotkey_vk,
        "min_hold_ms":      cfg.min_hold_ms,
        "stylist_enabled":  cfg.stylist_enabled,
        "stylist_model":    cfg.stylist_model,
    });
    m.insert("ui_preferences".into(), ui);
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
