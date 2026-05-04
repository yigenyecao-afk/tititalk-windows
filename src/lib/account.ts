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
  /** (角色身份系统 v1) teacher/doctor/journalist/lawyer/engineer/
   *  product_manager/sales/general。null = 未做 onboarding，App.tsx
   *  会全屏显示 OnboardingRoleSheet 强制选（决策 #1）。 */
  role: string | null;
  role_chosen_at: string | null;
  created_at: string;
}

export type AuthState =
  | { kind: "unauthenticated" }
  | { kind: "authenticating"; session_id: string }
  | { kind: "authenticated"; user: User }
  /** `code` 是后端 error code（device_limit_reached / login_timeout / refresh_invalid /
   *  session_mismatch / network_offline 等），UI 用它精确决定要不要弹专项按钮。
   *  `manage_url` 来自服务端 detail（device_limit_reached 才有），用结构化字段
   *  避免 message.includes("dashboard/devices") 这种脆弱嗅探。 */
  | { kind: "error"; message: string; code?: string; manage_url?: string };

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
  /// True from process start until `bootstrap()` finishes (success or
  /// failure). Used by the WelcomeGate to render "正在恢复账号…" instead
  /// of flashing the login screen at users with a stored refresh token
  /// that's mid-swap.
  bootstrap_in_flight: boolean;
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

/** FIX-32: 用 catalog 反查 plan 短名（PlanBadge / Toast / 升级按钮共用）。
 *  catalog 没拉到 / plan 不在 catalog 里时回退服务端 PLAN_META 的静态镜像，
 *  再不行回退 plan code 本身——保证任意状态都不显示空。 */
export function planName(code: string, catalog: PlansCatalog | null): string {
  const hit = catalog?.plans.find((p) => p.code === code);
  if (hit) return hit.title;
  return planNameFallback(code);
}

/** 长名（用于发票/正式标题）。同样三级回退。 */
export function planLongName(code: string, catalog: PlansCatalog | null): string {
  const hit = catalog?.plans.find((p) => p.code === code);
  if (hit) return hit.title_long;
  return planNameFallback(code);
}

/** 完全断网启动时的最后兜底镜像。新增 plan code 时同步加一行（可选）。 */
function planNameFallback(code: string): string {
  switch (code) {
    case "pro_annual":   return "Pro 年订";
    case "pro_flagship": return "旗舰";
    case "pro_unlock":   return "专业解锁包";
    case "pro_lifetime": return "终身";
    case "free":         return "免费版";
    default:             return code;
  }
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

/** (角色身份系统 v1) 提交所选角色。OnboardingRoleSheet + Settings RoleRow 都调。
 *  内部 cmd_role_select 走 PUT /api/me/role + reload_me，成功后 account-state-changed
 *  事件让 React 看到新 user.role，App.tsx 的 onboarding gate 自动让位主 UI。 */
export async function selectRole(role: string): Promise<void> {
  await invoke("cmd_role_select", { role });
}

export async function reloadMe(): Promise<void> {
  await invoke("cmd_account_reload_me");
}

/** FIX-25: 单次原子拉 me + license + quota，支付成功后用。
 *  服务端 5xx 时 Rust 侧自动 fallback 到 reloadMe 路径，不抛错。 */
export async function reloadMeAtomic(): Promise<void> {
  await invoke("cmd_account_reload_me_atomic");
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
