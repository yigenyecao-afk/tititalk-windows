mod account;
#[cfg(windows)]
mod app_context;
mod asr;
mod asr_prewarm;
mod asr_local;
mod asr_stream;
mod assistant;
mod audio;
mod batch_transcribe;
// Wave 4 — 桌面伴侣（v0.13.4 砍后 v0.16 重新引入，跟 Mac Companion 等价）
mod companion;
mod config;
mod history;
mod hotkey;
mod hotword_candidate;
mod insertion;
mod mouse_hotkey;
mod pill;
mod rewrite_selection;
mod state;
mod stylist;
mod system_audio_muter;
mod text_post_process;
mod translate;
mod tray;

use std::io::Write;
use std::sync::Arc;

use tauri::{Emitter, Manager};
use tokio::sync::mpsc;

use crate::state::{AppState, PipelineEvent, PipelinePhase};

/// 日志文件落点：`%LOCALAPPDATA%\TiTiTalk\tititalk.log`。
/// 启动时如果 >2MB 就 rename 成 `tititalk.log.1`（覆盖更老的），简单 ring。
/// 不用第三方 rolling crate，目的是让 user 能在出 bug 时一个固定路径捞日志，
/// 而不是 stdout 跟着进程死。
fn log_file_path() -> std::path::PathBuf {
    let base = dirs::data_local_dir()
        .unwrap_or_else(|| std::env::temp_dir())
        .join("TiTiTalk");
    let _ = std::fs::create_dir_all(&base);
    base.join("tititalk.log")
}

fn rotate_log_if_large() {
    let p = log_file_path();
    let Ok(meta) = std::fs::metadata(&p) else { return };
    if meta.len() > 2 * 1024 * 1024 {
        let prev = p.with_extension("log.1");
        let _ = std::fs::remove_file(&prev);
        let _ = std::fs::rename(&p, &prev);
    }
}

pub fn run() {
    rotate_log_if_large();

    // env_logger 默认只写 stdout —— Windows GUI app stdout 通常重定向到
    // /dev/null，user 报 bug 时根本拿不到日志。改成「stdout + 同步追加到
    // tititalk.log」双写。OpenOptions::append 在多线程下被 OS 串行化，
    // env_logger 自己也对 writer 上 Mutex，这里不用额外锁。
    let log_file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_file_path())
        .ok();
    let mut builder = env_logger::Builder::from_env(
        env_logger::Env::default().default_filter_or("info"),
    );
    if let Some(file) = log_file {
        let file = std::sync::Mutex::new(file);
        builder.format(move |buf, record| {
            let line = format!(
                "[{} {} {}] {}\n",
                chrono::Utc::now().to_rfc3339(),
                record.level(),
                record.target(),
                record.args()
            );
            // stdout 不让 panic 掐主路径
            let _ = buf.write_all(line.as_bytes());
            if let Ok(mut g) = file.lock() {
                let _ = g.write_all(line.as_bytes());
            }
            Ok(())
        });
    }
    builder.init();

    // 之前 bug：Rust panic（unwrap on None / index OOB / 第三方库 panic）
    // 没有 hook 兜，进程直接死，user 看到「app 闪退」，我们看不到栈。
    // 这个 hook 把 panic 写进文件日志，至少 user 报 bug 时能从
    // %LOCALAPPDATA%\TiTiTalk\tititalk.log 拉到现场。
    std::panic::set_hook(Box::new(|info| {
        let bt = std::backtrace::Backtrace::force_capture();
        log::error!("PANIC: {info}\nbacktrace:\n{bt}");
    }));

    let (event_tx, mut event_rx) = mpsc::unbounded_channel::<PipelineEvent>();
    let app_state = Arc::new(AppState::new(event_tx.clone()));

    tauri::Builder::default()
        // Single-instance MUST be the very first plugin. With the
        // `deep-link` feature it auto-forwards `tititalk://...` URLs from
        // a freshly-spawned second instance into the already-running
        // instance's `deep_link().on_open_url` listener. Without this,
        // Windows opens a NEW exe per callback, that new exe has no
        // `Authenticating` state, and `handle_auth_callback` rejects with
        // "not awaiting login" — exactly the symptom users hit.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // The plugin's `deep-link` feature already routes URLs; we
            // still surface the running window so the user sees feedback.
            use tauri::Manager;
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        // (P1-11 历史导出 2026-05-06) 历史 export 用 plugin-fs.writeTextFile 落盘
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_deep_link::init())
        // (v0.12.0 2026-05-06) Login startup — registers `HKCU\...\Run` so
        // Windows boots TiTiTalk in the background. Frontend toggle in
        // Settings sheet calls `plugin:autostart|enable/disable` to switch.
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .manage(app_state.clone())
        .invoke_handler(tauri::generate_handler![
            cmd_get_config,
            cmd_save_config,
            cmd_test_asr,
            cmd_force_record_start,
            cmd_force_record_stop,
            cmd_force_record_cancel,
            cmd_open_main_window,
            cmd_reset_default_config,
            cmd_open_log_folder,
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
            cmd_account_reload_me_atomic,
            cmd_role_select,
            cmd_history_recent,
            cmd_history_clear,
            cmd_open_mic_settings,
            cmd_check_microphone,
            cmd_hotword_candidates,
            cmd_hotword_dismiss,
            cmd_hotword_clear_all,
            cmd_assistant_run_action,
            cmd_assistant_insert_to_app,
            cmd_assistant_hide,
            // P0 wave 3 — 通用 authed HTTP 通道（personalization / app persona
            // rules / repolish / meetings / orgs / audit / cross-history search
            // 17 个 endpoint 全走这 4 个 cmd），加 batch_transcribe + rewrite_selection
            cmd_account_authed_get,
            cmd_account_authed_post,
            cmd_account_authed_put,
            cmd_account_authed_delete,
            batch_transcribe::cmd_transcribe_file,
            rewrite_selection::cmd_get_clipboard_text,
            rewrite_selection::cmd_rewrite_selection_start,
            // Wave 4 桌面伴侣（cmd_companion_*）— tauri::generate_handler!
            // 宏要找 __tauri_command_name_X 跟 fn 定义同模块；re-export 不行。
            companion::window::cmd_companion_list_pets,
            companion::window::cmd_companion_tap,
            companion::window::cmd_companion_double_tap,
            companion::window::cmd_companion_drag_end,
            companion::window::cmd_companion_save_position,
            // (v1.1 性格化陪伴) 长按抚摸 + 总开关 + 频率 picker
            companion::window::cmd_companion_long_press,
            companion::window::cmd_set_companion_voice_enabled,
            companion::window::cmd_set_companion_chattiness,
            companion::window::cmd_set_companion_pet_name,
            // (v0.16.2 B4) 深度抚摸 — 持续按 ≥2.5s 触发
            companion::window::cmd_companion_deep_press,
        ])
        .setup(move |app| {
            let handle = app.handle().clone();

            // (v0.8.4 backlog #5) 让 AppState 持有 AppHandle，给 hotkey 触发的
            // assistant::trigger 读 webview window 用。
            *app_state.app_handle.write() = Some(handle.clone());

            // P0 wave 3 #2 #12 — 前台窗口探测（emit `app_context_changed` 给前端）
            #[cfg(windows)]
            {
                let probe = app_context::AppContextProbe::new();
                probe.start(handle.clone(), app_state.clone());
                // probe 内部 spawn 后通过 Arc<AtomicBool> 自管，drop 即可
                std::mem::forget(probe);
            }

            // Tray + menu — 某些 Windows SKU（精简版/Server Core）没装托盘
            // shell，install_tray 会 panic 把整个进程拖死。改 graceful：错误
            // 写日志，继续启动；用户可从 Start menu 重新打开主窗口。
            if let Err(e) = tray::install_tray(&handle) {
                eprintln!("[tray] install failed: {e}; continuing without tray");
            }

            // Pill positioning helper (initial hide)
            if let Some(pill) = app.get_webview_window("pill") {
                let _ = pill.hide();
            }
            // Wave 4 — 桌面伴侣初始化（按 cfg.companion_enabled 决定是否 show）
            {
                let h2 = handle.clone();
                let s2 = app_state.clone();
                tauri::async_runtime::spawn(async move {
                    companion::window::ensure(&h2, &s2).await;
                });
            }

            // Show main window on first launch + every cold start. The window
            // is `visible:false` in tauri.conf.json so it doesn't flash before
            // the React tree mounts; we explicitly show + focus here once the
            // app has booted. Without this the user sees nothing after install
            // and has to find the tray icon.
            if let Some(main) = app.get_webview_window("main") {
                // FIX-19 (qa-2026-05-03): 主窗口冷启动前 sanity-check 位置——
                // 用户拔掉外接屏后 saved position 可能在虚拟桌面外，老路径只
                // 有点托盘时才修。现在冷启动也兜底（WIN-003）。
                if let (Ok(pos), Ok(size), Ok(monitors)) =
                    (main.outer_position(), main.outer_size(), main.available_monitors())
                {
                    let on_screen = monitors.iter().any(|m| {
                        let mp = m.position();
                        let ms = m.size();
                        let cx = pos.x + (size.width as i32) / 2;
                        let cy = pos.y + (size.height as i32) / 2;
                        cx >= mp.x
                            && cx <= mp.x + ms.width as i32
                            && cy >= mp.y
                            && cy <= mp.y + ms.height as i32
                    });
                    if !on_screen {
                        log::warn!(
                            "main window saved at ({}, {}) outside any current monitor — re-centering",
                            pos.x, pos.y
                        );
                        let _ = main.center();
                    }
                }
                let _ = main.show();
                let _ = main.set_focus();
            }

            // Hotkey listener (low-level keyboard hook on Windows)
            hotkey::spawn_hook_thread(app_state.clone());
            // (v0.8.4 P2-1) 鼠标侧键 hotkey —— 单独 LL mouse hook 线程
            mouse_hotkey::spawn_mouse_hook_thread(app_state.clone());

            // Account integration — build, attach, kick bootstrap.
            let account = account::Account::new(handle.clone(), app_state.clone());
            *app_state.account.write() = Some(account.clone());
            let acc_for_boot = account.clone();
            tauri::async_runtime::spawn(async move {
                acc_for_boot.bootstrap().await;
            });

            // (P1 hotkey→partial 加速 2026-05-05; v0.10.1 hotfix)
            // 推迟到 setup 闭包返回 + tauri runtime 真正进入主事件循环之后再起，
            // 避免 setup 阶段 spawn_blocking + cpal::default_host 在 Windows 某些
            // 机器上崩死整个 process（v0.10.0 用户实测「装好但起不来」根因）。
            //
            // 用 std::thread::spawn + catch_unwind：
            //   - std::thread 不依赖 tauri/tokio runtime
            //   - 800ms 等 setup 全部完成 + main loop 启动
            //   - catch_unwind 接住任何 cpal driver 异常，prewarm 失败也不影响 app
            let app_state_for_prewarm = app_state.clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(800));
                let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    asr_prewarm::ensure_started(app_state_for_prewarm);
                    asr_prewarm::enable();
                }));
                let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    audio::prewarm_audio_device();
                }));
            });

            // Deep-link callback — forwarded to Account.
            //
            // `register("tititalk")` is a runtime fallback for two cases
            // production NSIS install does NOT cover:
            //   1. dev mode (`pnpm tauri dev`) — no installer ever ran, so
            //      Windows registry has no handler for tititalk://;
            //   2. portable / old-install upgrade where the registry key
            //      didn't get rewritten.
            // It's a no-op when the registry already points to this exe.
            use tauri_plugin_deep_link::DeepLinkExt;
            if let Err(e) = app.deep_link().register("tititalk") {
                log::warn!("deep-link register fallback failed: {e}");
            }
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
            // Cold-start belt-and-braces: if Windows launched us with a
            // tititalk:// URL on argv (single-instance hadn't shipped in
            // older builds, so an upgrading user might still have a stale
            // launcher path), pick it up here too. on_open_url won't fire
            // for this case since the URL arrived before the listener.
            for arg in std::env::args().skip(1) {
                if arg.starts_with("tititalk://") {
                    log::info!("deep-link cold-start arg: {arg}");
                    let acc = account.clone();
                    tauri::async_runtime::spawn(async move {
                        acc.handle_auth_callback(&arg).await;
                    });
                }
            }

            // Pipeline event pump → forward to JS + drive pill +
            // persist transcript to history JSONL.
            let pump_state = app_state.clone();
            let pump_handle = handle.clone();
            tauri::async_runtime::spawn(async move {
                while let Some(ev) = event_rx.recv().await {
                    log::debug!("pipeline event: {:?}", ev);
                    let _ = pump_handle.emit("pipeline", &ev);
                    pill::on_pipeline_event(&pump_handle, &pump_state, &ev).await;
                    companion::window::on_pipeline_event(&pump_handle, &pump_state, &ev).await;
                    // tray tooltip 联动 phase —— 录音中/转写中/空闲在 tray hover
                    // 看得见，比静态 tooltip 强很多（pill 默认关时尤其重要）。
                    if let PipelineEvent::Phase { phase } = &ev {
                        tray::update_tooltip_for_phase(&pump_handle, *phase);
                    }
                    if let PipelineEvent::Transcript { text } = &ev {
                        let cfg = pump_state.config.read();
                        let item = history::HistoryItem {
                            at: chrono::Utc::now(),
                            text: text.clone(),
                            engine: cfg.engine.clone(),
                            model: Some(cfg.model.clone()),
                            // (v0.15.2 C1) 新字段 — 实时落地条目暂时填空，工作台
                            // 摘要/章节后续触发时再 attach 写回（Phase 4 wav 归档
                            // 接通后 duration_ms 会有真值；当前没法准确算 PCM 时长）。
                            polished: String::new(),
                            duration_ms: None,
                            analysis_reports: None,
                        };
                        drop(cfg);
                        // append 是同步 fs，几十微秒；不值得起 spawn_blocking。
                        history::append(&item);
                    }
                }
            });

            // 启动时跑一次 cleanup（如果开了），并起 24h 周期任务。
            // 一次性 cleanup 的代价是单次 JSONL 重写，user-facing 无感。
            //
            // 注意：parking_lot::RwLockReadGuard 不是 Send，决不能跨 .await
            // 持锁；下面把 (enabled, days) 拷贝出来再 drop guard，再 await。
            let cleanup_state = app_state.clone();
            tauri::async_runtime::spawn(async move {
                use std::time::Duration;
                loop {
                    let (enabled, days) = {
                        let cfg = cleanup_state.config.read();
                        (cfg.history_cleanup_enabled, cfg.history_retention_days)
                    };
                    if enabled {
                        // spawn_blocking 隔离 fs IO 不挡 tokio 运行时
                        let _ = tokio::task::spawn_blocking(move || {
                            history::cleanup(days);
                        })
                        .await;
                    }
                    tokio::time::sleep(Duration::from_secs(24 * 3600)).await;
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
            // (v0.16.2 B2 离场归来) main window focus state → SpeechController
            // 记 last_blurred / 检查 elapsed ≥30min 强冒 launch 招呼。其他
            // window (pill / companion / pet) focus 切换不触发，避免误判。
            if let tauri::WindowEvent::Focused(focused) = event {
                if window.label() == "main" {
                    if let Some(speech) = companion::window::get_speech_ctrl() {
                        if *focused {
                            speech.on_focused();
                        } else {
                            speech.on_blurred();
                        }
                    }
                }
            }
        })
        .build(tauri::generate_context!())
        .unwrap_or_else(|err| {
            // (P0-7 2026-05-06) tauri Builder::build 失败 = 进程根本起不来；
            // 老 .expect 只在 stderr 抛 + abort，部分 Windows SKU 直接闪退用户
            // 不知道为啥。这里写日志 + 弹一次系统消息框 + exit(1)，至少留下
            // 现场。panic hook (line 95) 已捕获栈，外加这里再写一条 fatal log。
            log::error!("[fatal] tauri build failed: {err}");
            #[cfg(windows)]
            unsafe {
                use windows::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONERROR, MB_OK};
                use windows::core::PCWSTR;
                let title: Vec<u16> = "TiTiTalk 启动失败\0".encode_utf16().collect();
                let body: Vec<u16> = format!(
                    "TiTiTalk 无法启动：{err}\n\n请把日志（%LOCALAPPDATA%\\TiTiTalk\\tititalk.log）发邮件给 hi@tititalk.com\0"
                ).encode_utf16().collect();
                let _ = MessageBoxW(None, PCWSTR(body.as_ptr()), PCWSTR(title.as_ptr()), MB_OK | MB_ICONERROR);
            }
            std::process::exit(1);
        })
        .run(|app_handle, event| {
            // FIX-28: 应用真退出（系统/托盘 quit）前 flush CloudConfigSync 的
            // 待发 PUT，最多 3s。绝大多数情况立即返（没有 in-flight）；只有用户
            // 刚改完设置秒退时才真起作用。
            if let tauri::RunEvent::ExitRequested { .. } = event {
                let state: tauri::State<'_, Arc<AppState>> = app_handle.state();
                let acc_opt = state.account.read().clone();  // 立刻 drop guard
                if let Some(acc) = acc_opt {
                    tauri::async_runtime::block_on(async move {
                        if let Some(s) = acc.sync_clone_arc().await {
                            let _ = s.flush_for_shutdown(std::time::Duration::from_secs(3)).await;
                        }
                    });
                }
            }
        });
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

/// (v0.8.3 P0-3) ESC 取消 —— 跟 stop 不同，丢弃 PCM 不转写不插入不计配额。
#[tauri::command]
fn cmd_force_record_cancel(state: tauri::State<'_, Arc<AppState>>) -> Result<(), String> {
    state.request_phase(PipelinePhase::Idle);
    Ok(())
}

#[tauri::command]
fn cmd_open_main_window(handle: tauri::AppHandle) -> Result<(), String> {
    tray::ensure_main_visible(&handle);
    Ok(())
}

/// (P2-25 2026-05-06) 重置 cfg 到默认值。账户/历史/词典默认条目不动。
#[tauri::command]
fn cmd_reset_default_config(state: tauri::State<'_, Arc<AppState>>) -> Result<config::AppConfig, String> {
    // 保留用户的字典——重置只针对偏好开关，不删用户主动添加的内容
    let prev = state.config.read().clone();
    let mut fresh = config::AppConfig::default();
    fresh.dictionary = prev.dictionary;
    fresh.api_key = prev.api_key; // 不动 API key
    state.replace_config(fresh.clone()).map_err(|e| e.to_string())?;
    if let Some(acc) = state.account.read().clone() {
        tauri::async_runtime::spawn(async move { acc.on_settings_changed().await; });
    }
    Ok(fresh)
}

/// (P1-16 + P2-25) 打开日志文件夹（panic_hook 和 slow request 都写在此处）。
#[tauri::command]
fn cmd_open_log_folder() -> Result<(), String> {
    let dir = dirs::data_local_dir()
        .map(|p| p.join("TiTiTalk"))
        .ok_or_else(|| "cannot resolve LocalAppData".to_string())?;
    std::fs::create_dir_all(&dir).ok();
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        std::process::Command::new("explorer")
            .arg(&dir)
            .creation_flags(0x08000000) // CREATE_NO_WINDOW
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(not(windows))]
    {
        let _ = dir;
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

/// (角色身份系统 v1) 用户在 OnboardingRoleSheet 选完点确认 / Settings RoleRow
/// 切角色时调。后端 `PUT /api/me/role` 写库后，内部 reload_me() 会触发
/// `account-state-changed` 事件让 React 看到新 user.role 值。
/// 决策 #7：role 不传 polish/asr API；只通过此命令写后端，热词 + prefix 由
/// 后端按 user 自动注入。
#[tauri::command]
async fn cmd_role_select(
    role: String,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<(), String> {
    let acc = account_handle(&state)?;
    acc.select_role(&role).await
}

/// FIX-25: 单次原子拉 me + license + quota，frontend 在支付成功后调一次。
/// 服务端 5xx 时内部自动 fallback 到 cmd_account_reload_me 等价路径。
#[tauri::command]
async fn cmd_account_reload_me_atomic(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<(), String> {
    let acc = account_handle(&state)?;
    acc.reload_me_atomic().await
}

// ---------- History commands ----------

#[tauri::command]
fn cmd_history_recent(limit: Option<usize>) -> Vec<history::HistoryItem> {
    history::load_recent(limit.unwrap_or(50))
}

#[tauri::command]
fn cmd_history_clear() -> Result<(), String> {
    history::clear_all().map_err(|e| e.to_string())
}

/// 打开 Windows 11 设置 → 隐私和安全 → 麦克风。`ms-settings:` URI scheme
/// 是 Win10/11 通用的「直达深页面」，不需要 PowerShell 也不需要权限。
/// 用于权限被拒后的「一键去开」按钮 —— 没这个用户得自己翻 4 层菜单。
#[tauri::command]
fn cmd_open_mic_settings() -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use std::process::Command;
        Command::new("cmd")
            .args(["/c", "start", "", "ms-settings:privacy-microphone"])
            .spawn()
            .map_err(|e| e.to_string())?;
        Ok(())
    }
    #[cfg(not(target_os = "windows"))]
    {
        Err("仅 Windows 平台支持".into())
    }
}

/// 主线程不阻塞的麦克风可用性预检 —— 前端可在 Settings / 首启时主动调一次，
/// 拿到 Err 就显示「未授权」banner + 一键打开设置按钮。
/// 跟 `audio::orchestrate_start` 的预检走同一函数，结论一致。
#[tauri::command]
fn cmd_check_microphone() -> Result<(), String> {
    audio::preflight_microphone()
}

// (v0.8.4 backlog #5) 「随便问」浮窗 ——
//   run_action: action ∈ translate / polish / email / qa
#[tauri::command]
async fn cmd_assistant_run_action(
    state: tauri::State<'_, Arc<AppState>>,
    action: String,
    user_input: String,
    selection: String,
) -> Result<String, String> {
    // 拿 Arc clone 给 async 用；State<Arc<T>> 解引用是 &Arc<T>，clone 拿 Arc<T>。
    let st: Arc<AppState> = (*state).clone();
    assistant::run_action(st, action, user_input, selection)
        .await
        .map_err(|e| e.to_string())
}

/// 把 LLM 答案插回原 app —— 模拟 Ctrl+V（前端 setClipboard 然后调这个）
#[tauri::command]
fn cmd_assistant_insert_to_app(text: String) -> Result<(), String> {
    #[cfg(windows)]
    {
        crate::translate::write_clipboard_text_pub(&text).map_err(|e| e.to_string())?;
        std::thread::sleep(std::time::Duration::from_millis(30));
        crate::translate::simulate_ctrl_v_pub().map_err(|e| e.to_string())?;
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = text;
        Err("仅 Windows 支持".into())
    }
}

#[tauri::command]
fn cmd_assistant_hide(handle: tauri::AppHandle) {
    use tauri::Manager;
    if let Some(win) = handle.get_webview_window("assistant") {
        let _ = win.hide();
    }
}

// (v0.8.4 P1-2) 词汇候选 —— 前端 DictionaryTab banner 用
#[tauri::command]
fn cmd_hotword_candidates(
    state: tauri::State<'_, Arc<AppState>>,
) -> Vec<(String, u32)> {
    let cfg = state.config.read();
    let dict = cfg.dictionary.clone();
    drop(cfg);
    hotword_candidate::ready_candidates(&dict)
}

#[tauri::command]
fn cmd_hotword_dismiss(token: String) {
    hotword_candidate::dismiss(&token);
}

#[tauri::command]
fn cmd_hotword_clear_all() {
    hotword_candidate::clear_all();
}

// ---------- (P0 wave 3) 通用 authed HTTP 命令 ----------
//
// 给前端 lib/wave3-api.ts 跑 17 个 wave 3 endpoint 用。所有调用复用 Account
// 的 ApiClient（同一份 token / refresh single-flight / X-User-Plan tap），
// 不另起 reqwest::Client；这样 401 自动 refresh / device_limit 等错误码也跟
// 主路径一致。
//
// 设计取舍：
//   • 返 serde_json::Value 让前端 TypeScript 自己定义 DTO；后端响应 schema
//     一变不需要 Rust 同步动。
//   • body 从前端 JSON 字符串 / object 都接（用 Value）—— 比 generic 简单。
//   • 错误转 String：ApiError::friendly_message 已经是给用户看的人话。

#[tauri::command]
async fn cmd_account_authed_get(
    state: tauri::State<'_, Arc<AppState>>,
    path: String,
) -> Result<serde_json::Value, String> {
    let acc = account_handle(&state)?;
    acc.api()
        .get::<serde_json::Value>(&path)
        .await
        .map_err(|e| e.friendly_message())
}

#[tauri::command]
async fn cmd_account_authed_post(
    state: tauri::State<'_, Arc<AppState>>,
    path: String,
    body: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let acc = account_handle(&state)?;
    acc.api()
        .post::<serde_json::Value, serde_json::Value>(&path, &body, true)
        .await
        .map_err(|e| e.friendly_message())
}

#[tauri::command]
async fn cmd_account_authed_put(
    state: tauri::State<'_, Arc<AppState>>,
    path: String,
    body: serde_json::Value,
    // Wave 4 Stage 2 — companion PUT 用 If-Match: <version>；其它端点不传时
    // 默认 None → 转空切片，零兼容代价。
    headers: Option<std::collections::HashMap<String, String>>,
) -> Result<serde_json::Value, String> {
    let acc = account_handle(&state)?;
    let extra: Vec<(&str, String)> = headers
        .as_ref()
        .map(|m| m.iter().map(|(k, v)| (k.as_str(), v.clone())).collect())
        .unwrap_or_default();
    acc.api()
        .put::<serde_json::Value, serde_json::Value>(&path, &body, &extra)
        .await
        .map_err(|e| e.friendly_message())
}

#[tauri::command]
async fn cmd_account_authed_delete(
    state: tauri::State<'_, Arc<AppState>>,
    path: String,
) -> Result<(), String> {
    let acc = account_handle(&state)?;
    acc.api().delete(&path).await.map_err(|e| e.friendly_message())
}
