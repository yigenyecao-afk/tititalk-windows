// P0 wave 3 #2 + #12 — 前台窗口探测器（Win32 GetForegroundWindow → exe basename）。
//
// 1Hz 轮询：tauri 没有 NSWorkspace 那种 didActivate 通知，hook WH_SHELL 又
// 需要 DLL 注入；1 秒一次足够覆盖 persona 自动切 + 会议探针场景，CPU 几乎 0。
//
// 拿到的 exe 名（如 "DingTalk.exe"）emit 给前端 `app_context_changed` 事件，
// 前端 PersonaRouter / MeetingProbe 订阅即可。

#![cfg(windows)]

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Emitter};
use tokio::time::{Duration, sleep};

use crate::state::AppState;

#[derive(Debug, Clone, serde::Serialize)]
pub struct AppContextEvent {
    pub exe: String,
    pub window_title: String,
}

pub struct AppContextProbe {
    running: Arc<AtomicBool>,
}

impl AppContextProbe {
    pub fn new() -> Self {
        Self {
            running: Arc::new(AtomicBool::new(false)),
        }
    }

    /// 启动 1Hz 轮询；多次 start 是幂等的（启动期间忽略后续调用）。
    /// (P2-30 2026-05-06) 接 AppState，每 tick 读 telemetry_app_context_enabled
    /// 决定是否 emit；用户关掉后立即停止上报。
    pub fn start(&self, app: AppHandle, state: Arc<AppState>) {
        if self.running.swap(true, Ordering::SeqCst) {
            return;
        }
        let running = self.running.clone();
        tokio::spawn(async move {
            let mut last_exe: Option<String> = None;
            let mut last_title: Option<String> = None;
            while running.load(Ordering::SeqCst) {
                let telemetry_on = state.config.read().telemetry_app_context_enabled;
                if telemetry_on {
                    if let Some((exe, title)) = current_foreground() {
                        if Some(&exe) != last_exe.as_ref() || Some(&title) != last_title.as_ref() {
                            let payload = AppContextEvent {
                                exe: exe.clone(),
                                window_title: title.clone(),
                            };
                            let _ = app.emit("app_context_changed", payload);
                            last_exe = Some(exe);
                            last_title = Some(title);
                        }
                    }
                } else {
                    // 关闭后清空 last_*，再次开启时重发当前 ctx
                    last_exe = None;
                    last_title = None;
                }
                sleep(Duration::from_millis(1000)).await;
            }
        });
    }

    pub fn stop(&self) {
        self.running.store(false, Ordering::SeqCst);
    }
}

/// (exe basename without path, foreground window title) — 失败返 None。
fn current_foreground() -> Option<(String, String)> {
    use windows::Win32::Foundation::{CloseHandle, HWND, MAX_PATH};
    use windows::Win32::System::ProcessStatus::GetModuleFileNameExW;
    use windows::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};
    use windows::Win32::UI::WindowsAndMessaging::{
        GetForegroundWindow, GetWindowTextW, GetWindowThreadProcessId,
    };

    unsafe {
        let hwnd: HWND = GetForegroundWindow();
        if hwnd.0.is_null() {
            return None;
        }

        // window title
        let mut title_buf = [0u16; 256];
        let title_len = GetWindowTextW(hwnd, &mut title_buf);
        let title = if title_len > 0 {
            String::from_utf16_lossy(&title_buf[..title_len as usize])
        } else {
            String::new()
        };

        // process id → exe path
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
            .unwrap_or("")
            .to_string();
        if exe.is_empty() {
            return None;
        }
        Some((exe, title))
    }
}

// macOS / linux 平台 stub（保证 lib.rs 引用不爆）
#[cfg(not(windows))]
pub mod stub {
    use tauri::AppHandle;

    pub struct AppContextProbe;
    impl AppContextProbe {
        pub fn new() -> Self { Self }
        pub fn start(&self, _app: AppHandle) {}
        pub fn stop(&self) {}
    }
}
