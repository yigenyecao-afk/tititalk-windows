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
use std::time::{Duration, Instant};

use crate::state::{AppState, PipelinePhase};

/// 单 modifier KeyDown→KeyUp 上限（>= 即视为长按，重置）
#[cfg(windows)]
const DBL_MOD_TAP_MAX_MS: u128 = 200;
/// 两次 tap 间隔上限（> 即视为新一轮单击）
#[cfg(windows)]
const DBL_MOD_WINDOW_MS: u128 = 300;

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
    /// (v0.8.4 P2-2) 双修饰键 hotkey 状态机 ——
    ///   - dbl_mod_pressed_at: 当前 modifier 按下时刻（None=没按）
    ///   - dbl_mod_last_tap_at: 上次成功 tap (KeyDown→KeyUp <200ms) 落幕时刻
    /// 单 modifier KeyDown→KeyUp <200ms 算 tap；两次 tap 间隔 <300ms 触发 toggle。
    /// 期间任何其它 vk 按下都重置（避免打字时误触）。
    dbl_mod_pressed_at: parking_lot::Mutex<Option<Instant>>,
    dbl_mod_last_tap_at: parking_lot::Mutex<Option<Instant>>,
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
            dbl_mod_pressed_at: parking_lot::Mutex::new(None),
            dbl_mod_last_tap_at: parking_lot::Mutex::new(None),
        });
        // (v0.7.8) 先 spawn 线程；HOOK_CTX 在 hook 装上后再 set，避免装 hook
        // 失败留个指向死信的 ctx。
        let ctx_for_thread = ctx.clone();
        match std::thread::Builder::new()
            .name("tititalk-hotkey".into())
            .spawn(move || run_hook_loop(ctx_for_thread))
        {
            Ok(_) => log::info!("hotkey hook thread spawned"),
            Err(e) => log::error!("FATAL: spawn hotkey hook thread failed: {e} — 快捷键将完全不可用"),
        }
    }
    #[cfg(not(windows))]
    {
        let _ = state;
    }
}

#[cfg(windows)]
fn run_hook_loop(ctx: Arc<HookContext>) {
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
                log::error!("FATAL: SetWindowsHookExW failed: {e} — 快捷键将完全不可用，可能是 UAC/AV 拦截，提醒用户用「以管理员身份运行」试试");
                return;
            }
        };
        // (v0.7.8) hook 装好之后再 set HOOK_CTX —— 失败时不留指向死信的 ctx
        let _ = HOOK_CTX.set(ctx);
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
            let dbl_mod = cfg.double_modifier_key.clone();
            drop(cfg);

            // (v0.8.4 P2-2) 双修饰键检测 —— 跟主 hotkey 并行，不互斥。
            handle_double_modifier(ctx, msg, kb.vkCode, &dbl_mod);

            // (v0.8.4 backlog #4 #5) Ctrl+Alt+T → 翻译 / Ctrl+Alt+/ → 「随便问」
            // 同样跟主 hotkey 并行，监听 KEYDOWN 即触发（不跟 PTT 抢 KEYUP）。
            handle_secondary_combo(ctx, msg, kb.vkCode);

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
                        if let Err(e) = std::thread::Builder::new()
                            .name("tititalk-hybrid-gate".into())
                            .spawn(move || {
                                std::thread::sleep(Duration::from_millis(hybrid_threshold as u64));
                                let still_held = ctx2.pressed_at.lock().is_some();
                                if still_held {
                                    *ctx2.armed.lock() = true;
                                    ctx2.state.request_phase(PipelinePhase::Recording);
                                }
                            })
                        {
                            log::error!("hybrid gate thread spawn failed: {e}");
                        }
                    }
                    _ => {
                        // push_to_talk（默认）
                        let ctx2 = ctx.clone();
                        if let Err(e) = std::thread::Builder::new()
                            .name("tititalk-hold-gate".into())
                            .spawn(move || {
                                std::thread::sleep(Duration::from_millis(min_hold as u64));
                                let still_held = ctx2.pressed_at.lock().is_some();
                                if still_held {
                                    *ctx2.armed.lock() = true;
                                    ctx2.state.request_phase(PipelinePhase::Recording);
                                }
                            })
                        {
                            log::error!("hold gate thread spawn failed: {e}");
                        }
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
                    // push_to_talk
                    if was_armed {
                        ctx.state.request_phase(PipelinePhase::Stopping);
                    } else if let Some(t0) = was_held {
                        let elapsed = t0.elapsed().as_millis();
                        if elapsed >= min_hold {
                            // (v0.7.8 race-comp) timer 还没 fire 就被 KEYUP 抢先 →
                            // pressed_at 被清，timer 看到 still_held=false 不开。但
                            // elapsed >= min_hold 说明用户真按了「够久」，此时 fire
                            // 一次 toggle (start)，让用户再按一次自然停。比「无反应」
                            // 体感好得多 — Mac 端 NSEvent monitor 没这个 race。
                            log::info!(
                                "hotkey PTT race compensated: elapsed={}ms ≥ min_hold={}ms — firing toggle Recording",
                                elapsed, min_hold
                            );
                            let s = ctx.state.clone();
                            match s.current_phase() {
                                PipelinePhase::Recording => {
                                    s.request_phase(PipelinePhase::Stopping)
                                }
                                _ => s.request_phase(PipelinePhase::Recording),
                            }
                        } else {
                            log::debug!("hotkey tap ignored ({}ms < min_hold {}ms)", elapsed, min_hold);
                        }
                    }
                }
            }
        }
        _ => {}
    }
}

/// (v0.8.4 backlog #4 #5) 检测 Ctrl+Alt+T (translate) 跟 Ctrl+Alt+/ (assistant)
/// KEYDOWN 即触发；GetAsyncKeyState 看 Ctrl/Alt 是否同时按住。
/// 用 KEYDOWN 而不是 KEYUP：用户按住组合键时，第一次 KEYDOWN 即响应，KEYUP 来时
/// 已经在跑翻译，避免 KEYUP 二次 fire。auto-repeat KEYDOWN 用 dbl_mod_pressed_at
/// 之外的 mech 拦下：既然 fire 后立即 spawn 任务且任务自带 80ms+ 等待，期间
/// 同一组合的 auto-repeat fire 也无害（最多多调一次 LLM）。这里加一个 50ms
/// 的 debounce 兜底防误。
#[cfg(windows)]
fn handle_secondary_combo(ctx: &Arc<HookContext>, msg: u32, vk: u32) {
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_CONTROL, VK_MENU};
    use windows::Win32::UI::WindowsAndMessaging::{WM_KEYDOWN, WM_SYSKEYDOWN};

    let is_keydown = msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN;
    if !is_keydown {
        return;
    }
    // 仅这两个目标 vk 才往下查 modifier 状态
    let is_t = vk == 0x54;       // 'T'
    let is_slash = vk == 0xBF;   // VK_OEM_2 是常见 ASCII '/'
    if !is_t && !is_slash {
        return;
    }
    // 检查 Ctrl + Alt 都按住（GetAsyncKeyState 高位 = 当前按下）
    let ctrl_down = (unsafe { GetAsyncKeyState(VK_CONTROL.0 as i32) } as u16) & 0x8000 != 0;
    let alt_down = (unsafe { GetAsyncKeyState(VK_MENU.0 as i32) } as u16) & 0x8000 != 0;
    if !(ctrl_down && alt_down) {
        return;
    }
    // 50ms debounce —— 防 auto-repeat 重复触发
    {
        static LAST_FIRE: parking_lot::Mutex<Option<Instant>> = parking_lot::Mutex::new(None);
        let mut g = LAST_FIRE.lock();
        if let Some(t) = *g {
            if t.elapsed().as_millis() < 50 {
                return;
            }
        }
        *g = Some(Instant::now());
    }

    if is_t {
        let cfg = ctx.state.config.read();
        let enabled = cfg.translate_hotkey_enabled;
        drop(cfg);
        if enabled {
            log::info!("hotkey: Ctrl+Alt+T → translate");
            crate::translate::trigger(ctx.state.clone());
        }
    } else if is_slash {
        let cfg = ctx.state.config.read();
        let enabled = cfg.assistant_hotkey_enabled;
        drop(cfg);
        if enabled {
            log::info!("hotkey: Ctrl+Alt+/ → assistant");
            crate::assistant::trigger(ctx.state.clone());
        }
    }
}

/// (v0.8.4 P2-2) 双修饰键 hotkey ——
/// 单 modifier (Shift/Ctrl/Alt/Win) 在 200ms 内 KeyDown→KeyUp = 1 次 tap，
/// 两次 tap 间隔 < 300ms 触发 toggle（同主 hotkey 行为）。
/// 期间任何「非目标 modifier 的 vk」KeyDown 立即重置（避免打字时误触）。
#[cfg(windows)]
fn handle_double_modifier(ctx: &Arc<HookContext>, msg: u32, vk: u32, dbl_mod: &str) {
    use windows::Win32::UI::WindowsAndMessaging::{WM_KEYDOWN, WM_KEYUP, WM_SYSKEYDOWN, WM_SYSKEYUP};
    if dbl_mod.is_empty() {
        return;
    }
    let target_vks: &[u32] = match dbl_mod {
        "shift" => &[0xA0, 0xA1],         // VK_LSHIFT, VK_RSHIFT
        "ctrl"  => &[0xA2, 0xA3],         // VK_LCONTROL, VK_RCONTROL
        "opt"   => &[0xA4, 0xA5],         // VK_LMENU, VK_RMENU (Alt)
        "cmd"   => &[0x5B, 0x5C],         // VK_LWIN, VK_RWIN
        _ => return,
    };
    let is_target = target_vks.contains(&vk);
    let is_keydown = msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN;
    let is_keyup = msg == WM_KEYUP || msg == WM_SYSKEYUP;

    if !is_target {
        // 任何其它 vk 按下 → 重置（用户在打字，Shift+a 不算）
        if is_keydown {
            *ctx.dbl_mod_pressed_at.lock() = None;
            *ctx.dbl_mod_last_tap_at.lock() = None;
        }
        return;
    }

    if is_keydown {
        // LL hook 持续按住会重复 KEYDOWN，只在 None→Some 时记
        let mut p = ctx.dbl_mod_pressed_at.lock();
        if p.is_none() {
            *p = Some(Instant::now());
        }
        return;
    }
    if is_keyup {
        let pressed = ctx.dbl_mod_pressed_at.lock().take();
        let Some(start) = pressed else { return };
        let dur = start.elapsed().as_millis();
        if dur >= DBL_MOD_TAP_MAX_MS {
            // 长按 → 不算 tap，重置
            *ctx.dbl_mod_last_tap_at.lock() = None;
            return;
        }
        // 这是一次 tap
        let now = Instant::now();
        let mut last = ctx.dbl_mod_last_tap_at.lock();
        let triggered = match *last {
            Some(t) if t.elapsed().as_millis() < DBL_MOD_WINDOW_MS => {
                *last = None;
                true
            }
            _ => {
                *last = Some(now);
                false
            }
        };
        drop(last);
        if triggered {
            log::info!("hotkey: double-modifier {dbl_mod} triggered toggle");
            // 跟主 hotkey toggle 同行为：录音中 → Stopping，否则 → Recording
            let s = ctx.state.clone();
            // 异步推到主 runtime，避免在 LL hook 线程里 block
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(0));
                match s.current_phase() {
                    PipelinePhase::Recording => s.request_phase(PipelinePhase::Stopping),
                    _ => s.request_phase(PipelinePhase::Recording),
                }
            });
        }
    }
}
