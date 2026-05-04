import type { PillThemeProps } from "./types";

/// 「批注」 — 暖黄信纸便签风。圆角矩形像贴在桌上的便签纸：
///   - 浅黄信笺底（paper-warm #F4ECD8）
///   - 仿宋 / 思源宋体斜体大字
///   - 右上角朱砂红圆点录音指示
///   - 底部一段虚线像「书页跳脚批注引用线」
///
/// 跟其他主题区别：跟内容关系亲，像写笔记的人贴在 doc 边缘的注。
export default function AnnotationPill({ mode, phase, text, cloudConnecting, showPttHint }: PillThemeProps) {
  if (mode === "hidden") return null;

  const isPolishing = phase === "polishing" || phase === "inserting";
  const isError = mode === "error";

  const dotColor = isError ? "#F97316" : isPolishing ? "#5B7553" : "#D7392E";
  const captionText = (() => {
    if (isError) return "出错";
    if (mode === "listening") return cloudConnecting ? "聆听中… 连接云端" : "聆听中…";
    if (mode === "polishing") return "在替你润色…";
    return text;
  })();

  return (
    <div className="h-screen w-screen flex flex-col items-center justify-center select-none">
      {showPttHint && (
        <div className="mb-1.5 px-2 py-0.5 text-[9px] font-medium rounded-full text-[#1C1B1A]/70"
             style={{ background: "#F4ECD8", fontFamily: "'PingFang SC',system-ui" }}>
          松开即停 →
        </div>
      )}

      <div
        className="relative px-4 pt-3 pb-2.5 max-w-[260px] min-w-[180px]"
        style={{
          background: "#F4ECD8",
          color: "#1C1B1A",
          borderRadius: 4,
          // 真便签贴墙效果：左下右上微 skew + 多层阴影 + 边角折页
          boxShadow:
            "0 1px 0 rgba(0,0,0,0.08), 0 4px 14px rgba(11,27,42,0.45), inset 0 0 0 1px rgba(28,27,26,0.05)",
          fontFamily: "'Source Han Serif SC','PingFang SC',serif",
          transform: "rotate(-0.6deg)",
        }}
      >
        {/* 朱砂录音点 — 右上角 */}
        <span
          className="absolute"
          style={{
            top: 6,
            right: 8,
            width: 6,
            height: 6,
            borderRadius: 999,
            background: dotColor,
            boxShadow: `0 0 6px ${dotColor}`,
            opacity: mode === "listening" ? 1 : 0.7,
          }}
        />

        {/* 顶端 caption — 仿宋 mini-meta */}
        <div className="text-[9px] tracking-[0.18em] uppercase"
             style={{ color: "#8C8780", fontFamily: "'JetBrains Mono','PingFang SC',monospace" }}>
          margin · 批注
        </div>

        {/* 主文本 — 宋体 italic，像手写引文 */}
        <div className="mt-1 text-[14px] leading-[1.6]"
             style={{ fontStyle: mode === "listening" || mode === "polishing" ? "italic" : "normal" }}>
          {captionText || " "}
        </div>

        {/* 底部「批注引用线」— SVG 虚线右伸 30px 到 pill 外，假装连到光标 */}
        <svg
          width="30"
          height="6"
          viewBox="0 0 30 6"
          className="absolute"
          style={{ right: -28, bottom: 8, opacity: 0.55 }}
          aria-hidden
        >
          <path
            d="M0 3 H 30"
            stroke="#1C1B1A"
            strokeWidth="1"
            strokeDasharray="2 2"
            fill="none"
          />
        </svg>
      </div>
    </div>
  );
}
