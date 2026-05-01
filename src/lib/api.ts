import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { AppConfig, PipelineEvent } from "./types";

export async function getConfig(): Promise<AppConfig> {
  return await invoke<AppConfig>("cmd_get_config");
}

export async function saveConfig(cfg: AppConfig): Promise<void> {
  await invoke("cmd_save_config", { newConfig: cfg });
}

export async function testAsr(): Promise<string> {
  return await invoke<string>("cmd_test_asr");
}

export async function forceStart(): Promise<void> {
  await invoke("cmd_force_record_start");
}
export async function forceStop(): Promise<void> {
  await invoke("cmd_force_record_stop");
}

export function onPipeline(cb: (ev: PipelineEvent) => void): Promise<UnlistenFn> {
  return listen<PipelineEvent>("pipeline", (e) => cb(e.payload));
}

/** Common Win32 virtual-key codes the user can pick. */
export const VK_CHOICES: { vk: number; label: string }[] = [
  { vk: 0x70, label: "F1" },
  { vk: 0x71, label: "F2" },
  { vk: 0x72, label: "F3" },
  { vk: 0x73, label: "F4" },
  { vk: 0x78, label: "F9" },
  { vk: 0x79, label: "F10" },
  { vk: 0x14, label: "Caps Lock" },
  { vk: 0x12, label: "Alt（左）" },
  { vk: 0x5B, label: "Win 键（左）" },
];
