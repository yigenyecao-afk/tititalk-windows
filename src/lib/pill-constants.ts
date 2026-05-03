// (v0.8.7) Win pill 精致化常量 —— 跟 Mac `Sources/VoiceInk/UI/PillConstants.swift`
// 一一对应。改这里就同步前端，避免在 PillApp.tsx 散落 magic number。
//
// 设计契约（用户 2026-05-04 验收要求）：
//   • pill 宽度收 30%（旧 px-4+gap-3 ≈ 250-260px → 新固定 180px）
//   • 文字居中对齐 + 两端 fade-mask 渐隐，不直接截断
//   • 只 3 个用户可见状态：「聆听中…」/ asr 实时文本 /「AI 润色中…」
//     旧的「识别中…」「插入…」「结束…」「失败」label 都去掉。

export const PILL_LABEL = {
  /// recording / transcribing 但还没有任何文字
  listening: "聆听中…",
  /// polishing 但流式 polished 文本还没到第一帧
  polishing: "AI 润色中…",
} as const;

/// pill 容器宽度（px）。固定宽度配合 text-center 让文字居中；超出走 marquee 滚动。
export const PILL_WIDTH = 180;
/// 容器高度（px）—— 比旧版降低 ~15% 跟 Mac 同步。
export const PILL_HEIGHT = 36;

/// 实时文本字号（px）。比旧 13px 减 1px 适配新窄宽。
export const PILL_FONT_SIZE = 12;

/// fade-mask 渐变停止点（百分比）—— 两端各留 8% 给柔和淡出。
export const PILL_FADE_PERCENT = 8;
