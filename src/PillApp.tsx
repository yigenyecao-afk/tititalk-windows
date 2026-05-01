import { useEffect, useState } from "react";
import { onPipeline } from "./lib/api";
import type { PipelinePhase } from "./lib/types";

export default function PillApp() {
  const [phase, setPhase] = useState<PipelinePhase>("idle");
  const [rms, setRms] = useState(0);
  const [hint, setHint] = useState<string>("");

  useEffect(() => {
    const un = onPipeline((ev) => {
      if (ev.kind === "phase") setPhase(ev.phase);
      else if (ev.kind === "level") setRms(ev.rms);
      else if (ev.kind === "transcript") setHint(truncate(ev.text, 22));
      else if (ev.kind === "error") setHint("出错");
    });
    return () => {
      un.then((fn) => fn());
    };
  }, []);

  const { color, label } = renderState(phase);
  const bars = barLevels(rms);

  return (
    <div className="h-screen w-screen flex items-center justify-center select-none">
      <div
        className="flex items-center gap-3 rounded-full px-4 py-2 shadow-2xl backdrop-blur-md"
        style={{
          background: "rgba(15, 16, 20, 0.86)",
          border: "1px solid rgba(255,255,255,0.08)",
        }}
      >
        <div className="flex items-end gap-[3px] h-5">
          {bars.map((h, i) => (
            <div
              key={i}
              className="w-[3px] rounded-sm transition-all duration-75"
              style={{
                height: `${h}%`,
                background: color,
                opacity: phase === "recording" ? 1 : 0.45,
              }}
            />
          ))}
        </div>
        <span className="text-[13px] font-medium" style={{ color: "#f7f7f8" }}>
          {hint || label}
        </span>
      </div>
    </div>
  );
}

function renderState(phase: PipelinePhase): { color: string; label: string } {
  switch (phase) {
    case "recording":     return { color: "#ef4444", label: "录音中…" };
    case "stopping":      return { color: "#f59e0b", label: "结束…" };
    case "transcribing":  return { color: "#3b82f6", label: "转写中…" };
    case "polishing":     return { color: "#8b5cf6", label: "润色中…" };
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
