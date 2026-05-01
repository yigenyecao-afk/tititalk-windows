// Frontend wrappers for the account/* Tauri commands and the
// `account-state` + `cloud-config-conflict` events. Mirror what
// `TiTiTalkAccount` + `CloudConfigSync` expose on macOS — the Settings
// "账号" section is the only consumer for now.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export interface User {
  user_id: number;
  username: string;
  display_name: string | null;
  plan: string; // "free" | "pro_annual" | "pro_lifetime"
  plan_expires_at: string | null;
  created_at: string;
}

export type AuthState =
  | { kind: "unauthenticated" }
  | { kind: "authenticating"; session_id: string }
  | { kind: "authenticated"; user: User }
  | { kind: "error"; message: string };

export interface LicenseInfo {
  plan: string;
  valid: boolean;
  expires_at: string | null;
  device_count: number;
  device_limit: number;
  checked_at: string;
}

export interface QuotaInfo {
  date: string;
  plan?: string | null;
  limit_cents: number | null;
  used_cents: number;
  remaining_cents: number | null;
  call_count?: number | null;
  reset_at: string;
}

export interface AccountSnapshot {
  state: AuthState;
  license: LicenseInfo | null;
  quota: QuotaInfo | null;
}

export interface DeviceInfo {
  id: number;
  device_name: string | null;
  machine_uuid: string | null;
  platform: string | null;
  last_seen_at: string | null;
  is_current: boolean | null;
}

export interface ConflictPayload {
  local: Record<string, unknown>;
  cloud: Record<string, unknown>;
  cloud_version: number;
}

export type ConflictAction = "keep_local" | "use_cloud" | "merge";

// --- commands -----------------------------------------------------------

export async function startLogin(): Promise<void> {
  await invoke("cmd_account_login_start");
}

export async function logout(): Promise<void> {
  await invoke("cmd_account_logout");
}

export async function getAccountState(): Promise<AccountSnapshot> {
  return await invoke<AccountSnapshot>("cmd_account_get_state");
}

export async function resolveConflict(action: ConflictAction): Promise<void> {
  await invoke("cmd_account_resolve_conflict", { action });
}

export async function getDevices(): Promise<DeviceInfo[]> {
  return await invoke<DeviceInfo[]>("cmd_account_get_devices");
}

export async function unbindDevice(deviceId: number): Promise<void> {
  await invoke("cmd_account_unbind_device", { deviceId });
}

// --- events -------------------------------------------------------------

export function onAccountState(
  cb: (snap: AccountSnapshot) => void,
): Promise<UnlistenFn> {
  return listen<AccountSnapshot>("account-state", (e) => cb(e.payload));
}

export function onConflict(
  cb: (payload: ConflictPayload) => void,
): Promise<UnlistenFn> {
  return listen<ConflictPayload>("cloud-config-conflict", (e) => cb(e.payload));
}

// --- helpers ------------------------------------------------------------

/** Format `100` as `¥1.00`. */
export function fmtCents(c: number | null | undefined, currency = "¥"): string {
  if (c == null) return "-";
  return `${currency}${(c / 100).toFixed(2)}`;
}
