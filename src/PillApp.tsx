import { useEffect, useRef, useState } from "react";
import { onPipeline } from "./lib/api";
import type { PipelinePhase, PillTheme } from "./lib/types";
import MinimalPill from "./pill-themes/MinimalPill";
import type { DisplayMode, PillThemeProps } from "./pill-themes/types";

/// (v0.14.1 重做) 录音浮窗宿主 — 订阅 pipeline 事件并转发给 MinimalPill。
/// 跟 Mac AppState 字段一一对应：
///   • phase / level / partial / transcript / cloud_connecting → MinimalPill props
///   • sessionStart 在 phase=recording 翻起时记，phase=idle/done 时清零
///
/// 极简 pill 不再 drop partial — 实时识别字幕是核心 UX。
export default function PillApp() {
  const [phase, setPhase] = useState<PipelinePhase>("idle");
  const [rms, setRms] = useState(0);
  const [partial, setPartial] = useState("");
  const [finalText, setFinalText] = useState("");
  const [polished, setPolished] = useState("");
  const [cloudConnecting, setCloudConnecting] = useState(false);
  const [sessionStart, setSessionStart] = useState(0);

  // 上一阶段引用 — 用来检测「recording 翻起」打 sessionStart 时戳
  const prevPhaseRef = useRef<PipelinePhase>("idle");

  useEffect(() => {
    const un = onPipeline((ev) => {
      if (ev.kind === "phase") {
        setPhase(ev.phase);
        // recording 启动时打时戳；离开 recording 但还在 processing 时保持时戳
        // （时长不再跳但仍保留供 transcribing 阶段如果想恢复显示）；
        // 完全空闲（idle/done）时清零让下次 recording 重新计时。
        if (ev.phase === "recording" && prevPhaseRef.current !== "recording") {
          setSessionStart(Date.now());
        }
        if (ev.phase === "idle") {
          setSessionStart(0);
          setPartial("");
          setFinalText("");
          setPolished("");
          setCloudConnecting(false);
        }
        prevPhaseRef.current = ev.phase;
      } else if (ev.kind === "level") {
        setRms(ev.rms);
      } else if (ev.kind === "partial") {
        setPartial(ev.text);
      } else if (ev.kind === "transcript") {
        setFinalText(ev.text);
        setPartial(""); // ASR-final 到达后 partial 已被并入 final
      } else if (ev.kind === "cloud_connecting") {
        setCloudConnecting(ev.connecting);
      }
      // notice / error / sound — pill 不直接渲染（toast / errorbar 各自处理）
    });
    return () => {
      un.then((fn) => fn());
    };
  }, []);

  const props: PillThemeProps & {
    partial: string;
    finalText: string;
    polished: string;
    sessionStart: number;
  } = {
    mode: "live" as DisplayMode, // 兼容性占位
    phase,
    text: "", // 兼容性占位
    rms,
    cloudConnecting,
    showPttHint: false,
    partial,
    finalText,
    polished,
    sessionStart,
  };

  return <MinimalPill {...props} />;
}

/// (v0.13.4) 老 cfg.pill_theme 入站迁移 — 全部映射成 "minimal"。
/// 保留 export 是为 SettingsSheet 旧 import 兼容。
export function migrateLegacyPillTheme(_theme: string): PillTheme {
  return "minimal";
}
