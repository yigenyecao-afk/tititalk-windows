//! Push-to-talk hotkey via low-level keyboard hook (`WH_KEYBOARD_LL`).
//!
//! `RegisterHotKey` only delivers single-shot WM_HOTKEY messages on press, which
//! is fine for toggle but bad UX for "hold to talk". The LL hook gives us KEYDOWN
//! and KEYUP for any virtual-key, which is exactly the behavior macOS Fn-hold has.
//!
//! We run the hook on its own thread with a Win32 message loop. The hook callback
//! must be a plain `extern "system" fn` so we route into a `static` channel to
//! reach the async pipeline owned by `AppState`.

use std::sync::Arc;
use std::time::Instant;

use crate::state::{AppState, PipelinePhase};

#[cfg(windows)]
use once_cell::sync::OnceCell;

#[cfg(windows)]
struct HookContext {
    state: Arc<AppState>,
    /// Wall-clock time when the configured key went down. Used to filter accidental
    /// taps shorter than `min_hold_ms`.
    pressed_at: parking_lot::Mutex<Option<Instant>>,
    /// Whether we've actually told the pipeline to start (passed the min-hold gate).
    armed: parking_lot::Mutex<bool>,
}

#[cfg(windows)]
static HOOK_CTX: OnceCell<Arc<HookContext>> = OnceCell::new();

pub fn spawn_hook_thread(state: Arc<AppState>) {
    #[cfg(windows)]
    {
        let ctx = Arc::new(HookContext {
            state,
            pressed_at: parking_lot::Mutex::new(None),
            armed: parking_lot::Mutex::new(false),
        });
        let _ = HOOK_CTX.set(ctx);

        std::thread::Builder::new()
            .name("tititalk-hotkey".into())
            .spawn(|| run_hook_loop())
            .expect("spawn hook thread");
    }
    #[cfg(not(windows))]
    {
        let _ = state;
    }
}

#[cfg(windows)]
fn run_hook_loop() {
    use windows::Win32::Foundation::HINSTANCE;
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::UI::WindowsAndMessaging::{
        DispatchMessageW, GetMessageW, SetWindowsHookExW, TranslateMessage, UnhookWindowsHookEx,
        MSG, WH_KEYBOARD_LL,
    };

    unsafe {
        let h_instance: HINSTANCE = GetModuleHandleW(None).unwrap_or_default().into();
        let hook = match SetWindowsHookExW(WH_KEYBOARD_LL, Some(low_level_kb_proc), h_instance, 0) {
            Ok(h) => h,
            Err(e) => {
                log::error!("SetWindowsHookExW failed: {e}");
                return;
            }
        };
        log::info!("keyboard LL hook installed");

        let mut msg = MSG::default();
        while GetMessageW(&mut msg, None, 0, 0).into() {
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
        let _ = UnhookWindowsHookEx(hook);
    }
}

#[cfg(windows)]
unsafe extern "system" fn low_level_kb_proc(
    n_code: i32,
    w_param: windows::Win32::Foundation::WPARAM,
    l_param: windows::Win32::Foundation::LPARAM,
) -> windows::Win32::Foundation::LRESULT {
    use std::time::Duration;
    use windows::Win32::UI::WindowsAndMessaging::{
        CallNextHookEx, HC_ACTION, KBDLLHOOKSTRUCT, WM_KEYDOWN, WM_KEYUP, WM_SYSKEYDOWN,
        WM_SYSKEYUP,
    };

    if n_code == HC_ACTION as i32 {
        let kb = &*(l_param.0 as *const KBDLLHOOKSTRUCT);
        let msg = w_param.0 as u32;

        if let Some(ctx) = HOOK_CTX.get() {
            let target_vk = ctx.state.config.read().hotkey_vk;
            let min_hold = ctx.state.config.read().min_hold_ms as u128;

            if kb.vkCode == target_vk {
                match msg {
                    m if m == WM_KEYDOWN || m == WM_SYSKEYDOWN => {
                        // The hook receives auto-repeat KEYDOWNs while held. Only act on first one.
                        let mut pressed = ctx.pressed_at.lock();
                        if pressed.is_none() {
                            *pressed = Some(Instant::now());
                            drop(pressed);

                            let ctx2 = ctx.clone();
                            std::thread::Builder::new()
                                .name("tititalk-hold-gate".into())
                                .spawn(move || {
                                    std::thread::sleep(Duration::from_millis(min_hold as u64));
                                    let still_held = ctx2.pressed_at.lock().is_some();
                                    if still_held {
                                        *ctx2.armed.lock() = true;
                                        ctx2.state.request_phase(PipelinePhase::Recording);
                                    }
                                })
                                .ok();
                        }
                    }
                    m if m == WM_KEYUP || m == WM_SYSKEYUP => {
                        let mut pressed = ctx.pressed_at.lock();
                        let was_held = pressed.take();
                        drop(pressed);

                        let mut armed = ctx.armed.lock();
                        if *armed {
                            *armed = false;
                            drop(armed);
                            ctx.state.request_phase(PipelinePhase::Stopping);
                        } else if let Some(t0) = was_held {
                            log::debug!("hotkey tap ignored ({:?} < min_hold)", t0.elapsed());
                        }
                    }
                    _ => {}
                }
            }
        }
    }
    CallNextHookEx(None, n_code, w_param, l_param)
}
