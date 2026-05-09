//! 应用感知 watcher — 5s tokio interval，前台窗口 .exe basename 变化时
//! 调 SpeechController::on_app_activated。Mac 那边走 NSWorkspace
//! didActivate notification；Win 这里仿 app_context.rs 的 1Hz 写法
//! 但更慢 (5s)，专给宠物冒泡用，不跟 telemetry 路径耦合。
//!
//! cooldown 在 SpeechController 内部（同 exe 不重发 + 3min 同 ctx 不重发），
//! 这里只负责"前台变化就告知"。

#![cfg(windows)]

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use super::speech::SpeechController;

pub struct AppWatcher {
    running: Arc<AtomicBool>,
}

impl AppWatcher {
    pub fn new() -> Self {
        Self {
            running: Arc::new(AtomicBool::new(false)),
        }
    }

    /// 5s 轮询；多次 start 是幂等的。
    pub fn start(&self, speech: Arc<SpeechController>) {
        if self.running.swap(true, Ordering::SeqCst) {
            return;
        }
        let running = self.running.clone();
        tauri::async_runtime::spawn(async move {
            let mut last_exe: Option<String> = None;
            while running.load(Ordering::SeqCst) {
                if let Some(exe) = current_foreground_exe() {
                    if Some(&exe) != last_exe.as_ref() {
                        last_exe = Some(exe.clone());
                        speech.on_app_activated(&exe);
                    }
                }
                tokio::time::sleep(Duration::from_secs(5)).await;
            }
        });
    }

    #[allow(dead_code)]
    pub fn stop(&self) {
        self.running.store(false, Ordering::SeqCst);
    }
}

/// 拿前台 .exe basename。失败返 None。
fn current_foreground_exe() -> Option<String> {
    use windows::Win32::Foundation::{CloseHandle, HWND, MAX_PATH};
    use windows::Win32::System::ProcessStatus::GetModuleFileNameExW;
    use windows::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};
    use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowThreadProcessId};

    unsafe {
        let hwnd: HWND = GetForegroundWindow();
        if hwnd.0.is_null() {
            return None;
        }
        let mut pid: u32 = 0;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        if pid == 0 {
            return None;
        }
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut path_buf = [0u16; MAX_PATH as usize];
        let path_len = GetModuleFileNameExW(handle, None, &mut path_buf);
        let _ = CloseHandle(handle);
        if path_len == 0 {
            return None;
        }
        let path = String::from_utf16_lossy(&path_buf[..path_len as usize]);
        let exe = std::path::Path::new(&path)
            .file_name()
            .and_then(|n| n.to_str())
            .map(|s| s.to_string())?;
        if exe.is_empty() {
            return None;
        }
        Some(exe)
    }
}

// 非 Windows 平台 stub
#[cfg(not(windows))]
pub mod stub {
    use std::sync::Arc;

    use super::super::speech::SpeechController;

    pub struct AppWatcher;
    impl AppWatcher {
        pub fn new() -> Self {
            Self
        }
        pub fn start(&self, _s: Arc<SpeechController>) {}
        pub fn stop(&self) {}
    }
}
