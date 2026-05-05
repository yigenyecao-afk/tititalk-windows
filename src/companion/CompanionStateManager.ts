// Wave 4 Stage 2 — 客户端 companion state 管理。
//
// 责任：
//   1. 启动时 GET /api/me/companion 拉服务端权威态 → 喂给 PetEngine
//   2. PetEngine 触发关键事件（session_done / session_record / session_failed /
//      feed）→ POST /api/me/companion/events，新 state 喂回 PetEngine
//   3. 每日首启 → POST decay_tick (nutrition-3 / mood-2 + day_chars_today 归零)
//   4. 用户 settings 改 pet_slug / decorations → PUT 全量（带 If-Match）
//      412 → 拿 detail.current 静默替换（server-wins，不弹 dialog）
//
// 不做的：UI；persistent local cache —— 全用服务端权威即可，client 只做 transient
// 内存态 + 网络断时 best-effort fallback。

import {
  getCompanionState,
  postCompanionEvent,
  putCompanionState,
  type CompanionEventType,
  type CompanionStateDTO,
} from "../lib/wave3-api";

const DECAY_TICK_KEY = "companion:lastDecayDate";

export class CompanionStateManager {
  private state: CompanionStateDTO | null = null;
  private listeners = new Set<(s: CompanionStateDTO) => void>();
  /// 防同时多次 PUT —— 用户连续点 Settings 时合并到最新一次
  private pendingPut: ReturnType<typeof setTimeout> | null = null;
  /// 5min 跨设备 pull 定时器 — 用户在 Mac 改的，Win 这边能在 5min 内同步
  private pullTimer: ReturnType<typeof setInterval> | null = null;

  /// 启动时拉一次 + 触发 decay_tick (一日一次)
  async start(): Promise<void> {
    try {
      const s = await getCompanionState();
      this.update(s);
    } catch (e) {
      console.debug("[companion-state] initial GET failed (probably logged out):", e);
      return;
    }
    // decay_tick once per day
    const today = new Date().toISOString().slice(0, 10);
    const last = window.localStorage.getItem(DECAY_TICK_KEY);
    if (last !== today) {
      try {
        const s = await postCompanionEvent({ type: "decay_tick" });
        this.update(s);
        window.localStorage.setItem(DECAY_TICK_KEY, today);
      } catch (e) {
        console.debug("[companion-state] decay_tick failed:", e);
      }
    }

    // 5min 跨设备 pull —— 让 Win 同步 Mac 上的改动；只在没本地未发 PUT 时拉
    if (this.pullTimer) clearInterval(this.pullTimer);
    this.pullTimer = setInterval(async () => {
      if (this.pendingPut) return; // 本地有未 flush 的修改，等 PUT 完成
      try {
        const s = await getCompanionState();
        if (this.state == null || s.version !== this.state.version) {
          this.update(s);
        }
      } catch {
        // 静默
      }
    }, 5 * 60 * 1000);
  }

  current(): CompanionStateDTO | null {
    return this.state;
  }

  subscribe(cb: (s: CompanionStateDTO) => void): () => void {
    this.listeners.add(cb);
    if (this.state) cb(this.state);
    return () => this.listeners.delete(cb);
  }

  /// 触发服务端权威增量
  async event(type: CompanionEventType, chars = 0): Promise<void> {
    try {
      const s = await postCompanionEvent({ type, chars });
      this.update(s);
    } catch (e) {
      console.debug("[companion-state] event", type, "failed:", e);
    }
  }

  /// 用户改了 pet_slug / decorations → debounce 800ms 后 PUT
  schedulePut(payload: { pet_slug: string; decorations: string[] }): void {
    if (this.pendingPut) clearTimeout(this.pendingPut);
    this.pendingPut = setTimeout(async () => {
      this.pendingPut = null;
      const v = this.state?.version ?? 1;
      try {
        const s = await putCompanionState(payload, v);
        this.update(s);
      } catch (e: any) {
        // 412 server-wins：detail.current 是新 state，静默接受
        const detail = e?.detail ?? e?.response?.detail;
        if (detail && typeof detail === "object" && detail.current) {
          this.update(detail.current as CompanionStateDTO);
          return;
        }
        console.debug("[companion-state] PUT failed:", e);
      }
    }, 800);
  }

  private update(s: CompanionStateDTO) {
    this.state = s;
    for (const cb of this.listeners) cb(s);
  }
}

/// module-level singleton — companion webview / main webview 共享一份
export const companionStateManager = new CompanionStateManager();
