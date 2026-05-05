// P0 wave 3 #9 — 批量音频文件转录（记者 / 教师 / 律师场景）。
//
// 架构：
//   1. 前端 BatchTranscribePanel 拖入文件 → 调 cmd_transcribe_file(path)
//   2. 这里用 symphonia 解码 mp3/m4a/wav/opus/flac 等 → 16k mono i16 PCM
//   3. 用现成 asr::transcribe（走当前 cfg.engine 的非流式路径）拿 transcript
//   4. 返字符串给前端，由前端入队 + 进度条 + 导出 .txt/.srt
//
// 复用 asr::transcribe 不另起 endpoint —— 跟说话场景共用引擎/配额池/计费口径。
// streaming（asr_stream）跟批量场景对不上：流式 WS 假设 mic feed，批量场景一
// 整个文件 base64 走非流式更直接。

use std::path::Path;
use std::sync::Arc;

use anyhow::{anyhow, Context};
use symphonia::core::audio::{AudioBufferRef, Signal};
use symphonia::core::codecs::{DecoderOptions, CODEC_TYPE_NULL};
use symphonia::core::errors::Error as SymError;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;
use symphonia::core::sample::Sample;

use crate::audio::CapturedAudio;
use crate::state::AppState;

/// 解一个本地音频文件 → 16k mono i16 PCM。失败返 `Err`。
pub fn decode_to_pcm16k_mono(path: &Path) -> anyhow::Result<Vec<i16>> {
    let file = std::fs::File::open(path)
        .with_context(|| format!("打开文件失败：{}", path.display()))?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());

    let mut hint = Hint::new();
    if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
        hint.with_extension(ext);
    }

    let probed = symphonia::default::get_probe()
        .format(&hint, mss, &FormatOptions::default(), &MetadataOptions::default())
        .context("symphonia probe 失败：不支持的格式 / 损坏文件")?;

    let mut format = probed.format;
    let track = format
        .tracks()
        .iter()
        .find(|t| t.codec_params.codec != CODEC_TYPE_NULL)
        .ok_or_else(|| anyhow!("未找到可解码音轨"))?;
    let track_id = track.id;
    let sr_in = track
        .codec_params
        .sample_rate
        .ok_or_else(|| anyhow!("音轨缺采样率元数据"))?;
    let ch_in = track
        .codec_params
        .channels
        .map(|c| c.count())
        .unwrap_or(1)
        .max(1);

    let mut decoder = symphonia::default::get_codecs()
        .make(&track.codec_params, &DecoderOptions::default())
        .context("解码器构造失败")?;

    // 收集所有 mono f32 sample，在最后再一次性下采到 16k —— 简单稳，逐块下采
    // 在变速比下边界 sample 得插值，对短音频意义不大，长音频内存消耗可控
    // （30min 16k mono i16 ≈ 56MB；解前 f32 mono 折半再翻 4 倍 ≈ 224MB，仍可接受）。
    let mut mono_f32: Vec<f32> = Vec::with_capacity((sr_in as usize) * 2);

    loop {
        let packet = match format.next_packet() {
            Ok(p) => p,
            // EOF —— symphonia 的 IoError(UnexpectedEof) 是正常 stream 结束信号。
            Err(SymError::IoError(e)) if e.kind() == std::io::ErrorKind::UnexpectedEof => break,
            Err(SymError::ResetRequired) => {
                // 流切轨；当前 batch 场景无需续解，直接停。
                break;
            }
            Err(e) => return Err(anyhow!("symphonia 读包失败：{e}")),
        };
        if packet.track_id() != track_id {
            continue;
        }
        let decoded = match decoder.decode(&packet) {
            Ok(d) => d,
            Err(SymError::IoError(_)) => break,
            Err(SymError::DecodeError(_)) => continue, // 单帧错跳过
            Err(e) => return Err(anyhow!("解码失败：{e}")),
        };
        append_mono_f32(decoded, ch_in, &mut mono_f32);
    }

    if mono_f32.is_empty() {
        return Err(anyhow!("未解出任何音频样本"));
    }

    // 16k 重采样 —— 简单线性插值。批量场景解出来的速度远超 LLM 调用耗时，
    // 用 rubato 这种高质量 SRC 性价比低。
    let resampled = linear_resample(&mono_f32, sr_in, 16_000);
    let pcm: Vec<i16> = resampled
        .iter()
        .map(|s| (s.clamp(-1.0, 1.0) * 32767.0) as i16)
        .collect();
    Ok(pcm)
}

/// AudioBuffer → mono f32（多声道平均）。symphonia 的 sample 类型靠 ref 带，
/// 用 macro-pattern 把 4 种 (i16/i32/f32/u8) 统一收平。
fn append_mono_f32(buf: AudioBufferRef<'_>, ch_in: usize, out: &mut Vec<f32>) {
    macro_rules! collapse {
        ($b:expr, $to_f32:expr) => {{
            let frames = $b.frames();
            for f in 0..frames {
                let mut acc = 0f32;
                for c in 0..ch_in {
                    let s = $b.chan(c)[f];
                    acc += $to_f32(s);
                }
                out.push(acc / ch_in as f32);
            }
        }};
    }
    match buf {
        AudioBufferRef::F32(b) => collapse!(b, |s: f32| s),
        AudioBufferRef::F64(b) => collapse!(b, |s: f64| s as f32),
        AudioBufferRef::S8(b)  => collapse!(b, |s: i8|  (s as f32) / 128.0),
        AudioBufferRef::S16(b) => collapse!(b, |s: i16| (s as f32) / 32768.0),
        AudioBufferRef::S24(b) => collapse!(b, |s: symphonia::core::sample::i24| (s.inner() as f32) / 8_388_608.0),
        AudioBufferRef::S32(b) => collapse!(b, |s: i32| (s as f32) / 2_147_483_648.0),
        AudioBufferRef::U8(b)  => collapse!(b, |s: u8|  ((s as f32) - 128.0) / 128.0),
        AudioBufferRef::U16(b) => collapse!(b, |s: u16| ((s as f32) - 32_768.0) / 32_768.0),
        AudioBufferRef::U24(b) => collapse!(b, |s: symphonia::core::sample::u24| ((s.inner() as f32) - 8_388_608.0) / 8_388_608.0),
        AudioBufferRef::U32(b) => collapse!(b, |s: u32| ((s as f32) - 2_147_483_648.0) / 2_147_483_648.0),
    }
}

fn linear_resample(input: &[f32], sr_in: u32, sr_out: u32) -> Vec<f32> {
    if sr_in == sr_out {
        return input.to_vec();
    }
    let ratio = sr_in as f64 / sr_out as f64;
    let out_len = (input.len() as f64 / ratio).floor() as usize;
    let mut out = Vec::with_capacity(out_len);
    for i in 0..out_len {
        let src = (i as f64) * ratio;
        let i0 = src.floor() as usize;
        let i1 = (i0 + 1).min(input.len() - 1);
        let frac = (src - i0 as f64) as f32;
        out.push(input[i0] * (1.0 - frac) + input[i1] * frac);
    }
    out
}

/// Tauri 命令：转一个文件。返回完整 transcript 字符串。
/// 一条至多走一次 ASR；前端做队列调度（每条独立 invoke）。
#[tauri::command]
pub async fn cmd_transcribe_file(
    path: String,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<String, String> {
    let p = std::path::PathBuf::from(&path);
    if !p.exists() {
        return Err(format!("文件不存在：{path}"));
    }
    // 解码放 spawn_blocking，CPU 重 + IO 重，不挡 tokio 主 runtime。
    let p_for_blocking = p.clone();
    let pcm = tokio::task::spawn_blocking(move || decode_to_pcm16k_mono(&p_for_blocking))
        .await
        .map_err(|e| format!("解码任务 panic：{e}"))?
        .map_err(|e| e.to_string())?;
    if pcm.is_empty() {
        return Err("解码后无音频".into());
    }
    let duration = pcm.len() as f32 / 16_000.0;
    let audio = CapturedAudio {
        samples_i16: pcm,
        sample_rate: 16_000,
        duration_secs: duration,
    };
    let cfg = state.config.read().clone();
    let st: Arc<AppState> = (*state).clone();
    crate::asr::transcribe(&cfg, &audio, &st)
        .await
        .map_err(|e| format!("ASR 失败：{e}"))
}
