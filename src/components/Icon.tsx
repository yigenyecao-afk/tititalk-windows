/// (v0.9 Editorial Chinese) 1.5px stroke 线性 icon 组件。砍掉 SettingsSheet
/// 里散落的 emoji（✦ ⌘ ✋ ⌥ 🖱 🌐 🗣 🪄 ✨ 🎨 🌍 ↵ 📋 ␣ ⎋ 🔇 🔔 🔊 🏷 🔑 ✏︎ 🎚 📖 ...）
/// 跟 Mac 端 SF Symbols 同款的视觉风格 —— 编辑型设计需要朴素、一致、可染色的
/// 矢量图，emoji 各家 vendor 渲染差异大、跟宋体 / 朱砂 token 撞色严重。
///
/// 用法：<Icon name="mic" /> —— 16×16 currentColor stroke。badge 容器在
/// TypelessRow 里包了 28×28 圆角，icon 居中。
import type { ReactNode } from "react";

type IconName =
  | "engine"        // 识别引擎 — 闪电芯片
  | "keyboard"      // 录音热键
  | "hand"          // 触发方式 — 手掌
  | "modifier"      // 双击修饰键
  | "mouse"         // 鼠标侧键
  | "globe"         // 翻译 / 输出语言
  | "speak"         // 翻译目标语言 — 说话
  | "magic"         // 随便问 / 魔棒
  | "sparkle"       // 自动整理 / 建议加词典
  | "palette"       // 风格
  | "earth"         // 输出语言
  | "enter"         // 自动插入到光标
  | "clipboard"     // 同时复制到剪贴板
  | "space"         // 中英自动加空格
  | "esc"           // ESC 取消
  | "mute"          // 静音
  | "bell"          // 提示音
  | "volume"        // 音量
  | "tag"           // 识别模型
  | "key"           // API 密钥
  | "edit"          // 整理模型
  | "slider"        // 整理强度
  | "book"          // 词典
  // (P1-16 + P2-25 2026-05-06) 新增：工具栏 / 隐私
  | "info"          // 一键诊断
  | "folder"        // 打开日志文件夹
  | "reset"         // 重置默认
  | "trash"         // 删除账户
  | "shield";       // 隐私 / 遥测

export function Icon({ name, size = 14 }: { name: IconName; size?: number }): ReactNode {
  const props = {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.6,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };
  switch (name) {
    case "engine":
      // 闪电 + 芯片框
      return (
        <svg {...props}>
          <rect x="4" y="6" width="16" height="12" rx="2" />
          <path d="M11 9l-2 4h3l-1 3" />
          <path d="M2 9h2M2 12h2M2 15h2M20 9h2M20 12h2M20 15h2" />
        </svg>
      );
    case "keyboard":
      return (
        <svg {...props}>
          <rect x="2" y="6" width="20" height="12" rx="2" />
          <path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M6 14h.01M10 14h.01M14 14h.01M18 14h.01M7 18h10" />
        </svg>
      );
    case "hand":
      return (
        <svg {...props}>
          <path d="M9 11V5a2 2 0 0 1 4 0v6" />
          <path d="M13 11V4a2 2 0 0 1 4 0v8" />
          <path d="M17 12V6a2 2 0 0 1 4 0v9a6 6 0 0 1-6 6h-3a6 6 0 0 1-6-6v-3l-3-3a1.4 1.4 0 0 1 0-2 1.4 1.4 0 0 1 2 0l3 3" />
        </svg>
      );
    case "modifier":
      // ⌘ 风格回环
      return (
        <svg {...props}>
          <circle cx="6" cy="6" r="2.5" />
          <circle cx="18" cy="6" r="2.5" />
          <circle cx="6" cy="18" r="2.5" />
          <circle cx="18" cy="18" r="2.5" />
          <path d="M8.5 6h7M8.5 18h7M6 8.5v7M18 8.5v7" />
        </svg>
      );
    case "mouse":
      return (
        <svg {...props}>
          <rect x="6" y="3" width="12" height="18" rx="6" />
          <path d="M12 7v4" />
        </svg>
      );
    case "globe":
      return (
        <svg {...props}>
          <circle cx="12" cy="12" r="9" />
          <path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" />
        </svg>
      );
    case "speak":
      return (
        <svg {...props}>
          <path d="M12 3v12" />
          <path d="M9 7h6M8 11h8M9 15h6" />
          <path d="M5 18a4 4 0 0 0 4 3h6a4 4 0 0 0 4-3" />
        </svg>
      );
    case "magic":
      return (
        <svg {...props}>
          <path d="M5 19l10-10" />
          <path d="M14 5l1 3 3 1-3 1-1 3-1-3-3-1 3-1z" />
          <path d="M4 14l.5 1.5L6 16l-1.5.5L4 18l-.5-1.5L2 16l1.5-.5z" />
        </svg>
      );
    case "sparkle":
      return (
        <svg {...props}>
          <path d="M12 4l1.8 5.2L19 11l-5.2 1.8L12 18l-1.8-5.2L5 11l5.2-1.8z" />
          <path d="M19 17l.6 1.4L21 19l-1.4.6L19 21l-.6-1.4L17 19l1.4-.6z" />
        </svg>
      );
    case "palette":
      return (
        <svg {...props}>
          <path d="M12 21a9 9 0 1 1 9-9c0 2.5-2 4-4.5 4H15a2 2 0 0 0-2 2c0 .5.2 1 .5 1.5.3.5.5 1 .5 1.5 0 .8-.5 1.5-2 1.5z" />
          <circle cx="7.5" cy="11" r="1" />
          <circle cx="9.5" cy="7" r="1" />
          <circle cx="14" cy="6.5" r="1" />
          <circle cx="17.5" cy="9.5" r="1" />
        </svg>
      );
    case "earth":
      return (
        <svg {...props}>
          <circle cx="12" cy="12" r="9" />
          <path d="M3 14h6l3 3v3" />
          <path d="M21 12c-3 0-3-3-6-3s-3 3-6 3" />
        </svg>
      );
    case "enter":
      return (
        <svg {...props}>
          <path d="M20 6v6a3 3 0 0 1-3 3H5" />
          <path d="M9 11l-4 4 4 4" />
        </svg>
      );
    case "clipboard":
      return (
        <svg {...props}>
          <rect x="6" y="4" width="12" height="17" rx="2" />
          <rect x="9" y="2" width="6" height="4" rx="1" />
        </svg>
      );
    case "space":
      return (
        <svg {...props}>
          <path d="M3 10v3a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1v-3" />
        </svg>
      );
    case "esc":
      return (
        <svg {...props}>
          <rect x="3" y="6" width="18" height="12" rx="2" />
          <path d="M9 10c-1 0-2 .5-2 1.5s1 1 2 1 2 0 2 1.5-1 1.5-2 1.5M14 10l3 4M17 10l-3 4" />
        </svg>
      );
    case "mute":
      return (
        <svg {...props}>
          <path d="M11 5L6 9H3v6h3l5 4V5z" />
          <path d="M22 9l-6 6M16 9l6 6" />
        </svg>
      );
    case "bell":
      return (
        <svg {...props}>
          <path d="M6 8a6 6 0 0 1 12 0c0 7 3 8 3 8H3s3-1 3-8z" />
          <path d="M10 21a2 2 0 0 0 4 0" />
        </svg>
      );
    case "volume":
      return (
        <svg {...props}>
          <path d="M11 5L6 9H3v6h3l5 4V5z" />
          <path d="M16 8a5 5 0 0 1 0 8" />
          <path d="M19 5a9 9 0 0 1 0 14" />
        </svg>
      );
    case "tag":
      return (
        <svg {...props}>
          <path d="M21 13l-8 8a1 1 0 0 1-1.4 0L3 12.4V3h9.4l8.6 8.6a1 1 0 0 1 0 1.4z" />
          <circle cx="8" cy="8" r="1.5" />
        </svg>
      );
    case "key":
      return (
        <svg {...props}>
          <circle cx="8" cy="14" r="4" />
          <path d="M11 12l9-9" />
          <path d="M16 7l3 3M14 9l3 3" />
        </svg>
      );
    case "edit":
      return (
        <svg {...props}>
          <path d="M4 20h4l11-11-4-4L4 16v4z" />
          <path d="M14 6l4 4" />
        </svg>
      );
    case "slider":
      return (
        <svg {...props}>
          <path d="M4 6h16M4 12h16M4 18h16" />
          <circle cx="9" cy="6" r="1.8" fill="currentColor" />
          <circle cx="15" cy="12" r="1.8" fill="currentColor" />
          <circle cx="7" cy="18" r="1.8" fill="currentColor" />
        </svg>
      );
    case "book":
      return (
        <svg {...props}>
          <path d="M4 5a2 2 0 0 1 2-2h13v18H6a2 2 0 0 1-2-2z" />
          <path d="M19 17H6a2 2 0 0 0-2 2" />
          <path d="M9 7h6" />
        </svg>
      );
    case "info":
      return (
        <svg {...props}>
          <circle cx="12" cy="12" r="9" />
          <path d="M12 11v5" />
          <path d="M12 8h.01" />
        </svg>
      );
    case "folder":
      return (
        <svg {...props}>
          <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
        </svg>
      );
    case "reset":
      return (
        <svg {...props}>
          <path d="M3 12a9 9 0 1 0 3-6.7" />
          <path d="M3 4v5h5" />
        </svg>
      );
    case "trash":
      return (
        <svg {...props}>
          <path d="M4 6h16" />
          <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
          <path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2" />
        </svg>
      );
    case "shield":
      return (
        <svg {...props}>
          <path d="M12 3l8 4v5c0 5-3.5 8.5-8 9-4.5-.5-8-4-8-9V7z" />
        </svg>
      );
  }
}
