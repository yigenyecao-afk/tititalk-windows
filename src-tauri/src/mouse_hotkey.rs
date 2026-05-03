//! (v0.8.4 P2-1) 鼠标侧键 hotkey —— XBUTTON1 (back) / XBUTTON2 (forward) toggle
//! 录音。跟主键盘 hotkey 并行，不互斥。默认关（要求鼠标有侧键且用户主动开）。
//!
//! 实现：单独 spawn 一根线程跑 WH_MOUSE_LL hook + 自己的 message loop，跟键盘
//! hook 解耦避免互相阻塞。callback 内拿 OnceCell 拿 ctx → state → 翻 phase。
//! `WM_XBUTTONDOWN` 高 16 位是 XButton number (1=back, 2=forward)。
//!
//! 跟 hotkey.rs 同样防 auto-repeat：mouse hook 不会重复发 XBUTTONDOWN（除非用户
//! 真按了第二次），所以不需要 50ms debounce。

use std::sync::Arc;

use crate::state::{AppState, PipelinePhase};

#[cfg(windows)]
use once_cell::sync::OnceCell;

#[cfg(windows)]
struct MouseHookContext {
    state: Arc<AppState>,
}

#[cfg(windows)]
static MOUSE_HOOK_CTX: OnceCell<Arc<MouseHookContext>> = OnceCell::new();

pub fn spawn_mouse_hook_thread(state: Arc<AppState>) {
    #[cfg(windows)]
    {
        let ctx = Arc::new(MouseHookContext { state });
        let ctx_for_thread = ctx.clone();
        match std::thread::Builder::new()
            .name("tititalk-mouse-hotkey".into())
            .spawn(move || run_mouse_hook_loop(ctx_for_thread))
        {
            Ok(_) => log::info!("mouse hotkey hook thread spawned"),
            Err(e) => log::error!("FATAL: spawn mouse hook thread failed: {e}"),
        }
    }
    #[cfg(not(windows))]
    {
        let _ = state;
    }
}

#[cfg(windows)]
fn run_mouse_hook_loop(ctx: Arc<MouseHookContext>) {
    use windows::Win32::Foundation::HINSTANCE;
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::UI::WindowsAndMessaging::{
        DispatchMessageW, GetMessageW, SetWindowsHookExW, TranslateMessage, UnhookWindowsHookEx,
        MSG, WH_MOUSE_LL,
    };

    unsafe {
        let h_instance: HINSTANCE = GetModuleHandleW(None).unwrap_or_default().into();
        let hook = match SetWindowsHookExW(WH_MOUSE_LL, Some(low_level_mouse_proc), h_instance, 0) {
            Ok(h) => h,
            Err(e) => {
                log::error!("FATAL: SetWindowsHookExW(WH_MOUSE_LL) failed: {e}");
                return;
            }
        };
        let _ = MOUSE_HOOK_CTX.set(ctx);
        log::info!("mouse LL hook installed");

        let mut msg = MSG::default();
        while GetMessageW(&mut msg, None, 0, 0).into() {
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
        let _ = UnhookWindowsHookEx(hook);
    }
}

#[cfg(windows)]
unsafe extern "system" fn low_level_mouse_proc(
    n_code: i32,
    w_param: windows::Win32::Foundation::WPARAM,
    l_param: windows::Win32::Foundation::LPARAM,
) -> windows::Win32::Foundation::LRESULT {
    use windows::Win32::UI::WindowsAndMessaging::{
        CallNextHookEx, HC_ACTION, MSLLHOOKSTRUCT, WM_XBUTTONDOWN,
    };

    if n_code == HC_ACTION as i32 && w_param.0 as u32 == WM_XBUTTONDOWN {
        if let Some(ctx) = MOUSE_HOOK_CTX.get() {
            let cfg = ctx.state.config.read();
            let bound = cfg.mouse_side_button;
            drop(cfg);
            if bound != 0 {
                let ms = &*(l_param.0 as *const MSLLHOOKSTRUCT);
                // mouseData 高 16 位是 XButton 编号（1 / 2）
                let xbutton = ((ms.mouseData >> 16) & 0xFFFF) as u32;
                if xbutton == bound {
                    log::info!("mouse hotkey: XBUTTON{xbutton} → toggle");
                    let s = ctx.state.clone();
                    std::thread::spawn(move || match s.current_phase() {
                        PipelinePhase::Recording => s.request_phase(PipelinePhase::Stopping),
                        _ => s.request_phase(PipelinePhase::Recording),
                    });
                }
            }
        }
    }
    CallNextHookEx(None, n_code, w_param, l_param)
}
