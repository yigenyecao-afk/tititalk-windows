/// 简净 (typeless) — 跟 Mac TypelessPill 视觉对齐：毛玻璃极简横条 + 朱砂边框
/// idle 时朱砂边框 1.6s 呼吸，录音时 RMS 驱动边框透明度。
import type { PillThemeProps } from "./types";
import { useEffect, useState } from "react";

export default function TypelessPill({ mode, text, rms, cloudConnecting, showPttHint }: PillThemeProps) {
  const isIdle = mode !== "live" && mode !== "listening" && mode !== "polishing";
  const [breathPulse, setBreathPulse] = useState(false);

  // idle 朱砂边框呼吸；非 idle 跟 RMS 强度走
  useEffect(() => {
    if (!isIdle) return;
    const t = setInterval(() => setBreathPulse((p) => !p), 800);
    return () => clearInterval(t);
  }, [isIdle]);

  const strokeOpacity = isIdle
    ? (breathPulse ? 0.55 : 0.30)
    : 0.30 + Math.min(0.40, rms * 0.40);
  const strokeWidth = isIdle ? 1.0 : 1.0 + Math.min(0.6, rms * 0.6);

  const label =
    mode === "polishing" ? "AI 润色中…" :
    mode === "listening" ? (cloudConnecting ? "连接云端…" : "聆听中…") :
    text;

  return (
    <div className="pill-typeless">
      <div className="pill-typeless-content">{label}</div>
      <div
        className="pill-typeless-border"
        style={{
          borderColor: `rgba(237, 89, 51, ${strokeOpacity})`,
          borderWidth: `${strokeWidth}px`,
          transition: "border-color 1.6s ease-in-out",
        }}
      />
      {showPttHint && <div className="pill-ptt-hint">松开即停 →</div>}
    </div>
  );
}
