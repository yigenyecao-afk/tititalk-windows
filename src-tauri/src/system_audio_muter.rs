//! (v0.8.3 P0-5) 录音中静音系统输出，停止后恢复。跟 Mac SystemAudioMuter.swift 同源。
//!
//! 用 Windows Core Audio (IAudioEndpointVolume) 控 default render endpoint 的
//! mute 状态。我们只动 mute，不动 volume —— 恢复时不会因为浮点累积漂移。
//!
//! 嵌套保护：连续 mute() / restore() 调多次只有最外层真写。原始 mute 状态保留
//! 在 saved_was_muted —— 如果用户在我们 mute 之前就已经 muted，restore 时不动。

use parking_lot::Mutex;

#[cfg(windows)]
mod imp {
    use super::*;
    use windows::Win32::Media::Audio::{
        eConsole, eRender, IMMDeviceEnumerator, MMDeviceEnumerator,
    };
    use windows::Win32::Media::Audio::Endpoints::IAudioEndpointVolume;
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_ALL, COINIT_APARTMENTTHREADED,
    };

    static STATE: Mutex<Option<MuterState>> = Mutex::new(None);

    struct MuterState {
        depth: u32,
        saved_was_muted: bool,
    }

    pub fn mute() {
        let mut g = STATE.lock();
        if let Some(s) = g.as_mut() {
            s.depth += 1;
            return;
        }
        let was_muted = match read_mute() {
            Ok(v) => v,
            Err(e) => {
                log::warn!("P0-5 mute: read failed: {e:?}; skip");
                return;
            }
        };
        // 不论是否已 muted 都建 state（restore 时 depth-- 仍要走）；只有当时没 muted 才真写。
        *g = Some(MuterState { depth: 1, saved_was_muted: was_muted });
        if was_muted {
            log::info!("P0-5 mute: already muted; skip write");
            return;
        }
        if let Err(e) = write_mute(true) {
            log::warn!("P0-5 mute: write failed: {e:?}");
        } else {
            log::info!("P0-5 mute: ok");
        }
    }

    pub fn restore() {
        let mut g = STATE.lock();
        let Some(s) = g.as_mut() else { return };
        s.depth = s.depth.saturating_sub(1);
        if s.depth > 0 {
            return;
        }
        let was_muted = s.saved_was_muted;
        *g = None;
        if was_muted {
            log::info!("P0-5 restore: skip (was already muted)");
            return;
        }
        if let Err(e) = write_mute(false) {
            log::warn!("P0-5 restore: write failed: {e:?}");
        } else {
            log::info!("P0-5 restore: ok");
        }
    }

    fn read_mute() -> windows::core::Result<bool> {
        with_endpoint(|epv| unsafe { epv.GetMute() }.map(|v| v.as_bool()))
    }

    fn write_mute(on: bool) -> windows::core::Result<()> {
        with_endpoint(|epv| unsafe { epv.SetMute(on, std::ptr::null()) })
    }

    /// 取 default render endpoint 的 IAudioEndpointVolume；每次 init 一遍 COM
    /// （我们 muter 只在录音 start/stop 调用，频次低）。
    fn with_endpoint<R>(
        f: impl FnOnce(&IAudioEndpointVolume) -> windows::core::Result<R>,
    ) -> windows::core::Result<R> {
        unsafe {
            let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
            let r = (|| -> windows::core::Result<R> {
                let enumerator: IMMDeviceEnumerator =
                    CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
                let device = enumerator.GetDefaultAudioEndpoint(eRender, eConsole)?;
                let epv: IAudioEndpointVolume = device.Activate(CLSCTX_ALL, None)?;
                f(&epv)
            })();
            CoUninitialize();
            r
        }
    }
}

#[cfg(not(windows))]
mod imp {
    pub fn mute() {}
    pub fn restore() {}
}

pub fn mute() {
    imp::mute();
}

pub fn restore() {
    imp::restore();
}
