// Wave 4 — companion 共享类型。
// 跟 public/pets/pets.json schema 一一对应。

export type PetStateId =
  | "idle"
  | "running-right"
  | "running-left"
  | "waving"
  | "jumping"
  | "failed"
  | "waiting"
  | "running"
  | "review";

export interface PetStateFrame {
  row: number;
  frames: number;
  durationMs: number;
}

export type PetVibe = "cozy" | "focused" | "playful" | "heroic" | "cheerful";

export interface PetMeta {
  slug: string;
  name: string;
  vibe: PetVibe;
  /// fallback emoji — sprite 加载失败 / 用户没下 sprite 时渲染这个。
  emoji: string;
  tagline: string;
  /// spritesheet URL（相对路径或绝对）。空字符串 → 走 emoji fallback。
  spritesheet: string;
  /// sound URL（mp3/ogg）。空字符串 → 不播。
  sound: string;
  states: Record<PetStateId, PetStateFrame>;
}

export interface PetsManifest {
  version: number;
  schema: string;
  pets: PetMeta[];
}

/// PetEngine 对外暴露的 snapshot（PetView 订阅渲染）。
export interface PetSnapshot {
  meta: PetMeta;
  state: PetStateId;
  /// overlay：当前活跃的「外挂装饰」—— headset / glasses / tie / tea。
  /// 渲染层把这些当 png absolute overlay 叠在 sprite 上。
  overlays: Overlay[];
  /// 当前要显示的 bubble 文本；null = 没 bubble。
  bubble: string | null;
}

export type Overlay = "headset" | "glasses" | "tie" | "tea" | "birthday-hat";
