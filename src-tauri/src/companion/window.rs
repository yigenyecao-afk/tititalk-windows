//! Companion 窗口控制器 + 行为机。Mac PetWindowController.swift 的 Win 等价。
//!
//! 一个 96×104 px 的 webview window（label="companion"），无边框、不抢焦点、
//! alwaysOnTop。前端渲染（CompanionApp/PetView）；后端推 mood/facing 状态 + 30fps
//! set_position。
//!
//! 行为机：
//!   • wandering    — 屏幕底部 30fps 推 X 位置；撞 visibleFrame 边缘 flip facing；
//!                    pill 显示中 / 用户拖动后暂停巡游。
//!   • stationary   — pill 显示时切到这个 mood 站定（前端按 phase 切 row）；
//!                    pill 隐藏 1.2s 后回 baseline（用户意图）。
//!   • wave (transient) — 单击宠物触发 700ms。
//!   • jump (transient) — 留接口；当前不自发触发（同 Mac 决策——多余 transient
//!                        会跟主流程 mood 抢 reset_token）。
//!
//! 持久化：origin 落 `<config_dir>/TiTiTalk/companion-position.json`。
//!
//! 屏幕拓扑变更：当前 Tauri 没有 didChangeScreenParameters 事件等价，
//! 改成「set_position 前 clamp 到当前 monitor」防越界（被动防御 vs Mac 主动 clamp）。

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition};
use tokio::sync::OnceCell;

use crate::state::{AppState, PipelineEvent, PipelinePhase};

use super::catalog::{self, PetEntry};
use super::state::{CompanionSnapshot, CompanionState, Facing, Mood};

/// 单帧逻辑尺寸（CSS px）。Mac NSPanel 64×69；Win webview 留点 padding 防 alwaysOnTop
/// 边缘子像素抖（96×104 = 1.5×64）。前端 PetView 精确画 64×69 居中。
const PANEL_W: f64 = 96.0;
const PANEL_H: f64 = 104.0;

/// 巡游速度 px/s（同 Mac 36，Mac NSPoint 是逻辑点 = Win logical px 等价）
const WANDER_SPEED: f64 = 36.0;
/// 30fps tick
const WANDER_TICK_HZ: f64 = 30.0;
/// 单击 wave 时长
const WAVE_MS: u64 = 700;
/// pill 隐藏后回 wandering 的延迟
const RESUME_WANDER_DELAY_MS: u64 = 1200;

/// 单例 —— ensure 只跑一次（多次 setup 调或 hot-reload 时复用同一份 state）。
static COMPANION_STATE: OnceCell<Arc<CompanionState>> = OnceCell::const_new();

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct PersistedOrigin {
    x: i32,
    y: i32,
}

fn position_file() -> PathBuf {
    let mut p = dirs::config_dir().unwrap_or_else(|| PathBuf::from("."));
    p.push("TiTiTalk");
    let _ = std::fs::create_dir_all(&p);
    p.push("companion-position.json");
    p
}

fn load_origin() -> Option<PersistedOrigin> {
    let raw = std::fs::read_to_string(position_file()).ok()?;
    serde_json::from_str(&raw).ok()
}

fn save_origin(o: PersistedOrigin) {
    if let Ok(s) = serde_json::to_string(&o) {
        let _ = std::fs::write(position_file(), s);
    }
}

/// app setup 阶段调一次：注 CompanionState、按 cfg 决定是否 show window、
/// 起 30fps wander tick。
pub async fn ensure(handle: &AppHandle, app_state: &Arc<AppState>) {
    let companion = CompanionState::new();
    // OnceCell::set 失败说明已经 init 过；幂等不报错
    let _ = COMPANION_STATE.set(companion.clone());

    let enabled = app_state.config.read().companion_enabled;
    if enabled {
        if let Err(e) = show_window(handle).await {
            log::warn!("companion: show_window failed: {e}");
        }
    } else {
        // visible:false in tauri.conf.json 默认即隐藏；保险起见也尝试 hide
        if let Some(w) = handle.get_webview_window("companion") {
            let _ = w.hide();
        }
    }

    // 30fps wander tick——永远跑（mood != Wandering 时早 return），
    // 避免 toggle 时反复 spawn task 互相 race。
    spawn_wander_tick(handle.clone(), app_state.clone(), companion.clone());

    // 推一次初始 snapshot 给前端（前端可能挂载早于 ensure 调用）
    emit_state(handle, &companion);
}

async fn show_window(handle: &AppHandle) -> tauri::Result<()> {
    // companion window 由 tauri.conf.json 在启动时创建（visible:false）。
    // 如果 conf 漏配 → 直接 bail；不在 runtime 走 WebviewWindowBuilder
    // 路径（transparent 在 macOS 没 macos-private-api feature 时编译失败，
    // 反正生产 conf 永远存在 companion 条目）。
    let Some(win) = handle.get_webview_window("companion") else {
        log::warn!("companion: window 'companion' not found in tauri.conf.json — skip show");
        return Ok(());
    };

    // 决定初始位置——优先 saved，没有则默认右下角
    let origin = load_origin().unwrap_or_else(|| default_origin(&win));
    let clamped = clamp_to_visible_screen(&win, origin);
    let _ = win.set_position(PhysicalPosition::new(clamped.x, clamped.y));

    let _ = win.set_size(LogicalSize::new(PANEL_W, PANEL_H));
    let _ = win.show();
    Ok(())
}

fn default_origin(win: &tauri::WebviewWindow) -> PersistedOrigin {
    let Ok(Some(monitor)) = win.current_monitor() else {
        return PersistedOrigin { x: 0, y: 0 };
    };
    let pos = monitor.position();
    let size = monitor.size();
    let scale = monitor.scale_factor();
    let panel_w_px = (PANEL_W * scale) as i32;
    let panel_h_px = (PANEL_H * scale) as i32;
    PersistedOrigin {
        x: pos.x + size.width as i32 - panel_w_px - (24.0 * scale) as i32,
        y: pos.y + size.height as i32 - panel_h_px - (96.0 * scale) as i32,
    }
}

/// 把 origin clamp 到「当前包含它的 monitor 的 work area」内。
/// Tauri 没暴露 visibleFrame（去掉 taskbar）—— 直接 clamp 到 monitor.size 满足
/// 95% 场景（任务栏底 40px 高，宠物本身 104px，被任务栏盖住一半也 OK）。
fn clamp_to_visible_screen(win: &tauri::WebviewWindow, origin: PersistedOrigin) -> PersistedOrigin {
    let Ok(monitors) = win.available_monitors() else {
        return origin;
    };
    if monitors.is_empty() {
        return origin;
    }
    // 找包含 origin 的 monitor；不在任何 monitor 内 → 退到 primary
    let target = monitors
        .iter()
        .find(|m| {
            let mp = m.position();
            let ms = m.size();
            origin.x >= mp.x
                && origin.x < mp.x + ms.width as i32
                && origin.y >= mp.y
                && origin.y < mp.y + ms.height as i32
        })
        .or_else(|| monitors.first());
    let Some(m) = target else { return origin };
    let pos = m.position();
    let size = m.size();
    let scale = m.scale_factor();
    let panel_w_px = (PANEL_W * scale) as i32;
    let panel_h_px = (PANEL_H * scale) as i32;
    let min_x = pos.x;
    let max_x = pos.x + size.width as i32 - panel_w_px;
    let min_y = pos.y;
    let max_y = pos.y + size.height as i32 - panel_h_px;
    PersistedOrigin {
        x: origin.x.clamp(min_x, max_x.max(min_x)),
        y: origin.y.clamp(min_y, max_y.max(min_y)),
    }
}

/// 30fps wander tick——永远跑，mood != Wandering 时立即 return；
/// wandering 时按 facing 推 X，撞边 flip。
fn spawn_wander_tick(handle: AppHandle, app_state: Arc<AppState>, companion: Arc<CompanionState>) {
    let dt = 1.0 / WANDER_TICK_HZ;
    let interval_ms = (1000.0 / WANDER_TICK_HZ) as u64;
    tauri::async_runtime::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_millis(interval_ms));
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            tick.tick().await;

            // companion 关闭即 sleep（避免空转浪费 CPU）
            let enabled = app_state.config.read().companion_enabled;
            if !enabled {
                tokio::time::sleep(Duration::from_millis(500)).await;
                continue;
            }

            if companion.mood() != Mood::Wandering {
                continue;
            }

            let Some(win) = handle.get_webview_window("companion") else {
                continue;
            };

            // 取当前 physical position + monitor
            let Ok(cur) = win.outer_position() else { continue };
            let Ok(Some(monitor)) = win.current_monitor() else { continue };
            let scale = monitor.scale_factor();
            let mp = monitor.position();
            let ms = monitor.size();
            let panel_w_px = (PANEL_W * scale) as i32;
            let dx_px = (WANDER_SPEED * dt * scale) as i32 * if companion.facing() == Facing::Right { 1 } else { -1 };

            let mut new_x = cur.x + dx_px;
            let mut new_y = cur.y;
            // Y 锁到底（默认 origin Y 已在底部 96px 处；wander 不爬上去）
            let bottom_y = mp.y + ms.height as i32 - (PANEL_H * scale) as i32 - (96.0 * scale) as i32;
            if (new_y - bottom_y).abs() > 2 {
                new_y = bottom_y;
            }

            let min_x = mp.x;
            let max_x = mp.x + ms.width as i32 - panel_w_px;
            if new_x <= min_x {
                new_x = min_x;
                if companion.facing() == Facing::Left {
                    companion.flip_facing();
                    emit_state(&handle, &companion);
                }
            } else if new_x >= max_x {
                new_x = max_x;
                if companion.facing() == Facing::Right {
                    companion.flip_facing();
                    emit_state(&handle, &companion);
                }
            }

            if new_x != cur.x || new_y != cur.y {
                let _ = win.set_position(PhysicalPosition::new(new_x, new_y));
            }
        }
    });
}

/// pipeline event hook —— pill 显示中切 stationary 让位；隐藏后 1.2s 回 baseline。
pub async fn on_pipeline_event(
    handle: &AppHandle,
    app_state: &Arc<AppState>,
    ev: &PipelineEvent,
) {
    if !app_state.config.read().companion_enabled {
        return;
    }
    let Some(companion) = COMPANION_STATE.get().cloned() else {
        return;
    };

    match ev {
        PipelineEvent::Phase { phase } => match phase {
            PipelinePhase::Recording
            | PipelinePhase::Transcribing
            | PipelinePhase::Polishing
            | PipelinePhase::Inserting => {
                companion.set(Mood::Stationary);
                emit_state(handle, &companion);
            }
            PipelinePhase::Done | PipelinePhase::Failed | PipelinePhase::Idle => {
                schedule_resume_wander(handle.clone(), companion.clone());
            }
            _ => {}
        },
        _ => {}
    }
}

fn schedule_resume_wander(handle: AppHandle, companion: Arc<CompanionState>) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(RESUME_WANDER_DELAY_MS)).await;
        // 同 Mac scheduleResumeWander —— 1.2s 后如果 pipeline 已回 idle/done，
        // 切到用户意图（wandering / stationary）。
        // 这里没法直接拿 phase；改成「如果 mood 仍是 stationary 且没新 phase event
        // 把它推到 recording」就当作可以恢复——多次 spawn race 是顺序串行无害。
        if companion.mood() == Mood::Stationary {
            let want = if *companion.user_wants_wandering.read() {
                Mood::Wandering
            } else {
                Mood::Stationary
            };
            companion.set(want);
            emit_state(&handle, &companion);
        }
    });
}

fn emit_state(handle: &AppHandle, companion: &Arc<CompanionState>) {
    let snap: CompanionSnapshot = companion.snapshot();
    let _ = handle.emit("companion-state", &snap);
}

// ---------- Tauri commands ----------

#[tauri::command]
pub fn cmd_companion_list_pets(handle: AppHandle) -> Vec<PetEntry> {
    catalog::discover(&handle)
}

/// 单击 pet → wave 700ms，回 baseline。
#[tauri::command]
pub fn cmd_companion_tap(handle: AppHandle, state: tauri::State<'_, Arc<AppState>>) {
    let Some(companion) = COMPANION_STATE.get().cloned() else {
        return;
    };
    let fallback = baseline_mood(&state, &companion);
    companion.trigger(Mood::Wave, Duration::from_millis(WAVE_MS), fallback);
    emit_state(&handle, &companion);
    // duration 后 trigger 内部会 set + 我们这边再补一次 emit_state 让前端同步
    let h2 = handle.clone();
    let c2 = companion.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(WAVE_MS + 30)).await;
        emit_state(&h2, &c2);
    });
}

/// 双击 pet → toggle 巡游意图；pill 隐藏时立即生效。
#[tauri::command]
pub fn cmd_companion_double_tap(handle: AppHandle, state: tauri::State<'_, Arc<AppState>>) {
    let Some(companion) = COMPANION_STATE.get().cloned() else {
        return;
    };
    {
        let mut want = companion.user_wants_wandering.write();
        *want = !*want;
    }
    let in_active_phase = !matches!(state.current_phase(), PipelinePhase::Idle);
    if !in_active_phase {
        let next = if *companion.user_wants_wandering.read() {
            Mood::Wandering
        } else {
            Mood::Stationary
        };
        companion.set(next);
    }
    emit_state(&handle, &companion);
}

/// 用户拖完一次 → 持久化新位置 + 暂停巡游 1.2s。
#[tauri::command]
pub fn cmd_companion_drag_end(handle: AppHandle) {
    let Some(win) = handle.get_webview_window("companion") else {
        return;
    };
    if let Ok(pos) = win.outer_position() {
        save_origin(PersistedOrigin { x: pos.x, y: pos.y });
    }
    let Some(companion) = COMPANION_STATE.get().cloned() else {
        return;
    };
    // 暂停巡游 1.2s（防拖完立即被 wander tick 推走）
    if companion.mood() == Mood::Wandering {
        companion.set(Mood::Stationary);
        emit_state(&handle, &companion);
        let h2 = handle.clone();
        let c2 = companion.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_millis(RESUME_WANDER_DELAY_MS)).await;
            if *c2.user_wants_wandering.read() && c2.mood() == Mood::Stationary {
                c2.set(Mood::Wandering);
                emit_state(&h2, &c2);
            }
        });
    }
}

/// 前端拖动期间持续推 LogicalPosition（前端 onMouseMove 计算 delta，调这个写回）。
#[tauri::command]
pub fn cmd_companion_save_position(
    handle: AppHandle,
    x: i32,
    y: i32,
) {
    let Some(win) = handle.get_webview_window("companion") else {
        return;
    };
    let pos = clamp_to_visible_screen(&win, PersistedOrigin { x, y });
    let _ = win.set_position(PhysicalPosition::new(pos.x, pos.y));
}

/// 当前 baseline mood —— 不在 transient 里时 mood 应该是哪个。
fn baseline_mood(state: &Arc<AppState>, companion: &Arc<CompanionState>) -> Mood {
    if !matches!(state.current_phase(), PipelinePhase::Idle) {
        return Mood::Stationary;
    }
    if *companion.user_wants_wandering.read() {
        Mood::Wandering
    } else {
        Mood::Stationary
    }
}

