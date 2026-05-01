//! Stylist post-processing: feed raw ASR transcript through 百炼 chat-completion
//! with a persona prompt. Mirrors the Mac StylistService idea.
//!
//! Three personas v0.2 (kept tight on purpose; v0.3 will let users edit prompts):
//!  - `friendly`     — 顺成口语化通顺中文，去口头语；最高频默认
//!  - `formal`       — 提炼成书面、商务/邮件腔
//!  - `mixed_zh_en`  — 中英混说话场景：保留英文词，中文部分通顺
//!
//! Failure mode: returns the raw text + a log warning, never blocks insertion.
//! This is a "polish, not gate" feature — if the LLM is slow/down, user still
//! gets their transcript pasted.

use anyhow::{anyhow, Context};
use serde::{Deserialize, Serialize};
use std::time::Duration;

use crate::config::AppConfig;

const QWEN_CHAT_ENDPOINT: &str =
    "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions";
const OPENAI_CHAT_ENDPOINT: &str = "https://api.openai.com/v1/chat/completions";

/// Hard timeout — stylist must not stall the paste; raw text is the fallback.
const STYLIST_TIMEOUT_SECS: u64 = 8;

pub async fn polish(cfg: &AppConfig, raw: &str) -> anyhow::Result<String> {
    if !cfg.stylist_enabled {
        return Ok(raw.to_string());
    }
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(String::new());
    }
    // Don't bill an LLM round-trip for one-word commands.
    if trimmed.chars().count() < 4 {
        return Ok(raw.to_string());
    }
    if cfg.api_key.trim().is_empty() {
        return Err(anyhow!("API key 为空，无法调润色"));
    }

    let (endpoint, model) = match cfg.engine.as_str() {
        "qwen" => (QWEN_CHAT_ENDPOINT, cfg.stylist_model.as_str()),
        "openai" => (OPENAI_CHAT_ENDPOINT, "gpt-4o-mini"),
        other => return Err(anyhow!("未知引擎 {other}")),
    };

    let sys = persona_system_prompt(&cfg.stylist_persona);

    let body = ChatRequest {
        model,
        temperature: 0.2,
        messages: vec![
            ChatMessage { role: "system", content: sys.into() },
            ChatMessage { role: "user", content: trimmed.into() },
        ],
    };

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(STYLIST_TIMEOUT_SECS))
        .build()?;

    let resp = client
        .post(endpoint)
        .bearer_auth(&cfg.api_key)
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .context("润色请求失败（网络）")?;

    let status = resp.status();
    let txt = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(anyhow!("润色返回 {status}: {txt}"));
    }

    let parsed: ChatResponse = serde_json::from_str(&txt).context("润色响应解析失败")?;
    let polished = parsed
        .choices
        .into_iter()
        .next()
        .and_then(|c| Some(c.message.content))
        .ok_or_else(|| anyhow!("润色响应无 choices"))?;

    Ok(strip_wrapper(&polished))
}

fn persona_system_prompt(key: &str) -> &'static str {
    match key {
        "formal" => {
            "你是一个文字润色助手。把用户输入的口语转写改写为书面、正式、商务/邮件得体的中文。规则：\n\
             1. 不要添加任何不在原文里的信息或解释。\n\
             2. 不要回答用户、不要扩展、不要总结。\n\
             3. 只输出润色后的文字本身，不要任何前后缀、不要 markdown、不要引号包裹。\n\
             4. 修正口语化错乱、嗯啊、重复、自我修正，让句子通顺简洁。\n\
             5. 标点用中文标点。"
        }
        "mixed_zh_en" => {
            "你是一个文字润色助手。用户的转写是中英文混合口语。规则：\n\
             1. 保留所有英文术语/产品名/专有名词不翻译。\n\
             2. 中文部分修正口语错乱、嗯啊、重复、自我修正，使其通顺。\n\
             3. 不要添加任何不在原文里的信息。不要回答用户。\n\
             4. 只输出润色后的文字本身，无前后缀，无 markdown。\n\
             5. 中英文混排空格按英文排版规范（中英文之间加空格）。"
        }
        // friendly + 任意未知值
        _ => {
            "你是一个文字润色助手。把用户输入的口语转写改写为通顺、自然、友好的中文。规则：\n\
             1. 不要添加任何不在原文里的信息或解释。\n\
             2. 不要回答用户、不要扩展、不要总结。\n\
             3. 只输出润色后的文字本身，不要任何前后缀、不要 markdown、不要引号包裹。\n\
             4. 修正口语化错乱、嗯啊、重复、自我修正，让句子流畅。\n\
             5. 保持原意、保持长度大致一致，不要过度改写。"
        }
    }
}

/// Some models wrap output in ``` or 「」 even with explicit "no markdown" instruction.
/// Strip the outer wrapper if it's the entire payload.
fn strip_wrapper(s: &str) -> String {
    let t = s.trim();
    // ```...``` fence
    if let Some(inner) = t.strip_prefix("```").and_then(|x| x.strip_suffix("```")) {
        // Some models prefix language hint like ```text\n
        let inner = inner.trim_start_matches(|c: char| c.is_alphanumeric()).trim_start_matches('\n');
        return inner.trim().to_string();
    }
    // Chinese quote pair
    if t.starts_with('「') && t.ends_with('」') && t.chars().count() >= 2 {
        let mut chars: Vec<char> = t.chars().collect();
        chars.pop();
        chars.remove(0);
        return chars.into_iter().collect::<String>().trim().to_string();
    }
    if t.starts_with('"') && t.ends_with('"') && t.len() >= 2 {
        return t[1..t.len() - 1].trim().to_string();
    }
    t.to_string()
}

// ---------- OpenAI-compatible chat-completion shapes ----------

#[derive(Serialize)]
struct ChatRequest<'a> {
    model: &'a str,
    temperature: f32,
    messages: Vec<ChatMessage<'a>>,
}

#[derive(Serialize)]
struct ChatMessage<'a> {
    role: &'a str,
    content: std::borrow::Cow<'a, str>,
}

#[derive(Deserialize)]
struct ChatResponse {
    choices: Vec<ChatChoice>,
}

#[derive(Deserialize)]
struct ChatChoice {
    message: ChatChoiceMessage,
}

#[derive(Deserialize)]
struct ChatChoiceMessage {
    content: String,
}
