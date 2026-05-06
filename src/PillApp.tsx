import { useEffect, useRef, useState } from "react";
import { onPipeline, getConfig } from "./lib/api";
import type { PipelinePhase, PillTheme } from "./lib/types";
/// (v0.13.0) 4 主题切到 Mac 老 4 主题对齐：typeless/titi/aurora/mono
/// 老 Editorial 4 文件 (LanternPill/AnnotationPill/TelegraphPill/SealPill) 删
import TypelessPill from "./pill-themes/TypelessPill";
import TitiPill from "./pill-themes/TitiPill";
import AuroraPill from "./pill-themes/AuroraPill";
import MonoPill from "./pill-themes/MonoPill";
import type { DisplayMode, PillThemeProps } from "./pill-themes/types";

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

/// (v0.9 Editorial Chinese) PillApp 已 demoted 为「dispatcher」—— 跟 PipelineEvent
/// 流的耦合留这；具体每个主题的视觉 / DOM 形态 / 字体动画下放给 4 个独立
/// 主题文件（pill-themes/*.tsx）。新增主题不动这个 dispatcher，只 import +
/// route case 即可。
export default function PillApp() {
  const [phase, setPhase] = useState<PipelinePhase>("idle");
  const [rms, setRms] = useState(0);
  const [, setTarget] = useState<string>("");
  const [displayed, setDisplayed] = useState<string>("");
  const [cloudConnecting, setCloudConnecting] = useState(false);
  const [hotkeyMode, setHotkeyMode] = useState<string>("hybrid");
  const [pillTheme, setPillTheme] = useState<PillTheme>("typeless");
  const targetRef = useRef<string>("");
  const displayedRef = useRef<string>("");
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    getConfig()
      .then((c) => {
        setHotkeyMode(c.hotkey_mode);
        if (c.pill_theme) setPillTheme(migrateLegacyPillTheme(c.pill_theme));
      })
      .catch(() => {});
  }, []);

  // 60fps 平滑追字符 loop（共享给 4 个主题）
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
        if (ev.phase === "recording" || ev.phase === "done" || ev.phase === "failed") {
          targetRef.current = "";
          displayedRef.current = "";
          setTarget("");
          setDisplayed("");
        }
      } else if (ev.kind === "level") {
        setRms(ev.rms);
      } else if (ev.kind === "partial") {
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

  // 5 phase → 5 mode 归一（4 主题共享）
  const mode: DisplayMode = (() => {
    if (phase === "idle" || phase === "done") return "hidden";
    if (phase === "failed") return "error";
    if (phase === "polishing") return displayed ? "live" : "polishing";
    if (phase === "inserting") return "live";
    if (phase === "transcribing") return displayed ? "live" : "listening";
    if (phase === "recording" || phase === "stopping") return displayed ? "live" : "listening";
    return "listening";
  })();

  const showPttHint = phase === "recording" && shouldShowPttHint(hotkeyMode);
  useEffect(() => {
    if (showPttHint) bumpPttHintShown();
  }, [showPttHint]);

  const props: PillThemeProps = {
    mode,
    phase,
    text: displayed,
    rms,
    cloudConnecting,
    showPttHint,
  };

  switch (pillTheme) {
    case "titi":      return <TitiPill {...props} />;
    case "aurora":    return <AuroraPill {...props} />;
    case "mono":      return <MonoPill {...props} />;
    case "typeless":
    default:          return <TypelessPill {...props} />;
  }
}

/// (v0.13.0) cloud sync 入站老 Editorial key 自动迁移到新 key。
/// 视觉相近映射：lantern(朱砂呼吸)→titi(朱砂气泡) / annotation(便签)→aurora(流光) /
/// telegraph(等宽 ticker)→mono(素白细条) / seal(印章)→typeless(简净)。
export function migrateLegacyPillTheme(theme: string): PillTheme {
  switch (theme) {
    case "lantern":    return "titi";
    case "annotation": return "aurora";
    case "telegraph":  return "mono";
    case "seal":       return "typeless";
    case "typeless":
    case "titi":
    case "aurora":
    case "mono":
      return theme;
    default:
      return "typeless";
  }
}

function commonPrefix(a: string, b: string): string {
  let i = 0;
  const max = Math.min(a.length, b.length);
  while (i < max && a[i] === b[i]) i++;
  return a.slice(0, i);
}
