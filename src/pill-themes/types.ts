/// 4 个 pill 主题共享 props。PillApp.tsx 拿到 PipelineEvent + config
/// 后归一到 ThemeProps 喂给具体 ThemeView。每个主题各自决定怎么渲染。
import type { PipelinePhase } from "../lib/types";

export type DisplayMode = "listening" | "live" | "polishing" | "error" | "hidden";

export interface PillThemeProps {
  /// 5 态归一后的视觉模式
  mode: DisplayMode;
  /// 当前 phase（让 theme 自己判 polish vs record 阶段着色）
  phase: PipelinePhase;
  /// 实时显示文本（partial / polished stream / error 都走这）
  text: string;
  /// 麦克风音量 RMS 0~1（lantern 呼吸幅度 + telegraph 电平指示用）
  rms: number;
  /// 云端 cold-connect 中（recording 但 WS 还没 ready）
  cloudConnecting: boolean;
  /// PTT 用户前 5 次显示「松开即停 →」 onboarding hint
  showPttHint: boolean;
}
