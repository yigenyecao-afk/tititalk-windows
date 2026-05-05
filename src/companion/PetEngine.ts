// Wave 4 — PetEngine: 4 信号 → state / overlays / bubble 的状态机。
//
// 信号源（webview 内可直接订阅）:
//   1. onPipeline (PipelineEvent) — 录音 phase / error / partial / sound
//   2. listen("app_context_changed") — wave 3 #1 已有的探针
//   3. cfg.companion_chattiness 控制 bubble 频率
//   4. setInterval 定时 tick 处理 idle-long / late-night / weekend 等
//
// 不从这里发后端请求 —— 配额状态从 home pane 已有的 daily_summary 走 props 注入
// （PetEngine.setQuotaPercent(p) 主动喂）。这样 PetEngine 是纯状态机，可单测。
//
// 输出：subscribe((snapshot) => …) 给 Pet.tsx；snapshot 变化时 emit 1 次。

import { listen } from "@tauri-apps/api/event";
import { onPipeline } from "../lib/api";
import type { PipelineEvent, StylistPersona } from "../lib/types";
import type {
  Overlay,
  PetMeta,
  PetSnapshot,
  PetsManifest,
} from "./types";
import { pickBubble, type BubbleTrigger } from "./bubbles";

interface AppContextEvent {
  exe: string;
  window_title: string;
}

interface ChattinessTuning {
  /// idle bubble 抽样间隔（ms）；0 = 关闭
  idleIntervalMs: number;
  /// 一次「关键事件」后的最小 bubble 间隔（防刷屏）
  minGapMs: number;
}

const CHATTINESS: Record<0 | 1 | 2 | 3, ChattinessTuning> = {
  0: { idleIntervalMs: 0, minGapMs: 0 }, // 静音
  1: { idleIntervalMs: 0, minGapMs: 30_000 }, // 只关键事件
  2: { idleIntervalMs: 12 * 60 * 1000, minGapMs: 60_000 }, // 默认
  3: { idleIntervalMs: 4 * 60 * 1000, minGapMs: 30_000 }, // 频繁
};

const IDE_RE = /(cursor|code|idea|webstorm|pycharm|rustrover|clion|goland)\.exe/i;
const MEET_RE = /(zoom|teams|wemeetapp|tencentmeeting|feishu|dingtalk)\.exe/i;
const FORMAL_RE = /(outlook|slack|wxwork)\.exe/i;

const IDLE_LONG_MS = 5 * 60 * 1000;
const BUBBLE_VISIBLE_MS = 5_500;

/// PetEngine 触发的「服务端可观察事件」类型。CompanionApp 拿这个 callback
/// 转发给 CompanionStateManager.event() — 让服务端权威算饱食/熟练/心情。
export type PetEngineEvent =
  | { kind: "session_done"; chars: number }
  | { kind: "session_record"; chars: number }
  | { kind: "session_failed" };

export class PetEngine {
  private snapshot: PetSnapshot;
  private listeners: Set<(s: PetSnapshot) => void> = new Set();
  private eventListeners: Set<(e: PetEngineEvent) => void> = new Set();
  private unsubs: Array<() => void> = [];
  private tickTimer: number | null = null;
  private bubbleTimer: number | null = null;
  /// session_done 时拿到的本段字数（外部喂入，因为 transcript event 不在 phase 流里）
  private lastSessionChars = 0;

  private chattiness: 0 | 1 | 2 | 3 = 2;
  private persona: StylistPersona = "friendly";
  private quotaPercent = 0; // 0..100
  private lastSpeechAt = Date.now();
  private lastBubbleAt = 0;
  private dayChars = 0;
  private dayCharsRecord = 0;
  private greeted = false;

  constructor(meta: PetMeta) {
    this.snapshot = {
      meta,
      state: "idle",
      overlays: [],
      bubble: null,
    };
  }

  /// 启动订阅。返回 unsubscribe 让外部 cleanup。
  async start(): Promise<void> {
    // 1. pipeline phase / error / sound — `onPipeline` returns UnlistenFn after await
    const pipeUn = await onPipeline((ev) => this.onPipeline(ev));
    this.unsubs.push(pipeUn);

    // 2. app_context_changed
    const ctxUn = await listen<AppContextEvent>(
      "app_context_changed",
      (e) => this.onAppContext(e.payload.exe),
    );
    this.unsubs.push(ctxUn);

    // 3. tick 30s 一次：idle-long / late-night / weekend
    this.tickTimer = window.setInterval(() => this.onTick(), 30_000);

    // 首次启动 greet 一次（≤ 2s 后）
    if (!this.greeted) {
      this.greeted = true;
      window.setTimeout(() => this.tryBubble("first-greet", true), 1500);
    }
  }

  stop(): void {
    for (const un of this.unsubs) un();
    this.unsubs = [];
    if (this.tickTimer != null) {
      window.clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    if (this.bubbleTimer != null) {
      window.clearTimeout(this.bubbleTimer);
      this.bubbleTimer = null;
    }
  }

  subscribe(cb: (s: PetSnapshot) => void): () => void {
    this.listeners.add(cb);
    cb(this.snapshot);
    return () => this.listeners.delete(cb);
  }

  /// 订阅「服务端可观察事件」(session_done / session_record / session_failed)。
  subscribeEvents(cb: (e: PetEngineEvent) => void): () => void {
    this.eventListeners.add(cb);
    return () => this.eventListeners.delete(cb);
  }

  private emitEvent(e: PetEngineEvent) {
    for (const cb of this.eventListeners) cb(e);
  }

  /// CompanionApp 在 onPipeline transcript event 里调，喂入本段字数；
  /// 下次进入 done phase 时计入 session_done event。
  noteSessionChars(chars: number) {
    this.lastSessionChars = chars;
  }

  /// 切宠物（用户在 Settings 选了别只）
  setPet(meta: PetMeta) {
    this.update({ meta, state: "waving", overlays: this.snapshot.overlays });
    window.setTimeout(() => this.update({ state: "idle" }), 1500);
  }

  setChattiness(c: 0 | 1 | 2 | 3) {
    this.chattiness = c;
  }

  setPersona(p: StylistPersona) {
    this.persona = p;
  }

  /// 由调用方喂入：当日字数 / 历史峰值 → 决定要不要 record-broken
  setDayChars(today: number, record: number) {
    this.dayChars = today;
    this.dayCharsRecord = record;
  }

  /// 由调用方喂入：今日 token quota 占比 0..100
  setQuotaPercent(p: number) {
    const prev = this.quotaPercent;
    this.quotaPercent = p;
    // 跨阈值 → 触发 bubble + 状态变化
    if (prev < 80 && p >= 80 && p < 95) this.tryBubble("quota-warn-80", true);
    else if (prev < 95 && p >= 95 && p < 100) this.tryBubble("quota-warn-95", true);
    else if (prev < 100 && p >= 100) {
      this.tryBubble("quota-exhausted", true);
      this.update({ state: "failed" });
    }
  }

  // ------ 内部信号处理 ------

  private onPipeline(ev: PipelineEvent) {
    // transcript event 喂入本段字数（done phase 时计入 session_done event）
    if (ev.kind === "transcript") {
      this.lastSessionChars = (ev.text || "").length;
      return;
    }
    if (ev.kind !== "phase") return;
    switch (ev.phase) {
      case "recording":
        this.lastSpeechAt = Date.now();
        this.update({ state: "waving" });
        this.tryBubble("session-start", false);
        break;
      case "transcribing":
        this.update({ state: "running" });
        break;
      case "polishing":
        this.update({ state: "review" });
        break;
      case "done":
        this.update({ state: "idle" });
        // 破纪录判断：dayChars 已在外部 set，简单比较
        if (this.dayChars > 0 && this.dayChars >= this.dayCharsRecord) {
          this.tryBubble("session-record-broken", true, { chars: this.dayChars });
          this.update({ state: "jumping" });
          window.setTimeout(() => this.update({ state: "idle" }), 1200);
          this.emitEvent({ kind: "session_record", chars: this.lastSessionChars });
        } else {
          this.tryBubble("session-success", false);
          this.emitEvent({ kind: "session_done", chars: this.lastSessionChars });
        }
        this.lastSessionChars = 0;
        break;
      case "failed":
        this.update({ state: "failed" });
        this.emitEvent({ kind: "session_failed" });
        break;
    }
  }

  private onAppContext(exe: string) {
    const overlays: Overlay[] = [];
    if (MEET_RE.test(exe)) {
      overlays.push("headset");
      this.tryBubble("app-switch-meeting", false);
    } else if (IDE_RE.test(exe)) {
      overlays.push("glasses");
      this.tryBubble("app-switch-ide", false, { appName: prettyApp(exe) });
    } else if (FORMAL_RE.test(exe)) {
      overlays.push("tie");
      this.tryBubble("app-switch-formal", false);
    }
    // 时段叠加（午夜端茶，跟当前 app 共存）
    const hr = new Date().getHours();
    if (hr >= 22 || hr < 4) overlays.push("tea");
    this.update({ overlays });
  }

  private onTick() {
    const now = Date.now();
    // idle-long
    if (now - this.lastSpeechAt > IDLE_LONG_MS) {
      if (this.snapshot.state === "idle") this.update({ state: "waiting" });
      this.tryBubble("idle-long", false);
    } else if (this.snapshot.state === "waiting") {
      this.update({ state: "idle" });
    }
    // late-night / early-morning / weekend（每 tick 各 < 0.5% 触发概率，靠 chattiness 控）
    const d = new Date();
    const hr = d.getHours();
    const dow = d.getDay();
    if (hr >= 23 || hr < 4) this.tryBubble("late-night", false);
    else if (hr < 7) this.tryBubble("early-morning", false, { hour: hr });
    if (dow === 0 || dow === 6) {
      // 周末只在工作时段提，免得下午 3 点弹「周末加班」过分热情
      if (hr >= 10 && hr <= 19) this.tryBubble("weekend", false);
    }
  }

  // ------ bubble 节流 + 抽词 ------

  /// 关键事件 important=true：跨过 chattiness=0 静音外都触发；
  /// 普通事件 important=false：受 chattiness gate + idleIntervalMs 节流。
  private tryBubble(trigger: BubbleTrigger, important: boolean, vars: Record<string, string | number> = {}) {
    if (this.chattiness === 0 && !important) return;
    const tuning = CHATTINESS[this.chattiness];
    const now = Date.now();
    if (!important && tuning.idleIntervalMs === 0) return;
    if (now - this.lastBubbleAt < tuning.minGapMs) return;
    if (!important) {
      // 非关键：抽样命中 1/N，N = idleIntervalMs / 30s（tick 频率）
      const denom = Math.max(1, Math.floor(tuning.idleIntervalMs / 30_000));
      if (Math.random() * denom > 1) return;
    }
    const text = pickBubble(trigger, this.persona, vars);
    if (!text) return;
    this.lastBubbleAt = now;
    this.update({ bubble: text });
    if (this.bubbleTimer != null) window.clearTimeout(this.bubbleTimer);
    this.bubbleTimer = window.setTimeout(() => {
      this.update({ bubble: null });
      this.bubbleTimer = null;
    }, BUBBLE_VISIBLE_MS);
  }

  private update(patch: Partial<PetSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const cb of this.listeners) cb(this.snapshot);
  }
}

function prettyApp(exe: string): string {
  const stem = exe.toLowerCase().replace(/\.exe$/, "");
  const map: Record<string, string> = {
    cursor: "Cursor",
    code: "VS Code",
    idea64: "IntelliJ",
    webstorm64: "WebStorm",
    outlook: "Outlook",
    slack: "Slack",
    wxwork: "企业微信",
    feishu: "飞书",
    dingtalk: "钉钉",
    zoom: "Zoom",
    teams: "Teams",
    wemeetapp: "腾讯会议",
  };
  return map[stem] ?? stem;
}

/// 加载 pets.json + 按 slug 取 meta；fallback 到第一只。
export async function loadPetsManifest(): Promise<PetsManifest> {
  const r = await fetch("/pets/pets.json", { cache: "no-cache" });
  if (!r.ok) throw new Error(`pets.json fetch failed: ${r.status}`);
  return (await r.json()) as PetsManifest;
}

export function findPet(manifest: PetsManifest, slug: string): PetMeta {
  const hit = manifest.pets.find((p) => p.slug === slug);
  return hit ?? manifest.pets[0];
}
