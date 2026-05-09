/// 桌面伴侣气泡 — 圆角白底 + 小尾巴指向宠物头顶。Mac PetSpeechBubble.swift 的 Win 等价。
///
/// fade-in 0.4s → 字数自适应停留（外部 timer） → fade-out 0.4s。
/// 由 CompanionApp 的 `companion-speech` 订阅写 `text: string | null` 触发；
/// null = 完全隐藏。

interface Props {
  text: string | null;
  /// 期望最大宽度（≈ pet panel 宽 - 边距），超过 wrap 两行
  maxWidth?: number;
}

export function PetSpeechBubble({ text, maxWidth = 130 }: Props) {
  const visible = !!text;

  return (
    <div
      style={{
        position: "relative",
        maxWidth,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        opacity: visible ? 1 : 0,
        transform: visible ? "scale(1)" : "scale(0.85)",
        transformOrigin: "bottom center",
        transition: "opacity 0.4s ease-out, transform 0.4s ease-out",
        pointerEvents: "none",
      }}
    >
      {/* 主气泡体 */}
      <div
        style={{
          fontSize: 11,
          color: "#1c1c1e",
          textAlign: "center",
          lineHeight: 1.35,
          padding: "6px 10px",
          borderRadius: 12,
          background: "rgba(245, 245, 247, 0.96)",
          border: "0.5px solid rgba(0, 0, 0, 0.08)",
          boxShadow: "0 2px 4px rgba(0, 0, 0, 0.18)",
          // 两行截断
          display: "-webkit-box",
          WebkitLineClamp: 2,
          WebkitBoxOrient: "vertical",
          overflow: "hidden",
          wordBreak: "break-word",
          // 永远占据 DOM 节点（即使空字符串也要保留）防 transition 抖
          minHeight: 11 * 1.35,
          // 中文字符不能 hyphenation 但允许 wrap
          whiteSpace: "normal",
        }}
      >
        {text ?? ""}
      </div>
      {/* 尾巴：朝下的小三角，指向宠物头顶 */}
      <div
        style={{
          width: 0,
          height: 0,
          marginTop: -0.5,
          borderLeft: "5px solid transparent",
          borderRight: "5px solid transparent",
          borderTop: "6px solid rgba(245, 245, 247, 0.96)",
          filter: "drop-shadow(0 1px 1px rgba(0, 0, 0, 0.10))",
        }}
      />
    </div>
  );
}
