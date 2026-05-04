import type { PillThemeProps } from "./types";

/// 「印章」 — 朱砂方印章，像传统书画上的钤印。
///
/// 跟其他主题区别：仪式感强、品牌识别极高。形态：30~36px 红色方印，
/// 篆书式单字「听 / 记 / 校」按 mode 切换；切 mode 时 stamp-down 落章
/// 动画（缩 1.4 → 0.95 → 1，旋 -6deg → 2deg → 0deg）。
///
/// 文字（实时识别 / 整理流式）以宋体小字横排在印章右侧，跟印章一起像
/// 「钤印 + 题款」的传统排版。
export default function SealPill({ mode, phase, text, cloudConnecting, showPttHint }: PillThemeProps) {
  if (mode === "hidden") return null;

  const isPolishing = phase === "polishing" || phase === "inserting";
  const isError = mode === "error";

  // 印面单字 — 不超过 1 个汉字才像真印
  const sealChar = (() => {
    if (isError) return "误";
    if (mode === "listening") return "听";
    if (isPolishing) return "校";
    return "记";
  })();

  // mode 切换时 key 变 → 触发重挂载，stamp-down 动画从头跑一次
  const stampKey = `${mode}-${phase}`;

  const tail = (() => {
    if (isError) return "出错";
    if (mode === "listening") return cloudConnecting ? "—— 聆听中（等云端）" : "—— 聆听中";
    if (mode === "polishing") return "—— 在替你润色";
    return text;
  })();

  return (
    <div className="h-screen w-screen flex items-center justify-center select-none">
      {showPttHint && (
        <div className="absolute top-1/2 -translate-y-12 px-2 py-0.5 rounded text-[9px] font-medium"
             style={{ background: "#F4ECD8", color: "#1C1B1A",
                      fontFamily: "'PingFang SC',system-ui" }}>
          松开即停 →
        </div>
      )}

      <div
        className="flex items-center gap-3 px-3 py-2 max-w-[360px]"
        style={{
          background: "rgba(244,236,216,0.96)",
          color: "#1C1B1A",
          borderRadius: 4,
          boxShadow: "0 8px 24px rgba(0,0,0,0.45), inset 0 0 0 1px rgba(28,27,26,0.06)",
          fontFamily: "'Source Han Serif SC','PingFang SC',serif",
        }}
      >
        {/* 钤印 — 36×36 红方印 */}
        <div
          key={stampKey}
          className="shrink-0 flex items-center justify-center"
          style={{
            width: 36,
            height: 36,
            background: "#D7392E",
            color: "#F4ECD8",
            fontSize: 22,
            fontWeight: 600,
            fontFamily: "'Source Han Serif SC','STSong','serif'",
            border: "1.5px solid #B82E26",
            borderRadius: 2,
            // 印章「不工整」的天然崩角：4 corner-cut 用 clip-path 模拟磨损
            clipPath:
              "polygon(2px 0, calc(100% - 1px) 0, 100% 2px, 100% calc(100% - 2px), calc(100% - 2px) 100%, 1px 100%, 0 calc(100% - 1px), 0 1px)",
            animation: "stampDown 0.36s cubic-bezier(0.2, 1.4, 0.4, 1) forwards",
            transformOrigin: "50% 50%",
          }}
        >
          {sealChar}
        </div>

        {/* 题款 — 印章右侧宋体小字横排 */}
        <div
          className="flex-1 truncate"
          style={{
            fontSize: 13,
            lineHeight: 1.5,
            fontStyle: mode === "listening" || mode === "polishing" ? "italic" : "normal",
            color: isError ? "#B82E26" : "#1C1B1A",
            fontFeatureSettings: '"palt" 1',
          }}
        >
          {tail || " "}
        </div>
      </div>

      <style>{`
        @keyframes stampDown {
          0%   { opacity: 0; transform: scale(1.4) rotate(-6deg); }
          60%  { opacity: 1; transform: scale(0.95) rotate(2deg); }
          100% { opacity: 1; transform: scale(1) rotate(0deg); }
        }
      `}</style>
    </div>
  );
}
