import type { PillThemeProps } from "./types";

/// 「电报」 — 等宽字 + 屏幕底部 ticker 横条。像旧报社的实时电传。
///
/// 跟其他主题区别：献给程序员 / CLI 用户。等宽字 + 状态用电码符。
/// 形态：full-width 横条贴屏幕底（pill 窗体本身就贴底），radius 0，
/// 暗背景 + 一条朱砂顶 border。文字用 JetBrains Mono。
export default function TelegraphPill({ mode, phase, text, cloudConnecting, showPttHint }: PillThemeProps) {
  if (mode === "hidden") return null;

  const isPolishing = phase === "polishing" || phase === "inserting";
  const isError = mode === "error";

  // 状态电码 — 摩斯码风用 dot/dash 表示阶段。视觉强、好辨认。
  const morseCode = (() => {
    if (isError) return "−·−"; // K = check
    if (mode === "listening") return "·  ·  ·"; // S 反复 = ready
    if (isPolishing) return "−·−·"; // C = compose
    return "−·− >"; // 直播态
  })();

  const stateLabel = (() => {
    if (isError) return "ERR";
    if (mode === "listening") return cloudConnecting ? "REC · CONNECTING" : "REC";
    if (mode === "polishing") return "POLISH";
    return "LIVE";
  })();

  const ticker = (() => {
    if (isError) return "出错";
    if (mode === "listening") return cloudConnecting ? "聆听中… 等云端就绪" : "聆听中…";
    if (mode === "polishing") return "AI 整理中…";
    return text;
  })();

  return (
    <div className="h-screen w-screen flex items-end justify-center select-none">
      {showPttHint && (
        <div className="absolute bottom-7 left-1/2 -translate-x-1/2 px-2 py-0.5 rounded text-[9px] font-medium"
             style={{ background: "rgba(11,27,42,0.85)", color: "#E8DCC4",
                      fontFamily: "'JetBrains Mono',monospace" }}>
          RELEASE → STOP
        </div>
      )}

      <div
        className="w-full flex items-center gap-3 px-4 py-1.5"
        style={{
          background: "rgba(11,27,42,0.94)",
          borderTop: "1px solid #D7392E",
          color: "#E8DCC4",
          fontFamily: "'JetBrains Mono','SF Mono','Consolas',monospace",
          fontSize: 11,
          fontFeatureSettings: '"calt" 0',
        }}
      >
        {/* 左侧 morse + state — fixed-width，避免 ticker 区域被挤变形 */}
        <span style={{ color: "#D7392E", letterSpacing: "0.08em", minWidth: 60, flexShrink: 0 }}>
          {morseCode}
        </span>
        <span style={{ color: "#7993A8", letterSpacing: "0.16em", minWidth: 92, flexShrink: 0 }}>
          {stateLabel}
        </span>

        {/* 中央 ticker — overflow 隐藏 + fade-mask，长文滚字进入 */}
        <div
          className="flex-1 overflow-hidden whitespace-nowrap"
          style={{
            maskImage: "linear-gradient(to right, transparent 0%, white 6%, white 94%, transparent 100%)",
            WebkitMaskImage: "linear-gradient(to right, transparent 0%, white 6%, white 94%, transparent 100%)",
          }}
        >
          <span style={{ color: isError ? "#F97316" : "#E8DCC4" }}>
            {ticker || "—"}
          </span>
        </div>

        {/* 右侧时间码 — 给 telegraph 真实电报感。 */}
        <span style={{ color: "#7993A8", flexShrink: 0 }}>
          {nowHms()}
        </span>
      </div>
    </div>
  );
}

function nowHms(): string {
  const d = new Date();
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}
function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}
