import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/// 跟 Rust companion::state::CompanionSnapshot 一一对应。
export type CompanionMood = "wandering" | "stationary" | "wave" | "jump";
export type CompanionFacing = "left" | "right";

export interface CompanionState {
  mood: CompanionMood;
  facing: CompanionFacing;
}

/// 跟 Rust companion::catalog::PetEntry 一一对应。
export interface PetEntry {
  slug: string;
  display_name: string;
  description: string | null;
  /// 绝对路径——webview 渲染时需经 `convertFileSrc` 转 asset:// URL。
  spritesheet_path: string;
  is_bundled: boolean;
}

export async function listPets(): Promise<PetEntry[]> {
  return await invoke<PetEntry[]>("cmd_companion_list_pets");
}

export async function tap(): Promise<void> {
  await invoke("cmd_companion_tap");
}

export async function doubleTap(): Promise<void> {
  await invoke("cmd_companion_double_tap");
}

export async function dragEnd(): Promise<void> {
  await invoke("cmd_companion_drag_end");
}

export async function savePosition(x: number, y: number): Promise<void> {
  await invoke("cmd_companion_save_position", { x, y });
}

export function onCompanionState(cb: (s: CompanionState) => void): Promise<UnlistenFn> {
  return listen<CompanionState>("companion-state", (e) => cb(e.payload));
}
