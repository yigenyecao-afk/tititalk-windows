use tauri::{
    image::Image,
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager,
};

use std::sync::Arc;
use std::time::Duration;

use crate::state::{AppState, PipelinePhase};

/// Install the system tray. We deliberately do NOT use `app.trayIcon` in
/// `tauri.conf.json` — that creates a SECOND auto-tray which collides with
/// this builder (you'd see two icons in the systray, one transparent + one
/// real). All tray ownership lives here.
///
/// `with_id("main-tray")` lets us look it up later via `app.tray_by_id`.
/// `.icon(default_window_icon)` is required — without it Tauri 2 falls
/// back to a transparent placeholder (this was the bug).
pub fn install_tray(app: &AppHandle) -> tauri::Result<()> {
    let open_item = MenuItem::with_id(app, "open", "打开 TiTiTalk", true, None::<&str>)?;
    let settings_item = MenuItem::with_id(app, "settings", "设置…", true, None::<&str>)?;
    let about_item = MenuItem::with_id(app, "about", "关于", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit_item = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;

    let menu = Menu::with_items(
        app,
        &[&open_item, &settings_item, &separator, &about_item, &quit_item],
    )?;

    let mut builder = TrayIconBuilder::with_id("main-tray")
        .tooltip("TiTiTalk · 按住快捷键说话")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" | "settings" => show_main(app),
            "about" => show_main(app),
            "quit" => graceful_quit(app),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            // Both Up and Down work in different Windows situations; use Up
            // to match common click semantics. `Down` would fire on press
            // before user lifts mouse → can feel laggy on slow systems.
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main(tray.app_handle());
            }
        });

    // Use the bundled app icon. Falling back to default_window_icon means
    // we always have a real icon (vs the transparent placeholder bug).
    if let Some(icon) = app.default_window_icon().cloned() {
        builder = builder.icon(icon).icon_as_template(false);
    } else {
        // Last-ditch: bake the bundled PNG bytes in (same file the bundler uses).
        // Without an icon Tauri 2 shows transparent — that's the regression.
        if let Ok(img) = Image::from_bytes(include_bytes!("../icons/icon.png")) {
            builder = builder.icon(img).icon_as_template(false);
        }
    }

    let _tray = builder.build(app)?;
    Ok(())
}

fn show_main(app: &AppHandle) {
    ensure_main_visible(app);
}

/// 显示 main window 之前先确认它落在某个还存在的显示器上。
/// 之前 bug：用户上次把窗口拖到外接屏 (2000, 200) 然后拔掉外接屏，
/// 重启 / 从托盘点「打开」会调 show，但坐标还是 (2000, 200) —— 在当前
/// 仅剩主屏的几何空间外，窗口看不见。Tauri 的 current_monitor() 在窗口
/// 落在所有 monitor 之外时返 None；此时 center() 把它拉回主屏中央。
/// 本 helper 只对「明确不可见」做处理，不动用户主动放好的位置。
pub fn ensure_main_visible(app: &AppHandle) {
    let Some(w) = app.get_webview_window("main") else { return };
    // current_monitor() 在 win 上当 outer_position 不在任何 monitor 时返 None。
    let off_screen = matches!(w.current_monitor(), Ok(None));
    if off_screen {
        let _ = w.center();
    }
    let _ = w.show();
    let _ = w.unminimize();
    let _ = w.set_focus();
}

/// 把 tray tooltip 跟当前 phase 联动 —— 用户最小化主窗口后，如果不弹
/// pill（默认关），唯一能看出「我在录」的视觉信号就是 tray hover 提示。
/// 本来全程恒定 "TiTiTalk · 按住快捷键说话"，跟没装一样。
/// 不换 icon 是因为换 ico 涉及加新资源 + 多分辨率切换，tooltip 是零成本。
pub fn update_tooltip_for_phase(app: &AppHandle, phase: PipelinePhase) {
    let label = match phase {
        PipelinePhase::Idle | PipelinePhase::Done => "TiTiTalk · 按住快捷键说话",
        PipelinePhase::Recording => "TiTiTalk · 🎙️ 录音中…",
        PipelinePhase::Stopping => "TiTiTalk · 收尾中…",
        PipelinePhase::Transcribing => "TiTiTalk · 转写中…",
        PipelinePhase::Polishing => "TiTiTalk · 润色中…",
        PipelinePhase::Inserting => "TiTiTalk · 插入中…",
        PipelinePhase::Failed => "TiTiTalk · 上次失败，按热键再试",
    };
    if let Some(tray) = app.tray_by_id("main-tray") {
        let _ = tray.set_tooltip(Some(label));
    }
}

/// 之前 bug：tray「退出」直接 app.exit(0)，正在录的最后一段会变孤儿
/// 请求（消耗配额拿不回结果），settings 改了但 3s debounce 还没到的
/// 也丢了。现在：先翻 Recording → Stopping 让 audio thread 收尾刷帧，
/// 给 cloud sync 几百 ms 排空 in-flight PUT，然后 exit。
/// 600ms 是 trade-off：太长用户感觉「关不掉」；太短 sync 来不及落盘。
/// 实测云端单 PUT ~150ms，配上 sync.stop() 写本地 version 文件足够。
fn graceful_quit(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Some(state) = app.try_state::<Arc<AppState>>() {
            let st = state.inner().clone();
            // 录音中先翻去 Stopping，让 audio thread 收尾（不再继续 transcribe，
            // 但已经在录的 buffer 不会被腰斩）。
            if matches!(st.current_phase(), PipelinePhase::Recording) {
                st.request_phase(PipelinePhase::Stopping);
            }
            // 让 cloud sync 把 in-flight PUT 排空 + 解绑订阅。
            let acc = st.account.read().clone();
            if let Some(acc) = acc {
                if let Some(sync) = acc.cloud_sync().await {
                    sync.stop().await;
                }
            }
        }
        // 给 audio thread + reqwest 一点时间 flush
        tokio::time::sleep(Duration::from_millis(600)).await;
        app.exit(0);
    });
}
