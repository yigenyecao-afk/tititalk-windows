//! WASAPI capture + WAV encoding + pipeline orchestration.
//!
//! `cpal::Stream` is not `Send`, so we keep it owned by a dedicated OS thread.
//! Communication is via channels:
//!  - main → capture thread: a `stop` signal (parking_lot Mutex<bool>)
//!  - capture thread → main: a oneshot `Sender<CapturedAudio>` once the stream ends
//!
//! Resampling: most consumer mics deliver 44.1k or 48k stereo float; we collapse to
//! mono and resample-by-decimation to 16k i16 with a tiny anti-alias decimation filter.
//! Quality is more than enough for short-form ASR (DashScope Qwen) and matches what the
//! Mac client does.

use std::io::Cursor;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, Context};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{SampleFormat, StreamConfig};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tokio::sync::oneshot;

use crate::asr;
use crate::insertion;
use crate::state::{AppState, PipelineEvent, PipelinePhase};
use crate::stylist;

const TARGET_SR: u32 = 16_000;
const MAX_DURATION_SECS: f32 = 60.0;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CapturedAudio {
    pub samples_i16: Vec<i16>,
    pub sample_rate: u32,
    pub duration_secs: f32,
}

impl CapturedAudio {
    pub fn to_wav_bytes(&self) -> anyhow::Result<Vec<u8>> {
        let spec = hound::WavSpec {
            channels: 1,
            sample_rate: self.sample_rate,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        let mut buf: Vec<u8> = Vec::with_capacity(self.samples_i16.len() * 2 + 64);
        {
            let mut writer = hound::WavWriter::new(Cursor::new(&mut buf), spec)?;
            for s in &self.samples_i16 {
                writer.write_sample(*s)?;
            }
            writer.finalize()?;
        }
        Ok(buf)
    }
}

struct CaptureHandle {
    stop_flag: Arc<Mutex<bool>>,
    rx: Option<oneshot::Receiver<anyhow::Result<CapturedAudio>>>,
}

/// Currently active recording. Cleared when stop completes.
static ACTIVE: once_cell::sync::Lazy<Mutex<Option<CaptureHandle>>> =
    once_cell::sync::Lazy::new(|| Mutex::new(None));

pub async fn orchestrate_start(state: Arc<AppState>) {
    // 权限预检：在 set_phase(Recording) 之前确认麦克风可用，避免「pill 亮了
    // 红点用户开始说话，结果系统弹框遮住、直到松手才发现没录到」。预检即
    // 调用 default_input_config —— 跟真录音同一条路径，最准确，比只查
    // device.name() 靠谱。失败直接 Notice + 不进入 Recording phase。
    if let Err(reason) = preflight_microphone() {
        // 用 Error 走 HomeView lastError Banner（sticky），不再用 Notice 弹 toast。
        // 跟 Mac VoicePipeline 对齐：录音前置错误统一靠 Banner 而非 toast。
        state.emit(PipelineEvent::Error { message: reason });
        return;
    }

    state.set_phase(PipelinePhase::Recording);
    state.emit(PipelineEvent::Sound { sound: "start".into() });

    let stop_flag = Arc::new(Mutex::new(false));
    let (tx, rx) = oneshot::channel::<anyhow::Result<CapturedAudio>>();
    let stop_flag_thr = stop_flag.clone();
    let event_tx = state.event_tx.clone();

    std::thread::Builder::new()
        .name("tititalk-capture".into())
        .spawn(move || {
            let result = capture_blocking(stop_flag_thr, event_tx);
            let _ = tx.send(result);
        })
        .expect("spawn capture thread");

    *ACTIVE.lock() = Some(CaptureHandle {
        stop_flag,
        rx: Some(rx),
    });
}

pub async fn orchestrate_stop(state: Arc<AppState>) {
    state.set_phase(PipelinePhase::Stopping);
    state.emit(PipelineEvent::Sound { sound: "stop".into() });

    let rx = {
        let mut active = ACTIVE.lock();
        let Some(handle) = active.as_mut() else {
            state.set_phase(PipelinePhase::Failed);
            state.emit(PipelineEvent::Error {
                message: "no active recording".into(),
            });
            return;
        };
        *handle.stop_flag.lock() = true;
        handle.rx.take()
    };

    let Some(rx) = rx else {
        return;
    };

    let captured = match rx.await {
        Ok(Ok(audio)) => audio,
        Ok(Err(e)) => {
            *ACTIVE.lock() = None;
            state.set_phase(PipelinePhase::Failed);
            state.emit(PipelineEvent::Error { message: e.to_string() });
            return;
        }
        Err(_) => {
            *ACTIVE.lock() = None;
            state.set_phase(PipelinePhase::Failed);
            state.emit(PipelineEvent::Error {
                message: "capture channel dropped".into(),
            });
            return;
        }
    };
    *ACTIVE.lock() = None;

    *state.current_audio.write() = Some(captured.clone());
    state.set_phase(PipelinePhase::Transcribing);

    let cfg = state.config.read().clone();
    let raw = match asr::transcribe(&cfg, &captured, &state).await {
        Ok(t) => t,
        Err(e) => {
            state.set_phase(PipelinePhase::Failed);
            state.emit(PipelineEvent::Error { message: e.to_string() });
            return;
        }
    };

    if raw.trim().is_empty() {
        state.set_phase(PipelinePhase::Done);
        return;
    }

    // Stylist post-processing — opt-in. Failure falls back to raw with a warning,
    // never blocks insertion (paste must always happen on the user's gesture).
    let text = if cfg.stylist_enabled {
        state.set_phase(PipelinePhase::Polishing);
        // (v0.7.4 polish-fix) 全程日志：起手 / 结束 / 失败 都打 elapsed + engine
        // + model + text_len，复现「润色超时」时一眼看穿走的 cloud 还是 BYOK，
        // 慢在哪一步。
        let polish_t0 = std::time::Instant::now();
        log::info!(
            "polish start: engine={} model={} stylist_persona={} text_len={}",
            cfg.engine, cfg.stylist_model, cfg.stylist_persona, raw.chars().count()
        );
        match stylist::polish(&cfg, &raw, &state).await {
            Ok(p) if !p.trim().is_empty() => {
                log::info!(
                    "polish done: engine={} elapsed={:.2}s output_len={}",
                    cfg.engine, polish_t0.elapsed().as_secs_f32(), p.chars().count()
                );
                p
            }
            Ok(_) => {
                log::warn!(
                    "polish returned empty: engine={} elapsed={:.2}s — falling back to raw",
                    cfg.engine, polish_t0.elapsed().as_secs_f32()
                );
                state.emit(PipelineEvent::Error {
                    message: "⚠️ 润色返回空，已落原始转写".into(),
                });
                raw.clone()
            }
            Err(e) => {
                log::warn!(
                    "polish failed: engine={} elapsed={:.2}s err={e} — falling back to raw",
                    cfg.engine, polish_t0.elapsed().as_secs_f32()
                );
                // (v0.7.4 polish-fix) 旧版本只 log 不通知 UI，用户体感「润色失效
                // 但没原因」。改 emit Error 让前端 lastError banner 接住具体原因
                // （pill 已经在显示 raw 了，这条文字补「为什么没润色」信息差）。
                // 用户之前反馈「不要重复 toast」是指 input-process 错误重复，
                // polish 失败发一次 banner 是补信息不算重复。
                state.emit(PipelineEvent::Error {
                    message: format!("⚠️ 润色失败，已落原始转写：{e}"),
                });
                raw.clone()
            }
        }
    } else {
        raw.clone()
    };

    state.emit(PipelineEvent::Transcript { text: text.clone() });

    if cfg.auto_insert {
        state.set_phase(PipelinePhase::Inserting);
        match insertion::insert_text(&text, cfg.also_copy) {
            Ok(()) => {
                state.set_phase(PipelinePhase::Done);
            }
            Err(e) => {
                // Fall back to clipboard-only
                let _ = insertion::copy_to_clipboard(&text);
                state.set_phase(PipelinePhase::Failed);
                state.emit(PipelineEvent::Error {
                    message: format!("插入失败，已复制到剪贴板：{e}"),
                });
            }
        }
    } else {
        let _ = insertion::copy_to_clipboard(&text);
        state.set_phase(PipelinePhase::Done);
    }
}

/// 录音前轻量级麦克风可用性 + 权限预检。
/// 走 cpal 同一条路径（host → default_input_device → default_input_config）
/// —— 跟真录音失败的根因一致，不会出现「预检过了，真录音又炸」。
/// 返回 Ok(()) 代表可以走，Err(message) 是给用户看的人话（不带 internal err）。
pub fn preflight_microphone() -> Result<(), String> {
    let host = cpal::default_host();
    let device = host.default_input_device().ok_or_else(|| {
        "找不到麦克风。请插好麦克风，或到「Windows 设置 → 隐私和安全 → 麦克风」开启。".to_string()
    })?;
    device.default_input_config().map_err(|e| {
        log::warn!("preflight cfg err: {e}");
        // cpal 的 default_input_config 失败几乎都是权限或独占；不区分细节，
        // 给用户最 actionable 的指引。
        "麦克风暂时不可用。常见原因：① Windows 隐私设置里 TiTiTalk \
         没有麦克风权限；② 被其他应用独占（QQ、Teams、Zoom 等）。\
         点「打开 Windows 麦克风设置」开启权限，或先关掉抢占的应用。"
            .to_string()
    })?;
    Ok(())
}

fn capture_blocking(
    stop_flag: Arc<Mutex<bool>>,
    event_tx: tokio::sync::mpsc::UnboundedSender<PipelineEvent>,
) -> anyhow::Result<CapturedAudio> {
    let host = cpal::default_host();
    let device = host
        .default_input_device()
        .ok_or_else(|| anyhow!(
            "找不到麦克风。请插好麦克风，并到 Windows 设置 → 隐私和安全 → 麦克风 \
             允许 TiTiTalk 访问。"
        ))?;
    let supported = device
        .default_input_config()
        .map_err(|e| anyhow!(
            "麦克风配置读取失败：{e}。常见原因：Windows 隐私设置里 TiTiTalk \
             没有麦克风权限，或被其他应用独占。"
        ))?;

    let src_sr = supported.sample_rate().0;
    let channels = supported.channels() as usize;
    let format = supported.sample_format();

    let cfg: StreamConfig = supported.into();
    let collected: Arc<Mutex<Vec<i16>>> = Arc::new(Mutex::new(Vec::with_capacity(
        (TARGET_SR as f32 * MAX_DURATION_SECS) as usize,
    )));
    let collected_cb = collected.clone();
    let event_tx_cb = event_tx.clone();

    // 录音中设备拔出 / driver 抽风时 cpal 会从 OS 侧推 err 上来。原来这里
    // 只 log 不通知前端 —— 用户面对一段沉默的「录音中…」直到松手才知道炸了。
    // 现在升级为 Notice，pill 上能立刻看到。capture 线程仍会按 stop_flag 退
    // 出，由 orchestrate_stop 接管 → 走完正常 Failed/Done 流。
    let err_event_tx = event_tx.clone();
    let err_fn = move |e: cpal::StreamError| {
        log::error!("audio stream error: {e}");
        let msg = match &e {
            cpal::StreamError::DeviceNotAvailable => {
                "麦克风设备已断开（拔出 USB 麦 / 蓝牙断连？）。请重新插上后再试。".to_string()
            }
            cpal::StreamError::BackendSpecific { err } => {
                format!("音频驱动异常：{}。请重新插拔麦克风或重启 TiTiTalk。", err)
            }
        };
        // 用 Error（HomeView lastError Banner sticky）替代 Notice toast，避免
        // 跟前端音频设备状态显示重复
        let _ = err_event_tx.send(PipelineEvent::Error { message: msg });
    };

    let stream = match format {
        SampleFormat::F32 => device.build_input_stream(
            &cfg,
            move |data: &[f32], _: &_| {
                process_chunk_f32(data, channels, src_sr, &collected_cb, &event_tx_cb);
            },
            err_fn,
            None,
        )?,
        SampleFormat::I16 => device.build_input_stream(
            &cfg,
            move |data: &[i16], _: &_| {
                process_chunk_i16(data, channels, src_sr, &collected_cb, &event_tx_cb);
            },
            err_fn,
            None,
        )?,
        SampleFormat::U16 => device.build_input_stream(
            &cfg,
            move |data: &[u16], _: &_| {
                let as_i16: Vec<i16> =
                    data.iter().map(|s| (*s as i32 - 32_768) as i16).collect();
                process_chunk_i16(&as_i16, channels, src_sr, &collected_cb, &event_tx_cb);
            },
            err_fn,
            None,
        )?,
        other => return Err(anyhow!("不支持的采样格式 {other:?}")),
    };

    stream.play().map_err(|e| anyhow!(
        "启动音频流失败：{e}。如果是首次使用，请在 Windows 系统弹出的「允许 \
         TiTiTalk 访问麦克风」对话框点同意；已经拒绝过的话，去「设置 → 隐私 \
         → 麦克风」手动开启。"
    ))?;

    let start = std::time::Instant::now();
    while !*stop_flag.lock() {
        if start.elapsed().as_secs_f32() > MAX_DURATION_SECS {
            log::warn!("hit max duration {MAX_DURATION_SECS}s, force stop");
            break;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    drop(stream);

    let samples = std::mem::take(&mut *collected.lock());
    let duration_secs = samples.len() as f32 / TARGET_SR as f32;
    Ok(CapturedAudio {
        samples_i16: samples,
        sample_rate: TARGET_SR,
        duration_secs,
    })
}

fn process_chunk_f32(
    data: &[f32],
    channels: usize,
    src_sr: u32,
    collected: &Arc<Mutex<Vec<i16>>>,
    event_tx: &tokio::sync::mpsc::UnboundedSender<PipelineEvent>,
) {
    let mono: Vec<f32> = if channels <= 1 {
        data.to_vec()
    } else {
        data.chunks(channels)
            .map(|c| c.iter().sum::<f32>() / channels as f32)
            .collect()
    };
    let resampled = decimate_to_target(&mono, src_sr);
    let mut sum_sq = 0.0f64;
    let mut buf = Vec::with_capacity(resampled.len());
    for s in &resampled {
        let clamped = s.max(-1.0).min(1.0);
        sum_sq += (clamped as f64) * (clamped as f64);
        buf.push((clamped * 32_767.0) as i16);
    }
    collected.lock().extend_from_slice(&buf);
    if !resampled.is_empty() {
        let rms = (sum_sq / resampled.len() as f64).sqrt() as f32;
        let _ = event_tx.send(PipelineEvent::Level { rms });
    }
}

fn process_chunk_i16(
    data: &[i16],
    channels: usize,
    src_sr: u32,
    collected: &Arc<Mutex<Vec<i16>>>,
    event_tx: &tokio::sync::mpsc::UnboundedSender<PipelineEvent>,
) {
    let as_f: Vec<f32> = data.iter().map(|s| *s as f32 / 32_768.0).collect();
    process_chunk_f32(&as_f, channels, src_sr, collected, event_tx);
}

/// Naive integer-ratio decimation with leading boxcar filter — good enough for
/// 48k → 16k speech. Not phase-perfect, but DashScope/Whisper handle it fine.
fn decimate_to_target(mono: &[f32], src_sr: u32) -> Vec<f32> {
    if src_sr == TARGET_SR || src_sr == 0 {
        return mono.to_vec();
    }
    let ratio = src_sr as f32 / TARGET_SR as f32;
    if ratio <= 1.0 {
        // upsample (rare): linear interpolate
        let out_len = (mono.len() as f32 / ratio).round() as usize;
        let mut out = Vec::with_capacity(out_len);
        for i in 0..out_len {
            let src_idx = i as f32 * ratio;
            let lo = src_idx.floor() as usize;
            let hi = (lo + 1).min(mono.len().saturating_sub(1));
            let f = src_idx - lo as f32;
            out.push(mono[lo] * (1.0 - f) + mono[hi] * f);
        }
        return out;
    }
    let step = ratio as usize;
    let mut out = Vec::with_capacity(mono.len() / step.max(1) + 1);
    let win = step.max(1);
    let mut idx = 0usize;
    while idx + win <= mono.len() {
        let avg: f32 = mono[idx..idx + win].iter().sum::<f32>() / win as f32;
        out.push(avg);
        idx += win;
    }
    out
}
