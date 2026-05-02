use std::sync::Arc;

use parking_lot::RwLock;
use serde::Serialize;
use tokio::sync::mpsc::UnboundedSender;

use crate::account::Account;
use crate::audio::CapturedAudio;
use crate::config::{load_config, save_config, AppConfig};

/// Where in the record→ASR→(polish→)insert pipeline we currently are.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PipelinePhase {
    Idle,
    Recording,
    Stopping,
    Transcribing,
    Polishing,
    Inserting,
    Done,
    Failed,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PipelineEvent {
    Phase { phase: PipelinePhase },
    Level { rms: f32 },
    Transcript { text: String },
    Error { message: String },
    /// Soft notice — UI shows as a transient toast, not a red error banner.
    /// Used for "stylist 失败已用原文" / "未登录请先登录" — situations where
    /// the pipeline degraded gracefully but the user should know.
    Notice { message: String },
    /// 触发前端播音效（HTML5 Audio）。后端不直接出声 —— webview 可控音量、
    /// 跨格式、零新增 native 依赖。sound: "start" / "stop"。受 config
    /// `sound_feedback_enabled/volume` 调制；后端不判断开关，前端按 cfg 拦。
    /// （字段名不能叫 `kind` —— 跟 `#[serde(tag = "kind")]` 撞名。）
    Sound { sound: String },
}

/// Mutable global app state. Cheap to clone (`Arc`).
pub struct AppState {
    pub config: RwLock<AppConfig>,
    pub event_tx: UnboundedSender<PipelineEvent>,
    pub current_audio: RwLock<Option<CapturedAudio>>,
    pub phase: RwLock<PipelinePhase>,
    /// Set in `lib.rs::setup` once the Tauri AppHandle is available.
    /// `None` until then (and in headless tests).
    pub account: RwLock<Option<Account>>,
}

impl AppState {
    pub fn new(event_tx: UnboundedSender<PipelineEvent>) -> Self {
        Self {
            config: RwLock::new(load_config()),
            event_tx,
            current_audio: RwLock::new(None),
            phase: RwLock::new(PipelinePhase::Idle),
            account: RwLock::new(None),
        }
    }

    pub fn replace_config(self: &Arc<Self>, new_config: AppConfig) -> anyhow::Result<()> {
        save_config(&new_config)?;
        *self.config.write() = new_config;
        Ok(())
    }

    pub fn emit(&self, ev: PipelineEvent) {
        let _ = self.event_tx.send(ev);
    }

    pub fn set_phase(&self, phase: PipelinePhase) {
        *self.phase.write() = phase;
        self.emit(PipelineEvent::Phase { phase });
    }

    pub fn current_phase(&self) -> PipelinePhase {
        *self.phase.read()
    }

    /// Driven by Tauri commands or hotkey thread to request a transition.
    /// Actual pipeline orchestration lives in `audio::orchestrate`.
    pub fn request_phase(self: &Arc<Self>, phase: PipelinePhase) {
        match (self.current_phase(), phase) {
            (PipelinePhase::Idle, PipelinePhase::Recording)
            | (PipelinePhase::Done, PipelinePhase::Recording)
            | (PipelinePhase::Failed, PipelinePhase::Recording) => {
                // Hotkey-friendly gate: if the user hasn't signed in yet
                // (cold-start race: hook thread is armed before
                // `account.bootstrap()` resolves, OR user genuinely never
                // logged in but found the hotkey), don't pretend to record.
                // Show a toast and bail. Direct UI button presses get the
                // same treatment for free.
                if !self.account_ready_for_record() {
                    // bootstrap 进行中（refresh token → 拿 access）vs 真未登录
                    // 是不同体验：前者用户已经登过、稍等几秒就好；后者要求
                    // 用户去主窗口登录。
                    // 用户报障（v0.7.2 hotfix）: 「需要登录」HomeView 已经有 needsLogin Banner，
                    // 再 toast Notice 重复。改成：未登录 → 只把主窗口拉前（Banner 在那等他）；
                    // 恢复中 → 保留 Notice（转瞬即逝，无 Banner 替代）。
                    let in_flight = self
                        .account
                        .read()
                        .clone()
                        .map(|a| a.snapshot().bootstrap_in_flight)
                        .unwrap_or(false);
                    if in_flight {
                        self.emit(PipelineEvent::Notice {
                            message: "正在恢复登录状态…请稍候 1-2 秒再试。".to_string(),
                        });
                    } else {
                        // 拉主窗口给 Banner 一个被看见的机会，不再叠 toast
                        self.surface_main_window();
                    }
                    return;
                }
                // (B3) 配额预检：tititalk_cloud 引擎 + 已知 quota 且 remaining=0
                // → 不让录。otherwise 用户按住录 5 秒，松手才看到「额度用完」。
                // 用 Error 走 lastError Banner（同时触发 UpgradeBanner detect），不用 Notice。
                let cfg_engine = self.config.read().engine.clone();
                if cfg_engine == "tititalk_cloud" {
                    if let Some(reason) = self.cloud_quota_block_reason() {
                        self.emit(PipelineEvent::Error { message: reason });
                        return;
                    }
                }
                let s = self.clone();
                tauri::async_runtime::spawn(async move {
                    crate::audio::orchestrate_start(s).await;
                });
            }
            (PipelinePhase::Recording, PipelinePhase::Stopping) => {
                let s = self.clone();
                tauri::async_runtime::spawn(async move {
                    crate::audio::orchestrate_stop(s).await;
                });
            }
            _ => {
                log::debug!(
                    "phase request ignored: {:?} → {:?}",
                    self.current_phase(),
                    phase
                );
            }
        }
    }

    /// True iff Account is wired AND the user is currently authenticated
    /// (not in `.unauthenticated` / `.authenticating` / `.error`). Allows
    /// hotkey + force-record commands to fail fast with a friendly notice
    /// instead of triggering a doomed pipeline run.
    fn account_ready_for_record(&self) -> bool {
        let acc = self.account.read().clone();
        let Some(acc) = acc else { return false };
        let snap = acc.snapshot();
        matches!(snap.state, crate::account::auth::AuthState::Authenticated { .. })
    }

    /// 检查 tititalk_cloud 配额是否够录一段：
    ///   • license 显示已过期（pro 套餐 expired）→ 拒
    ///   • free 用户 quota.remaining_tokens == Some(0) → 拒
    /// 其他情况（quota=None / 未拉到 / pro_lifetime 等）→ 放行，让 ASR
    /// 自己 429 回来再说。这里只挡「我们 100% 知道一定会失败」的情况。
    /// 返回 None = 放行；Some(msg) = 拒绝并给用户看的人话。
    fn cloud_quota_block_reason(&self) -> Option<String> {
        let acc = self.account.read().clone()?;
        let snap = acc.snapshot();
        let plan = snap
            .license
            .as_ref()
            .map(|l| l.plan.clone())
            .or_else(|| match &snap.state {
                crate::account::auth::AuthState::Authenticated { user } => Some(user.plan.clone()),
                _ => None,
            })
            .unwrap_or_default();
        // pro_lifetime / pro_flagship 用户 quota 也有上限（旗舰 6h/天），
        // 但拿不到 quota 就放行；只在显式 0 时挡。
        if let Some(q) = snap.quota.as_ref() {
            if let Some(rem) = q.remaining_tokens {
                if rem <= 0 {
                    let when = friendly_reset_time(&q.reset_at);
                    return Some(if plan == "free" {
                        format!(
                            "今日免费额度已用完。{}\n或在「设置 → 账号」升级 Pro / 解锁 BYOK 直连。",
                            when
                        )
                    } else {
                        format!("今日额度已用完。{}", when)
                    });
                }
            } else if let Some(rem_cents) = q.remaining_cents {
                // legacy cents 路径
                if rem_cents <= 0 {
                    let when = friendly_reset_time(&q.reset_at);
                    return Some(format!("今日额度已用完。{}", when));
                }
            }
        }
        None
    }

    /// Pull the main window to the front + focus + unminimize. State 本身
    /// 不持 AppHandle —— 借 account 已有的那一份。Account 在 lib.rs::setup
    /// 里就 install 了，hotkey 此时永远能拿到（cold-start race 的路径
    /// 在 account_ready_for_record 已被挡掉）。
    /// Best-effort：失败只 log，绝不 panic（hotkey 调用路径，崩溃即灾难）。
    fn surface_main_window(&self) {
        let acc = self.account.read().clone();
        let Some(acc) = acc else {
            log::debug!("surface_main_window: account not ready yet");
            return;
        };
        let handle = acc.app_handle().clone();
        // tauri 的 webview 操作要在 UI 线程上 —— spawn 到 async 运行时即可，
        // 不要在 hook 回调线程同步调（容易死锁）。
        // 走 tray::ensure_main_visible 兜底「窗口卡在拔掉的外接屏」场景。
        tauri::async_runtime::spawn(async move {
            crate::tray::ensure_main_visible(&handle);
        });
    }
}

/// 把 reset_at（ISO8601 UTC）翻成「今晚 00:00 重置 / 明天 00:30 重置」。
/// 解析失败 fallback 到「次日 0 点重置」。给 quota-exhausted toast 用。
fn friendly_reset_time(reset_at: &str) -> String {
    use chrono::{DateTime, Local, Utc};
    let parsed: Option<DateTime<Utc>> = DateTime::parse_from_rfc3339(reset_at)
        .ok()
        .map(|dt| dt.with_timezone(&Utc));
    let Some(reset_utc) = parsed else {
        return "次日 0 点重置".to_string();
    };
    let local = reset_utc.with_timezone(&Local);
    let now = Local::now();
    let same_day = local.date_naive() == now.date_naive();
    let prefix = if same_day { "今天" } else { "明天" };
    format!("{}{} 重置", prefix, local.format("%H:%M"))
}
