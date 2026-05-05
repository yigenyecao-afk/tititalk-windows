// P0 wave 3 #2 — 按当前前台 app 自动决定本次 polish 用什么 persona。
//
// 数据源:
//   1. 远端规则表（启动 + 5min 一次拉 /api/me/app_persona_rules/）
//   2. 客户端默认表（兜底，跟服务端 routes/app_persona.py:_DEFAULTS 对齐）
//      —— 第一次启动无网时也能切；服务端规则到达后覆盖。
//
// 输入: AppContextEvent.exe（"DingTalk.exe" / "Code.exe" 等 basename）
// 输出: persona override 字符串（"friendly" / "formal" / "code" / "mixed_zh_en"）
//       或 null（走用户默认 persona）。
//
// 调用方式:
//   const router = usePersonaRouter();   // React hook 在 App.tsx 用
//   router.startAutoRefresh();           // 启动一次
//   router.currentPersonaOverride        // 录音 forceStart 前读
//
// 不监听 forceStart 时机，因为 PersonaRouter 通过 listen("app_context_changed")
// 实时更新 currentPersonaOverride，录音真起的时候直接读 ref 即可。

import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useEffect, useRef, useState } from "react";

import {
  getAppPersonaRules,
  type AppPersonaRuleDTO,
} from "./wave3-api";

interface AppContextEvent {
  exe: string;
  window_title: string;
}

/// Win 默认表（exe basename → persona / label）—— 跟服务端 _DEFAULTS 镜像。
/// key 用 lowercase，匹配时统一 toLowerCase 防大小写漂移（OUTLOOK.EXE vs outlook.exe）。
const WIN_DEFAULTS: Record<string, { persona: string; label: string }> = {
  // 友好口语 — IM/聊天工具
  "dingtalk.exe":          { persona: "friendly",     label: "钉钉" },
  "wechat.exe":            { persona: "friendly",     label: "微信" },
  "qq.exe":                { persona: "friendly",     label: "QQ" },
  // 正式书面 — 邮件 / 团队协作
  "outlook.exe":           { persona: "formal",       label: "Outlook" },
  "slack.exe":             { persona: "formal",       label: "Slack" },
  "feishu.exe":            { persona: "formal",       label: "飞书" },
  "wxwork.exe":            { persona: "formal",       label: "企业微信" },
  // 代码 — IDE / 编辑器
  "cursor.exe":            { persona: "code",         label: "Cursor" },
  "code.exe":              { persona: "code",         label: "VS Code" },
  "idea64.exe":            { persona: "code",         label: "IntelliJ" },
  // 中英混 — 浏览器（搜索 / 网页内容偏中英杂）
  "chrome.exe":            { persona: "mixed_zh_en",  label: "Chrome" },
  "msedge.exe":            { persona: "mixed_zh_en",  label: "Edge" },
  // Mac 同源条目跳过 (Xcode/Safari/iTerm/Mail) —— 这里只关 Win 真实 exe
};

const REFRESH_INTERVAL_MS = 5 * 60 * 1000;

/// 内部状态容器 —— 用 module-level instance 让 hook 多次 mount 共享一份缓存
/// （避免每个组件挂一次都触发一遍 5min 拉）。
class PersonaRouterStore {
  private rules: Map<string, AppPersonaRuleDTO> = new Map();
  private currentExe = "";
  /// 从 app_context_changed 推断出的 persona override（null = 用默认）
  private overrideValue: string | null = null;
  private listeners: Set<(v: string | null) => void> = new Set();
  private refreshTimer: number | null = null;
  private unlisten: UnlistenFn | null = null;

  constructor() {
    this.seedDefaults();
  }

  private seedDefaults() {
    for (const [exe, meta] of Object.entries(WIN_DEFAULTS)) {
      this.rules.set(exe, {
        app_id: exe,
        persona: meta.persona,
        role: null,
        source: "default",
        enabled: true,
        label: meta.label,
      });
    }
  }

  get currentPersonaOverride(): string | null {
    return this.overrideValue;
  }

  /// 订阅 override 变化（React useState 重渲染挂钩）
  subscribe(cb: (v: string | null) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private emit() {
    for (const cb of this.listeners) cb(this.overrideValue);
  }

  /// 给 exe basename 决定 persona override（lowercase 匹配）
  personaFor(exe: string): string | null {
    const key = exe.toLowerCase();
    const r = this.rules.get(key);
    if (r && r.enabled) return r.persona;
    return null;
  }

  /// 拉服务端规则覆盖默认表。无登录 / 网失败时静默保留 cache。
  async refresh(): Promise<void> {
    try {
      const fetched = await getAppPersonaRules();
      // 把服务端规则混进默认表 —— 服务端 source=default 的也是同一份镜像，
      // 直接覆盖即可；用户改过的（source=manual）覆盖默认。
      for (const r of fetched) {
        this.rules.set(r.app_id.toLowerCase(), r);
      }
      // 如果已有 currentExe，重新算 override（规则刚更新过）
      if (this.currentExe) this.applyExe(this.currentExe);
    } catch (e) {
      // 静默：保留 cache，下次 refresh 再试
      console.debug("[PersonaRouter] refresh failed (kept cache):", e);
    }
  }

  /// 启动 5min 自动 refresh + 监听 app_context_changed
  async start(): Promise<void> {
    if (this.unlisten) return; // already running
    this.unlisten = await listen<AppContextEvent>(
      "app_context_changed",
      (e) => {
        this.applyExe(e.payload.exe);
      },
    );
    // 先刷一次 + 起周期任务
    await this.refresh();
    this.refreshTimer = window.setInterval(() => {
      void this.refresh();
    }, REFRESH_INTERVAL_MS);
  }

  stop(): void {
    if (this.unlisten) {
      this.unlisten();
      this.unlisten = null;
    }
    if (this.refreshTimer != null) {
      window.clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  private applyExe(exe: string) {
    this.currentExe = exe;
    const next = this.personaFor(exe);
    if (next !== this.overrideValue) {
      this.overrideValue = next;
      this.emit();
    }
  }
}

export const personaRouter = new PersonaRouterStore();

/// 命令式启动接口 —— App.tsx 在 useEffect 里调用一次，
/// 返回 stop fn（卸载时清 listener / interval）。
/// 跟 usePersonaRouter() hook 互补：hook 关心「当前 override 值」，
/// 这个 helper 只关心「跑没跑」。
export function startPersonaRouter(): () => void {
  void personaRouter.start();
  return () => personaRouter.stop();
}

/// React hook —— 暴露当前 override + 启动 router 的 effect
/// 用法（App.tsx）:
///   const override = usePersonaRouter();
///   // 录音前 if (override) cfg.stylist_persona = override;
///
/// 注：override 是「当前前台 app 的建议值」，并不会自己改 cfg；调用方决定怎么用。
export function usePersonaRouter(): string | null {
  const [override, setOverride] = useState<string | null>(
    personaRouter.currentPersonaOverride,
  );
  const startedRef = useRef(false);
  useEffect(() => {
    if (!startedRef.current) {
      startedRef.current = true;
      void personaRouter.start();
    }
    const unsub = personaRouter.subscribe(setOverride);
    return () => {
      unsub();
      // 故意不 stop —— store 是 module-level singleton，多 mount 共用。
      // 进程退出时由 OS 自动清。
    };
  }, []);
  return override;
}
