import { useEffect, useState } from "react";
import { onPipeline } from "./lib/api";
import type { PipelinePhase, PillTheme } from "./lib/types";
import MinimalPill from "./pill-themes/MinimalPill";
import type { DisplayMode, PillThemeProps } from "./pill-themes/types";

/// (v0.13.4 返璞归真) 单一 MinimalPill 主题（typeless 风黑色 capsule + ✕ +
/// 波形 + ✓）。砍 4 主题 dispatcher / showPttHint / 流式追字 RAF / cloud-connecting
/// 文案分支 —— 极简 pill 完全不显示文字，这些状态都不需要。
///
/// 保留：phase / rms 实时反馈给 MinimalPill 内部画波形。
export default function PillApp() {
  const [phase, setPhase] = useState<PipelinePhase>("idle");
  const [rms, setRms] = useState(0);

  useEffect(() => {
    const un = onPipeline((ev) => {
      if (ev.kind === "phase") {
        setPhase(ev.phase);
      } else if (ev.kind === "level") {
        setRms(ev.rms);
      }
      // partial / transcript / error / cloud_connecting / sound / notice 都
      // 不在 minimal pill 显示，drop 即可。
    });
    return () => {
      un.then((fn) => fn());
    };
  }, []);

  // mode 字段保留作 PillThemeProps 兼容性占位（极简主题不读它）
  const mode: DisplayMode = phase === "idle" || phase === "done" ? "hidden" :
    phase === "failed" ? "error" : "listening";

  const props: PillThemeProps = {
    mode,
    phase,
    text: "",
    rms,
    cloudConnecting: false,
    showPttHint: false,
  };

  return <MinimalPill {...props} />;
}

/// (v0.13.4) 老 cfg.pill_theme 入站迁移 —— 全部映射成 "minimal"（永远只有这一个）
/// 保留 export 是为 SettingsSheet 旧 import 兼容（SettingsSheet 也会一起砍 picker）。
export function migrateLegacyPillTheme(_theme: string): PillTheme {
  return "minimal";
}
