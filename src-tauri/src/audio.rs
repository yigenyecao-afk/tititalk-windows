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
    state.set_phase(PipelinePhase::Recording);

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
    let text = match asr::transcribe(&cfg, &captured).await {
        Ok(t) => t,
        Err(e) => {
            state.set_phase(PipelinePhase::Failed);
            state.emit(PipelineEvent::Error { message: e.to_string() });
            return;
        }
    };

    if text.trim().is_empty() {
        state.set_phase(PipelinePhase::Done);
        return;
    }
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

fn capture_blocking(
    stop_flag: Arc<Mutex<bool>>,
    event_tx: tokio::sync::mpsc::UnboundedSender<PipelineEvent>,
) -> anyhow::Result<CapturedAudio> {
    let host = cpal::default_host();
    let device = host
        .default_input_device()
        .ok_or_else(|| anyhow!("找不到默认输入设备（麦克风）"))?;
    let supported = device
        .default_input_config()
        .context("默认输入配置读取失败")?;

    let src_sr = supported.sample_rate().0;
    let channels = supported.channels() as usize;
    let format = supported.sample_format();

    let cfg: StreamConfig = supported.into();
    let collected: Arc<Mutex<Vec<i16>>> = Arc::new(Mutex::new(Vec::with_capacity(
        (TARGET_SR as f32 * MAX_DURATION_SECS) as usize,
    )));
    let collected_cb = collected.clone();
    let event_tx_cb = event_tx.clone();

    let err_fn = |e| log::error!("audio stream error: {e}");

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

    stream.play().context("启动音频流失败")?;

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
