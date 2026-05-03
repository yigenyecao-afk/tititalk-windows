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
    /// Hotkey 行为模式（对齐 mac AppDefaults.hotkeyMode）：
    /// - "push_to_talk": 按住录，松手停（默认）
    /// - "toggle": 按一下开，再按一下停（不需要一直按住）
    /// - "hybrid": 短按 toggle，长按（> hybrid_press_threshold_ms）push-to-talk
    #[serde(default = "default_hotkey_mode")]
    pub hotkey_mode: String,
    /// Hybrid 模式下，按下时间超过此阈值即转为 PTT；短于此阈值算 tap → toggle。
    /// mac 默认 500ms（hybridPressThresholdSeconds=0.5）。
    #[serde(default = "default_hybrid_threshold_ms")]
    pub hybrid_press_threshold_ms: u32,
    /// 录音开始 / 结束时是否播提示音（对齐 mac isSoundFeedbackEnabled，默认开）。
    #[serde(default = "yes")]
    pub sound_feedback_enabled: bool,
    /// 提示音音量 0.0~1.0（对齐 mac soundFeedbackVolume=0.4）。前端 HTML5 Audio
    /// 直接读这个值，不走系统 mixer。
    #[serde(default = "default_sound_volume")]
    pub sound_feedback_volume: f32,
    /// 历史保留天数；超过的转写记录在下次启动 + 每日 GC 时被删除。
    /// 0 = 永久保留。对齐 mac historyRetentionDays=30，但默认我们关闭清理
    /// （`history_cleanup_enabled=false`）—— 用户不主动开就不动他的数据。
    #[serde(default = "default_history_retention_days")]
    pub history_retention_days: u32,
    /// 是否启用历史清理（按 history_retention_days 截断）。默认关；用户在
    /// Settings 显式开。对齐 mac isHistoryCleanupEnabled=false。
    #[serde(default = "no")]
    pub history_cleanup_enabled: bool,
    /// If true, also copy the transcript to clipboard regardless of insert mode.
    #[serde(default = "no")]
    pub also_copy: bool,
    /// User-installed dictionary terms (passed to ASR as biasing prompt).
    #[serde(default)]
    pub dictionary: Vec<String>,
    /// Stylist post-processing: feed transcript through chat-completion with persona prompt
    /// before insertion. Default ON to match mac (`enablePolish=true`); 用户嫌慢/嫌
    /// 改太多可在 Settings 关掉。stylist 失败已经 fallback 原文 + Notice 而非整条
    /// 链路炸，开默认是安全的。
    #[serde(default = "yes")]
    pub stylist_enabled: bool,
    /// Persona key: "friendly" (default), "formal", "mixed_zh_en". Unknown → friendly.
    #[serde(default = "default_persona")]
    pub stylist_persona: String,
    /// Stylist model. Defaults to qwen-turbo for speed; user can switch to qwen-plus.
    #[serde(default = "default_stylist_model")]
    pub stylist_model: String,
    // ---- v0.8.3 typeoff 吸收（跟 Mac 2.10.35 同源） ----
    /// P0-1: 云端 ASR 5s 内未 ready → 自动回退到本地 / 备用引擎。默认 ON。
    #[serde(default = "yes")]
    pub cloud_auto_fallback_to_local: bool,
    /// P0-2: 中文 ↔ Latin 边界自动加空格（typeoff v1.0.53 同款排版规则）。默认 ON。
    #[serde(default = "yes")]
    pub cjk_auto_space: bool,
    /// P0-3: 录音/转写中按 ESC 立即取消（typeoff v1.0.50）。默认 ON。
    #[serde(default = "yes")]
    pub esc_cancel: bool,
    /// P0-5: 录音中静音系统输出，停止后恢复（typeoff v1.0.47）。默认 OFF。
    #[serde(default = "no")]
    pub mute_system_during_recording: bool,
    /// P1-3: 润色强度 "light" / "normal" / "heavy"。默认 "normal" 保留旧行为。
    #[serde(default = "default_polish_intensity")]
    pub polish_intensity: String,
}

fn default_engine() -> String { "tititalk_cloud".into() }
fn default_model() -> String { "qwen3-asr-flash".into() }
// "auto" 让百炼按音频自适应；强制 "zh" 会让英文/中英混的用户第一句就糊。
// 跟 mac AppDefaults.asrForcedLanguage="auto" 对齐。
fn default_lang() -> String { "auto".into() }
// CapsLock (VK 0x14) — 大键、容易按住、几乎没有 app 拦截。F1 在 Windows 上是
// 系统级帮助键，被浏览器/Office/IDE 多处占用，作为默认会让 60% 用户第一次试
// 就以为坏了。CapsLock 行为我们在 LL hook 里反 toggle 过（按下就 swallow 不
// 让 IME 切大写），但这里仅作默认值；用户可在「设置」改回 F1。
fn default_hotkey() -> u32 { 0x14 }
// (v0.7.8) 60ms — 真正的「轻按一下」就能识别成 PTT；旧值 150ms 太大，用户
// 短按 CapsLock 常 80-130ms，timer 还没 fire 已被 KEYUP 清 pressed_at →
// 完全没反应（v0.7.7 用户报「快捷键唤醒不了」根因之一）。
fn default_min_hold_ms() -> u32 { 60 }
fn default_persona() -> String { "friendly".into() }
// qwen-turbo 4 月已 deprecated（百炼公告点 qwen-flash 为 drop-in 替代），
// 跟 mac AppDefaults.polishModel="qwen-flash" 对齐。
fn default_stylist_model() -> String { "qwen-flash".into() }
// (v0.7.8) 默认 hybrid 而不是 push_to_talk —— 小白第一次按快捷键 99% 是
// 短按一下，PTT 模式下短按 = 不响应（无论 min_hold 多小），体感「坏了」。
// hybrid：tap 当 toggle（按一下开/再按一下停），hold 当 PTT，两路兜底。
fn default_hotkey_mode() -> String { "hybrid".into() }
// (v0.7.8) 250ms 阈值 —— 介于「快速点击 100-150ms」跟「故意长按 400ms+」
// 之间的合理切分点；500ms 太长，用户长按 0.4s 想 PTT 反而被当 toggle 双触发。
fn default_hybrid_threshold_ms() -> u32 { 250 }
fn default_sound_volume() -> f32 { 0.4 }
fn default_history_retention_days() -> u32 { 30 }
fn default_polish_intensity() -> String { "normal".into() }
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
            stylist_enabled: true,
            stylist_persona: default_persona(),
            stylist_model: default_stylist_model(),
            hotkey_mode: default_hotkey_mode(),
            hybrid_press_threshold_ms: default_hybrid_threshold_ms(),
            sound_feedback_enabled: true,
            sound_feedback_volume: default_sound_volume(),
            history_retention_days: default_history_retention_days(),
            history_cleanup_enabled: false,
            cloud_auto_fallback_to_local: true,
            cjk_auto_space: true,
            esc_cancel: true,
            mute_system_during_recording: false,
            polish_intensity: default_polish_intensity(),
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
