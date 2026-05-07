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
use std::sync::Arc;
use std::time::Duration;

use crate::config::AppConfig;
use crate::state::AppState;

const QWEN_CHAT_ENDPOINT: &str =
    "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions";
const OPENAI_CHAT_ENDPOINT: &str = "https://api.openai.com/v1/chat/completions";

/// (v0.7.4 polish-fix) BYOK 路径 timeout 8s → 20s。原 8s 对 qwen-flash
/// 短文本够用，但 qwen-plus / qwen-max 长文本经常 8-15s，每次都 timeout
/// 报错走 raw fallback，用户体感「润色失效」。20s 跟 Mac BYOK watchdog
/// 同口径，给 LLM 充足响应时间。
/// tititalk_cloud 路径走 ApiClient post_with_timeout 35s（v0.7.4 由 30s 拉，
/// 保证服务端 25s timeout 一定先到，client 只兜 forever-hang）。
const STYLIST_TIMEOUT_SECS: u64 = 20;

/// 后端 4 个 persona key（client 文案归并到这 4 个，跟 backend 写死的 prompt
/// 表对齐）。client 这边只暴露 friendly/formal/mixed_zh_en —— code 留给未来。
fn map_to_cloud_persona(client_key: &str) -> &'static str {
    match client_key {
        "formal" => "formal",
        "mixed_zh_en" => "mixed_zh_en",
        "code" => "code",
        // friendly + 任意未知值
        _ => "friendly",
    }
}

pub async fn polish(
    cfg: &AppConfig,
    raw: &str,
    state: &Arc<AppState>,
) -> anyhow::Result<String> {
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
    // (v0.13.3 极速感专项 P1-6) 短句旁路：长度 ≤ 12 字 + 末尾正常标点 + 不含
    // 口头禅 + 不含 meta-command 关键词 → 直接返回 raw 当 polished 走，省 LLM
    // round-trip（典型节省 200-500ms qwen-flash）。跟 Mac ShortSentenceBypass.swift
    // 同源策略：保守判定，宁可让边界 case 走 LLM。
    if short_sentence_can_bypass(trimmed, 12) {
        log::info!(
            "polish: short-sentence bypass (len={} chars)",
            trimmed.chars().count()
        );
        return Ok(raw.to_string());
    }

    // tititalk_cloud：走平台代理。优先尝试流式 (v0.8.6 #1)，失败 fallback 到一次性。
    if cfg.engine == "tititalk_cloud" {
        match cloud_polish_stream(cfg, trimmed, state).await {
            Ok(text) => return Ok(text),
            Err(e) => {
                log::warn!("cloud-polish stream failed, fallback to one-shot: {e}");
                return cloud_polish(cfg, trimmed, state).await;
            }
        }
    }

    if cfg.api_key.trim().is_empty() {
        return Err(anyhow!("API key 为空，无法调润色"));
    }

    let (endpoint, model) = match cfg.engine.as_str() {
        "qwen" => (QWEN_CHAT_ENDPOINT, cfg.stylist_model.as_str()),
        "openai" => (OPENAI_CHAT_ENDPOINT, "gpt-4o-mini"),
        other => return Err(anyhow!("未知引擎 {other}")),
    };

    // (v0.8.4 typeless 学习 P0 #1+#2 + P1 #4) 把 self-correction + auto-list
    // + output-language override 三段公共规则拼到 persona prompt 末尾。
    let mut sys = persona_system_prompt(&cfg.stylist_persona).to_string();
    sys.push_str(SHARED_POLISH_RULES);
    if !cfg.output_language_override.trim().is_empty() {
        sys.push_str(&format!(
            "\n\n【输出语言覆盖 / Output language override】\n\
             本次最终结果请用 **{lang}** 输出（即使用户口语用的是别的语言）。\n\
             翻译时仍遵守上面所有规则：不增不减、不改原意、保留专有名词大小写、\n\
             代码标识符和找不到合适翻译的人名/品牌名保留原文不翻。",
            lang = cfg.output_language_override.trim()
        ));
    }

    let body = ChatRequest {
        model,
        temperature: 0.2,
        messages: vec![
            ChatMessage { role: "system", content: sys.as_str().into() },
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

/// (v0.8.6 #1 streaming polish) /api/polish/stream 真流式 SSE 路径。
/// 跟 cloud_polish 同款 plan/quota gate，但 LLM token 边到边走 PipelineEvent::Partial
/// 推到前端 pill —— ASR-final 后 ~100ms 看到首个 polish token，跟 typeless 同款
/// 「边出字」体感。失败抛错让 polish() 回落到 cloud_polish 一次性路径。
async fn cloud_polish_stream(
    cfg: &AppConfig,
    text: &str,
    state: &Arc<AppState>,
) -> anyhow::Result<String> {
    let account = state
        .account
        .read()
        .clone()
        .ok_or_else(|| anyhow!("尚未登录 tititalk.com，无法走云端流式润色"))?;
    let mut model = cfg.stylist_model.clone();
    if (model == "qwen-plus" || model == "qwen-max")
        && account.current_plan().as_deref() == Some("free")
    {
        log::info!("cloud-polish-stream: free plan can't use {model} → downgrade to qwen-flash");
        model = "qwen-flash".into();
    }
    let persona = map_to_cloud_persona(&cfg.stylist_persona);

    let mut accumulated = String::new();
    let mut final_polished: Option<String> = None;
    account
        .cloud_polish_stream(
            text, persona, &model, &cfg.polish_intensity,
            cfg.cjk_auto_space, &cfg.output_language_override,
            |delta| {
                accumulated.push_str(delta);
                // pill 显示渐进 polished 文本——前端 pill PartialText 已存在的
                // 显示通道，零前端改动。每次发整段 accumulated，pill 用最新值
                // 覆盖（跟 ASR partial 同 semantics）。
                state.emit(crate::state::PipelineEvent::Partial {
                    text: accumulated.clone(),
                });
            },
            |resp| {
                if resp.over_limit {
                    log::info!("cloud-polish-stream: over_limit flag set");
                    state.emit(crate::state::PipelineEvent::Notice {
                        message: "今日云端额度已贴顶，下次将被挡 — 明天 0 点（北京）重置".into(),
                    });
                    let acc2 = account.clone();
                    tauri::async_runtime::spawn(async move {
                        let _ = acc2.reload_me().await;
                    });
                }
                final_polished = Some(strip_wrapper(&resp.polished));
            },
        )
        .await
        .map_err(|e| anyhow!(e))?;

    // SSE 流结束后用 final 事件里的 polished（已含服务端 CJK 兜底）
    final_polished.ok_or_else(|| anyhow!("流式润色未返回 final 事件"))
}

/// /api/polish 代理路径。account.cloud_polish 自带 401 refresh-then-retry
/// + 30s timeout + plan-tap，比 BYOK 路径稳。错误从 ApiError 翻成中文 anyhow
/// 抛出去，audio.rs 捕获后走「润色失败用原文」兜底。
async fn cloud_polish(
    cfg: &AppConfig,
    text: &str,
    state: &Arc<AppState>,
) -> anyhow::Result<String> {
    let account = state
        .account
        .read()
        .clone()
        .ok_or_else(|| anyhow!("尚未登录 tititalk.com，无法走云端润色"))?;

    // free plan 上不能用 qwen-plus / qwen-max（后端会 402）—— 静默降级到
    // qwen-flash，比让用户看到「升级 Pro」弹窗顺滑。
    let mut model = cfg.stylist_model.clone();
    if (model == "qwen-plus" || model == "qwen-max")
        && account.current_plan().as_deref() == Some("free")
    {
        log::info!("cloud-polish: free plan can't use {model} → downgrade to qwen-flash");
        model = "qwen-flash".into();
    }
    let persona = map_to_cloud_persona(&cfg.stylist_persona);

    match account
        .cloud_polish(text, persona, &model, &cfg.polish_intensity, cfg.cjk_auto_space, &cfg.output_language_override)
        .await
    {
        Ok(resp) => {
            // (v0.7.8) over_limit race —— 后端调 LLM 时被其他请求消完 quota，
            // 本次结果给了但下次必 429。提前给用户软提示 + 强 reload quota，
            // 避免他们按完一次没事再按一次「莫名其妙不行了」。
            if resp.over_limit {
                log::info!("cloud-polish: over_limit flag set — issuing soft warn + reload");
                state.emit(crate::state::PipelineEvent::Notice {
                    message: "今日云端额度已贴顶，下次将被挡 — 明天 0 点（北京）重置".into(),
                });
                let acc2 = account.clone();
                tauri::async_runtime::spawn(async move {
                    let _ = acc2.reload_me().await;
                });
            }
            Ok(strip_wrapper(&resp.polished))
        }
        Err(e) => {
            // 翻译几种典型错为中文，UI 兜底用得上。其它走 friendly_message。
            let status = e.status();
            let code = e.code().map(|s| s.to_string());
            let msg = e.message().to_string();
            let friendly = match (status, code.as_deref()) {
                (Some(402), Some("model_pro_locked")) => {
                    if !msg.is_empty() { msg } else { "该模型仅 Pro 起可用".into() }
                }
                (Some(429), Some("quota_exceeded")) => {
                    if !msg.is_empty() { msg } else { "今日云端配额已用完，明天 0 点重置".into() }
                }
                (Some(502), _) | (Some(504), _) => {
                    "云端润色服务暂不可用，请稍后重试".into()
                }
                _ => e.friendly_message(),
            };
            Err(anyhow!(friendly))
        }
    }
}

/// (v0.8.4 typeless 学习 P0 #1+#2) 三档 persona 公共追加规则：
///   • 自我修正处理（"等下"/"不对"/"应该是" 后的内容覆盖前面）
///   • 自动结构化列表（≥3 个明确并列项渲染成 markdown 列表）
/// 加在 persona_system_prompt 输出后。
const SHARED_POLISH_RULES: &str = "\n\n\
    【自我修正处理】—— 用户说话中途改口\n\
    口语经常出现「说一半改口」：「发给小张，不对，发给小李」「会议是 3 点，啊不是 4 点」\n\
    「用 yarn，我意思是 npm」。常见触发词：「不对」「等下」「等等」「啊不」「我的意思是」\n\
    「应该是」「还是」「重说」「sorry」「不是」「换成」。\n\
    检测到触发词时，**保留改口后的版本，丢弃改口前那段**。最终只输出用户真正想表达的，\n\
    触发词本身也不留。如果分不清是真改口还是口癖，原样保留。\n\n\
    【自动结构化列表】—— 用户明确并列时\n\
    用户连续说出 **三项或以上** 的明确并列内容（「第一/第二/第三」「一是/二是/三是」\n\
    「首先/其次/再次/最后」「Step 1 / 2 / 3」「然后是 A / 然后是 B / 然后是 C」），\n\
    渲染成 markdown 列表（`- 项目` 或 `1. 项目`）。两项或以下保持行内散文。\n\
    **不要**捏造用户没列出来的项目；**不要**把「我去了 A、B、C」简单并列变列表。";

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

/// (v0.13.3 极速感专项 P1-6) 短句旁路判定 —— 跟 Mac ShortSentenceBypass.swift
/// 同源策略：保守判定，宁可让边界 case 走 LLM 也不要 over-bypass。
///
/// 条件 AND：
///   1. 长度 ≤ max_chars
///   2. 末尾是正常标点（。！？.!?）
///   3. 不含口头禅（嗯/啊/那个/uh/um...）
///   4. 不含 meta-command 关键词（翻译/改正式/总结/translate...）
fn short_sentence_can_bypass(trimmed: &str, max_chars: usize) -> bool {
    if max_chars == 0 {
        return false;
    }
    let len = trimmed.chars().count();
    if len > max_chars {
        return false;
    }
    let last = match trimmed.chars().last() {
        Some(c) => c,
        None => return false,
    };
    let end_punct = ['。', '！', '？', '…', '）', '」', '.', '!', '?', ')', '"', '\u{201D}'];
    if !end_punct.contains(&last) {
        return false;
    }
    // 中文口头禅子串命中 → 不旁路
    let cn_fillers = [
        "嗯", "啊", "呃", "额", "诶", "哦", "嗨", "唉",
        "那个", "这个", "就是", "然后", "其实", "对吧",
        "你知道", "怎么说", "怎么讲", "我觉得",
        "比如说", "总之", "反正", "这样吧",
    ];
    for f in cn_fillers.iter() {
        if trimmed.contains(*f) {
            return false;
        }
    }
    // 英文口头禅 word-boundary 命中 → 不旁路
    let lowered = trimmed.to_lowercase();
    let padded = format!(" {} ", lowered);
    let en_fillers = [
        " uh ", " um ", " uhm ", " ah ", " er ",
        " you know ", " like ", " well ", " so ",
        " anyway ", " i mean ", " sort of ", " kind of ",
    ];
    for f in en_fillers.iter() {
        if padded.contains(*f) {
            return false;
        }
    }
    // meta-command 关键词命中 → 不旁路（让 LLM 走 meta-command 流程）
    let cn_triggers = [
        "翻译", "改正式", "改简洁", "改邮件", "总结", "做个总结",
        "写个", "帮我", "重写",
    ];
    for t in cn_triggers.iter() {
        if trimmed.contains(*t) {
            return false;
        }
    }
    let en_triggers = ["translate", "summarize", "rewrite"];
    for t in en_triggers.iter() {
        if lowered.contains(*t) {
            return false;
        }
    }
    true
}
