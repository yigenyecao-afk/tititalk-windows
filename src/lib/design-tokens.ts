/// Win 端 Editorial Chinese 设计 token —— 跟 site frontend/public/design/design-tokens.json
/// 一一对应。修改时请同步 SwiftUI 端 Sources/VoiceInk/Resources/DesignTokens.swift。
///
/// 所有客户端 UI 应从这里读颜色 / 字号；不要再散落 #6366F1 / #0A0A0A 这种字面值。

export const Color = {
  ink: {
    950: "#0B1B2A",
    900: "#102233",
    800: "#1B2D3F",
    700: "#2A3D4F",
    500: "#7993A8",
    300: "#B9C9D6",
    100: "#E8DCC4",
    50:  "#F2EFE8",
  },
  signal: { 600: "#B82E26", 500: "#D7392E", 400: "#E94B3C", 100: "#FBE9E7" },
  calm:   { 700: "#3F5639", 600: "#5B7553", 500: "#7C9874", 100: "#E0EBD9" },
  paper:  { warm: "#F4ECD8", cool: "#EAE7E0" },
} as const;

export const Font = {
  display: `"Noto Serif SC", "Source Han Serif SC", "STSong", serif`,
  body:    `-apple-system, "PingFang SC", "Hiragino Sans GB", system-ui, sans-serif`,
  mono:    `"JetBrains Mono", "IBM Plex Mono", ui-monospace, monospace`,
} as const;

export const Size = {
  pillFont: 13,
  pillHeight: 28,
  lineHeightChinese: 1.75,
  letterSpacingChinese: "0.02em",
} as const;

export const Radius = {
  annotation: 4,
  telegraph:  0,
  lantern:  999,
  seal:       4,
  card:      12,
  button:     6,
} as const;

/// Pill 4 主题契约 —— PillApp.tsx 根据 themeKey 切形态/字体/圆角。
/// 每个主题独立 component（AnnotationPill / TelegraphPill / LanternPill / SealPill）。
export const PillTheme = {
  annotation: { label: "批注", form: "stickynote",  fontFamily: Font.display, radius: Radius.annotation, paper: Color.paper.warm,    text: Color.ink[950], accent: Color.signal[500] },
  telegraph:  { label: "电报", form: "ticker",      fontFamily: Font.mono,    radius: Radius.telegraph,  paper: Color.ink[950],      text: Color.ink[100], accent: Color.signal[500] },
  lantern:    { label: "灯笼", form: "globe",       fontFamily: Font.body,    radius: Radius.lantern,    paper: Color.ink[950],      text: Color.ink[100], accent: Color.signal[500] },
  seal:       { label: "印章", form: "square-seal", fontFamily: Font.display, radius: Radius.seal,       paper: Color.paper.warm,    text: Color.ink[950], accent: Color.signal[500] },
} as const;

export type PillThemeKey = keyof typeof PillTheme;
