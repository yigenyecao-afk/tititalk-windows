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
use super::personality::Scene;
use super::speech::SpeechController;
use super::state::{CompanionSnapshot, CompanionState, Facing, Mood};

/// (v1.1 性格化陪伴) panel 尺寸 — Mac PetWindowController.panelSize 144×140 的
/// Win 等价。气泡区在上方 ~70px，sprite 64×69 居中下方。撞墙判断按 panel
/// 边缘（视觉上 sprite 离屏边 ~40px 转身——可接受 trade-off）。
const PANEL_W: f64 = 144.0;
const PANEL_H: f64 = 140.0;

/// (v1.1) 鼠标"看着" 半径阈值（逻辑像素）—— 鼠标进入半径内时切 facing 朝向鼠标。
const MOUSE_LOOK_RADIUS: f64 = 200.0;
/// (v1.1) 鼠标 watcher tick 间隔——节流到 100ms / ~10fps，CPU 几乎 0。
const MOUSE_WATCH_TICK_MS: u64 = 100;
/// (v1.1) 鼠标离开 1s 后回 baseline（防抖）
const MOUSE_AWAY_RESUME_MS: u64 = 1000;

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
/// (v1.1) 性格化文案 controller 单例。同 COMPANION_STATE 全局唯一。
static SPEECH_CTRL: OnceCell<Arc<SpeechController>> = OnceCell::const_new();

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

    // (v1.1 性格化陪伴) 创建 SpeechController + 启动 idle tick；
    // 多次 ensure 调用幂等（OnceCell::set 已 init 过会失败，复用旧实例）。
    let speech = SpeechController::new(handle.clone(), app_state.clone());
    let _ = SPEECH_CTRL.set(speech.clone());

    // (v1.1) 30fps 鼠标 watcher —— 鼠标进入 panel 200px 半径时 emit
    // companion-facing 给前端切朝向；离开 1s 后 emit companion-baseline。
    spawn_mouse_watcher(handle.clone(), app_state.clone(), companion.clone());

    // (v1.1) 5s 应用感知 watcher —— 前台 .exe 变化时通知 speech
    #[cfg(windows)]
    {
        let watcher = super::app_watcher::AppWatcher::new();
        watcher.start(speech.clone());
        // watcher 内部 spawn 自管，drop 即可
        std::mem::forget(watcher);
    }

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
        PipelineEvent::Phase { phase } => {
            match phase {
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
            }
            // (v1.1) speech 边沿处理：on_phase 内部跟 last_phase 比对，
            // recording/transcribing/polishing → done/idle 视作录音完成；
            // 任意 → failed 视作录音失败。
            if let Some(speech) = SPEECH_CTRL.get() {
                speech.on_phase(*phase);
            }
        }
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

/// 单击 pet → wave 700ms，回 baseline。25% 概率附带说一句。
#[tauri::command]
pub fn cmd_companion_tap(handle: AppHandle, state: tauri::State<'_, Arc<AppState>>) {
    let Some(companion) = COMPANION_STATE.get().cloned() else {
        return;
    };
    let fallback = baseline_mood(&state, &companion);
    companion.trigger(Mood::Wave, Duration::from_millis(WAVE_MS), fallback);
    emit_state(&handle, &companion);
    // (v1.1) 25% 概率冒泡（克制；scene 内部 30s 节流再过滤一次）
    if rand_unit() < 0.25 {
        if let Some(speech) = SPEECH_CTRL.get() {
            speech.notify(Scene::SingleTap);
        }
    }
    // duration 后 trigger 内部会 set + 我们这边再补一次 emit_state 让前端同步
    let h2 = handle.clone();
    let c2 = companion.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(WAVE_MS + 30)).await;
        emit_state(&h2, &c2);
    });
}

/// (v1.1) 长按 pet ≥0.5s → 抚摸；wave 1.5s + 70% 概率说"被摸了"。
#[tauri::command]
pub fn cmd_companion_long_press(handle: AppHandle, state: tauri::State<'_, Arc<AppState>>) {
    let Some(companion) = COMPANION_STATE.get().cloned() else {
        return;
    };
    let fallback = baseline_mood(&state, &companion);
    companion.trigger(Mood::Wave, Duration::from_millis(1500), fallback);
    emit_state(&handle, &companion);
    if rand_unit() < 0.70 {
        if let Some(speech) = SPEECH_CTRL.get() {
            speech.notify(Scene::Petting);
        }
    }
    let h2 = handle.clone();
    let c2 = companion.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(1500 + 30)).await;
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
    // (v1.1) 40% 概率冒泡
    if rand_unit() < 0.40 {
        if let Some(speech) = SPEECH_CTRL.get() {
            speech.notify(Scene::DoubleTap);
        }
    }
}

/// 用户拖完一次 → 持久化新位置 + 暂停巡游 1.2s。25% 概率说一句。
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
    // (v1.1) 25% 概率冒泡（拖动是高频小动作，不要每次都吐槽）
    if rand_unit() < 0.25 {
        if let Some(speech) = SPEECH_CTRL.get() {
            speech.notify(Scene::DragEnd);
        }
    }
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

/// (v1.1) 偷懒 0..1 浮点：基于 SystemTime nanos SplitMix64 一步。零依赖、
/// 质量足够 25%/40%/70% 概率分支用。speech.rs 内有同款副本（不互相依赖）。
fn rand_unit() -> f64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.subsec_nanos() as u64 ^ d.as_secs())
        .unwrap_or(0);
    let mut z = nanos.wrapping_add(0x9E37_79B9_7F4A_7C15);
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    z = z ^ (z >> 31);
    (z >> 11) as f64 / ((1u64 << 53) as f64)
}

// ---------- (v1.1) 鼠标 watcher ----------
//
// 30fps（实际 100ms / 10fps 节流）跨进程拿光标位置，跟 panel 中心算距离：
//   ≤200px → 切 stationary 站定看着 + emit `companion-facing` { dir }
//   >200px → 1s 后 emit `companion-baseline`（防抖）
// 用 windows::Win32::UI::WindowsAndMessaging::GetCursorPos —— 不需要权限提升。

#[cfg(windows)]
fn spawn_mouse_watcher(
    handle: AppHandle,
    app_state: Arc<AppState>,
    companion: Arc<CompanionState>,
) {
    use std::sync::atomic::{AtomicBool, Ordering};
    let was_in_radius = Arc::new(AtomicBool::new(false));
    let scheduled_baseline = Arc::new(AtomicBool::new(false));
    tauri::async_runtime::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_millis(MOUSE_WATCH_TICK_MS));
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            tick.tick().await;
            // companion 关闭即 sleep 一会儿避免空转
            if !app_state.config.read().companion_enabled {
                tokio::time::sleep(Duration::from_millis(500)).await;
                continue;
            }
            let mood = companion.mood();
            if !matches!(mood, Mood::Wandering | Mood::Stationary) {
                continue;
            }
            // pill 显示中不抢——让 ASR 状态优先
            if !matches!(app_state.current_phase(), PipelinePhase::Idle) {
                continue;
            }
            let Some(win) = handle.get_webview_window("companion") else {
                continue;
            };
            let Ok(cur_pos) = win.outer_position() else {
                continue;
            };
            let Ok(Some(monitor)) = win.current_monitor() else {
                continue;
            };
            let scale = monitor.scale_factor();
            let panel_w_px = (PANEL_W * scale) as i32;
            let panel_h_px = (PANEL_H * scale) as i32;
            // sprite 中心约 panel 下半 30% 处（跟 Mac processMouse 同）
            let sprite_cx = cur_pos.x + panel_w_px / 2;
            let sprite_cy = cur_pos.y + (panel_h_px as f64 * 0.7) as i32;

            let Some((cx, cy)) = current_cursor_pos() else {
                continue;
            };
            let dx = (cx - sprite_cx) as f64;
            let dy = (cy - sprite_cy) as f64;
            let dist_px = (dx * dx + dy * dy).sqrt();
            let radius_px = MOUSE_LOOK_RADIUS * scale;

            if dist_px <= radius_px {
                // 鼠标靠近：切 stationary 让宠物站定 + emit facing
                scheduled_baseline.store(false, Ordering::SeqCst);
                if mood == Mood::Wandering {
                    companion.set(Mood::Stationary);
                    emit_state(&handle, &companion);
                }
                let dir = if dx >= 0.0 { Facing::Right } else { Facing::Left };
                if companion.facing() != dir {
                    let mut f = companion.facing.write();
                    *f = dir;
                    drop(f);
                    emit_state(&handle, &companion);
                }
                let _ = handle.emit(
                    "companion-facing",
                    &serde_json::json!({ "dir": match dir { Facing::Left => "left", Facing::Right => "right" } }),
                );
                was_in_radius.store(true, Ordering::SeqCst);
            } else if was_in_radius.load(Ordering::SeqCst) {
                // 鼠标已远离 — 1s 后 emit baseline + 切回 user 意图（防抖动）
                if !scheduled_baseline.swap(true, Ordering::SeqCst) {
                    let h2 = handle.clone();
                    let c2 = companion.clone();
                    let s2 = app_state.clone();
                    let was = was_in_radius.clone();
                    let sched = scheduled_baseline.clone();
                    tauri::async_runtime::spawn(async move {
                        tokio::time::sleep(Duration::from_millis(MOUSE_AWAY_RESUME_MS)).await;
                        // 期间又靠近过 → 放弃
                        if !sched.load(Ordering::SeqCst) {
                            return;
                        }
                        sched.store(false, Ordering::SeqCst);
                        was.store(false, Ordering::SeqCst);
                        if matches!(s2.current_phase(), PipelinePhase::Idle) {
                            let want = if *c2.user_wants_wandering.read() {
                                Mood::Wandering
                            } else {
                                Mood::Stationary
                            };
                            c2.set(want);
                            emit_state(&h2, &c2);
                        }
                        let _ = h2.emit("companion-baseline", &serde_json::json!({}));
                    });
                }
            }
        }
    });
}

#[cfg(windows)]
fn current_cursor_pos() -> Option<(i32, i32)> {
    use windows::Win32::Foundation::POINT;
    use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;
    let mut pt = POINT { x: 0, y: 0 };
    unsafe {
        if GetCursorPos(&mut pt).is_ok() {
            Some((pt.x, pt.y))
        } else {
            None
        }
    }
}

// 非 Windows 平台 stub —— mac/linux 编译占位
#[cfg(not(windows))]
fn spawn_mouse_watcher(
    _handle: AppHandle,
    _app_state: Arc<AppState>,
    _companion: Arc<CompanionState>,
) {
}

// ---------- (v1.1) 设置开关 IPC ----------

/// 总开关：让伴侣说话 on/off。关掉后立即清空气泡。
#[tauri::command]
pub async fn cmd_set_companion_voice_enabled(
    enabled: bool,
    state: tauri::State<'_, Arc<AppState>>,
    handle: AppHandle,
) -> Result<(), String> {
    let mut cfg = state.config.read().clone();
    cfg.companion_voice_enabled = enabled;
    state
        .replace_config(cfg)
        .map_err(|e| format!("save config: {e}"))?;
    if !enabled {
        // 立即清气泡，跟 Mac clearImmediately 同
        let _ = handle.emit(
            "companion-speech",
            &super::speech::SpeechPayload {
                text: None,
                dwell_ms: 0,
            },
        );
    }
    Ok(())
}

/// 频率 picker：少 / 中 / 多 = 1 / 2 / 3。idle interval 下次 sleep 自动应用新值。
#[tauri::command]
pub async fn cmd_set_companion_chattiness(
    level: u8,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<(), String> {
    let level = level.clamp(0, 3);
    let mut cfg = state.config.read().clone();
    cfg.companion_chattiness = level;
    state
        .replace_config(cfg)
        .map_err(|e| format!("save config: {e}"))?;
    Ok(())
}

/// (v0.16.2 B1 起名) 写昵称——空字符串 = 清空（恢复"用本名"）。
/// trim 处理首尾空白；保存到 cfg.companion_pet_name；speech.rs display() 路径
/// 实时读取，不需 reload speech controller。
#[tauri::command]
pub async fn cmd_set_companion_pet_name(
    name: String,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<(), String> {
    let trimmed = name.trim().to_string();
    let mut cfg = state.config.read().clone();
    cfg.companion_pet_name = trimmed;
    state
        .replace_config(cfg)
        .map_err(|e| format!("save config: {e}"))?;
    Ok(())
}
