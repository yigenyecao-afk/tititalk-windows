import { useEffect, useRef, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { PipelinePhase } from "../lib/types";
import type { CompanionState } from "../lib/companion-api";
import { PetSpeechBubble } from "./PetSpeechBubble";

/// 单帧 192×208 → 渲染 64×69.3，跟 Mac PetView 同比例。
const FRAME_W = 192;
const FRAME_H = 208;
const RENDER_W = 64;
const RENDER_H = 64 * (FRAME_H / FRAME_W); // ≈ 69.3
const SHEET_COLS = 8;
const SHEET_ROWS = 9;

/// (v1.1) panel 尺寸——跟 tauri.conf.json + Rust PANEL_W/H 同步。
const PANEL_W = 144;
const PANEL_H = 140;
const BUBBLE_MAX_W = 130;

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
///
/// (v1.1) panel 改 144×140：上方气泡区 + 下方 sprite 居中。
/// idle 状态走 hold cycle（静止 6-12s + 1.1s 完整 6 帧）；深夜 1-5 点 25%
/// 概率切 jumping row[0] 0.6s 当哈欠。
export function PetView({
  companion,
  phase,
  spriteUrl,
  onTap,
  onDoubleTap,
  onLongPress,
  onDragStart,
}: {
  companion: CompanionState;
  phase: PipelinePhase;
  spriteUrl: string;
  onTap: () => void;
  onDoubleTap: () => void;
  onLongPress: () => void;
  onDragStart: (e: React.MouseEvent) => void;
}) {
  const state = mapState(companion, phase);
  const [frame, setFrame] = useState(0);
  const [showYawn, setShowYawn] = useState(false);
  const stateRef = useRef<State>(state);

  // 性格化文案气泡 ----------------------------------------------------
  const [bubbleText, setBubbleText] = useState<string | null>(null);
  useEffect(() => {
    let un: UnlistenFn | null = null;
    let alive = true;
    listen<{ text: string | null; dwell_ms: number }>("companion-speech", (e) => {
      if (!alive) return;
      const { text } = e.payload;
      setBubbleText(text && text.length > 0 ? text : null);
    }).then((fn) => {
      if (alive) un = fn;
      else fn();
    });
    return () => {
      alive = false;
      if (un) un();
    };
  }, []);

  // 状态变 → 重置帧 + 重启 timer ---------------------------------------
  useEffect(() => {
    if (stateRef.current === state) return;
    stateRef.current = state;
    setFrame(0);
    setShowYawn(false);
  }, [state]);

  // sprite 帧动画。idle 用 hold cycle；其它状态连续循环。
  // (v1.1) hold cycle: 静止 6-12s 后跑一次完整 6 帧；25% 深夜哈欠分支
  useEffect(() => {
    let cancelled = false;
    let timeoutId: number | null = null;
    let intervalId: number | null = null;

    const clearAll = () => {
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId);
        timeoutId = null;
      }
      if (intervalId !== null) {
        window.clearInterval(intervalId);
        intervalId = null;
      }
    };

    if (state !== "idle") {
      // 连续循环
      const total = FRAMES_OF[state];
      const interval = DURATION_MS_OF[state] / total;
      intervalId = window.setInterval(() => {
        if (cancelled) return;
        setFrame((f) => (f + 1) % total);
      }, interval);
    } else {
      // hold cycle: 静止 6-12s 后偶尔动一下
      const startHold = () => {
        if (cancelled) return;
        const holdSec = 6 + Math.random() * 6; // 6..12
        timeoutId = window.setTimeout(() => {
          if (cancelled) return;
          // 25% 深夜哈欠（凌晨 1-5 点）
          const h = new Date().getHours();
          if (h >= 1 && h < 5 && Math.random() < 0.25) {
            playYawn();
          } else {
            playIdleFrames();
          }
        }, holdSec * 1000);
      };

      const playYawn = () => {
        setShowYawn(true);
        timeoutId = window.setTimeout(() => {
          if (cancelled) return;
          setShowYawn(false);
          setFrame(0);
          startHold();
        }, 600);
      };

      const playIdleFrames = () => {
        const total = FRAMES_OF.idle;
        const interval = DURATION_MS_OF.idle / total;
        let f = 1;
        setFrame(f);
        intervalId = window.setInterval(() => {
          if (cancelled) return;
          if (f >= total - 1) {
            window.clearInterval(intervalId!);
            intervalId = null;
            setFrame(0);
            startHold();
          } else {
            f += 1;
            setFrame(f);
          }
        }, interval);
      };

      // 立即进入 hold
      setFrame(0);
      startHold();
    }

    return () => {
      cancelled = true;
      clearAll();
    };
  }, [state]);

  const row = ROW_OF[state];
  const safeFrame = Math.min(frame, FRAMES_OF[state] - 1);

  // 整张 sheet 缩放到 RENDER_W * SHEET_COLS × RENDER_H * SHEET_ROWS，
  // 然后用 background-position 把目标帧挪到 (0,0) 显示。
  const bgW = RENDER_W * SHEET_COLS;
  const bgH = RENDER_H * SHEET_ROWS;
  // (v1.1) 哈欠借用 jumping row[0]
  const yawnRow = ROW_OF.jumping;
  const offsetX = showYawn ? 0 : -safeFrame * RENDER_W;
  const offsetY = -(showYawn ? yawnRow : row) * RENDER_H;

  // pill 显示中（stationary mood 下 phase 非 idle）→ 透明度降到 0.4
  const isPillActive =
    companion.mood === "stationary" &&
    phase !== "idle" &&
    phase !== "done" &&
    phase !== "failed" &&
    phase !== "stopping";
  const opacity = isPillActive ? 0.4 : 1.0;

  // ---------- 单击 / 双击 / 长按 / 拖动 区分 ----------
  // 长按 ≥0.5s → onLongPress（抚摸），松手早 → tap 路径。
  // 单击 vs 双击：250ms 内第二次按下算双击。
  // 拖动：mousedown 后立即注册 move listener；如果累计 delta > 4px 标记为拖动，
  //       松开时不走 tap/long-press。
  //
  // 注意：拖动跟 long-press 互斥——按住不动 0.5s 算抚摸；按住有 delta 算拖。
  //       250ms tap-detector 跟 mousedown 流程独立，互不干扰。
  const longPressTimer = useRef<number | null>(null);
  const clickTimer = useRef<number | null>(null);
  const dragInfo = useRef<{ startX: number; startY: number; moved: boolean }>({
    startX: 0,
    startY: 0,
    moved: false,
  });

  const cancelLongPress = () => {
    if (longPressTimer.current !== null) {
      window.clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragInfo.current = { startX: e.screenX, startY: e.screenY, moved: false };
    // 启动 long-press timer（0.5s 触发抚摸；如果期间检测到拖动会取消）
    cancelLongPress();
    longPressTimer.current = window.setTimeout(() => {
      longPressTimer.current = null;
      // 仅在没拖动时触发 long-press
      if (!dragInfo.current.moved) {
        onLongPress();
        // 标记 moved=true 让 mouseup 知道这次不走 tap
        dragInfo.current.moved = true;
      }
    }, 500);

    // 把拖动事件交给父组件——父组件管 outerPosition 计算 + cmd_companion_save_position
    onDragStart(e);

    const onMove = (ev: MouseEvent) => {
      const dx = ev.screenX - dragInfo.current.startX;
      const dy = ev.screenY - dragInfo.current.startY;
      if (!dragInfo.current.moved && Math.hypot(dx, dy) > 4) {
        dragInfo.current.moved = true;
        cancelLongPress();
      }
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      cancelLongPress();
      // 如果没拖、没触发 long-press → 走 tap detector
      if (!dragInfo.current.moved) {
        // 250ms 内若没第二次 mousedown 就当 single tap
        if (clickTimer.current !== null) {
          window.clearTimeout(clickTimer.current);
          clickTimer.current = null;
          onDoubleTap();
        } else {
          clickTimer.current = window.setTimeout(() => {
            clickTimer.current = null;
            onTap();
          }, 250);
        }
      }
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  return (
    <div
      style={{
        width: PANEL_W,
        height: PANEL_H,
        position: "relative",
        background: "transparent",
      }}
    >
      {/* 上方：气泡区（hit-test 关掉，不挡 sprite 点击） */}
      <div
        style={{
          position: "absolute",
          top: 4,
          left: 0,
          right: 0,
          display: "flex",
          justifyContent: "center",
          pointerEvents: "none",
        }}
      >
        <PetSpeechBubble text={bubbleText} maxWidth={BUBBLE_MAX_W} />
      </div>

      {/* 底部：sprite 居中 */}
      <div
        style={{
          position: "absolute",
          bottom: 4,
          left: (PANEL_W - RENDER_W) / 2,
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
        onMouseDown={handleMouseDown}
        title="单击招手 · 双击切换巡游 · 长按抚摸 · 拖动换位置"
      />
    </div>
  );
}
