mod account;
mod asr;
mod audio;
mod config;
mod hotkey;
mod insertion;
mod pill;
mod state;
mod stylist;
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
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_deep_link::init())
        .manage(app_state.clone())
        .invoke_handler(tauri::generate_handler![
            cmd_get_config,
            cmd_save_config,
            cmd_test_asr,
            cmd_force_record_start,
            cmd_force_record_stop,
            cmd_open_main_window,
            cmd_account_login_start,
            cmd_account_logout,
            cmd_account_get_state,
            cmd_account_resolve_conflict,
            cmd_account_get_devices,
            cmd_account_unbind_device,
            cmd_billing_get_plans,
            cmd_billing_checkout,
            cmd_billing_get_order,
            cmd_billing_open_url,
            cmd_account_reload_me,
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

            // Account integration — build, attach, kick bootstrap.
            let account = account::Account::new(handle.clone(), app_state.clone());
            *app_state.account.write() = Some(account.clone());
            let acc_for_boot = account.clone();
            tauri::async_runtime::spawn(async move {
                acc_for_boot.bootstrap().await;
            });

            // Deep-link callback — forwarded to Account.
            use tauri_plugin_deep_link::DeepLinkExt;
            let acc_for_deeplink = account.clone();
            app.deep_link().on_open_url(move |event| {
                for url in event.urls() {
                    let url_str = url.to_string();
                    log::info!("deep-link open_url: {url_str}");
                    let acc = acc_for_deeplink.clone();
                    tauri::async_runtime::spawn(async move {
                        acc.handle_auth_callback(&url_str).await;
                    });
                }
            });

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
    state.replace_config(new_config).map_err(|e| e.to_string())?;
    // Notify the cloud-sync engine — it'll debounce 3s, then PUT.
    if let Some(acc) = state.account.read().clone() {
        tauri::async_runtime::spawn(async move {
            acc.on_settings_changed().await;
        });
    }
    Ok(())
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

// ---------- Account commands ----------

fn account_handle(state: &Arc<AppState>) -> Result<account::Account, String> {
    state
        .account
        .read()
        .clone()
        .ok_or_else(|| "account not yet ready".to_string())
}

#[tauri::command]
async fn cmd_account_login_start(state: tauri::State<'_, Arc<AppState>>) -> Result<(), String> {
    let acc = account_handle(&state)?;
    acc.start_login().await
}

#[tauri::command]
async fn cmd_account_logout(state: tauri::State<'_, Arc<AppState>>) -> Result<(), String> {
    let acc = account_handle(&state)?;
    acc.logout().await;
    Ok(())
}

#[tauri::command]
fn cmd_account_get_state(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<account::AccountSnapshot, String> {
    let acc = account_handle(&state)?;
    Ok(acc.snapshot())
}

#[tauri::command]
async fn cmd_account_resolve_conflict(
    state: tauri::State<'_, Arc<AppState>>,
    action: String,
) -> Result<(), String> {
    let acc = account_handle(&state)?;
    let resolved = match action.as_str() {
        "keep_local" => account::ResolveAction::KeepLocal,
        "use_cloud" => account::ResolveAction::UseCloud,
        "merge" => account::ResolveAction::Merge,
        other => return Err(format!("unknown action: {other}")),
    };
    acc.resolve_conflict(resolved).await;
    Ok(())
}

#[tauri::command]
async fn cmd_account_get_devices(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<Vec<account::auth::DeviceInfo>, String> {
    let acc = account_handle(&state)?;
    acc.list_devices().await
}

#[tauri::command]
async fn cmd_account_unbind_device(
    state: tauri::State<'_, Arc<AppState>>,
    device_id: i64,
) -> Result<(), String> {
    let acc = account_handle(&state)?;
    acc.unbind_device(device_id).await
}

#[tauri::command]
async fn cmd_billing_get_plans(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<account::billing::PlansCatalog, String> {
    let acc = account_handle(&state)?;
    acc.fetch_plans().await
}

#[tauri::command]
async fn cmd_billing_checkout(
    state: tauri::State<'_, Arc<AppState>>,
    plan: String,
) -> Result<account::billing::CheckoutResp, String> {
    let acc = account_handle(&state)?;
    acc.billing_checkout(&plan).await
}

#[tauri::command]
async fn cmd_billing_get_order(
    state: tauri::State<'_, Arc<AppState>>,
    order_id: i64,
) -> Result<account::billing::OrderInfo, String> {
    let acc = account_handle(&state)?;
    acc.billing_get_order(order_id).await
}

/// Open the pay URL in the user's default browser. Tauri 2 doesn't bundle a
/// generic `open` API by default; we shell out to `cmd /c start`. URLs are
/// validated server-side (虎皮椒 host) but we still sanitise to avoid
/// arbitrary process exec.
#[tauri::command]
fn cmd_billing_open_url(url: String) -> Result<(), String> {
    if !url.starts_with("https://") {
        return Err("only https:// URLs allowed".into());
    }
    #[cfg(target_os = "windows")]
    {
        use std::process::Command;
        Command::new("cmd")
            .args(["/c", "start", "", &url])
            .spawn()
            .map_err(|e| e.to_string())?;
        Ok(())
    }
    #[cfg(target_os = "macos")]
    {
        use std::process::Command;
        Command::new("open").arg(&url).spawn().map_err(|e| e.to_string())?;
        Ok(())
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        let _ = url;
        Err("unsupported platform".into())
    }
}

#[tauri::command]
async fn cmd_account_reload_me(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<(), String> {
    let acc = account_handle(&state)?;
    acc.reload_me().await
}
