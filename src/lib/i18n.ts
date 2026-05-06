// (P2-27 i18n stub 2026-05-06) Win 端 i18n 框架雏形——跟 Mac L10n.swift 对齐。
//
// 当前阶段：仅中文，所有 UI 用中文硬编码（跟 Mac 当前一致）。
// 框架价值：未来出海加 en.json / ja.json 时不用刮 1700 行 App.tsx，只需把
// 现有硬编码字串挪到 zh.json 并按 key 调用 t(...)。增量迁移可行。
//
// 用法：
//   import { t, setLocale } from "./lib/i18n";
//   t("settings.title")  // → "设置"
//   t("history.count", { n: 5 })  // → "5 条记录"
//
// 未匹配 key 直接返 key（开发期暴露，不会静默死链）。

type Bundle = Record<string, string>;

// 当前空 bundle —— 增量迁移期。每条新文案进来时同步加 key。
const ZH: Bundle = {
  "app.name": "TiTiTalk",
  "settings.title": "设置",
  "settings.section.dictation": "听写",
  "settings.section.hotkey": "快捷键",
  "settings.section.style": "整理风格",
  "settings.section.pill": "录音浮窗",
  "settings.section.appearance_privacy": "外观与隐私",
  "settings.section.output": "输出",
  "settings.section.experience": "体验增强",
  "settings.section.sound": "提示音",
  "settings.section.companion": "桌面宠物",
  "settings.section.tools": "工具",
  "settings.theme.auto": "跟随系统",
  "settings.theme.light": "亮色",
  "settings.theme.dark": "暗色",
  "history.title": "历史记录",
  "history.export.txt": "导出 .txt",
  "history.export.md": "导出 .md",
  "history.export.json": "导出 .json",
  "history.empty": "还没说过话",
  "dictionary.title": "词典",
  "dictionary.placeholder": "TiTiTalk\nLLM\n智能体",
  "common.save": "保存",
  "common.saving": "保存中…",
  "common.saved": "已保存",
  "common.cancel": "取消",
  "common.close": "关闭",
  "common.confirm": "确定",
  "common.reset": "重置",
};

const EN: Bundle = {
  // 占位 stub—— 真正出海前再补完整。先列高频 key 占位。
  "app.name": "TiTiTalk",
  "settings.title": "Settings",
  "settings.section.dictation": "Dictation",
  "settings.section.hotkey": "Hotkeys",
  "history.title": "History",
  "common.save": "Save",
  "common.cancel": "Cancel",
};

const BUNDLES: Record<string, Bundle> = { zh: ZH, en: EN };

let currentLocale: string = "zh";

export function setLocale(loc: string): void {
  currentLocale = BUNDLES[loc] ? loc : "zh";
}

export function getLocale(): string {
  return currentLocale;
}

export function t(key: string, params?: Record<string, string | number>): string {
  const bundle = BUNDLES[currentLocale] ?? ZH;
  let val = bundle[key] ?? ZH[key] ?? key;
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      val = val.replace(`{${k}}`, String(v));
    }
  }
  return val;
}

// 启动时根据浏览器语言推断
if (typeof navigator !== "undefined") {
  const lang = (navigator.language || "zh").toLowerCase();
  setLocale(lang.startsWith("zh") ? "zh" : (lang.startsWith("en") ? "en" : "zh"));
}
