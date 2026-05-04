/**
 * (角色身份系统 v1) 客户端 catalog —— 拉公开 GET /api/roles + localStorage
 * 7 天 cache。catalog 是公开元数据（无 auth 要求），React 直接 fetch 比走
 * Tauri command 减少一层。
 *
 * 数据完全 server-driven —— 标题/emoji/副标题都从后端读，新增角色时客户端
 * 不需要改代码。版本控制由后端 ROLE_DICT_VERSION 驱动；客户端 cache 7d
 * 兜底断网/冷启动 flicker。
 */

const API_BASE = "https://tititalk.com";
const CACHE_KEY = "tititalk.roleCatalog.v1";
const CACHE_TTL_MS = 7 * 86400 * 1000;

export interface Role {
  id: string;
  title: string;
  emoji: string;
  subtitle: string;
  default_persona: string;
}

interface CachePayload {
  cached_at: number;
  roles: Role[];
}

let cached: Role[] | null = null;
let lastFetchAt: number = 0;

/** 默认兜底角色 id —— 跟后端 services/role.py::DEFAULT_ROLE 同步。
 *  catalog 拉不到时 UI 仍能渲染一张通用卡。 */
export const DEFAULT_ROLE_ID = "general";

/** 同步取本地已知 catalog —— 立即渲染用。OnboardingRoleSheet 在 effect 里
 *  并行调 fetchRoleCatalog 拉新版。 */
export function getCachedRoles(): Role[] {
  if (cached) return cached;
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return [];
    const parsed: CachePayload = JSON.parse(raw);
    if (Date.now() - parsed.cached_at > CACHE_TTL_MS) return [];
    cached = parsed.roles;
    return parsed.roles;
  } catch {
    return [];
  }
}

/** 异步拉最新 catalog；失败保留旧 cache。OnboardingRoleSheet / Settings
 *  RoleRow 进入时各调一次（去重在 lastFetchAt 里）。 */
export async function fetchRoleCatalog(force = false): Promise<Role[]> {
  if (!force && Date.now() - lastFetchAt < 60_000 && cached) {
    return cached;
  }
  try {
    const resp = await fetch(`${API_BASE}/api/roles`, {
      headers: { Accept: "application/json" },
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data: { roles: Role[] } = await resp.json();
    cached = data.roles;
    lastFetchAt = Date.now();
    try {
      const payload: CachePayload = { cached_at: lastFetchAt, roles: data.roles };
      localStorage.setItem(CACHE_KEY, JSON.stringify(payload));
    } catch {
      // localStorage 满 / 隐身模式 —— 内存里有就行
    }
    return data.roles;
  } catch (err) {
    console.warn("fetchRoleCatalog failed:", err);
    // 兜底：返回任何已有 cache
    return getCachedRoles();
  }
}

/** 按 id 查 Role —— catalog 还没拉到 / id 不在 catalog 时返 null，UI 应
 *  fallback 显示 id 字符串。 */
export function findRole(id: string | null | undefined, roles?: Role[]): Role | null {
  if (!id) return null;
  const list = roles ?? cached ?? [];
  return list.find((r) => r.id === id) ?? null;
}
