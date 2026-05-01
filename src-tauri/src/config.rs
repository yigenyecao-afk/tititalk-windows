use std::path::PathBuf;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppConfig {
    /// Engine: "tititalk_cloud" (推荐 · 走 tititalk.com 代理 · 计平台额度) /
    /// "qwen" (BYOK DashScope/百炼 直连，需自填 key，不计平台额度) /
    /// "openai" (BYOK OpenAI Whisper)。
    /// 默认 tititalk_cloud — 商业模型核心路径，新用户登录即可用。
    #[serde(default = "default_engine")]
    pub engine: String,
    /// API key for the active engine. Stored locally (Windows DPAPI in v0.2).
    #[serde(default)]
    pub api_key: String,
    /// "qwen3-asr-flash" / "paraformer-realtime-v2" / "whisper-1" etc.
    #[serde(default = "default_model")]
    pub model: String,
    /// "zh" / "en" / "auto"
    #[serde(default = "default_lang")]
    pub language: String,
    /// Whether to auto-insert text into the foreground app.
    #[serde(default = "yes")]
    pub auto_insert: bool,
    /// Hotkey: virtual-key code that triggers push-to-talk while held.
    /// Defaults to F1 (0x70). Win+key combos handled separately.
    #[serde(default = "default_hotkey")]
    pub hotkey_vk: u32,
    /// Min hold duration to count as a real press (ms), filters accidental taps.
    #[serde(default = "default_min_hold_ms")]
    pub min_hold_ms: u32,
    /// If true, also copy the transcript to clipboard regardless of insert mode.
    #[serde(default = "no")]
    pub also_copy: bool,
    /// User-installed dictionary terms (passed to ASR as biasing prompt).
    #[serde(default)]
    pub dictionary: Vec<String>,
    /// Stylist post-processing: feed transcript through chat-completion with persona prompt
    /// before insertion. Default off (raw ASR), user opts in.
    #[serde(default = "no")]
    pub stylist_enabled: bool,
    /// Persona key: "friendly" (default), "formal", "mixed_zh_en". Unknown → friendly.
    #[serde(default = "default_persona")]
    pub stylist_persona: String,
    /// Stylist model. Defaults to qwen-turbo for speed; user can switch to qwen-plus.
    #[serde(default = "default_stylist_model")]
    pub stylist_model: String,
}

fn default_engine() -> String { "tititalk_cloud".into() }
fn default_model() -> String { "qwen3-asr-flash".into() }
fn default_lang() -> String { "zh".into() }
fn default_hotkey() -> u32 { 0x70 } // VK_F1
fn default_min_hold_ms() -> u32 { 150 }
fn default_persona() -> String { "friendly".into() }
fn default_stylist_model() -> String { "qwen-turbo".into() }
fn yes() -> bool { true }
fn no() -> bool { false }

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            engine: default_engine(),
            api_key: String::new(),
            model: default_model(),
            language: default_lang(),
            auto_insert: true,
            hotkey_vk: default_hotkey(),
            min_hold_ms: default_min_hold_ms(),
            also_copy: false,
            dictionary: vec![],
            stylist_enabled: false,
            stylist_persona: default_persona(),
            stylist_model: default_stylist_model(),
        }
    }
}

pub fn config_path() -> PathBuf {
    let mut p = dirs::config_dir().unwrap_or_else(|| PathBuf::from("."));
    p.push("TiTiTalk");
    let _ = std::fs::create_dir_all(&p);
    p.push("config.json");
    p
}

pub fn load_config() -> AppConfig {
    let path = config_path();
    match std::fs::read_to_string(&path) {
        Ok(s) => serde_json::from_str(&s).unwrap_or_default(),
        Err(_) => AppConfig::default(),
    }
}

pub fn save_config(cfg: &AppConfig) -> anyhow::Result<()> {
    let path = config_path();
    let s = serde_json::to_string_pretty(cfg)?;
    std::fs::write(path, s)?;
    Ok(())
}
