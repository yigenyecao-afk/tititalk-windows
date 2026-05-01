//! Floating pill window control.
//!
//! On phase change we show the pill near the bottom-center of the active monitor
//! (close to the cursor's screen). The actual visuals are rendered by `pill.tsx`,
//! which subscribes to the `pipeline` Tauri event we already emit from `lib.rs`.

use std::sync::Arc;

use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize};

use crate::state::{AppState, PipelineEvent, PipelinePhase};

pub async fn on_pipeline_event(handle: &AppHandle, _state: &Arc<AppState>, ev: &PipelineEvent) {
    let Some(pill) = handle.get_webview_window("pill") else {
        return;
    };

    match ev {
        PipelineEvent::Phase { phase } => {
            match phase {
                PipelinePhase::Recording
                | PipelinePhase::Transcribing
                | PipelinePhase::Polishing
                | PipelinePhase::Inserting => {
                    let _ = position_near_cursor(&pill);
                    let _ = pill.show();
                }
                PipelinePhase::Done | PipelinePhase::Failed => {
                    // Let pill linger for ~900ms then hide; UI side handles fade.
                    let pill2 = pill.clone();
                    tauri::async_runtime::spawn(async move {
                        tokio::time::sleep(std::time::Duration::from_millis(900)).await;
                        let _ = pill2.hide();
                    });
                }
                PipelinePhase::Idle => {
                    let _ = pill.hide();
                }
                _ => {}
            }
        }
        _ => {}
    }
}

fn position_near_cursor(pill: &tauri::WebviewWindow) -> tauri::Result<()> {
    // Find the monitor that contains the cursor; place pill near bottom-center.
    // Cursor coords come from Win32 (more reliable across DPI than tauri's helper).
    let cursor_xy = win_cursor_pos();
    let monitor = match cursor_xy.and_then(|(x, y)| {
        pill.app_handle().monitor_from_point(x as f64, y as f64).ok().flatten()
    }) {
        Some(m) => m,
        None => match pill.current_monitor()? {
            Some(m) => m,
            None => return Ok(()),
        },
    };

    let scale = monitor.scale_factor();
    let m_size: PhysicalSize<u32> = *monitor.size();
    let m_pos: PhysicalPosition<i32> = *monitor.position();

    // Approx pill size in physical pixels (logical 220×56 from tauri.conf)
    let pill_w = (220.0 * scale) as i32;
    let pill_h = (56.0 * scale) as i32;

    let x = m_pos.x + (m_size.width as i32 - pill_w) / 2;
    let y = m_pos.y + m_size.height as i32 - pill_h - (90.0 * scale) as i32;

    pill.set_position(PhysicalPosition::new(x, y))?;
    Ok(())
}

#[cfg(windows)]
fn win_cursor_pos() -> Option<(i32, i32)> {
    use windows::Win32::Foundation::POINT;
    use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;
    let mut p = POINT::default();
    unsafe {
        if GetCursorPos(&mut p).is_ok() {
            Some((p.x, p.y))
        } else {
            None
        }
    }
}

#[cfg(not(windows))]
fn win_cursor_pos() -> Option<(i32, i32)> { None }
