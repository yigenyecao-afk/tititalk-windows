// Wave 4 — companion webview 主组件。挂在 companion.html 的 #root。
//
// 生命周期:
//   1. mount → fetch /pets/pets.json + load cfg + 创建 PetEngine
//   2. PetEngine.start() (订阅 4 信号)
//   3. cfg.companion_enabled 变化 → 调 cmd_companion_show/hide（不在这里做，
//      由 main webview 在 SettingsSheet 改时即调）
//   4. 透过 listen("config-updated") 实时换 chattiness / persona / pet
//   5. 透过 listen("companion-quota") 接 main webview 喂的 quota 百分比
//
// 不在这里:
//   - account / billing / quota 拉取 — 那是 main webview 的活，结果通过 emit
//     发过来即可（避免双 webview 重复调 backend）

import { useEffect, useRef, useState } from "react";
import { listen, emitTo } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import type { AppConfig } from "../lib/types";
import { Pet } from "./Pet";
import { PetBubble } from "./PetBubble";
import { PetContextMenu } from "./PetContextMenu";
import {
  PetEngine,
  findPet,
  loadPetsManifest,
} from "./PetEngine";
import type { PetSnapshot, PetStateId, PetsManifest } from "./types";
import { companionStateManager } from "./CompanionStateManager";

const HIDE_1H_MS = 60 * 60 * 1000;
const FOCUS_DURATION_MS = 25 * 60 * 1000; // 25min 番茄
const HIDE_1H_KEY = "companion:hideUntil";

interface QuotaPayload {
  percent: number;
  day_chars?: number;
  day_chars_record?: number;
}

interface ConfigUpdatedPayload {
  cfg: AppConfig;
}

export default function CompanionApp() {
  const [snapshot, setSnapshot] = useState<PetSnapshot | null>(null);
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);
  const [overrideState, setOverrideState] = useState<PetStateId | null>(null);
  const [focusEndsAt, setFocusEndsAt] = useState<number | null>(null);
  const [focusRemain, setFocusRemain] = useState<string>("");
  const engineRef = useRef<PetEngine | null>(null);

  // 专心模式倒计时显示（每秒刷一次）
  useEffect(() => {
    if (focusEndsAt == null) {
      setFocusRemain("");
      return;
    }
    const tick = () => {
      const left = focusEndsAt - Date.now();
      if (left <= 0) {
        setFocusEndsAt(null);
        setFocusRemain("");
        return;
      }
      const m = Math.floor(left / 60_000);
      const s = Math.floor((left % 60_000) / 1000);
      setFocusRemain(`${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`);
    };
    tick();
    const t = window.setInterval(tick, 1000);
    return () => window.clearInterval(t);
  }, [focusEndsAt]);

  const handleClick = () => {
    // 单击 → 短 wave 0.7s，不进 PetEngine
    setOverrideState("waving");
    window.setTimeout(() => setOverrideState(null), 700);
  };

  const handleDoubleClick = () => {
    // 双击 → 进 / 退 25min 专心模式
    setFocusEndsAt((cur) => (cur ? null : Date.now() + FOCUS_DURATION_MS));
  };

  const handleMenu = (e: React.MouseEvent) => {
    setMenuPos({ x: e.clientX, y: e.clientY });
  };

  const handleFeed = async () => {
    await companionStateManager.event("feed");
    setOverrideState("jumping");
    window.setTimeout(() => setOverrideState(null), 800);
  };

  const handleRename = () => {
    const name = window.prompt("给 ta 起个新名字（仅本地显示）：", snapshot?.meta.name ?? "");
    if (name && name.trim()) {
      window.localStorage.setItem(`companion:nameOf:${snapshot?.meta.slug}`, name.trim());
    }
  };

  const handleHide1h = async () => {
    window.localStorage.setItem(HIDE_1H_KEY, String(Date.now() + HIDE_1H_MS));
    try { await invoke("cmd_companion_hide"); } catch {}
    // 1h 后自动恢复
    window.setTimeout(async () => {
      try { await invoke("cmd_companion_show"); } catch {}
    }, HIDE_1H_MS);
  };

  const handleShare = async () => {
    if (!snapshot) return;
    try {
      const { renderShareCard } = await import("./ShareCard");
      const { save } = await import("@tauri-apps/plugin-dialog");
      const cloudState = companionStateManager.current();
      const customName = window.localStorage.getItem(`companion:nameOf:${snapshot.meta.slug}`);
      const dayChars = cloudState?.day_chars_today ?? 0;
      const skillLvl = cloudState?.skill_lvl ?? 1;
      const streakDays = 0; // streak 不在 companion DTO 里 — 留待 Stage 3
      const savedMinutes = dayChars * 0.0032 * 60; // 跟后端公式同源（chars*0.8/250 min*60s）
      const base64 = await renderShareCard({
        pet: snapshot.meta,
        petName: customName ?? snapshot.meta.name,
        dayChars,
        savedMinutes: dayChars * 0.0032,
        streakDays,
        skillLvl,
      });
      void savedMinutes;
      const target = await save({
        defaultPath: `${snapshot.meta.slug}-${new Date().toISOString().slice(0, 10)}.png`,
        filters: [{ name: "PNG 图片", extensions: ["png"] }],
      });
      if (!target) return;
      await invoke("cmd_companion_save_share_card", {
        path: target,
        dataBase64: base64,
      });
    } catch (e) {
      console.warn("[companion] share-card failed:", e);
    }
  };

  const handleGoAway = () => {
    // 「走开」= 让 main webview 把 cfg.companion_enabled 写回 false 让下次启动不出现。
    // 跨 webview 通信走 Tauri emitTo("main", ...)；main App.tsx 在 useEffect 监听。
    void invoke("cmd_companion_hide");
    void emitTo("main", "companion-go-away", {});
  };

  useEffect(() => {
    let engine: PetEngine | null = null;
    let unsubs: Array<() => void> = [];
    let alive = true;

    (async () => {
      let manifest: PetsManifest;
      try {
        manifest = await loadPetsManifest();
      } catch (e) {
        console.error("[companion] load manifest failed:", e);
        return;
      }
      let cfg: AppConfig | null = null;
      try {
        cfg = await invoke<AppConfig>("cmd_get_config");
      } catch (e) {
        console.error("[companion] cmd_get_config failed:", e);
      }
      const slug = cfg?.companion_pet_slug ?? "boba";
      const meta = findPet(manifest, slug);
      if (!alive) return;
      engine = new PetEngine(meta);
      engineRef.current = engine;
      engine.setChattiness((cfg?.companion_chattiness ?? 2) as 0 | 1 | 2 | 3);
      engine.setPersona(cfg?.stylist_persona ?? "friendly");

      const off = engine.subscribe(setSnapshot);
      unsubs.push(off);

      // Stage 2 — events fan-out 给 CompanionStateManager (服务端权威算饱食/熟练/心情)
      const offEv = engine.subscribeEvents((ev) => {
        if (ev.kind === "session_done") void companionStateManager.event("session_done", ev.chars);
        else if (ev.kind === "session_record") void companionStateManager.event("session_record", ev.chars);
        else if (ev.kind === "session_failed") void companionStateManager.event("session_failed");
      });
      unsubs.push(offEv);

      // Stage 2 — 拉云端 state（拿到 day_chars_record + nutrition/skill/mood）
      void companionStateManager.start().then(() => {
        const s = companionStateManager.current();
        if (s) {
          engine?.setDayChars(s.day_chars_today, s.day_chars_record);
          engine?.setQuotaPercent(0); // quota 由 main webview 60s 推
        }
      });
      const offState = companionStateManager.subscribe((s) => {
        engine?.setDayChars(s.day_chars_today, s.day_chars_record);
      });
      unsubs.push(offState);

      await engine.start();

      // 监听 main 发的 config 更新（用户在 SettingsSheet 切宠物 / 话痨度 时）
      const cfgUn = await listen<ConfigUpdatedPayload>("companion-config", (e) => {
        const p = e.payload?.cfg;
        if (!p) return;
        engine?.setChattiness(p.companion_chattiness as 0 | 1 | 2 | 3);
        engine?.setPersona(p.stylist_persona);
        if (p.companion_pet_slug !== engine?.["snapshot"].meta.slug) {
          const next = findPet(manifest, p.companion_pet_slug);
          engine?.setPet(next);
        }
      });
      unsubs.push(cfgUn);

      // 监听 main 喂的 quota / 字数（main pane 已经拉过 daily_summary，转喂即可）
      const qUn = await listen<QuotaPayload>("companion-quota", (e) => {
        const p = e.payload;
        if (typeof p.percent === "number") engine?.setQuotaPercent(p.percent);
        if (typeof p.day_chars === "number" && typeof p.day_chars_record === "number") {
          engine?.setDayChars(p.day_chars, p.day_chars_record);
        }
      });
      unsubs.push(qUn);
    })();

    return () => {
      alive = false;
      for (const un of unsubs) un();
      engine?.stop();
    };
  }, []);

  if (!snapshot) {
    return null; // 资源没就绪前，透明窗口什么都不显示
  }

  // 专心模式：bubble 抑制 + sprite 加 focus-pulse 光晕，剩余时间显示底部
  const inFocus = focusEndsAt != null;

  return (
    <div className={"companion-stage" + (inFocus ? " focus-pulse" : "")}>
      <PetBubble text={inFocus ? "🍅 专心中…" : snapshot.bubble} />
      <Pet
        snapshot={snapshot}
        overrideState={overrideState}
        onClick={handleClick}
        onDoubleClick={handleDoubleClick}
        onMenu={handleMenu}
      />
      {inFocus && <div className="focus-timer">{focusRemain}</div>}
      {menuPos && (
        <PetContextMenu
          x={menuPos.x}
          y={menuPos.y}
          onClose={() => setMenuPos(null)}
          onFeed={handleFeed}
          onRename={handleRename}
          onHide1h={handleHide1h}
          onShare={handleShare}
          onGoAway={handleGoAway}
        />
      )}
    </div>
  );
}
