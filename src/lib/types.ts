export type Engine = "qwen" | "openai";

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
}

export type StylistPersona = "friendly" | "formal" | "mixed_zh_en";

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
  | { kind: "transcript"; text: string }
  | { kind: "error"; message: string };
