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

/// 后端 JSONL 历史 —— 启动时一次性拉，避免 React state 重启即丢。
/// 后续 transcript 仍走 onPipeline 增量加到前端 state。
export interface PersistedHistoryItem {
  at: string;          // ISO datetime
  text: string;
  engine: string;      // "tititalk_cloud" / "qwen" / "openai"
  model: string | null;
}

export async function getHistoryRecent(limit = 50): Promise<PersistedHistoryItem[]> {
  return await invoke<PersistedHistoryItem[]>("cmd_history_recent", { limit });
}

export async function clearHistory(): Promise<void> {
  await invoke("cmd_history_clear");
}

/// 麦克风可用性预检 —— 后端走 cpal default_input_device + default_input_config
/// 同一条路径，跟真录音一致。Ok = 可用，Err = 给用户看的人话（可作为 banner
/// body 直接显示）。前端在首次启动 + Settings 页面调，配「打开 Windows 设置」
/// 按钮指引用户开权限。
export async function checkMicrophone(): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    await invoke("cmd_check_microphone");
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: String(e) };
  }
}

/// 一键打开 Windows 11 「设置 → 隐私和安全 → 麦克风」深页面。
/// `ms-settings:` URI scheme 不需要权限，比让用户翻 4 层菜单友好。
export async function openMicSettings(): Promise<void> {
  await invoke("cmd_open_mic_settings");
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
