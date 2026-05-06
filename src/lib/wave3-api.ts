// P0 wave 3 — TiTiTalk REST 客户端：personalization / app_persona / repolish /
// orgs / audit / meetings / cross-history search 17 个 endpoint。
//
// 对应 Mac 端 WaveThreeAPI.swift。所有调用走 cmd_account_authed_{get,post,put,
// delete} 通用通道，复用 Account 的 token / refresh single-flight / X-User-Plan
// tap，不新起 fetch。
//
// 类型尽量贴 Mac 端口径，但保留 TypeScript 习惯（snake_case 字段照 backend 原样）。

import { invoke } from "@tauri-apps/api/core";

// ---- 共用通道 -----------------------------------------------------------

async function authedGet<T>(path: string): Promise<T> {
  return await invoke<T>("cmd_account_authed_get", { path });
}

async function authedPost<T>(path: string, body: unknown): Promise<T> {
  return await invoke<T>("cmd_account_authed_post", { path, body });
}

async function authedPut<T>(
  path: string,
  body: unknown,
  headers?: Record<string, string>,
): Promise<T> {
  return await invoke<T>("cmd_account_authed_put", { path, body, headers });
}

async function authedDelete(path: string): Promise<void> {
  await invoke("cmd_account_authed_delete", { path });
}

// ---- #1 Personalization (圆环 + 6 指标) ---------------------------------

export interface PersonalizationDTO {
  score: number;
  role_set: boolean;
  dict_count: number;
  corrections_count: number;
  streak_days: number;
  apps_used_30d: number;
  breakdown: Record<string, number>;
}

export function getPersonalization(): Promise<PersonalizationDTO> {
  return authedGet<PersonalizationDTO>("/api/me/personalization");
}

// ---- #7 Daily summary card -----------------------------------------------

export interface DailySummaryDTO {
  date: string;
  chars: number;
  saved_minutes: number;
  calls: number;
  streak_days: number;
  quota_used_pct: number;
}

export function getDailySummary(): Promise<DailySummaryDTO> {
  return authedGet<DailySummaryDTO>("/api/me/daily_summary");
}

// ---- #2 App persona rules ------------------------------------------------

export interface AppPersonaRuleDTO {
  app_id: string;
  persona: string;
  role: string | null;
  source: "default" | "auto" | "manual" | string;
  enabled: boolean;
  label: string | null;
}

export interface AppPersonaRuleIn {
  persona: string;
  role: string | null;
  enabled: boolean;
}

export function getAppPersonaRules(): Promise<AppPersonaRuleDTO[]> {
  return authedGet<AppPersonaRuleDTO[]>("/api/me/app_persona_rules/");
}

export function putAppPersonaRule(
  appId: string,
  body: AppPersonaRuleIn,
): Promise<AppPersonaRuleDTO> {
  const enc = encodeURIComponent(appId);
  return authedPut<AppPersonaRuleDTO>(`/api/me/app_persona_rules/${enc}`, body);
}

export function deleteAppPersonaRule(appId: string): Promise<void> {
  const enc = encodeURIComponent(appId);
  return authedDelete(`/api/me/app_persona_rules/${enc}`);
}

// ---- #13 Cross-history search --------------------------------------------

export interface HistorySearchHitDTO {
  id: number;
  role: string | null;
  snippet: string;
  matched_field: string;
  created_at: string;
}

export function searchHistory(
  q: string,
  limit = 20,
): Promise<HistorySearchHitDTO[]> {
  const qenc = encodeURIComponent(q);
  return authedGet<HistorySearchHitDTO[]>(
    `/api/me/history_search?q=${qenc}&limit=${limit}`,
  );
}

// ---- #43 Repolish batch --------------------------------------------------

export interface RepolishItemIn {
  id: string;
  text: string;
}

export interface RepolishItemResultDTO {
  id: string;
  polished: string | null;
  error: string | null;
  cost_tokens: number;
}

export interface RepolishIn {
  items: RepolishItemIn[];
  persona: string;
  model: string;
  intensity: string;
  output_language: string;
  strip_fillers: boolean;
}

export interface RepolishOut {
  results: RepolishItemResultDTO[];
  total_cost_tokens: number;
  used_tokens: number;
  limit_tokens: number;
  remaining_tokens: number;
  over_limit: boolean;
}

export function repolishBatch(payload: RepolishIn): Promise<RepolishOut> {
  return authedPost<RepolishOut>("/api/polish/repolish", payload);
}

// ---- #21 Orgs ------------------------------------------------------------

export interface OrgDTO {
  id: number;
  name: string;
  slug: string;
  plan: string;
  seat_limit: number;
  sso_enabled: boolean;
  audit_enabled: boolean;
  role: string;
}

export interface OrgCreateIn {
  name: string;
  slug: string;
}

export interface OrgMemberDTO {
  user_id: number;
  username: string | null;
  role: string;
  invited_at: string;
  joined_at: string | null;
}

/** 后端 200 + null = 用户没 org；这里包成 try-catch 让调用方拿到 null。 */
export async function getMyOrg(): Promise<OrgDTO | null> {
  try {
    const v = await authedGet<OrgDTO | null>("/api/me/org");
    return v ?? null;
  } catch {
    return null;
  }
}

export function createOrg(payload: OrgCreateIn): Promise<OrgDTO> {
  return authedPost<OrgDTO>("/api/me/org", payload);
}

export function listOrgMembers(): Promise<OrgMemberDTO[]> {
  return authedGet<OrgMemberDTO[]>("/api/me/org/members");
}

export function addOrgMember(
  user_id: number,
  role: string,
): Promise<OrgMemberDTO> {
  return authedPost<OrgMemberDTO>("/api/me/org/members", { user_id, role });
}

export function removeOrgMember(uid: number): Promise<void> {
  return authedDelete(`/api/me/org/members/${uid}`);
}

// ---- #22 Audit -----------------------------------------------------------

export interface AuditEntryDTO {
  id: number;
  action: string;
  resource: string | null;
  ip: string | null;
  extra: Record<string, string> | null;
  created_at: string;
}

export function listMyAudit(days = 30, limit = 200): Promise<AuditEntryDTO[]> {
  return authedGet<AuditEntryDTO[]>(
    `/api/me/audit?days=${days}&limit=${limit}`,
  );
}

// ---- #12 Meetings --------------------------------------------------------

export interface MeetingStartIn {
  source: string;
  title: string | null;
}

export interface MeetingStopIn {
  transcript: string | null;
  audio_url: string | null;
  duration_sec: number | null;
}

export interface MeetingDTO {
  id: number;
  source: string;
  title: string | null;
  status: string;
  started_at: string;
  ended_at: string | null;
  duration_sec: number | null;
  transcript_chars: number | null;
}

export function startMeeting(payload: MeetingStartIn): Promise<MeetingDTO> {
  return authedPost<MeetingDTO>("/api/me/meetings/start", payload);
}

export function stopMeeting(
  id: number,
  payload: MeetingStopIn,
): Promise<MeetingDTO> {
  return authedPost<MeetingDTO>(`/api/me/meetings/${id}/stop`, payload);
}

export function listMeetings(days = 30, limit = 50): Promise<MeetingDTO[]> {
  return authedGet<MeetingDTO[]>(`/api/me/meetings?days=${days}&limit=${limit}`);
}

// ---- Wave 4 Stage 2 Companion state ------------------------------------

export interface CompanionStateDTO {
  pet_slug: string;
  nutrition: number;        // 0..100
  skill_lvl: number;        // 1..50
  mood: number;             // 0..100
  birthday: string | null;  // YYYY-MM-DD
  decorations: string[];    // ["headset", "tea", ...]
  version: number;          // 乐观锁
  day_chars_today: number;
  day_chars_record: number;
  // C1 (2026-05-06): 连击 + 专注币
  streak_days: number;
  streak_record: number;
  coins_balance: number;
  unlocked_decorations: string[];
}

export interface SeasonalDecorationDTO {
  slug: string;
  name: string;
  emoji: string;
  is_free: boolean;
  cost: number;
  end_date: string | null;
}

export interface SeasonalDecorationsDTO {
  items: SeasonalDecorationDTO[];
}

export type CompanionEventType =
  | "feed"
  | "session_done"
  | "session_failed"
  | "session_record"
  | "decay_tick";

export interface CompanionEventIn {
  type: CompanionEventType;
  chars?: number;           // session_done / session_record 才用
}

export function getCompanionState(): Promise<CompanionStateDTO> {
  return authedGet<CompanionStateDTO>("/api/me/companion");
}

/// 服务端 If-Match 必带；版本不一致 412 → server-wins，client 拿 detail.current 替换本地。
export function putCompanionState(
  payload: { pet_slug: string; decorations: string[] },
  expectedVersion: number,
): Promise<CompanionStateDTO> {
  return authedPut<CompanionStateDTO>(
    "/api/me/companion",
    payload,
    { "If-Match": String(expectedVersion) },
  );
}

export function postCompanionEvent(ev: CompanionEventIn): Promise<CompanionStateDTO> {
  return authedPost<CompanionStateDTO>("/api/me/companion/events", ev);
}

// C3 (2026-05-06): 节日装饰当前可用列表
export function getSeasonalDecorations(): Promise<SeasonalDecorationsDTO> {
  return authedGet<SeasonalDecorationsDTO>("/api/me/companion/decorations/seasonal");
}

// C1+C3: 用专注币（或 free 时间窗）解锁装饰
export function spendForDecoration(slug: string): Promise<CompanionStateDTO> {
  return authedPost<CompanionStateDTO>(
    "/api/me/companion/decorations/spend",
    { decoration_slug: slug },
  );
}
