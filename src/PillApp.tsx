import { useEffect, useRef, useState } from "react";
import { onPipeline } from "./lib/api";
import type { PipelinePhase } from "./lib/types";

/// Pill UI — 跟 Mac 4 主题统一的丝滑流：
///   • 第一次拿到文字直接显示（不做起手 typewriter）
///   • 后续 partial 增长由 60fps requestAnimationFrame 平滑追字符，
///     gap 大时加速，避免「partial 跳 20 字一闪一闪」的卡顿感
export default function PillApp() {
  const [phase, setPhase] = useState<PipelinePhase>("idle");
  const [rms, setRms] = useState(0);
  const [target, setTarget] = useState<string>("");
  const [displayed, setDisplayed] = useState<string>("");
  // (ISSUE-2 2026-05-03) tititalk_cloud cold-connect 标识 —— 后端在
  // start_session_async 之前 emit connecting=true，ready 抵达后 emit false。
  // recording 阶段时如果 true，pill 文案换成「录音中… 连接云端」让用户知道
  // 是网络等待 (实测 2-3s)，不是 pill 没工作。
  const [cloudConnecting, setCloudConnecting] = useState(false);
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
        // target 缩短/被替换 → 拉齐
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
        const next = truncate(ev.text, 22);
        targetRef.current = next;
        setTarget(next);
        // 第一次拿到文字 → 直接 snap 到 target，避免起手 typewriter 卡顿感
        if (displayedRef.current === "") {
          displayedRef.current = next;
          setDisplayed(next);
        } else if (!next.startsWith(displayedRef.current)) {
          // partial 回退/被重写 → snap 到最长公共前缀，loop 再追
          const prefix = commonPrefix(displayedRef.current, next);
          displayedRef.current = prefix;
          setDisplayed(prefix);
        }
      } else if (ev.kind === "transcript") {
        const next = truncate(ev.text, 22);
        targetRef.current = next;
        setTarget(next);
      } else if (ev.kind === "error") {
        const next = "出错";
        targetRef.current = next;
        displayedRef.current = next;
        setTarget(next);
        setDisplayed(next);
      } else if (ev.kind === "cloud_connecting") {
        setCloudConnecting(ev.connecting);
      }
    });
    return () => {
      un.then((fn) => fn());
    };
  }, []);

  const { color: phaseColor, label: rawLabel } = renderState(phase);
  // (ISSUE-2) cold-connect 期间换文案
  const label = phase === "recording" && cloudConnecting ? "录音中… 连接云端" : rawLabel;
  const bars = barLevels(rms);
  const showText = displayed || (target ? "" : label);

  return (
    <div className="h-screen w-screen flex items-center justify-center select-none">
      <div
        className="flex items-center gap-3 rounded-full px-4 py-2 shadow-2xl backdrop-blur-md"
        style={{
          background: "rgba(15, 16, 20, 0.86)",
          border: "1px solid rgba(255,255,255,0.08)",
        }}
      >
        {phase === "recording" || phase === "transcribing" || phase === "stopping" ? (
          <>
            <div className="flex items-end gap-[3px] h-5">
              {bars.map((h, i) => (
                <div
                  key={i}
                  className="w-[3px] rounded-sm transition-all duration-75"
                  style={{
                    height: `${h}%`,
                    background: phaseColor,
                    opacity: phase === "recording" ? 1 : 0.55,
                  }}
                />
              ))}
            </div>
            <span className="text-[13px] font-medium" style={{ color: "#f7f7f8" }}>
              {showText}
            </span>
          </>
        ) : (
          <span className="text-[13px] font-medium" style={{ color: "#f7f7f8" }}>
            {displayed || label}
          </span>
        )}
      </div>
    </div>
  );
}

function renderState(phase: PipelinePhase): { color: string; label: string } {
  switch (phase) {
    case "recording":     return { color: "#ef4444", label: "录音中…" };
    case "stopping":      return { color: "#f59e0b", label: "结束…" };
    case "transcribing":  return { color: "#93c5fd", label: "识别中…" };
    case "polishing":     return { color: "#a78bfa", label: "润色中…" };
    case "inserting":     return { color: "#22c55e", label: "插入…" };
    case "done":          return { color: "#22c55e", label: "完成" };
    case "failed":        return { color: "#ef4444", label: "失败" };
    default:              return { color: "#83868d", label: "" };
  }
}

function barLevels(rms: number): number[] {
  const norm = Math.min(1, Math.max(0, rms * 6));
  return Array.from({ length: 6 }, (_, i) => {
    const phase = i / 5;
    const wobble = 0.5 + 0.5 * Math.sin(Date.now() / 80 + i);
    const h = (norm * 70 + 10) * (0.6 + 0.4 * wobble) * (1 - 0.15 * Math.abs(0.5 - phase));
    return Math.max(8, Math.min(100, h));
  });
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

function commonPrefix(a: string, b: string): string {
  let i = 0;
  const max = Math.min(a.length, b.length);
  while (i < max && a[i] === b[i]) i++;
  return a.slice(0, i);
}
