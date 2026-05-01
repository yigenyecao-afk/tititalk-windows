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
  /** "free" | "pro_annual" | "pro_flagship" | "pro_lifetime" (legacy) */
  plan: string;
  plan_expires_at: string | null;
  /** ISO timestamp; non-null = ¥49 专业版解锁包已购，本地 + BYOK 路径全开。
   * 与 plan 完全独立。 */
  pro_unlocked_at: string | null;
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
  /** Token 口径（首选 · v0.6+）。0.1s 说话 ≈ 1 token。 */
  limit_tokens?: number | null;
  used_tokens?: number | null;
  remaining_tokens?: number | null;
  /** 旧 cents 口径（兼容；客户端 v0.6 以下读这个）。 */
  limit_cents: number | null;
  used_cents: number;
  remaining_cents: number | null;
  call_count?: number | null;
  reset_at: string;
}

/** Helper: 已登录 + 已解锁 ¥49 专业包。本地 / BYOK 引擎 UI gate 用这个。 */
export function isProUnlocked(snap: AccountSnapshot | null): boolean {
  if (!snap || snap.state.kind !== "authenticated") return false;
  return snap.state.user.pro_unlocked_at != null;
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

// --- billing types ------------------------------------------------------

export interface PlanInfo {
  code: string;                   // "pro_annual" | "pro_flagship" | "pro_unlock" | future
  kind: "membership" | "pro_unlock";
  title: string;                  // short title for the upgrade card
  title_long: string;
  subtitle: string;
  price_cents: number;
  currency: string;
  duration_days: number | null;
  quota_tokens: number | null;
  features: string[];
  recommended: boolean;
  sort_order: number;
}

export interface CurrentUserOwnership {
  plan: string;
  pro_unlocked: boolean;
  owns: string[];                 // subset of {"pro_annual","pro_flagship","pro_unlock"}
}

export interface PlansCatalog {
  plans: PlanInfo[];
  currency: string;
  current_user: CurrentUserOwnership | null;
}

export interface CheckoutResp {
  order_id: number;
  trade_order_id: string;
  pay_url: string;
  qr_url: string | null;
  total_fee_cents: number;
  plan: string;
}

export interface OrderInfo {
  id: number;
  plan: string;
  status: "pending" | "paid" | "refunded" | "expired" | "failed";
  amount_cents: number;
  currency: string;
  paid_at: string | null;
  created_at: string;
  expires_at: string;
}

// --- commands -----------------------------------------------------------

export async function startLogin(): Promise<void> {
  await invoke("cmd_account_login_start");
}

export async function getBillingPlans(): Promise<PlansCatalog> {
  return await invoke<PlansCatalog>("cmd_billing_get_plans");
}

export async function billingCheckout(plan: string): Promise<CheckoutResp> {
  return await invoke<CheckoutResp>("cmd_billing_checkout", { plan });
}

export async function billingGetOrder(orderId: number): Promise<OrderInfo> {
  return await invoke<OrderInfo>("cmd_billing_get_order", { orderId });
}

export async function openPayUrl(url: string): Promise<void> {
  await invoke("cmd_billing_open_url", { url });
}

export async function reloadMe(): Promise<void> {
  await invoke("cmd_account_reload_me");
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
