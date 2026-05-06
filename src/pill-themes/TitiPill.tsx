/// 朱砂 (titi) — 跟 Mac TiTiFloatingBubble 视觉对齐：朱砂主品牌色气泡 + 方块图标
/// 录音时朱砂底色加深 + 内圈光晕脉动；polish 时切朱砂浅色 + ✨ 图标。
import type { PillThemeProps } from "./types";

export default function TitiPill({ mode, text, rms, cloudConnecting, showPttHint }: PillThemeProps) {
  const isPolish = mode === "polishing";
  const isRecording = mode === "live" || mode === "listening";

  const label =
    isPolish ? "AI 润色中…" :
    mode === "listening" ? (cloudConnecting ? "连接云端…" : "聆听中…") :
    text;

  // 录音时朱砂背景加深，RMS 驱动光晕
  const bg = isPolish
    ? "rgba(255, 245, 235, 0.96)"
    : isRecording
      ? `rgba(237, 89, 51, ${0.85 + Math.min(0.10, rms * 0.10)})`
      : "rgba(237, 89, 51, 0.85)";
  const fg = isPolish ? "#a04020" : "#ffffff";

  return (
    <div className="pill-titi" style={{ background: bg, color: fg }}>
      <div className="pill-titi-icon" aria-hidden>
        {isPolish ? "✨" : "▮"}
      </div>
      <div className="pill-titi-text">{label}</div>
      {showPttHint && <div className="pill-ptt-hint">松开即停 →</div>}
    </div>
  );
}
