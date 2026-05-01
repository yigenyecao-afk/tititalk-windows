mod asr;
mod audio;
mod config;
mod hotkey;
mod insertion;
mod pill;
mod state;
mod tray;

use std::sync::Arc;

use tauri::{Emitter, Manager};
use tokio::sync::mpsc;

use crate::state::{AppState, PipelineEvent, PipelinePhase};

pub fn run() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();

    let (event_tx, mut event_rx) = mpsc::unbounded_channel::<PipelineEvent>();
    let app_state = Arc::new(AppState::new(event_tx.clone()));

    tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_shell::init())
        .manage(app_state.clone())
        .invoke_handler(tauri::generate_handler![
            cmd_get_config,
            cmd_save_config,
            cmd_test_asr,
            cmd_force_record_start,
            cmd_force_record_stop,
            cmd_open_main_window,
        ])
        .setup(move |app| {
            let handle = app.handle().clone();

            // Tray + menu
            tray::install_tray(&handle).expect("install tray");

            // Pill positioning helper (initial hide)
            if let Some(pill) = app.get_webview_window("pill") {
                let _ = pill.hide();
            }

            // Hotkey listener (low-level keyboard hook on Windows)
            hotkey::spawn_hook_thread(app_state.clone());

            // Pipeline event pump → forward to JS + drive pill
            let pump_state = app_state.clone();
            let pump_handle = handle.clone();
            tauri::async_runtime::spawn(async move {
                while let Some(ev) = event_rx.recv().await {
                    log::debug!("pipeline event: {:?}", ev);
                    let _ = pump_handle.emit("pipeline", &ev);
                    pill::on_pipeline_event(&pump_handle, &pump_state, &ev).await;
                }
            });

            Ok(())
        })
        .on_window_event(|window, event| {
            // Hide main window on close instead of quitting (tray app behavior)
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    let _ = window.hide();
                    api.prevent_close();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running TiTiTalk");
}

// ---------- Tauri commands ----------

#[tauri::command]
fn cmd_get_config(state: tauri::State<'_, Arc<AppState>>) -> config::AppConfig {
    state.config.read().clone()
}

#[tauri::command]
fn cmd_save_config(
    state: tauri::State<'_, Arc<AppState>>,
    new_config: config::AppConfig,
) -> Result<(), String> {
    state.replace_config(new_config).map_err(|e| e.to_string())
}

#[tauri::command]
async fn cmd_test_asr(state: tauri::State<'_, Arc<AppState>>) -> Result<String, String> {
    // (fix) parking_lot 的 RwLockReadGuard 不是 Send；以前写法
    // `&state.config.read().clone()` 会让 guard 活到整个表达式结束，
    // 包括跨过 .await，导致整个 future 不 Send → tauri::generate_handler!
    // 编译失败。先 clone 进 owned 值再让 guard 立即 drop，再 .await。
    let cfg = state.config.read().clone();
    asr::test_credentials(&cfg)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn cmd_force_record_start(state: tauri::State<'_, Arc<AppState>>) -> Result<(), String> {
    state.request_phase(PipelinePhase::Recording);
    Ok(())
}

#[tauri::command]
fn cmd_force_record_stop(state: tauri::State<'_, Arc<AppState>>) -> Result<(), String> {
    state.request_phase(PipelinePhase::Stopping);
    Ok(())
}

#[tauri::command]
fn cmd_open_main_window(handle: tauri::AppHandle) -> Result<(), String> {
    if let Some(w) = handle.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
    Ok(())
}
