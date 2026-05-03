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
}

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
  | { kind: "sound"; sound: "start" | "stop" };
