//! 本地 ASR：sherpa-onnx + SenseVoice-Small int8。
//!
//! (v0.14.0 M1) Win 端从 0 到 1 的本地 ASR — 之前 engine="local" 选项是空 promise
//! （点击跳支付页但 unlock 后还是没有本地引擎）。现在带模型 ~234MB int8 onnx 直接
//! 打包进 installer，装完即用，无网也能转写。
//!
//! **栈选型**（决策路径见 docs/design-tokens.md / 调研报告）：
//!   • sherpa-onnx Rust crate v1.13.0（官方维护，Apache-2.0）
//!   • SenseVoice-Small int8（多语种含中文 + ITN，~234MB，AISHELL/WenetSpeech 中文 WER 反超 whisper-large）
//!   • 一个模型搞定 — 砍掉 region split 跟 Paraformer-zh 重复
//!
//! **跟 cloud 路径的差异**：
//!   • SenseVoice 不支持真流式 — batch 模式（攒完 PCM → 一次 decode → 出全文）
//!   • 「松开 hotkey 出全文」UX 配 SmoothLiveText 视觉伪流式 (M3 处理)
//!   • 不支持热词 (hotword) — Paraformer/SenseVoice 这两个非 transducer 模型对 hotword
//!     配置静默失效（[k2-fsa#2307](https://github.com/k2-fsa/sherpa-onnx/issues/2307)）
//!
//! **打包路径**：
//!   • 模型放 `src-tauri/resources/sherpa-models/sense-voice/`
//!   • Tauri builder 通过 `bundle.resources` 自动 copy 到 installer
//!   • runtime 用 `app.path().resource_dir()?.join("sherpa-models/sense-voice")` 解析

use anyhow::{anyhow, Context};
use once_cell::sync::OnceCell;
use sherpa_onnx::{
    OfflineRecognizer, OfflineRecognizerConfig, OfflineSenseVoiceModelConfig,
};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tauri::{path::BaseDirectory, AppHandle, Manager};

use crate::audio::CapturedAudio;

/// (M2) prewarm：OfflineRecognizer 跨多次 transcribe 调用复用 — 第一次构造
/// ~500ms（model load + ONNX session prepare），之后每次只走 decode (RTF 0.14)。
/// `Arc` 包是因为 sherpa_onnx::OfflineRecognizer 的 decode/create_stream 都是
/// `&self`，多线程 read-only 安全（C lib 内部锁）。
static PREWARMED: OnceCell<Arc<OfflineRecognizer>> = OnceCell::new();

const MODEL_FILE_REL: &str = "sherpa-models/sense-voice/model.int8.onnx";
const TOKENS_FILE_REL: &str = "sherpa-models/sense-voice/tokens.txt";
/// dev 模式 fallback —— `bundle.resources` 在 dev 不会展平到 resource_dir/sherpa-models/，
/// 而是平 mirror 在 src-tauri/resources/。开发跑 `cargo tauri dev` 时走此路径。
const MODEL_FILE_DEV: &str = "resources/sherpa-models/sense-voice/model.int8.onnx";
const TOKENS_FILE_DEV: &str = "resources/sherpa-models/sense-voice/tokens.txt";

/// resolve 模型文件 — 先尝 prod 路径（bundler 展平后的），fallback dev 路径。
fn resolve_model_files(handle: &AppHandle) -> anyhow::Result<(PathBuf, PathBuf)> {
    let resolver = handle.path();
    // 优先 prod：resource_dir/sherpa-models/sense-voice/...
    if let (Ok(m), Ok(t)) = (
        resolver.resolve(MODEL_FILE_REL, BaseDirectory::Resource),
        resolver.resolve(TOKENS_FILE_REL, BaseDirectory::Resource),
    ) {
        if m.is_file() && t.is_file() {
            return Ok((m, t));
        }
    }
    // dev fallback：resource_dir/resources/sherpa-models/sense-voice/...
    if let (Ok(m), Ok(t)) = (
        resolver.resolve(MODEL_FILE_DEV, BaseDirectory::Resource),
        resolver.resolve(TOKENS_FILE_DEV, BaseDirectory::Resource),
    ) {
        if m.is_file() && t.is_file() {
            return Ok((m, t));
        }
    }
    Err(anyhow!(
        "本地 ASR 模型未就绪 — 缺 {} 或 {}。重装应用或检查 resources/sherpa-models/sense-voice/ 路径。",
        MODEL_FILE_REL,
        TOKENS_FILE_REL
    ))
}

/// 本地 ASR 是否「准备好」—— 模型文件齐全才返回 true。
/// 用于 Settings 页面 / fallback 决策点 (M1 双向 fallback) 的预检。
pub fn is_available(handle: &AppHandle) -> bool {
    resolve_model_files(handle).is_ok()
}

/// 取得 prewarmed OfflineRecognizer — 第一次调时同步 init（~500ms），之后 cache。
fn ensure_recognizer(handle: &AppHandle) -> anyhow::Result<Arc<OfflineRecognizer>> {
    if let Some(r) = PREWARMED.get() {
        return Ok(r.clone());
    }
    let (model_path, tokens_path) = resolve_model_files(handle)?;
    let mut config = OfflineRecognizerConfig::default();
    config.model_config.sense_voice = OfflineSenseVoiceModelConfig {
        model: Some(model_path.to_string_lossy().into_owned()),
        language: Some("auto".into()),
        use_itn: true,
    };
    config.model_config.tokens = Some(tokens_path.to_string_lossy().into_owned());
    config.model_config.num_threads = 2;
    config.model_config.provider = Some("cpu".into());

    let r = OfflineRecognizer::create(&config)
        .context("OfflineRecognizer::create 失败 — 模型文件可能损坏或格式错误")?;
    let arc = Arc::new(r);
    // 多线程同时进 ensure_recognizer 时 set_or_init 之类不可用，OnceCell::set 任由 race 输者忽略
    let _ = PREWARMED.set(arc.clone());
    Ok(PREWARMED.get().cloned().unwrap_or(arc))
}

/// 主转写入口 —— 跟 `asr::transcribe` 同型。
///
/// 实现走 `tokio::task::spawn_blocking` —— sherpa-onnx 是同步 C 调用，
/// decode 一段 5s 音频在 i7 ≈ 700ms（RTF 0.14），不能阻 tokio runtime。
/// (M2) 30s timeout 防 sherpa_onnx 在某些极端 ONNX runtime panic 下卡死。
pub async fn transcribe(
    audio: &CapturedAudio,
    handle: &AppHandle,
) -> anyhow::Result<String> {
    if audio.samples_i16.is_empty() {
        return Err(anyhow!("空音频"));
    }
    if audio.duration_secs < 0.1 {
        return Err(anyhow!("音频过短（< 100ms），跳过本地转写"));
    }

    let recognizer = ensure_recognizer(handle)?;

    // i16 → f32 mono 16kHz —— sherpa accept_waveform 接受 f32
    let pcm_f32: Vec<f32> = audio
        .samples_i16
        .iter()
        .map(|&s| s as f32 / 32768.0)
        .collect();
    let sample_rate = audio.sample_rate as i32;

    let work = tokio::task::spawn_blocking(move || -> anyhow::Result<String> {
        let stream = recognizer.create_stream();
        stream.accept_waveform(sample_rate, &pcm_f32);
        recognizer.decode(&stream);
        let text = stream
            .get_result()
            .map(|r| r.text)
            .unwrap_or_default()
            .trim()
            .to_string();
        Ok(text)
    });

    // (M2) 30s timeout
    match tokio::time::timeout(Duration::from_secs(30), work).await {
        Ok(joined) => joined.context("本地 ASR 任务被取消")?,
        Err(_) => Err(anyhow!("本地引擎转写超时 30s")),
    }
}

/// 启动期健康自检 (M2) —— 跑 1s 静音验证模型能正常 load + decode。
/// 失败时 log warning，不阻断启动；用户切到 local engine 时再次 fail-fast 提示。
#[allow(dead_code)] // M2 task #242 接通后启用
pub async fn health_check(handle: &AppHandle) -> anyhow::Result<()> {
    if !is_available(handle) {
        return Err(anyhow!("模型缺失"));
    }
    let silence = CapturedAudio {
        samples_i16: vec![0i16; 16_000], // 1s 静音
        sample_rate: 16_000,
        duration_secs: 1.0,
    };
    let _ = transcribe(&silence, handle).await?; // 静音返空字符串 OK，模型能 load 即过
    Ok(())
}
