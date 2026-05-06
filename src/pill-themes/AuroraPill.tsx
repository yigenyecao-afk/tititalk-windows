/// 流光 (aurora) — 跟 Mac AuroraPill 视觉对齐：极光波形带流动渐变
/// 多色渐变背景 (cyan→pink→purple)，录音时左→右扫光，polish 时反向慢扫。
import type { PillThemeProps } from "./types";

export default function AuroraPill({ mode, text, rms, cloudConnecting, showPttHint }: PillThemeProps) {
  const isPolish = mode === "polishing";

  const label =
    isPolish ? "AI 润色中…" :
    mode === "listening" ? (cloudConnecting ? "连接云端…" : "聆听中…") :
    text;

  // RMS 影响渐变饱和度；polish 用紫粉系，录音用青粉系
  const sat = 0.55 + Math.min(0.30, rms * 0.30);
  const gradient = isPolish
    ? `linear-gradient(90deg, hsla(280, ${sat * 100}%, 65%, 0.92) 0%, hsla(330, ${sat * 100}%, 70%, 0.92) 50%, hsla(20, ${sat * 100}%, 70%, 0.92) 100%)`
    : `linear-gradient(90deg, hsla(190, ${sat * 100}%, 65%, 0.92) 0%, hsla(250, ${sat * 100}%, 70%, 0.92) 50%, hsla(330, ${sat * 100}%, 70%, 0.92) 100%)`;

  return (
    <div
      className="pill-aurora"
      style={{ background: gradient, animation: "aurora-flow 3.5s linear infinite" }}
    >
      <div className="pill-aurora-text">{label}</div>
      {showPttHint && <div className="pill-ptt-hint">松开即停 →</div>}
    </div>
  );
}
