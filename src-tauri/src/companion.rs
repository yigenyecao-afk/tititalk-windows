// Wave 4 #1 — 桌面宠物窗口控制（Win 端）。
//
// companion 是 tauri.conf.json 里声明的第 4 个 webview window：
// transparent=true、decorations=false、alwaysOnTop=true、skipTaskbar=true、
// focus=false、shadow=false。Rust 这层就 4 件事：
//
//   1. show / hide （前端开关同步窗口可见性）
//   2. set_position（用户拖宠物时由前端发坐标过来落库）
//   3. get_position（启动时读上次位置回填）
//   4. ensure_position_on_screen — 多屏拔插场景下，恢复时如果上次位置不在
//      任何 monitor 内（HDMI 拔了 / 屏幕 layout 改了），自动落到主屏右下
//
// 不在这一层做：状态机 / sprite / bubble / 4 信号订阅 —— 全在前端 PetEngine.ts
// 跑（webview 已经监听了 onPipeline 和 app_context_changed，主进程没必要重复）。

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, PhysicalPosition};

const COMPANION_LABEL: &str = "companion";
const DEFAULT_MARGIN_RIGHT: i32 = 24;
const DEFAULT_MARGIN_BOTTOM: i32 = 96; // 留出任务栏

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompanionPosition {
    pub x: i32,
    pub y: i32,
}

#[tauri::command]
pub fn cmd_companion_show(handle: AppHandle) -> Result<(), String> {
    let win = handle
        .get_webview_window(COMPANION_LABEL)
        .ok_or_else(|| "companion window not registered".to_string())?;
    // 没指定位置时按默认主屏右下角放（首次启动 / 多屏 fallback）
    if let Err(e) = ensure_on_screen(&win) {
        log::warn!("companion ensure_on_screen failed: {e}");
    }
    win.show().map_err(|e| e.to_string())?;
    // 不抢焦点 —— transparent 窗口被用户点到时才接 mouse；alwaysOnTop 已开
    Ok(())
}

#[tauri::command]
pub fn cmd_companion_hide(handle: AppHandle) -> Result<(), String> {
    let win = handle
        .get_webview_window(COMPANION_LABEL)
        .ok_or_else(|| "companion window not registered".to_string())?;
    win.hide().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn cmd_companion_set_position(handle: AppHandle, x: i32, y: i32) -> Result<(), String> {
    let win = handle
        .get_webview_window(COMPANION_LABEL)
        .ok_or_else(|| "companion window not registered".to_string())?;
    win.set_position(PhysicalPosition::new(x, y))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn cmd_companion_get_position(handle: AppHandle) -> Result<CompanionPosition, String> {
    let win = handle
        .get_webview_window(COMPANION_LABEL)
        .ok_or_else(|| "companion window not registered".to_string())?;
    let pos = win.outer_position().map_err(|e| e.to_string())?;
    Ok(CompanionPosition { x: pos.x, y: pos.y })
}

/// Wave 4 Stage 2 — 分享卡片落盘。前端 canvas → toDataURL("image/png") →
/// 把 base64 头剥掉传过来；这里 decode + write。path 走 plugin-dialog 的
/// save() 给出，permission 已经由用户选择路径 implicit grant。
#[tauri::command]
pub fn cmd_companion_save_share_card(path: String, data_base64: String) -> Result<(), String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&data_base64)
        .map_err(|e| format!("base64 decode: {e}"))?;
    std::fs::write(&path, bytes).map_err(|e| format!("write {path}: {e}"))
}

/// 把 companion 拉回某块屏幕里。outer_position() 已经在屏外（拔副屏）→
/// 落到主屏右下默认位（DEFAULT_MARGIN_RIGHT / DEFAULT_MARGIN_BOTTOM）。
fn ensure_on_screen(win: &tauri::WebviewWindow) -> Result<(), String> {
    let pos = win.outer_position().map_err(|e| e.to_string())?;
    let size = win.outer_size().map_err(|e| e.to_string())?;
    let monitors = win.available_monitors().map_err(|e| e.to_string())?;
    if monitors.is_empty() {
        return Ok(()); // 罕见：headless / 锁屏
    }
    let cx = pos.x + (size.width as i32) / 2;
    let cy = pos.y + (size.height as i32) / 2;
    let on = monitors.iter().any(|m| {
        let mp = m.position();
        let ms = m.size();
        cx >= mp.x
            && cx <= mp.x + ms.width as i32
            && cy >= mp.y
            && cy <= mp.y + ms.height as i32
    });
    if on {
        return Ok(());
    }
    // 找主屏（current_monitor 通常是当前焦点屏；兜底取第一块）
    let primary = win
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| monitors.first().cloned());
    if let Some(m) = primary {
        let mp = m.position();
        let ms = m.size();
        let nx = mp.x + ms.width as i32 - size.width as i32 - DEFAULT_MARGIN_RIGHT;
        let ny = mp.y + ms.height as i32 - size.height as i32 - DEFAULT_MARGIN_BOTTOM;
        win.set_position(PhysicalPosition::new(nx, ny))
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}
