use anyhow::{anyhow, Context};
use base64::Engine as _;
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::time::Duration;
use tauri::Manager; // for `app_handle.path()`

use crate::audio::CapturedAudio;
use crate::config::AppConfig;
use crate::state::AppState;

/// 共享 reqwest::Client —— 之前 4 个调用点各 new 一次，每次都重建
/// 连接池 + 重新走 TLS handshake，慢且耗 fd。同一进程一个 client 即可。
/// reqwest 默认开启 `proxy_from_env`，HTTPS_PROXY / HTTP_PROXY env var
/// 自动生效（VPN 客户端常这么设）。Windows 系统代理（Internet Options）
/// 不会被 reqwest 自动 pick —— 这是 reqwest 已知 gap，需要 user 手设
/// env var；下一步迭代可以加 sysproxy crate 拉系统设置。
/// 30s timeout 涵盖 ASR 上传 30 分钟音频后的等待 + 大音频 PUT。
static HTTP: Lazy<reqwest::Client> = Lazy::new(|| {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .connect_timeout(Duration::from_secs(8))
        .build()
        .expect("reqwest client")
});

const QWEN_ENDPOINT: &str =
    "https://dashscope.aliyuncs.com/api/v1/services/audio/asr/transcription";

/// (api-integration §4.8) tititalk.com proxy — receives 16kHz mono i16 PCM
/// (RAW bytes, no WAV header), Bearer-authed, returns `{text, cost_tokens, ...}`
/// + `X-User-Plan` header. Bills against the user's daily quota.
const TITITALK_ASR_ENDPOINT: &str = "https://tititalk.com/api/asr/transcribe";

/// Smoke test: hit /api/v1/models or similar lightweight endpoint with the key
/// to verify the credential is at least syntactically valid + not banned.
/// For `tititalk_cloud` engine (no user-supplied key), nothing to test —
/// auth is verified via the Account login flow directly.
pub async fn test_credentials(cfg: &AppConfig) -> anyhow::Result<String> {
    if cfg.engine == "tititalk_cloud" {
        return Ok("使用 TiTiTalk 云端 — 凭据通过登录验证".into());
    }
    if cfg.api_key.trim().is_empty() {
        return Err(anyhow!("API key 为空"));
    }
    match cfg.engine.as_str() {
        "qwen" => {
            // DashScope doesn't have a free /models call; do a tiny silent ASR ping instead.
            // (Internal call — no Account state needed for BYOK direct paths.)
            qwen_transcribe(cfg, &CapturedAudio {
                samples_i16: vec![0i16; 16_000 / 2], // 0.5s silence
                sample_rate: 16_000,
                duration_secs: 0.5,
            }).await.map(|t| {
                if t.trim().is_empty() {
                    "OK（空白音频，凭据有效）".into()
                } else {
                    format!("OK: {t}")
                }
            })
        }
        "openai" => {
            // Lightweight: call /v1/models (cheap, no audio).
            let resp = HTTP.clone()
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

pub async fn transcribe(
    cfg: &AppConfig,
    audio: &CapturedAudio,
    state: &Arc<AppState>,
) -> anyhow::Result<String> {
    match cfg.engine.as_str() {
        "tititalk_cloud" => tititalk_cloud_transcribe(cfg, audio, state).await,
        // (v0.14.0 M1) 本地 ASR — sherpa-onnx + SenseVoice int8，模型打包进
        // installer，装完即用。`pro_unlocked` 闸口由调用方决定是否暴露入口；
        // 这里只负责跑模型不做 license 检查（M1 双向 fallback 用得到此函数）。
        "local" => {
            let handle = state
                .app_handle
                .read()
                .clone()
                .ok_or_else(|| anyhow!("AppHandle 未就绪"))?;
            crate::asr_local::transcribe(audio, &handle).await
        }
        // BYOK direct paths — require user-supplied key AND pro_unlocked.
        // Enforced server-side too (license + 402), but the client-side
        // check gives an immediate friendly error instead of a wasted
        // upload + opaque server response.
        "qwen" | "openai" => {
            let pro_unlocked = {
                let acc = state.account.read().clone();
                acc.map(|a| a.is_pro_unlocked()).unwrap_or(false)
            };
            if !pro_unlocked {
                return Err(anyhow!(
                    "BYOK 直连引擎需要专业解锁包（pro_locked）。前往 tititalk.com/pricing 解锁 ¥49 一次性，或切换到 TiTiTalk 云端。"
                ));
            }
            if cfg.api_key.trim().is_empty() {
                return Err(anyhow!("尚未配置 API key（在「设置」里填，或切换到 TiTiTalk 云端）"));
            }
            match cfg.engine.as_str() {
                "qwen" => qwen_transcribe(cfg, audio).await,
                "openai" => openai_transcribe(cfg, audio).await,
                _ => unreachable!(),
            }
        }
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
        // (v0.14.1) 识别语言 picker 砍后恒定 "auto"。
        parameters: QwenParameters { language: "auto" },
    };

    let resp = HTTP.clone()
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

// ---------- TiTiTalk cloud proxy (api-integration §4.8) ----------

/// (api-integration §4.8) TitiTalk 云端代理。要求用户已登录；audio 上传 16k mono i16 RAW PCM
/// （不带 wav header）。
///
/// 错误处理：
/// - 401: token 失效 → 调用方走 refresh 流程（Account 已自动 retry）
/// - 402 pro_locked: BYOK 闸口；不会出现在此端点
/// - 429 quota_exceeded: 配额耗尽；error message 含 fallbacks，UI 弹升级卡
/// - 504/502: 上游百炼问题，提示重试不降级
async fn tititalk_cloud_transcribe(
    _cfg: &AppConfig,
    audio: &CapturedAudio,
    state: &Arc<AppState>,
) -> anyhow::Result<String> {
    let acc = state
        .account
        .read()
        .clone()
        .ok_or_else(|| anyhow!("未登录 TiTiTalk — 请在「设置 → 账号」登录后重试"))?;

    // RAW PCM bytes (i16 LE, 16k mono) — server expects no WAV header per §4.8
    let mut pcm: Vec<u8> = Vec::with_capacity(audio.samples_i16.len() * 2);
    for s in &audio.samples_i16 {
        pcm.extend_from_slice(&s.to_le_bytes());
    }

    // First attempt with the current access token.
    let access = acc
        .access_token()
        .ok_or_else(|| anyhow!("未登录 TiTiTalk — 请在「设置 → 账号」登录后重试"))?;
    let (status, body, plan_header) = post_pcm_once(&pcm, audio.sample_rate, &access).await?;

    // 401 → refresh + retry once. The ApiClient handles this automatically
    // for JSON paths via `send_with_retry`, but multipart uploads bypass it
    // (reqwest::Form isn't Clone-friendly), so we do the refresh dance here.
    // After 1h the access token expires; without this retry the user's first
    // hotkey press of the session would fail with a scary 401 message.
    let (status, body, plan_header) = if status.as_u16() == 401 {
        log::info!("ASR 401 — refreshing access token + retrying once");
        if let Err(e) = acc.try_refresh_now().await {
            // 不把 internal error 露出给用户 —— 只记 log。文案统一是 next-action。
            log::warn!("token refresh failed: {e}");
            return Err(anyhow!("登录已失效，请到「设置 → 账号」重新登录后重试。"));
        }
        let access2 = acc
            .access_token()
            .ok_or_else(|| anyhow!("登录状态异常，请到「设置 → 账号」重新登录。"))?;
        post_pcm_once(&pcm, audio.sample_rate, &access2).await?
    } else {
        (status, body, plan_header)
    };

    // Forward plan header to Account drift detector — keep parity with global tap.
    if let Some(plan) = plan_header {
        let acc2 = acc.clone();
        tauri::async_runtime::spawn(async move {
            acc2.observe_plan_header(Some(plan)).await;
        });
    }

    if !status.is_success() {
        // 解析常见 code 给人话；未知的留 verbatim 给 UI detectUpgradeReason 兜。
        let friendly = friendly_cloud_error(status.as_u16(), &body);
        return Err(anyhow!("{friendly}"));
    }

    #[derive(Deserialize)]
    struct ProxyResp {
        text: String,
        // Other fields (cost_tokens, used_tokens, remaining_tokens) are
        // accessible via /api/me/quota — UI fetches there.
    }
    let parsed: ProxyResp = serde_json::from_str(&body).context("TiTiTalk ASR 响应解析失败")?;
    Ok(clean_asr_text(&parsed.text))
}

/// Single multipart POST to the cloud proxy. Returns `(status, body, plan_header)`.
/// Pulled out so the 401-refresh-retry dance above can call it twice without
/// duplicating the form-construction boilerplate.
async fn post_pcm_once(
    pcm: &[u8],
    sample_rate: u32,
    access: &str,
) -> anyhow::Result<(reqwest::StatusCode, String, Option<String>)> {
    let part = reqwest::multipart::Part::bytes(pcm.to_vec())
        .file_name("audio.pcm")
        .mime_str("application/octet-stream")?;
    let form = reqwest::multipart::Form::new()
        .text("sample_rate", sample_rate.to_string())
        .part("audio", part);

    let resp = HTTP.clone()
        .post(TITITALK_ASR_ENDPOINT)
        .bearer_auth(access)
        .multipart(form)
        .send()
        .await
        .context("TiTiTalk ASR 请求失败")?;

    let status = resp.status();
    let plan_header = resp
        .headers()
        .get("x-user-plan")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());
    let body = resp.text().await.unwrap_or_default();
    Ok((status, body, plan_header))
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
    // (v0.14.1) 识别语言 picker 砍后恒定 "auto"，不再透传到 OpenAI 端。
    if !cfg.dictionary.is_empty() {
        form = form.text("prompt", cfg.dictionary.join(", "));
    }

    let resp = HTTP.clone()
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

/// 把 tititalk_cloud 的 raw error body 翻译成给用户看的中文。
/// 关键 code 字符串保留在 message 里 —— 前端 detectUpgradeReason 仍能正则
/// 命中「quota_exceeded / pro_locked」并弹升级 banner（避免双端协议改动）。
fn friendly_cloud_error(status: u16, body: &str) -> String {
    let lower = body.to_ascii_lowercase();
    if lower.contains("quota_exceeded") || lower.contains("额度") {
        return "今日额度已用完（quota_exceeded）。可升级专业版或明天再试。".into();
    }
    if lower.contains("pro_locked") {
        return "需要专业解锁包才能使用（pro_locked）。¥49 一次解锁，或切到 TiTiTalk 云端。".into();
    }
    if lower.contains("device_limit_reached") {
        return "已达账号设备上限（device_limit_reached）。到「我的设备」管理后再试。".into();
    }
    match status {
        400 => format!("请求被拒（400）。{}", body),
        401 => "登录已失效，请到「设置 → 账号」重新登录后重试。".into(),
        402 => format!("付费栅栏触发（402）。{}", body),
        403 => format!("未授权（403）。{}", body),
        429 => "请求过于频繁，稍等几秒再试。".into(),
        500..=599 => format!("云端暂时不可用（{status}）。请稍后重试；持续不可用可切到 BYOK。"),
        _ => format!("TiTiTalk 云端 ASR 错误（{status}）：{body}"),
    }
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
