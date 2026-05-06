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
import { DecorationStore } from "./DecorationStore";
import {
  PetEngine,
  findPet,
  loadPetsManifest,
} from "./PetEngine";
import type { PetSnapshot, PetStateId, PetsManifest } from "./types";
import { companionStateManager } from "./CompanionStateManager";
import type { CompanionStateDTO } from "../lib/wave3-api";

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
  // C1+C3: 装饰商店 sheet + 当前 companion state（用于显示余额 + 已解锁列表）
  const [shopOpen, setShopOpen] = useState(false);
  const [companionState, setCompanionState] = useState<CompanionStateDTO | null>(null);
  const engineRef = useRef<PetEngine | null>(null);

  const handleClick = () => {
    // 单击 → 短 wave 0.7s，不进 PetEngine
    setOverrideState("waving");
    window.setTimeout(() => setOverrideState(null), 700);
  };

  const handleMenu = (e: React.MouseEvent) => {
    setMenuPos({ x: e.clientX, y: e.clientY });
  };

  const handleFeed = async () => {
    await companionStateManager.event("feed");
    setOverrideState("jumping");
    window.setTimeout(() => setOverrideState(null), 800);
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
          setCompanionState(s);  // C1: 给 streak chip + 装饰商店
        }
      });
      const offState = companionStateManager.subscribe((s) => {
        engine?.setDayChars(s.day_chars_today, s.day_chars_record);
        setCompanionState(s);  // C1: 同步给 chip
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

  return (
    <div className="companion-stage">
      <PetBubble text={snapshot.bubble} />
      <Pet
        snapshot={snapshot}
        overrideState={overrideState}
        onClick={handleClick}
        onMenu={handleMenu}
      />
      {menuPos && (
        <PetContextMenu
          x={menuPos.x}
          y={menuPos.y}
          onClose={() => setMenuPos(null)}
          onFeed={handleFeed}
          onGoAway={handleGoAway}
          onShop={() => setShopOpen(true)}
        />
      )}
      {/* C1+C3 装饰商店 */}
      {shopOpen && companionState && (
        <DecorationStore
          state={companionState}
          onClose={() => setShopOpen(false)}
          onUpdate={(s) => setCompanionState(s)}
        />
      )}
      {/* C1 streak chip：右下角，仅 streak >= 2 时显示防杂讯 */}
      {companionState && companionState.streak_days >= 2 && (
        <div className="streak-chip" title={`已连续 ${companionState.streak_days} 天 · 历史最长 ${companionState.streak_record}`}>
          🔥 {companionState.streak_days} · 💰 {companionState.coins_balance}
        </div>
      )}
    </div>
  );
}
