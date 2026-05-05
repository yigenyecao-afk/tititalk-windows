//! (P1 hotkey→partial 加速 2026-05-05) Win 端 ASR WebSocket 空闲预连。
//!
//! 跟 Mac `Speech/TiTiTalkCloudASRPrewarmer.swift` 同源 — 都是为了把「按下
//! hotkey → pill 第一段 partial 文字出现」从冷启动 750-2700ms 砍到 200-400ms。
//!
//! 配套的服务端改动（asr.py）：
//!   1. MAX_IDLE_GRACE_SEC=60s — 第一帧 PCM 之前用 grace 检查，不会被 30s 4004 踢
//!   2. lazy dashscope.start — 第一帧 PCM 来才 init Recognition，prewarm 期间
//!      不占百炼 quota
//!
//! 客户端策略：
//!   • lib.rs setup → ensure_started + 监听 account login event 启动
//!   • prewarm 成功 → 50s 后主动 close + 重 prewarm（safety margin < 60s grace）
//!   • asr_stream.start_session_async → 优先 try_acquire 拿热 session
//!   • try_acquire 失败 silently 走原 start_session 冷路径
//!
//! 实现：单例 `Prewarmer` 跑「下一轮 prewarm task」chain：
//!   - 每个 task 跑 start_session 拿到 ready 的 StreamSession
//!   - 把 take_tx 注册到全局 take_slot
//!   - select! sleep(50s) / take_rx：
//!       50s 到 → drop ws + 重新 schedule 一轮
//!       take_rx 收到 → ws 转给 caller + 重新 schedule 下一轮
//!   - 失败 5s 后重试

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use once_cell::sync::OnceCell;
use tokio::sync::{Mutex, oneshot};

use crate::asr_stream::{start_session, StreamSession};
use crate::state::AppState;

/// 单例 prewarmer。lib.rs setup 阶段 ensure_started 一次。
static GLOBAL: OnceCell<Arc<Prewarmer>> = OnceCell::new();

/// safety margin < server GRACE_IDLE_SEC=60s
const REFRESH_INTERVAL_SEC: u64 = 50;
/// 启动后延迟 prewarm，让 UI 先稳定
const INITIAL_DELAY_SEC: u64 = 2;
/// prewarm 失败 / 被关后多久重试
const RETRY_DELAY_SEC: u64 = 5;
/// acquire 后立刻起下次 prewarm 的延迟
const POST_ACQUIRE_DELAY_MS: u64 = 500;

pub struct Prewarmer {
    state: Arc<AppState>,
    /// false 时跑完当前 task 自动停；ensure_started 后 set true
    enabled: AtomicBool,
    /// 当前 prewarm task 注册的 take_tx —— acquire() 从这里 take 拿走
    take_slot: Mutex<Option<oneshot::Sender<oneshot::Sender<StreamSession>>>>,
}

/// lib.rs setup 调一次，幂等。后续 account login event 来时再调 set_enabled(true)。
pub fn ensure_started(state: Arc<AppState>) {
    GLOBAL.get_or_init(|| {
        Arc::new(Prewarmer {
            state,
            enabled: AtomicBool::new(false),
            take_slot: Mutex::new(None),
        })
    });
}

/// 用户登录成功后调，开始 prewarm 循环。幂等。
pub fn enable() {
    let Some(p) = GLOBAL.get() else { return; };
    if p.enabled.swap(true, Ordering::SeqCst) {
        return;  // 已经 enabled 了
    }
    log::info!("ASR prewarmer enabled");
    let p = p.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(INITIAL_DELAY_SEC)).await;
        if p.enabled.load(Ordering::SeqCst) {
            p.run_one().await;
        }
    });
}

/// 用户登出 / app 退出时调。让 take_rx 收到 Err，task 内 ws 自动 drop。
pub fn disable() {
    let Some(p) = GLOBAL.get() else { return; };
    if !p.enabled.swap(false, Ordering::SeqCst) {
        return;
    }
    log::info!("ASR prewarmer disabled");
    let p = p.clone();
    tauri::async_runtime::spawn(async move {
        let _ = p.take_slot.lock().await.take();
    });
}

/// asr_stream.prepare_and_run 调：拿热 session。
/// 返回 None 时表示当前没 prewarm session（首次启动 / prewarm 失败 /
/// 已被消耗 / 没登录）—— caller 自己走 start_session 冷连路径。
pub async fn try_acquire(_state: &Arc<AppState>) -> Option<StreamSession> {
    let p = GLOBAL.get()?;
    if !p.enabled.load(Ordering::SeqCst) {
        return None;
    }
    // 拿走 take_tx
    let take_tx = {
        let mut slot = p.take_slot.lock().await;
        slot.take()?
    };
    // 建反向 channel：prewarm task 通过 response_tx 把 ws 资源转给 caller
    let (response_tx, response_rx) = oneshot::channel::<StreamSession>();
    if take_tx.send(response_tx).is_err() {
        // prewarm task 已经 timeout 退出（极端 race）
        return None;
    }
    response_rx.await.ok()
}

impl Prewarmer {
    /// 跑一轮 prewarm：prepare session → idle wait acquire / 50s timeout → 重 schedule。
    async fn run_one(self: Arc<Self>) {
        if !self.enabled.load(Ordering::SeqCst) {
            return;
        }
        // 没登录 → 30s 后重试（account.bootstrap 是 async，setup 阶段还没登录）。
        // 30s 轮询 + 服务端 60s grace = 用户登录后最迟 90s 可享 prewarm；多数用户
        // 开 app 后会先 idle 一分钟以上才录音，足够。
        if self.state.account.read().is_none() {
            log::debug!("ASR prewarm: not authenticated, retry in 30s");
            self.clone().schedule_after(Duration::from_secs(30));
            return;
        }

        let t0 = std::time::Instant::now();
        let session = match start_session(self.state.clone(), 16_000).await {
            Ok(s) => s,
            Err(e) => {
                log::debug!(
                    "ASR prewarm prepare failed ({}ms): {e}",
                    t0.elapsed().as_millis()
                );
                // 5s 后重试
                self.clone().schedule_after(Duration::from_secs(RETRY_DELAY_SEC));
                return;
            }
        };
        log::info!(
            "ASR prewarm session ready ({}ms cold cost saved next time)",
            t0.elapsed().as_millis()
        );

        // destructure 让 select! 不用持有 StreamSession（StreamSession 没 Sync 限制）
        let StreamSession { ws_sink, ws_stream, event_tx } = session;

        // 注册 take_tx 给 acquire 用
        let (take_tx, take_rx) = oneshot::channel::<oneshot::Sender<StreamSession>>();
        {
            let mut slot = self.take_slot.lock().await;
            *slot = Some(take_tx);
        }

        tokio::select! {
            _ = tokio::time::sleep(Duration::from_secs(REFRESH_INTERVAL_SEC)) => {
                // 50s 到点 —— 让位重 prewarm。take_slot 清掉 take_tx；
                // ws_sink/ws_stream 走出 scope 自动 drop → server 那边收到 close。
                log::debug!("ASR prewarm session 50s expired, refreshing");
                let _ = self.take_slot.lock().await.take();
                if self.enabled.load(Ordering::SeqCst) {
                    self.clone().schedule_after(Duration::from_millis(100));
                }
                // session 资源 drop 触发 ws close
                drop(ws_sink);
                drop(ws_stream);
                drop(event_tx);
            }
            response = take_rx => {
                match response {
                    Ok(response_tx) => {
                        let sess = StreamSession { ws_sink, ws_stream, event_tx };
                        if response_tx.send(sess).is_err() {
                            log::warn!("ASR prewarm: caller dropped response_rx, session lost");
                        } else {
                            log::info!("ASR prewarm session handed off to caller");
                        }
                        // 立刻 schedule 下一轮（短延迟让 caller 先 take ownership）
                        if self.enabled.load(Ordering::SeqCst) {
                            self.clone().schedule_after(Duration::from_millis(POST_ACQUIRE_DELAY_MS));
                        }
                    }
                    Err(_) => {
                        // take_tx 被 disable() 清掉了，正常退
                        log::debug!("ASR prewarm: disabled mid-session, dropping ws");
                        drop(ws_sink);
                        drop(ws_stream);
                        drop(event_tx);
                    }
                }
            }
        }
    }

    fn schedule_after(self: Arc<Self>, delay: Duration) {
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(delay).await;
            if self.enabled.load(Ordering::SeqCst) {
                self.run_one().await;
            }
        });
    }
}
