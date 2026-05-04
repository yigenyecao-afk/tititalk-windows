import type { PillThemeProps } from "./types";

/// 「灯笼」 — 默认主题。一颗 朱砂红 / 抹茶绿 球形 pill，呼吸光晕跟音量
/// 联动；文字单独一行写在 lantern 下方，不挤进球里。整理阶段切抹茶绿
/// 提示「在改你的口语」。
///
/// 跟其他 3 个主题共用同一组 5 态 mode，区别在「形态人格」：
///   lantern = 默认 / 品牌 / 女性向 / 抒情
export default function LanternPill({ mode, phase, text, rms, cloudConnecting, showPttHint }: PillThemeProps) {
  if (mode === "hidden") return null;

  // 整理阶段切抹茶；录音 / 实时 / 错误用朱砂；error 用稍偏橙的 #F97316。
  const isPolishing = phase === "polishing" || phase === "inserting";
  const isError = mode === "error";
  const orbColor = isError ? "#F97316" : isPolishing ? "#5B7553" : "#D7392E";
  const orbGlow  = isError ? "rgba(249,115,22,0.45)" : isPolishing ? "rgba(91,117,83,0.45)" : "rgba(215,57,46,0.55)";

  // 呼吸幅度 base 1.0；说话时 rms 抬到 1.06；hover-effect 不让人眼累。
  const breathScale = 1 + Math.min(0.06, rms * 0.4);

  const captionText = (() => {
    if (isError) return "出错";
    if (mode === "listening") return cloudConnecting ? "聆听中… 连接云端" : "聆听中…";
    if (mode === "polishing") return "AI 整理中…";
    return text;
  })();

  return (
    <div className="h-screen w-screen flex flex-col items-center justify-center select-none gap-2">
      {showPttHint && (
        <div
          className="px-2 py-0.5 text-[9px] font-medium rounded-full text-white/70"
          style={{ background: "rgba(0,0,0,0.45)", fontFamily: "PingFang SC, system-ui" }}
        >
          松开即停 →
        </div>
      )}

      {/* 球形 lantern — 64×64，呼吸 + glow */}
      <div
        className="rounded-full"
        style={{
          width: 64,
          height: 64,
          background: `radial-gradient(circle at 38% 32%, ${orbColor}EE 0%, ${orbColor}AA 55%, ${orbColor}66 100%)`,
          boxShadow: `0 0 28px 6px ${orbGlow}, inset -6px -8px 16px rgba(0,0,0,0.18), inset 4px 4px 10px rgba(255,255,255,0.18)`,
          animation: mode === "listening" ? "lanternBreath 1.6s ease-in-out infinite" : "none",
          transform: `scale(${breathScale})`,
          transition: "transform 80ms ease-out, background 200ms ease-out, box-shadow 220ms ease-out",
        }}
      />

      {/* 文字行 — 在球下方，最多 1 行 marquee */}
      <div
        className="max-w-[320px] truncate text-[13px] tracking-wide"
        style={{
          color: "rgba(247,247,248,0.92)",
          fontFamily: "'Source Han Serif SC','PingFang SC',serif",
          fontFeatureSettings: '"palt" 1',
          textShadow: "0 1px 4px rgba(0,0,0,0.5)",
        }}
      >
        {captionText}
      </div>

      <style>{`
        @keyframes lanternBreath {
          0%, 100% { box-shadow: 0 0 28px 4px ${orbGlow}; }
          50%      { box-shadow: 0 0 40px 10px ${orbGlow}; }
        }
      `}</style>
    </div>
  );
}
