use anyhow::{anyhow, Context};
use base64::Engine as _;
use serde::{Deserialize, Serialize};

use crate::audio::CapturedAudio;
use crate::config::AppConfig;

const QWEN_ENDPOINT: &str =
    "https://dashscope.aliyuncs.com/api/v1/services/audio/asr/transcription";

/// Smoke test: hit /api/v1/models or similar lightweight endpoint with the key
/// to verify the credential is at least syntactically valid + not banned.
pub async fn test_credentials(cfg: &AppConfig) -> anyhow::Result<String> {
    if cfg.api_key.trim().is_empty() {
        return Err(anyhow!("API key 为空"));
    }
    match cfg.engine.as_str() {
        "qwen" => {
            // DashScope doesn't have a free /models call; do a tiny silent ASR ping instead.
            let silent = CapturedAudio {
                samples_i16: vec![0i16; 16_000 / 2], // 0.5s silence
                sample_rate: 16_000,
                duration_secs: 0.5,
            };
            transcribe(cfg, &silent).await.map(|t| {
                if t.trim().is_empty() {
                    "OK（空白音频，凭据有效）".into()
                } else {
                    format!("OK: {t}")
                }
            })
        }
        "openai" => {
            // Lightweight: call /v1/models (cheap, no audio).
            let resp = reqwest::Client::new()
                .get("https://api.openai.com/v1/models")
                .bearer_auth(&cfg.api_key)
                .send()
                .await
                .context("OpenAI 网络失败")?;
            if resp.status().is_success() {
                Ok("OK".into())
            } else {
                let code = resp.status();
                let body = resp.text().await.unwrap_or_default();
                Err(anyhow!("OpenAI 鉴权失败 {code}: {body}"))
            }
        }
        other => Err(anyhow!("未知引擎 {other}")),
    }
}

pub async fn transcribe(cfg: &AppConfig, audio: &CapturedAudio) -> anyhow::Result<String> {
    if cfg.api_key.trim().is_empty() {
        return Err(anyhow!("尚未配置 API key（在「设置」里填）"));
    }
    match cfg.engine.as_str() {
        "qwen" => qwen_transcribe(cfg, audio).await,
        "openai" => openai_transcribe(cfg, audio).await,
        other => Err(anyhow!("未知引擎 {other}")),
    }
}

// ---------- Qwen / DashScope ----------

#[derive(Serialize)]
struct QwenRequest<'a> {
    model: &'a str,
    input: QwenInput<'a>,
    parameters: QwenParameters<'a>,
}

#[derive(Serialize)]
struct QwenInput<'a> {
    /// base64 PCM/WAV bytes prefixed `data:audio/wav;base64,`
    audio: String,
    /// optional dictionary biasing
    #[serde(skip_serializing_if = "Option::is_none")]
    hotwords: Option<&'a [String]>,
}

#[derive(Serialize)]
struct QwenParameters<'a> {
    language: &'a str,
}

#[derive(Deserialize)]
struct QwenResponse {
    output: Option<QwenOutput>,
    code: Option<String>,
    message: Option<String>,
}

#[derive(Deserialize)]
struct QwenOutput {
    text: Option<String>,
    sentences: Option<Vec<QwenSentence>>,
}

#[derive(Deserialize)]
struct QwenSentence {
    text: String,
}

async fn qwen_transcribe(cfg: &AppConfig, audio: &CapturedAudio) -> anyhow::Result<String> {
    let wav = audio.to_wav_bytes()?;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&wav);
    let data_uri = format!("data:audio/wav;base64,{b64}");

    let body = QwenRequest {
        model: &cfg.model,
        input: QwenInput {
            audio: data_uri,
            hotwords: if cfg.dictionary.is_empty() {
                None
            } else {
                Some(&cfg.dictionary)
            },
        },
        parameters: QwenParameters { language: &cfg.language },
    };

    let resp = reqwest::Client::new()
        .post(QWEN_ENDPOINT)
        .bearer_auth(&cfg.api_key)
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .context("百炼 ASR 请求失败")?;

    let status = resp.status();
    let parsed: QwenResponse = resp.json().await.context("百炼响应解析失败")?;

    if !status.is_success() {
        return Err(anyhow!(
            "百炼返回 {status}: {} {}",
            parsed.code.unwrap_or_default(),
            parsed.message.unwrap_or_default()
        ));
    }

    let out = parsed.output.ok_or_else(|| anyhow!("响应缺 output"))?;
    if let Some(t) = out.text {
        return Ok(clean_asr_text(&t));
    }
    if let Some(sents) = out.sentences {
        let joined = sents
            .into_iter()
            .map(|s| s.text)
            .collect::<Vec<_>>()
            .join("");
        return Ok(clean_asr_text(&joined));
    }
    Err(anyhow!("响应既无 text 也无 sentences"))
}

// ---------- OpenAI Whisper ----------

async fn openai_transcribe(cfg: &AppConfig, audio: &CapturedAudio) -> anyhow::Result<String> {
    let wav = audio.to_wav_bytes()?;
    let part = reqwest::multipart::Part::bytes(wav)
        .file_name("audio.wav")
        .mime_str("audio/wav")?;
    let mut form = reqwest::multipart::Form::new()
        .text("model", cfg.model.clone())
        .text("response_format", "json")
        .part("file", part);
    if cfg.language != "auto" {
        form = form.text("language", cfg.language.clone());
    }
    if !cfg.dictionary.is_empty() {
        form = form.text("prompt", cfg.dictionary.join(", "));
    }

    let resp = reqwest::Client::new()
        .post("https://api.openai.com/v1/audio/transcriptions")
        .bearer_auth(&cfg.api_key)
        .multipart(form)
        .send()
        .await
        .context("OpenAI ASR 请求失败")?;

    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(anyhow!("OpenAI 返回 {status}: {body}"));
    }
    #[derive(Deserialize)]
    struct R {
        text: String,
    }
    let r: R = serde_json::from_str(&body).context("OpenAI 响应解析失败")?;
    Ok(clean_asr_text(&r.text))
}

fn clean_asr_text(t: &str) -> String {
    let t = t.trim();
    // Strip a trailing period if user clearly didn't intend a sentence end.
    // Mac stylist handles this; for v0.1 we just trim & collapse whitespace.
    let collapsed: String = t
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    collapsed
}
