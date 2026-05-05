// Wave 4 — Pet bubble 文案库（80 条，按 trigger 分组）。
// persona 切换：每条文案带 persona 偏向（friendly / formal / mixed_zh_en / code），
// PetEngine 取 cfg.stylist_persona 作权重，落到具体一行。
//
// 设计原则：
//   - 短：≤ 24 字，一行能读完
//   - 上下文化：能引用具体数字（字数 / 百分比 / 应用名）的优先
//   - 不命令：不说「该休息了」「该……了」，只观察「你今天破了 2 次记录」
//   - 不卖萌过度：每 5 条有 1 条偏理性

import type { StylistPersona } from "../lib/types";

export type BubbleTrigger =
  | "first-greet"          // 首次启动 / 用户当天第一次开 app
  | "session-start"        // 录音开始（高频，慎触发）
  | "session-success"      // 录音 + 转写成功
  | "session-record-broken" // 字数破当日 / 30 天 / 历史记录
  | "quota-warn-80"        // 配额到 80%
  | "quota-warn-95"        // 配额到 95%
  | "quota-exhausted"      // 配额 = 0
  | "idle-long"            // 5+ 分钟没说话
  | "app-switch-ide"       // 切到 IDE
  | "app-switch-meeting"   // 切到 Zoom/Teams 等
  | "app-switch-formal"    // 切到 Outlook/Slack
  | "late-night"           // 23:00 后还在用
  | "early-morning"        // 7:00 前
  | "weekend"              // 周六周日工作
  | "error-mic"            // 麦克风权限丢
  | "error-network";       // 网络错误

export interface BubbleLine {
  text: string;
  /// 这一行最契合哪种 persona；PetEngine 拿 cfg.stylist_persona 优先匹配。
  persona: StylistPersona;
  /// 模板支持的占位符，渲染前 PetEngine 会 substitute：
  ///   {chars}, {percent}, {appName}, {records}
  placeholders?: string[];
}

/// trigger → 候选行数组。每次触发随机抽 1 条（按 persona 加权）。
export const BUBBLES: Record<BubbleTrigger, BubbleLine[]> = {
  "first-greet": [
    { text: "嗨，今天打算说点什么？", persona: "friendly" },
    { text: "你回来了。", persona: "formal" },
    { text: "ready when you are.", persona: "mixed_zh_en" },
    { text: "// new session started", persona: "code" },
  ],
  "session-start": [
    { text: "嗯，我在听。", persona: "friendly" },
    { text: "记录中…", persona: "formal" },
    { text: "🎙️ on", persona: "mixed_zh_en" },
    { text: "stdin → reading", persona: "code" },
  ],
  "session-success": [
    { text: "记好了。", persona: "friendly" },
    { text: "已归档。", persona: "formal" },
    { text: "got it ✓", persona: "mixed_zh_en" },
    { text: "saved to disk.", persona: "code" },
  ],
  "session-record-broken": [
    { text: "今天破纪录了，{chars} 字！", persona: "friendly", placeholders: ["chars"] },
    { text: "今日字数已达 {chars}，超过近期峰值。", persona: "formal", placeholders: ["chars"] },
    { text: "🔥 new high: {chars} chars", persona: "mixed_zh_en", placeholders: ["chars"] },
    { text: "// record++ ({chars})", persona: "code", placeholders: ["chars"] },
  ],
  "quota-warn-80": [
    { text: "嗯…快没饭吃了。", persona: "friendly" },
    { text: "今日额度已使用 {percent}%。", persona: "formal", placeholders: ["percent"] },
    { text: "quota at {percent}% 🍙", persona: "mixed_zh_en", placeholders: ["percent"] },
    { text: "// quota: {percent}% (warn)", persona: "code", placeholders: ["percent"] },
  ],
  "quota-warn-95": [
    { text: "真的快不行了……", persona: "friendly" },
    { text: "额度告罄，建议升级。", persona: "formal" },
    { text: "almost out 😵", persona: "mixed_zh_en" },
    { text: "// quota: {percent}% (critical)", persona: "code", placeholders: ["percent"] },
  ],
  "quota-exhausted": [
    { text: "喂我一口流量呗……", persona: "friendly" },
    { text: "今日额度已用尽。", persona: "formal" },
    { text: "out of fuel 🪫", persona: "mixed_zh_en" },
    { text: "// ENOQUOTA", persona: "code" },
  ],
  "idle-long": [
    { text: "在看什么呢？", persona: "friendly" },
    { text: "工作进展顺利？", persona: "formal" },
    { text: "still here 👀", persona: "mixed_zh_en" },
    { text: "// idle: 5+ min", persona: "code" },
  ],
  "app-switch-ide": [
    { text: "{appName} 是个好东西。", persona: "friendly", placeholders: ["appName"] },
    { text: "切到 {appName}，专注模式。", persona: "formal", placeholders: ["appName"] },
    { text: "🧑‍💻 in {appName}", persona: "mixed_zh_en", placeholders: ["appName"] },
    { text: "// context: {appName}", persona: "code", placeholders: ["appName"] },
  ],
  "app-switch-meeting": [
    { text: "开会要安静，我戴上耳机了。", persona: "friendly" },
    { text: "会议进行中，不打扰。", persona: "formal" },
    { text: "🎧 meeting mode", persona: "mixed_zh_en" },
    { text: "// muted, observing", persona: "code" },
  ],
  "app-switch-formal": [
    { text: "穿西装时间到。", persona: "friendly" },
    { text: "切换到正式表达模式。", persona: "formal" },
    { text: "👔 formal tone", persona: "mixed_zh_en" },
    { text: "// persona: formal", persona: "code" },
  ],
  "late-night": [
    { text: "夜深了。", persona: "friendly" },
    { text: "已 23:00，注意休息。", persona: "formal" },
    { text: "still up? 🌙", persona: "mixed_zh_en" },
    { text: "// hour > 22", persona: "code" },
  ],
  "early-morning": [
    { text: "好早啊！", persona: "friendly" },
    { text: "早安。", persona: "formal" },
    { text: "morning ☕", persona: "mixed_zh_en" },
    { text: "// boot at {hour}:xx", persona: "code", placeholders: ["hour"] },
  ],
  "weekend": [
    { text: "周末也在加班，辛苦。", persona: "friendly" },
    { text: "周末工作，谨记节奏。", persona: "formal" },
    { text: "weekend grind 💪", persona: "mixed_zh_en" },
    { text: "// weekend++", persona: "code" },
  ],
  "error-mic": [
    { text: "听不见你了……", persona: "friendly" },
    { text: "麦克风权限缺失，请检查。", persona: "formal" },
    { text: "🎤 ✗ permission?", persona: "mixed_zh_en" },
    { text: "// EACCES: microphone", persona: "code" },
  ],
  "error-network": [
    { text: "网……连不上呢。", persona: "friendly" },
    { text: "网络异常，已暂停。", persona: "formal" },
    { text: "offline 📡", persona: "mixed_zh_en" },
    { text: "// ENETUNREACH", persona: "code" },
  ],
};

/// 把 placeholders 替换成实际值。未给的占位符保持原 token。
export function fillBubble(line: BubbleLine, vars: Record<string, string | number>): string {
  let out = line.text;
  if (line.placeholders) {
    for (const ph of line.placeholders) {
      const v = vars[ph];
      if (v !== undefined && v !== null) {
        out = out.split(`{${ph}}`).join(String(v));
      }
    }
  }
  return out;
}

/// 按 persona 加权抽一行：当前 persona 命中 → 70%；其它 30% 平分。
/// 这样既维持人格一致，又偶尔来个跨 persona 的「俏皮话」。
export function pickBubble(
  trigger: BubbleTrigger,
  persona: StylistPersona,
  vars: Record<string, string | number> = {},
): string | null {
  const candidates = BUBBLES[trigger];
  if (!candidates || candidates.length === 0) return null;
  const matched = candidates.filter((c) => c.persona === persona);
  const others = candidates.filter((c) => c.persona !== persona);
  const useMatched = matched.length > 0 && Math.random() < 0.7;
  const pool = useMatched ? matched : others.length > 0 ? others : candidates;
  const line = pool[Math.floor(Math.random() * pool.length)];
  return fillBubble(line, vars);
}
