import { useEffect, useRef, useState } from "react";
import { onPipeline, getConfig } from "./lib/api";
import type { PipelinePhase } from "./lib/types";
import {
  PILL_LABEL,
  PILL_WIDTH,
  PILL_HEIGHT,
  PILL_FONT_SIZE,
  PILL_FADE_PERCENT,
} from "./lib/pill-constants";

/// (v0.8.4 typeless 学习 P1 #5) PTT「松开即停」短引导。新 PTT 用户每次
/// pill 出现就 +1 计数（localStorage），≥5 次后停止显示，不打扰熟练用户。
function shouldShowPttHint(mode: string): boolean {
  if (mode !== "push_to_talk" && mode !== "hybrid") return false;
  const n = parseInt(localStorage.getItem("pttHintShownCount") || "0", 10);
  return n < 5;
}
function bumpPttHintShown() {
  const n = parseInt(localStorage.getItem("pttHintShownCount") || "0", 10);
  localStorage.setItem("pttHintShownCount", String(n + 1));
}

/// (v0.8.7) 缩 30% + 文字居中 + 状态精简。整个 pill 体系只 3 状态：
///   1. 「聆听中…」 — recording 没文字 / transcribing 没文字
///   2. ASR 实时文本展示
///   3. 「AI 润色中…」 — polishing 没流式文本
/// 旧的「识别中…」「插入…」「结束…」「失败」label 全删（用户验收要求）。
export default function PillApp() {
  const [phase, setPhase] = useState<PipelinePhase>("idle");
  const [rms, setRms] = useState(0);
  const [, setTarget] = useState<string>("");
  const [displayed, setDisplayed] = useState<string>("");
  // (ISSUE-2 2026-05-03) tititalk_cloud cold-connect 标识 —— 后端在
  // start_session_async 之前 emit connecting=true，ready 抵达后 emit false。
  const [cloudConnecting, setCloudConnecting] = useState(false);
  // (P1 #5) PTT 引导
  const [hotkeyMode, setHotkeyMode] = useState<string>("hybrid");
  useEffect(() => {
    getConfig()
      .then((c) => setHotkeyMode(c.hotkey_mode))
      .catch(() => {});
  }, []);
  const targetRef = useRef<string>("");
  const displayedRef = useRef<string>("");
  const rafRef = useRef<number | null>(null);

  // 60fps 平滑追字符 loop
  useEffect(() => {
    const tick = () => {
      const t = targetRef.current;
      const d = displayedRef.current;
      if (d.length < t.length) {
        const gap = t.length - d.length;
        const stride = Math.max(1, Math.floor(gap / 8));
        const next = t.slice(0, d.length + stride);
        displayedRef.current = next;
        setDisplayed(next);
      } else if (d !== t) {
        displayedRef.current = t;
        setDisplayed(t);
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  useEffect(() => {
    const un = onPipeline((ev) => {
      if (ev.kind === "phase") {
        setPhase(ev.phase);
        if (ev.phase === "recording") {
          targetRef.current = "";
          displayedRef.current = "";
          setTarget("");
          setDisplayed("");
        } else if (ev.phase === "done" || ev.phase === "failed") {
          targetRef.current = "";
          displayedRef.current = "";
          setTarget("");
          setDisplayed("");
        }
      } else if (ev.kind === "level") {
        setRms(ev.rms);
      } else if (ev.kind === "partial") {
        // (v0.8.7) 不再 truncate —— 居中容器配 fade-mask + trailing scroll，
        // 长文本自然滚字而不是 ASCII "..." 截断。
        const next = ev.text;
        targetRef.current = next;
        setTarget(next);
        if (displayedRef.current === "") {
          displayedRef.current = next;
          setDisplayed(next);
        } else if (!next.startsWith(displayedRef.current)) {
          const prefix = commonPrefix(displayedRef.current, next);
          displayedRef.current = prefix;
          setDisplayed(prefix);
        }
      } else if (ev.kind === "transcript") {
        const next = ev.text;
        targetRef.current = next;
        setTarget(next);
      } else if (ev.kind === "error") {
        targetRef.current = "";
        displayedRef.current = "";
        setTarget("");
        setDisplayed("");
      } else if (ev.kind === "cloud_connecting") {
        setCloudConnecting(ev.connecting);
      }
    });
    return () => {
      un.then((fn) => fn());
    };
  }, []);

  // (v0.8.7) 5 状态映射 → 3 显示模式：
  //   recording 无文字 / stopping → listening label
  //   recording 有文字 / transcribing → 实时文本
  //   polishing 无 polished → polishing label
  //   polishing 有 polished → 流式润色文本
  //   inserting → 流式润色文本（如有）/ 实时文本
  //   error → 「出错」（不展开错误细节，避免占满 pill）
  type DisplayMode = "listening" | "live" | "polishing" | "error" | "hidden";
  const mode: DisplayMode = (() => {
    if (phase === "idle" || phase === "done") return "hidden";
    if (phase === "failed") return "error";
    // polish 阶段：partial 事件复用为 polish stream 载体（同 Mac），有 displayed 即流式
    if (phase === "polishing") return displayed ? "live" : "polishing";
    if (phase === "inserting") return "live";
    if (phase === "transcribing") return displayed ? "live" : "listening";
    if (phase === "recording" || phase === "stopping") return displayed ? "live" : "listening";
    return "listening";
  })();

  const showText = (() => {
    switch (mode) {
      case "listening":
        return cloudConnecting ? `${PILL_LABEL.listening} · 连接云端` : PILL_LABEL.listening;
      case "polishing":
        return PILL_LABEL.polishing;
      case "live":
        return displayed;
      case "error":
        return "出错";
      default:
        return "";
    }
  })();

  // 状态点颜色（替代多 label，给状态一个最小化视觉指示器）
  const dotColor = (() => {
    switch (mode) {
      case "listening":
        return "#ef4444";
      case "live":
        return phase === "polishing" || phase === "inserting" ? "#a78bfa" : "#ef4444";
      case "polishing":
        return "#a78bfa";
      case "error":
        return "#f97316";
      default:
        return "#83868d";
    }
  })();

  const showPttHint = phase === "recording" && shouldShowPttHint(hotkeyMode);
  useEffect(() => {
    if (showPttHint) bumpPttHintShown();
  }, [showPttHint]);

  // fade-mask 两端柔淡出
  const fadeMask = `linear-gradient(to right, transparent 0%, white ${PILL_FADE_PERCENT}%, white ${100 - PILL_FADE_PERCENT}%, transparent 100%)`;

  return (
    <div className="h-screen w-screen flex flex-col items-center justify-center select-none">
      {showPttHint && (
        <div
          className="mb-1 px-2 py-0.5 text-[9px] font-medium rounded-full text-white/70"
          style={{ background: "rgba(0,0,0,0.45)" }}
        >
          松开即停 →
        </div>
      )}
      {mode !== "hidden" && (
        <div
          className="flex items-center gap-2 rounded-full shadow-2xl backdrop-blur-md"
          style={{
            width: PILL_WIDTH,
            height: PILL_HEIGHT,
            paddingLeft: 10,
            paddingRight: 10,
            background: "rgba(15, 16, 20, 0.86)",
            border: "1px solid rgba(255,255,255,0.08)",
          }}
        >
          <span
            className="rounded-full shrink-0"
            style={{
              width: 6,
              height: 6,
              background: dotColor,
              boxShadow: `0 0 6px ${dotColor}`,
              opacity: phase === "recording" && rms > 0.05 ? 1 : 0.7,
            }}
          />
          {/* 居中 + fade-mask 容器：内层 inline-block 让窄文本自动居中；
              超长文本随 ASR 流入向右溢出，mask 两端柔淡出。 */}
          <div
            className="flex-1 overflow-hidden"
            style={{
              maskImage: fadeMask,
              WebkitMaskImage: fadeMask,
            }}
          >
            <div
              className="text-center font-medium whitespace-nowrap"
              style={{
                color: "#f7f7f8",
                fontSize: PILL_FONT_SIZE,
              }}
            >
              {showText}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function commonPrefix(a: string, b: string): string {
  let i = 0;
  const max = Math.min(a.length, b.length);
  while (i < max && a[i] === b[i]) i++;
  return a.slice(0, i);
}
