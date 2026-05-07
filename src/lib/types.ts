export type Engine = "tititalk_cloud" | "qwen" | "openai";

export interface AppConfig {
  engine: Engine;
  api_key: string;
  model: string;
  language: string;
  auto_insert: boolean;
  hotkey_vk: number;
  min_hold_ms: number;
  also_copy: boolean;
  dictionary: string[];
  stylist_enabled: boolean;
  stylist_persona: StylistPersona;
  stylist_model: string;
  hotkey_mode: HotkeyMode;
  hybrid_press_threshold_ms: number;
  sound_feedback_enabled: boolean;
  sound_feedback_volume: number;
  history_retention_days: number;
  history_cleanup_enabled: boolean;
  // (v0.8.3 typeoff 吸收) — 跟 Mac 2.10.35 同源
  /// P0-1 云端 ASR 5s 内未 ready → 自动回退到本地（如已配 BYOK qwen / openai key）。默认 ON。
  cloud_auto_fallback_to_local: boolean;
  /// P0-2 中文 ↔ 英文/数字 边界自动加空格（typeoff v1.0.53）。默认 ON。
  cjk_auto_space: boolean;
  /// P0-3 录音/转写中按 ESC 立即取消（typeoff v1.0.50）。默认 ON。
  esc_cancel: boolean;
  /// P0-5 录音中静音系统输出，停止后恢复（typeoff v1.0.47）。默认 OFF。
  mute_system_during_recording: boolean;
  /// P1-3 润色强度："light" / "normal" / "heavy"。默认 "normal"。
  polish_intensity: PolishIntensity;
  // (v0.8.4 backlog 5 件) — 跟 Mac 2.10.36 同源
  /// P2-2 双修饰键 hotkey："" (off, 默认) | "shift" | "cmd" | "opt" | "ctrl"
  double_modifier_key: string;
  /// P2-1 鼠标侧键 hotkey：0=off (默认), 1=XBUTTON1 back, 2=XBUTTON2 forward
  mouse_side_button: number;
  /// P1-2 词汇检测+建议加词典开关。默认 OFF
  hotword_suggestion_enabled: boolean;
  /// 翻译快捷键开关（默认 ON）
  translate_hotkey_enabled: boolean;
  /// 翻译目标语言（自然语言标签）
  translation_target: string;
  /// 「随便问」浮窗 hotkey 开关（默认 ON）
  assistant_hotkey_enabled: boolean;
  /// (v0.8.4 typeless 学习 P1 #4) 输出语言覆盖。空 = 跟随用户实际说
  /// 话语言；非空（"English" / "日本語" / "中文" 等）→ polish 阶段把
  /// 最终结果翻成指定语言。
  output_language_override: string;
  /// (v0.9.x Editorial Chinese) 录音浮窗主题。
  /// "lantern" 灯笼（球形朱砂呼吸，默认）/ "annotation" 批注（便签纸）/
  /// "telegraph" 电报（屏幕底 ticker）/ "seal" 印章（朱砂方印章）。
  pill_theme: PillTheme;
  /// Wave 4 — 桌面宠物开关，默认 OFF。
  companion_enabled: boolean;
  /// Wave 4 — 当前选中的宠物 slug（boba/byte-bunny/boxcat/punchy/scoop）。
  companion_pet_slug: string;
  /// Wave 4 — 宠物话痨度：0=静音 / 1=只关键事件 / 2=偶发+关键 (默认) / 3=频繁。
  companion_chattiness: 0 | 1 | 2 | 3;
  /// (P0-4 跨端对齐) 录音浮窗 pill 显示开关，跟 Mac floatingPillEnabled 默认 false 对齐。
  pill_enabled: boolean;
  /// (P2-30 隐私) 前台 app 上下文遥测 opt-out。默认 ON 跟旧行为兼容。
  telemetry_app_context_enabled: boolean;
  /// (v0.13.4 Onboarding) 首次启动 30 秒 magical moment 是否走完。false 时
  /// App.tsx 渲染 <Onboarding /> 全屏蒙层；用户做完一次完整录音自动置 true。
  onboarding_completed: boolean;
}

/// (v0.13.0) 4 主题对齐 Mac 老 4 主题；老 Editorial key（lantern/annotation/
/// telegraph/seal）由 SettingsSheet 启动时 normalize + cloud sync 入站迁移
/// 自动转新 key 不再出现在新 type 里。
/// (v0.13.4 返璞归真) 永远只有 "minimal" — 砍 4 主题（typeless/titi/aurora/mono）。
/// 字段保留兼容老 cfg.json + 云端 sync 入站的旧值（PillApp.migrateLegacyPillTheme
/// 会把旧值统一映射回 "minimal"）。
export type PillTheme = "minimal";

export type PolishIntensity = "light" | "normal" | "heavy";

// FIX-20 (qa-2026-05-03): code persona 加入联合类型，跟 Mac 端对齐
export type StylistPersona = "friendly" | "formal" | "mixed_zh_en" | "code";

/// 对齐 mac AppDefaults.hotkeyMode：
/// - push_to_talk: 按住录，松手停（默认；mac 上对应 Right Option 持按）
/// - toggle:       按一下开，再按一下停
/// - hybrid:       短按 toggle，长按 PTT（阈值 hybrid_press_threshold_ms）
export type HotkeyMode = "push_to_talk" | "toggle" | "hybrid";

export type PipelinePhase =
  | "idle"
  | "recording"
  | "stopping"
  | "transcribing"
  | "polishing"
  | "inserting"
  | "done"
  | "failed";

export type PipelineEvent =
  | { kind: "phase"; phase: PipelinePhase }
  | { kind: "level"; rms: number }
  /// (v0.7.6) 流式 ASR 进行中文本 — 用最新值覆盖（不是 diff），transcript 到达后清空。
  | { kind: "partial"; text: string }
  | { kind: "transcript"; text: string }
  | { kind: "error"; message: string }
  // Soft toast — graceful degradation (e.g. stylist failed but raw text was
  // inserted; hotkey pressed while logged out). Lives 3s, no red banner.
  | { kind: "notice"; message: string }
  // 后端要求前端播提示音；frontend 按 cfg.sound_feedback_enabled/volume 决定
  // 是否真播。kind: "start" / "stop"。两种是不同短 WAV，听感上能区分。
  | { kind: "sound"; sound: "start" | "stop" }
  // (ISSUE-2 2026-05-03) tititalk_cloud cold-connect 阶段标识 —— recorder
  // 已起、PCM 进 buffer，但 WS 还在握手等 ready。recording 阶段时如果
  // connecting=true，pill 文案换成「录音中… 连接云端」让用户知道是网络等待
  // (实测 2-3s)。ready 抵达后 connecting=false。Mac AppState.isCloudConnecting
  // 同源。
  | { kind: "cloud_connecting"; connecting: boolean };
