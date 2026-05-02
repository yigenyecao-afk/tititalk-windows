//! Push-to-talk + toggle + hybrid hotkey via low-level keyboard hook (`WH_KEYBOARD_LL`).
//!
//! `RegisterHotKey` only delivers single-shot WM_HOTKEY messages on press, which
//! is fine for toggle but bad UX for "hold to talk". The LL hook gives us KEYDOWN
//! and KEYUP for any virtual-key, which is exactly the behavior macOS Fn-hold has.
//!
//! Three modes (config.hotkey_mode, 对齐 mac AppDefaults):
//!   • `push_to_talk` — 按下 ≥ min_hold_ms 开录，松手停。（默认；防误触）
//!   • `toggle`        — 按一下开，再按一下停。（KEYUP 不动作；KEYDOWN 翻转）
//!   • `hybrid`        — 短按（< hybrid_press_threshold_ms）当 toggle，长按当 PTT。
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
    /// Wall-clock time when the configured key went down. Used for both PTT
    /// min-hold filter and hybrid tap-vs-hold discrimination.
    pressed_at: parking_lot::Mutex<Option<Instant>>,
    /// Whether we've actually told the pipeline to start (passed the gate).
    /// PTT/hybrid: set after min-hold timer fires while still pressed.
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
    use windows::Win32::UI::WindowsAndMessaging::{
        CallNextHookEx, HC_ACTION, KBDLLHOOKSTRUCT, WM_KEYDOWN, WM_KEYUP, WM_SYSKEYDOWN,
        WM_SYSKEYUP,
    };

    if n_code == HC_ACTION as i32 {
        let kb = &*(l_param.0 as *const KBDLLHOOKSTRUCT);
        let msg = w_param.0 as u32;

        if let Some(ctx) = HOOK_CTX.get() {
            let cfg = ctx.state.config.read();
            let target_vk = cfg.hotkey_vk;
            let min_hold = cfg.min_hold_ms as u128;
            let mode = cfg.hotkey_mode.clone();
            let hybrid_threshold = cfg.hybrid_press_threshold_ms as u128;
            drop(cfg);

            if kb.vkCode == target_vk {
                handle_target_key(ctx, msg, min_hold, &mode, hybrid_threshold);

                // For "stateful" toggle keys (CapsLock 0x14, NumLock 0x90,
                // ScrollLock 0x91), the OS would otherwise also flip its
                // toggle state on every press → user holds CapsLock to
                // record, lifts it, types in caps for the rest of the day.
                // We swallow the event by returning 1 instead of calling
                // CallNextHookEx. Side-effect: while CapsLock is bound to
                // the hotkey, the user can't use it for its normal toggle
                // purpose — that's the explicit trade-off of choosing it.
                let is_toggle_key = matches!(target_vk, 0x14 | 0x90 | 0x91);
                let is_key_event = msg == WM_KEYDOWN
                    || msg == WM_KEYUP
                    || msg == WM_SYSKEYDOWN
                    || msg == WM_SYSKEYUP;
                if is_toggle_key && is_key_event {
                    return windows::Win32::Foundation::LRESULT(1);
                }
            }
        }
    }
    CallNextHookEx(None, n_code, w_param, l_param)
}

#[cfg(windows)]
unsafe fn handle_target_key(
    ctx: &Arc<HookContext>,
    msg: u32,
    min_hold: u128,
    mode: &str,
    hybrid_threshold: u128,
) {
    use std::time::Duration;
    use windows::Win32::UI::WindowsAndMessaging::{WM_KEYDOWN, WM_KEYUP, WM_SYSKEYDOWN, WM_SYSKEYUP};
    match msg {
        m if m == WM_KEYDOWN || m == WM_SYSKEYDOWN => {
            // The hook receives auto-repeat KEYDOWNs while held. Only act on first one.
            let mut pressed = ctx.pressed_at.lock();
            if pressed.is_none() {
                *pressed = Some(Instant::now());
                drop(pressed);

                match mode {
                    "toggle" => {
                        // 立即翻转 phase；不要等 KEYUP，键盘按下就给反馈最即时。
                        let s = ctx.state.clone();
                        match s.current_phase() {
                            PipelinePhase::Recording => s.request_phase(PipelinePhase::Stopping),
                            _ => s.request_phase(PipelinePhase::Recording),
                        }
                    }
                    "hybrid" => {
                        // 长按超阈值 → 进入 PTT 模式（armed=true），
                        // 否则 KEYUP 时按 tap 处理（toggle 翻转）。
                        let ctx2 = ctx.clone();
                        std::thread::Builder::new()
                            .name("tititalk-hybrid-gate".into())
                            .spawn(move || {
                                std::thread::sleep(Duration::from_millis(hybrid_threshold as u64));
                                let still_held = ctx2.pressed_at.lock().is_some();
                                if still_held {
                                    *ctx2.armed.lock() = true;
                                    ctx2.state.request_phase(PipelinePhase::Recording);
                                }
                            })
                            .ok();
                    }
                    _ => {
                        // push_to_talk（默认）
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
            }
        }
        m if m == WM_KEYUP || m == WM_SYSKEYUP => {
            let mut pressed = ctx.pressed_at.lock();
            let was_held = pressed.take();
            drop(pressed);

            let mut armed = ctx.armed.lock();
            let was_armed = *armed;
            *armed = false;
            drop(armed);

            match mode {
                "toggle" => {
                    // KEYDOWN 已处理；KEYUP 不动作。
                }
                "hybrid" => {
                    if was_armed {
                        // PTT 路径走完一轮 → 停。
                        ctx.state.request_phase(PipelinePhase::Stopping);
                    } else if let Some(t0) = was_held {
                        // 短按（tap） → toggle 翻转。
                        if t0.elapsed().as_millis() < hybrid_threshold {
                            let s = ctx.state.clone();
                            match s.current_phase() {
                                PipelinePhase::Recording => s.request_phase(PipelinePhase::Stopping),
                                _ => s.request_phase(PipelinePhase::Recording),
                            }
                        }
                    }
                }
                _ => {
                    // push_to_talk（默认）
                    if was_armed {
                        ctx.state.request_phase(PipelinePhase::Stopping);
                    } else if let Some(t0) = was_held {
                        log::debug!("hotkey tap ignored ({:?} < min_hold)", t0.elapsed());
                    }
                }
            }
        }
        _ => {}
    }
}
