// (v0.13.4) 首次启动 30 秒 magical moment —— 跟 Mac OnboardingWindow.swift 同源。
// 黑屏 + 中央光点呼吸 + 「现在按 F1，说一句话」+ 用户真按 hotkey 录一句 +
// 波形回应 + 转写飞入 + 「Hi, I'm TiTiTalk」+ 自关。
//
// 状态机：
//   .breath  —— 中央光点呼吸 + 副标题渐入
//   .listen  —— 检测到 phase=recording → 波形跟着 RMS 抖
//   .reveal  —— 检测到 phase=polishing/inserting 且最近一次 transcript 非空：
//               转写飞入屏幕中央 + 「Hi, I'm TiTiTalk」+ 2.6s 自关
//
// 触发：App.tsx 检测 cfg.onboarding_completed === false 时 mount 此组件。
// 完成后 cmd_save_config 写回 onboarding_completed=true 持久化。

import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { onPipeline } from "../lib/api";
import type { AppConfig } from "../lib/types";

const BAR_COUNT = 24;

type Phase = "breath" | "listen" | "reveal";

interface Props {
  cfg: AppConfig;
  onConfigUpdate: (cfg: AppConfig) => void;
  hotkeyLabel: string; // 例如 "F1"
}

export default function Onboarding({ cfg, onConfigUpdate, hotkeyLabel }: Props) {
  const [phase, setPhase] = useState<Phase>("breath");
  const [history, setHistory] = useState<number[]>(() => new Array(BAR_COUNT).fill(0));
  const [revealText, setRevealText] = useState<string>("");
  const [subtitleVisible, setSubtitleVisible] = useState(false);
  const [pulseOn, setPulseOn] = useState(false);
  const [closing, setClosing] = useState(false);
  // (验收 fix) 把 lastTranscript 跟 phase 提到 ref —— 之前 useEffect deps=[phase]
  // 每次 phase 变就重建 listener 丢失 lastTranscript；改 deps=[] 用 ref 读最新 phase。
  const lastTranscriptRef = useRef<string>("");
  const phaseRef = useRef<Phase>("breath");
  useEffect(() => { phaseRef.current = phase; }, [phase]);

  // 0.8s 后副标题渐入；breath pulse 立即开。
  // (验收 fix) 60s 兜底超时 —— 用户首次按错键 / 不录音 / 系统权限没给时，不让蒙层
  // 卡死永久遮屏。
  useEffect(() => {
    setPulseOn(true);
    const t = setTimeout(() => setSubtitleVisible(true), 800);
    const fallback = setTimeout(() => complete(), 60_000);
    return () => { clearTimeout(t); clearTimeout(fallback); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 监听 pipeline 事件：phase + level + transcript
  useEffect(() => {
    const un = onPipeline((ev) => {
      if (ev.kind === "phase") {
        const cur = phaseRef.current;
        if (ev.phase === "recording" && cur === "breath") {
          setPhase("listen");
        }
        if ((ev.phase === "polishing" || ev.phase === "inserting") && cur === "listen") {
          const txt = lastTranscriptRef.current || "听到你了。";
          setRevealText(txt);
          setPhase("reveal");
          setTimeout(() => complete(), 2600);
        }
        if (ev.phase === "failed") {
          // 错误时不打扰 — 直接关
          setTimeout(() => complete(), 800);
        }
      } else if (ev.kind === "level") {
        setHistory((prev) => {
          const next = prev.slice(1);
          next.push(Math.max(0, Math.min(1, ev.rms)));
          return next;
        });
      } else if (ev.kind === "partial" || ev.kind === "transcript") {
        if ("text" in ev && typeof ev.text === "string" && ev.text.trim()) {
          lastTranscriptRef.current = ev.text.trim();
        }
      }
    });
    return () => { un.then((fn) => fn()); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function complete() {
    if (closing) return;
    setClosing(true);
    const next = { ...cfg, onboarding_completed: true };
    try {
      await invoke("cmd_save_config", { cfg: next });
      onConfigUpdate(next);
    } catch (e) {
      console.warn("Onboarding cmd_save_config failed:", e);
      // 失败不阻塞 — 让用户先继续，下次再触发也能容忍
      onConfigUpdate(next);
    }
  }

  function barHeight(i: number): number {
    const baseline = 6;
    const maxH = 50;
    const center = (BAR_COUNT - 1) / 2;
    const dist = Math.abs(i - center) / center;
    const envelope = (Math.cos(dist * Math.PI) + 1) / 2;
    const v = history[i] ?? 0;
    return Math.max(baseline, baseline + v * maxH * envelope);
  }

  return (
    <div
      className={`onboarding-overlay${closing ? " onboarding-closing" : ""}`}
      onDoubleClick={() => complete()}
    >
      <div className="onboarding-content">
        <div className="onboarding-center">
          {phase === "breath" && (
            <div
              className="onboarding-pulse"
              style={{
                transform: pulseOn ? "scale(1.6)" : "scale(1.0)",
                opacity: pulseOn ? 0.85 : 0.45,
              }}
            />
          )}
          {phase === "listen" && (
            <div className="onboarding-bars">
              {Array.from({ length: BAR_COUNT }).map((_, i) => (
                <span
                  key={i}
                  className="onboarding-bar"
                  style={{ height: `${barHeight(i)}px` }}
                />
              ))}
            </div>
          )}
          {phase === "reveal" && (
            <div className="onboarding-reveal">{revealText}</div>
          )}
        </div>

        <div className="onboarding-instruction">
          {phase === "breath" && (
            <>
              <div
                className="onboarding-headline"
                style={{ opacity: subtitleVisible ? 1 : 0 }}
              >
                现在按 {hotkeyLabel}，说一句话
              </div>
              <div
                className="onboarding-subtitle"
                style={{ opacity: subtitleVisible ? 1 : 0 }}
              >
                看看会发生什么
              </div>
            </>
          )}
          {phase === "listen" && (
            <div className="onboarding-listening">我在听…</div>
          )}
          {phase === "reveal" && (
            <div className="onboarding-greeting">Hi, I'm TiTiTalk</div>
          )}
        </div>
      </div>

      <div className="onboarding-skip">双击屏幕跳过</div>
    </div>
  );
}
