//! Cursor-aware text insertion. Two strategies:
//!  1. SendInput Unicode events — works in 95% of native apps (Notepad, VSCode, Office,
//!     WeChat input field, browser fields).
//!  2. Clipboard + Ctrl+V fallback — for IME-eating apps and very long strings.
//!
//! For v0.1 we always go through clipboard+paste; SendInput per-codepoint works but
//! drops characters under high system load and on apps that filter WM_CHAR. Clipboard+
//! paste is rock-solid and matches what Mac TiTiTalk effectively does via NSPasteboard.

use std::sync::Arc;

use anyhow::{anyhow, Context};

use crate::state::{AppState, PipelineEvent};

#[cfg(windows)]
use windows::Win32::{
    Foundation::HANDLE,
    System::{
        DataExchange::{
            CloseClipboard, EmptyClipboard, GetClipboardData, OpenClipboard, SetClipboardData,
        },
        Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE},
        Ole::CF_UNICODETEXT,
    },
    UI::Input::KeyboardAndMouse::{
        SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYBD_EVENT_FLAGS, KEYEVENTF_KEYUP,
        VK_CONTROL, VK_V,
    },
};

pub fn insert_text(text: &str, also_copy: bool, state: Option<Arc<AppState>>) -> anyhow::Result<()> {
    if text.is_empty() {
        return Ok(());
    }
    // Snapshot the current clipboard text BEFORE we overwrite it. Mac
    // clients call this `restoreClipboardAfterPaste` and have a setting
    // for it; on Windows we make it the default — the alternative is the
    // user copies a URL, presses CapsLock to insert a quick voice note,
    // and finds their URL gone next time they paste. `also_copy=true`
    // skips restoration: that's the user explicitly saying "I want the
    // transcript on the clipboard for re-pasting later".
    let saved = if also_copy { None } else { peek_clipboard_text() };
    copy_to_clipboard(text)?;
    paste_from_clipboard()?;

    // Wait long enough for Ctrl+V to actually drain through the target
    // app's message queue before we overwrite the clipboard with the
    // restored value. 之前 350ms 在 Office / Electron / 重 IME 环境下
    // 偶尔够呛 —— Word 收到 paste 但还没读完剪贴板，我们就把它换成旧
    // 内容，实际粘贴成「上一份剪贴板」。改 600ms 是 trade-off：用户
    // 一般不会在 600ms 内手动 ⌘V，而 Office / Notion / VSCode 都能在
    // 这个窗口内 drain 完。restore 是 async thread，主流水线不挡。
    if let Some(prior) = saved {
        let prior = prior.clone();
        let state_for_thread = state.clone();
        std::thread::Builder::new()
            .name("tititalk-clipboard-restore".into())
            .spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(600));
                if let Err(e) = copy_to_clipboard(&prior) {
                    // (P0-6 2026-05-06) 之前 restore 失败仅 warn 日志，用户
                    // 完全不知道——下次 ⌘V 拿到的是 transcript 而非他原来
                    // copy 的 URL。改：emit pill error event，pill UI 显示
                    // 「原剪贴板未恢复，可手动复制：[预览]」。
                    log::warn!("clipboard restore failed: {e}");
                    if let Some(st) = state_for_thread {
                        let preview = if prior.chars().count() > 24 {
                            format!("{}…", prior.chars().take(24).collect::<String>())
                        } else {
                            prior.clone()
                        };
                        st.emit(PipelineEvent::Error {
                            message: format!("原剪贴板未能恢复：{preview}（请手动复制）"),
                        });
                    }
                }
            })
            .ok();
    }
    Ok(())
}

/// Read whatever's currently on the clipboard as a UTF-16 string. Returns
/// None for non-text clipboard contents (image, file list, etc.) — those
/// can't be losslessly snapshotted via CF_UNICODETEXT, so we let them get
/// overwritten rather than try to restore a corrupted version.
#[cfg(windows)]
fn peek_clipboard_text() -> Option<String> {
    unsafe {
        if OpenClipboard(None).is_err() {
            return None;
        }
        let _guard = scopeguard::guard((), |_| {
            let _ = CloseClipboard();
        });
        let h = match GetClipboardData(CF_UNICODETEXT.0 as u32) {
            Ok(h) if !h.is_invalid() => h,
            _ => return None,
        };
        let ptr = GlobalLock(windows::Win32::Foundation::HGLOBAL(h.0)) as *const u16;
        if ptr.is_null() {
            return None;
        }
        // Find the trailing NUL — CF_UNICODETEXT is NUL-terminated.
        let mut len = 0usize;
        while *ptr.add(len) != 0 {
            len += 1;
            // Defensive cap so a corrupt buffer can't infinite-loop us.
            if len > 1_000_000 {
                let _ = GlobalUnlock(windows::Win32::Foundation::HGLOBAL(h.0));
                return None;
            }
        }
        let slice = std::slice::from_raw_parts(ptr, len);
        let s = String::from_utf16(slice).ok();
        let _ = GlobalUnlock(windows::Win32::Foundation::HGLOBAL(h.0));
        s
    }
}

#[cfg(not(windows))]
fn peek_clipboard_text() -> Option<String> { None }

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
