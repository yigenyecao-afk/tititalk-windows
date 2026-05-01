//! Cursor-aware text insertion. Two strategies:
//!  1. SendInput Unicode events — works in 95% of native apps (Notepad, VSCode, Office,
//!     WeChat input field, browser fields).
//!  2. Clipboard + Ctrl+V fallback — for IME-eating apps and very long strings.
//!
//! For v0.1 we always go through clipboard+paste; SendInput per-codepoint works but
//! drops characters under high system load and on apps that filter WM_CHAR. Clipboard+
//! paste is rock-solid and matches what Mac TiTiTalk effectively does via NSPasteboard.

use anyhow::{anyhow, Context};

#[cfg(windows)]
use windows::Win32::{
    Foundation::HANDLE,
    System::{
        DataExchange::{CloseClipboard, EmptyClipboard, OpenClipboard, SetClipboardData},
        Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE},
        Ole::CF_UNICODETEXT,
    },
    UI::Input::KeyboardAndMouse::{
        SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYBD_EVENT_FLAGS, KEYEVENTF_KEYUP,
        VK_CONTROL, VK_V,
    },
};

pub fn insert_text(text: &str, _also_copy: bool) -> anyhow::Result<()> {
    if text.is_empty() {
        return Ok(());
    }
    copy_to_clipboard(text)?;
    paste_from_clipboard()?;
    Ok(())
}

#[cfg(windows)]
pub fn copy_to_clipboard(text: &str) -> anyhow::Result<()> {
    use std::iter::once;
    let wide: Vec<u16> = text.encode_utf16().chain(once(0)).collect();
    let bytes = wide.len() * std::mem::size_of::<u16>();

    unsafe {
        OpenClipboard(None).context("OpenClipboard 失败")?;
        // Ensure we close it even on early return below.
        let _guard = scopeguard::guard((), |_| {
            let _ = CloseClipboard();
        });
        EmptyClipboard().context("EmptyClipboard 失败")?;

        let h_mem = GlobalAlloc(GMEM_MOVEABLE, bytes).context("GlobalAlloc 失败")?;
        let dst = GlobalLock(h_mem) as *mut u16;
        if dst.is_null() {
            return Err(anyhow!("GlobalLock 返回 null"));
        }
        std::ptr::copy_nonoverlapping(wide.as_ptr(), dst, wide.len());
        let _ = GlobalUnlock(h_mem);

        SetClipboardData(CF_UNICODETEXT.0 as u32, HANDLE(h_mem.0))
            .context("SetClipboardData 失败")?;
    }
    Ok(())
}

#[cfg(windows)]
fn paste_from_clipboard() -> anyhow::Result<()> {
    unsafe {
        let inputs = [
            // Ctrl down
            INPUT {
                r#type: INPUT_KEYBOARD,
                Anonymous: INPUT_0 {
                    ki: KEYBDINPUT {
                        wVk: VK_CONTROL,
                        wScan: 0,
                        dwFlags: KEYBD_EVENT_FLAGS(0),
                        time: 0,
                        dwExtraInfo: 0,
                    },
                },
            },
            // V down
            INPUT {
                r#type: INPUT_KEYBOARD,
                Anonymous: INPUT_0 {
                    ki: KEYBDINPUT {
                        wVk: VK_V,
                        wScan: 0,
                        dwFlags: KEYBD_EVENT_FLAGS(0),
                        time: 0,
                        dwExtraInfo: 0,
                    },
                },
            },
            // V up
            INPUT {
                r#type: INPUT_KEYBOARD,
                Anonymous: INPUT_0 {
                    ki: KEYBDINPUT {
                        wVk: VK_V,
                        wScan: 0,
                        dwFlags: KEYEVENTF_KEYUP,
                        time: 0,
                        dwExtraInfo: 0,
                    },
                },
            },
            // Ctrl up
            INPUT {
                r#type: INPUT_KEYBOARD,
                Anonymous: INPUT_0 {
                    ki: KEYBDINPUT {
                        wVk: VK_CONTROL,
                        wScan: 0,
                        dwFlags: KEYEVENTF_KEYUP,
                        time: 0,
                        dwExtraInfo: 0,
                    },
                },
            },
        ];
        let sent = SendInput(&inputs, std::mem::size_of::<INPUT>() as i32);
        if sent != inputs.len() as u32 {
            return Err(anyhow!("SendInput 仅注入 {sent}/{}", inputs.len()));
        }
    }
    Ok(())
}

#[cfg(not(windows))]
pub fn copy_to_clipboard(_text: &str) -> anyhow::Result<()> {
    Err(anyhow!("clipboard 仅 Windows"))
}
#[cfg(not(windows))]
fn paste_from_clipboard() -> anyhow::Result<()> {
    Err(anyhow!("paste 仅 Windows"))
}

#[allow(dead_code)]
#[cfg(windows)]
mod scopeguard {
    pub struct ScopeGuard<T, F: FnOnce(T)> {
        value: Option<T>,
        f: Option<F>,
    }
    impl<T, F: FnOnce(T)> Drop for ScopeGuard<T, F> {
        fn drop(&mut self) {
            if let (Some(v), Some(f)) = (self.value.take(), self.f.take()) {
                f(v);
            }
        }
    }
    pub fn guard<T, F: FnOnce(T)>(value: T, f: F) -> ScopeGuard<T, F> {
        ScopeGuard { value: Some(value), f: Some(f) }
    }
}
