/// 素白 (mono) — 跟 Mac MonoPill 视觉对齐：白底椭圆 (cornerRadius=18) + 等宽斯多葛
/// 状态用一颗微小圆点表达（录音红 / 润色蓝 / idle 灰），无渐变 / 无阴影 / 不抢焦点。
import type { PillThemeProps } from "./types";

export default function MonoPill({ mode, text, rms, cloudConnecting, showPttHint }: PillThemeProps) {
  const dotColor =
    mode === "polishing" ? "#3b82f6" :
    mode === "live" || mode === "listening" ? "#ef4444" :
    "#94a3b8";

  const label =
    mode === "polishing" ? "AI 润色中…" :
    mode === "listening" ? (cloudConnecting ? "连接云端…" : "聆听中…") :
    text;

  // RMS 驱动状态点轻微 scale 让 idle 跟录音区分
  const dotScale = 1 + Math.min(0.4, rms * 0.4);

  return (
    <div className="pill-mono">
      <span
        className="pill-mono-dot"
        style={{ background: dotColor, transform: `scale(${dotScale})` }}
      />
      <span className="pill-mono-text">{label}</span>
      {showPttHint && <span className="pill-ptt-hint">松开即停 →</span>}
    </div>
  );
}
