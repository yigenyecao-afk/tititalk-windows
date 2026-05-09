import { useEffect, useRef, useState } from "react";
import type { PipelinePhase } from "../lib/types";
import type { CompanionState } from "../lib/companion-api";

/// 单帧 192×208 → 渲染 64×69.3，跟 Mac PetView 同比例。
const FRAME_W = 192;
const FRAME_H = 208;
const RENDER_W = 64;
const RENDER_H = 64 * (FRAME_H / FRAME_W); // ≈ 69.3
const SHEET_COLS = 8;
const SHEET_ROWS = 9;
const SCALE = RENDER_W / FRAME_W; // 缩放因子，用 background-size 一并放大整张 sheet

/// 9 行状态固定语义（跟 Mac PetSheet.State 一一对应）。
type State =
  | "idle"
  | "running-right"
  | "running-left"
  | "waving"
  | "jumping"
  | "failed"
  | "waiting"
  | "running"
  | "review";

const ROW_OF: Record<State, number> = {
  idle: 0,
  "running-right": 1,
  "running-left": 2,
  waving: 3,
  jumping: 4,
  failed: 5,
  waiting: 6,
  running: 7,
  review: 8,
};

const FRAMES_OF: Record<State, number> = {
  idle: 6,
  "running-right": 8,
  "running-left": 8,
  waving: 4,
  jumping: 5,
  failed: 8,
  waiting: 6,
  running: 6,
  review: 6,
};

const DURATION_MS_OF: Record<State, number> = {
  idle: 1100,
  "running-right": 1060,
  "running-left": 1060,
  waving: 700,
  jumping: 840,
  failed: 1220,
  waiting: 1010,
  running: 820,
  review: 1030,
};

/// mood + phase → row。跟 Mac PetView.mapState 同。
function mapState(companion: CompanionState, phase: PipelinePhase): State {
  switch (companion.mood) {
    case "wave":
      return "waving";
    case "jump":
      return "jumping";
    case "wandering":
      return companion.facing === "right" ? "running-right" : "running-left";
    case "stationary":
    default:
      switch (phase) {
        case "recording":
          return "waiting";
        case "transcribing":
        case "polishing":
        case "inserting":
          return "review";
        case "failed":
          return "failed";
        case "idle":
        case "stopping":
        case "done":
        default:
          return "idle";
      }
  }
}

/// 64×69 sprite 渲染。background-image 整张 sheet + background-position 切帧。
/// 切片不动 DOM、不解码，纯 GPU compositing；30fps 步帧只调 setState 更新 style。
export function PetView({
  companion,
  phase,
  spriteUrl,
  onTap,
  onDoubleTap,
  onDragStart,
}: {
  companion: CompanionState;
  phase: PipelinePhase;
  spriteUrl: string;
  onTap: () => void;
  onDoubleTap: () => void;
  onDragStart: (e: React.MouseEvent) => void;
}) {
  const state = mapState(companion, phase);
  const [frame, setFrame] = useState(0);
  const stateRef = useRef<State>(state);

  // 状态变 → 重置帧 + 启动新 timer
  useEffect(() => {
    if (stateRef.current === state) return;
    stateRef.current = state;
    setFrame(0);
  }, [state]);

  useEffect(() => {
    const total = FRAMES_OF[state];
    const interval = DURATION_MS_OF[state] / total;
    const id = window.setInterval(() => {
      setFrame((f) => (f + 1) % total);
    }, interval);
    return () => window.clearInterval(id);
  }, [state]);

  const row = ROW_OF[state];
  const safeFrame = Math.min(frame, FRAMES_OF[state] - 1);

  // 整张 sheet 缩放到 RENDER_W * SHEET_COLS × RENDER_H * SHEET_ROWS，
  // 然后用 background-position 把目标帧挪到 (0,0) 显示。
  const bgW = RENDER_W * SHEET_COLS;
  const bgH = RENDER_H * SHEET_ROWS;
  const offsetX = -safeFrame * RENDER_W;
  const offsetY = -row * RENDER_H;

  // pill 显示中（stationary mood 下 phase 非 idle）→ 透明度降到 0.4
  const isPillActive =
    companion.mood === "stationary" &&
    phase !== "idle" &&
    phase !== "done" &&
    phase !== "failed" &&
    phase !== "stopping";
  const opacity = isPillActive ? 0.4 : 1.0;

  // 双击/单击区分：用 onClick + detail 计数；onMouseDown 启动可能的拖动
  const clickTimer = useRef<number | null>(null);
  const handleClick = (e: React.MouseEvent) => {
    if (e.detail === 2) {
      if (clickTimer.current) {
        window.clearTimeout(clickTimer.current);
        clickTimer.current = null;
      }
      onDoubleTap();
      return;
    }
    if (e.detail === 1) {
      // 250ms 内没第二次点击就当 single tap
      if (clickTimer.current) window.clearTimeout(clickTimer.current);
      clickTimer.current = window.setTimeout(() => {
        clickTimer.current = null;
        onTap();
      }, 250);
    }
  };

  const _ = SCALE; // 留 ref 防 lint 嫌没用（SCALE 是文档说明的语义常量）
  void _;

  return (
    <div
      style={{
        width: RENDER_W,
        height: RENDER_H,
        backgroundImage: `url("${spriteUrl}")`,
        backgroundSize: `${bgW}px ${bgH}px`,
        backgroundPosition: `${offsetX}px ${offsetY}px`,
        backgroundRepeat: "no-repeat",
        imageRendering: "auto",
        opacity,
        transition: "opacity 0.25s ease-in-out",
        cursor: "grab",
      }}
      onClick={handleClick}
      onMouseDown={onDragStart}
      title="单击招手 · 双击切换巡游 · 拖动换位置"
    />
  );
}
