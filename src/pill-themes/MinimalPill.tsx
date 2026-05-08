// (v0.14.1 重做) 录音浮窗 — 跟 Mac MinimalPill.swift 同源。
//
// 设计哲学（替换 16 根波形条）：
//   1. 单点光圈代替波形 — RMS 驱动饱和度 + scale，比波形更克制更有质感
//   2. 5 个用户视角的状态：
//        listening   → 「在听 ●」+ 时长（recording 但还无文字）
//        capturing   → 实时识别字幕 + 时长（recording 且有文本）
//        processing  → 「正在整理」+ 取消按钮（transcribing/polishing）
//        landed      → 「→ 已落到光标」绿色对勾（inserting）
//        errored     → ✕ 红色 + 人话错因
//   3. 字体：思源宋体（Editorial Chinese 调性）+ JetBrains Mono 时长
//   4. 状态间 cross-fade 不硬切；landed 给视觉收尾
//
// 视觉契约（跟 Mac 1:1）：
//   • 320×36 + backdrop blur dark capsule
//   • 左 14×14 状态指示器（光圈 / 弧 / 对勾 / ✕）
//   • 中实时字幕 / 状态文案
//   • 右时长 mm:ss / 取消按钮 / EmptyView

import { useEffect, useState } from "react";
import type { PillThemeProps } from "./types";
import { forceCancel } from "../lib/api";

interface Props extends PillThemeProps {
  partial: string;       // ASR 实时识别文本（recording 阶段）
  finalText: string;     // ASR final（transcribing 后保留）
  polished: string;      // polish 流式累加文本（polishing 阶段）
  sessionStart: number;  // recording 开始时戳（毫秒）— 0 = 未在录
}

export default function MinimalPill({
  rms,
  phase,
  cloudConnecting,
  partial,
  finalText,
  polished,
  sessionStart,
}: Props) {
  // 60fps reactive clock — 时长跳秒 + 光圈呼吸 + 处理弧旋转
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      setNow(Date.now());
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  // 显示文本优先级：polished (polishing) > finalText (transcribing) > partial (recording)
  const liveText =
    phase === "polishing" || phase === "inserting"
      ? polished || finalText
      : phase === "transcribing"
        ? finalText
        : partial;

  const showCancel = phase === "transcribing" || phase === "polishing" || phase === "failed";
  const showElapsed = phase === "recording" || phase === "stopping";

  return (
    <div className="pill" data-phase={phase}>
      <StatusDot phase={phase} rms={rms} now={now} />
      <CenterText
        phase={phase}
        cloudConnecting={cloudConnecting}
        liveText={liveText}
      />
      {showElapsed && sessionStart > 0 && (
        <span className="pill-elapsed">{formatElapsed(now - sessionStart)}</span>
      )}
      {showCancel && (
        <button
          className="pill-cancel"
          onClick={() => { void forceCancel(); }}
          aria-label="取消"
          title="取消（Esc）"
        >
          <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round">
            <path d="M6 6 L18 18 M18 6 L6 18" />
          </svg>
        </button>
      )}
    </div>
  );
}

// ─── Status indicator ─────────────────────────────────────────────

function StatusDot({ phase, rms, now }: { phase: string; rms: number; now: number }) {
  if (phase === "recording" || phase === "stopping") {
    const level = Math.max(0.05, Math.min(1, rms));
    const breath = 1.0 + Math.sin((now / 4000) * 2 * Math.PI) * 0.06;
    return (
      <span className="pill-dot pill-dot-recording" aria-hidden>
        <span
          className="pill-dot-halo"
          style={{ transform: `scale(${1.0 + level * 0.6})` }}
        />
        <span
          className="pill-dot-core"
          style={{
            transform: `scale(${breath})`,
            backgroundColor: level > 0.1 ? "#f5a64c" : "#c7a680",
          }}
        />
      </span>
    );
  }
  if (phase === "transcribing" || phase === "polishing") {
    const angle = (now / 1000) * 360;
    return (
      <span className="pill-dot pill-dot-processing" aria-hidden>
        <svg width="14" height="14" viewBox="0 0 14 14">
          <circle
            cx="7" cy="7" r="5"
            stroke="#f5a64c"
            strokeWidth="2"
            fill="none"
            strokeLinecap="round"
            strokeDasharray="22 32"
            transform={`rotate(${angle} 7 7)`}
          />
        </svg>
      </span>
    );
  }
  if (phase === "inserting" || phase === "done") {
    return (
      <span className="pill-dot pill-dot-landed" aria-hidden>
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="#4cc479" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M2.5 7.5 L6 11 L11.5 4" />
        </svg>
      </span>
    );
  }
  if (phase === "failed") {
    return (
      <span className="pill-dot pill-dot-error" aria-hidden>
        <svg width="14" height="14" viewBox="0 0 14 14" fill="#eb5c4c">
          <circle cx="7" cy="7" r="6.5" />
          <text x="7" y="10" textAnchor="middle" fontSize="10" fontWeight="700" fill="#fff" fontFamily="system-ui">!</text>
        </svg>
      </span>
    );
  }
  return <span className="pill-dot pill-dot-idle" aria-hidden />;
}

// ─── Center text ──────────────────────────────────────────────────

function CenterText({
  phase, cloudConnecting, liveText,
}: { phase: string; cloudConnecting: boolean; liveText: string }) {
  const text = (() => {
    if (phase === "recording" || phase === "stopping") {
      if (cloudConnecting) return "连接云端…";
      if (!liveText) return "在听";
      return liveText;
    }
    if (phase === "transcribing") return liveText || "正在识别";
    if (phase === "polishing") return liveText || "正在整理";
    if (phase === "inserting") return "→ 已落到光标";
    if (phase === "done") return "→ 已落到光标";
    if (phase === "failed") return "出问题了";
    return "";
  })();

  const isCaption = !!liveText && phase !== "inserting" && phase !== "done";
  const emphasis = phase === "inserting" || phase === "done" || phase === "failed";

  return (
    <span
      className={
        "pill-text" +
        (isCaption ? " pill-text-caption" : "") +
        (emphasis ? " pill-text-emphasis" : "")
      }
    >
      {text}
    </span>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────

function formatElapsed(ms: number): string {
  const secs = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}
