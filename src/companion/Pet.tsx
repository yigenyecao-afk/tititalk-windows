// Wave 4 — Pet sprite renderer + click/drag handling.
// 设计：
//   - 真 spritesheet 加载成功 → CSS background-position keyframe (跟 petdex 同款)
//   - 加载失败 / spritesheet 字段空 → emoji 渲染（带呼吸缩放）
//   - drag 通过 Tauri WebviewWindow.startDragging() 触发原生窗口拖动
//   - click 触发一次 waving (PetEngine 不感知，只本地动 0.7s)

import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { PetSnapshot, PetStateId } from "./types";

interface Props {
  snapshot: PetSnapshot;
  /// 让父级强制覆盖一次 state（如 click waving 不走 PetEngine）
  overrideState?: PetStateId | null;
  /// 右键菜单触发器
  onMenu?: (e: React.MouseEvent) => void;
  /// 双击 → 父级开「专心模式」25min
  onDoubleClick?: () => void;
  /// 单击 → 父级触发 wave 0.7s
  onClick?: () => void;
}

const SPRITE_WIDTH = 128; // 单帧像素 — petdex 默认 128x128
const SPRITE_HEIGHT = 128;

export function Pet({ snapshot, overrideState, onMenu, onDoubleClick, onClick }: Props) {
  const stateId = overrideState ?? snapshot.state;
  const stateMeta = snapshot.meta.states[stateId] ?? snapshot.meta.states.idle;
  const spriteOk = useSpriteAvailable(snapshot.meta.spritesheet);

  // 当前帧（仅 sprite 模式用；emoji fallback 走 CSS keyframe 不需要）
  const [frame, setFrame] = useState(0);
  const stateRef = useRef(stateId);
  stateRef.current = stateId;

  useEffect(() => {
    if (!spriteOk) return;
    const fpsMs = stateMeta.durationMs / stateMeta.frames;
    let i = 0;
    const t = window.setInterval(() => {
      i = (i + 1) % stateMeta.frames;
      setFrame(i);
    }, fpsMs);
    return () => window.clearInterval(t);
  }, [spriteOk, stateMeta.durationMs, stateMeta.frames]);

  const onMouseDown = async (e: React.MouseEvent) => {
    // 左键拖：调 Tauri 原生 startDragging（直接走 invoke，不依赖 plugin）
    if (e.button === 0) {
      try {
        // tauri 2 自带 internal 命令 plugin:window|start_dragging
        await invoke("plugin:window|start_dragging");
      } catch {
        // 兜底：什么都不做，拖不动也不影响其它互动
      }
    }
  };

  const onContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    onMenu?.(e);
  };

  const overlayEmoji = useMemo(() => {
    return snapshot.overlays.map((o) => OVERLAY_EMOJI[o]).filter(Boolean).join("");
  }, [snapshot.overlays]);

  return (
    <div
      className="pet-root"
      onMouseDown={onMouseDown}
      onContextMenu={onContextMenu}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
    >
      <div className="pet-shadow" />
      {spriteOk ? (
        <div
          className="pet-sprite"
          style={{
            width: SPRITE_WIDTH,
            height: SPRITE_HEIGHT,
            backgroundImage: `url(${snapshot.meta.spritesheet})`,
            backgroundPosition: `${-frame * SPRITE_WIDTH}px ${-stateMeta.row * SPRITE_HEIGHT}px`,
            imageRendering: "pixelated",
          }}
        />
      ) : (
        <EmojiPet emoji={snapshot.meta.emoji} state={stateId} />
      )}
      {overlayEmoji && <div className="pet-overlay">{overlayEmoji}</div>}
    </div>
  );
}

const OVERLAY_EMOJI: Record<string, string> = {
  headset: "🎧",
  glasses: "🤓",
  tie: "👔",
  tea: "🍵",
  "birthday-hat": "🎂",
};

/// emoji fallback 渲染：
/// - idle: 呼吸缩放 0.95→1.05
/// - waving: 左右 wiggle ±10°
/// - running / running-left / running-right: 上下 bobbing + 朝向
/// - jumping: translateY 起伏
/// - failed: 微微下沉 + 灰度
/// - waiting: 缩小 0.92 + 半透明
/// - review: 旋转 0→8→0 像在思考
function EmojiPet({ emoji, state }: { emoji: string; state: PetStateId }) {
  const animClass = `emoji-pet anim-${state}`;
  return <div className={animClass}>{emoji}</div>;
}

/// 检测 spritesheet 是否能加载。空字符串直接 false；否则 fetch HEAD。
function useSpriteAvailable(url: string): boolean {
  const [ok, setOk] = useState(false);
  useEffect(() => {
    if (!url) {
      setOk(false);
      return;
    }
    let cancelled = false;
    const img = new Image();
    img.onload = () => {
      if (!cancelled) setOk(true);
    };
    img.onerror = () => {
      if (!cancelled) setOk(false);
    };
    img.src = url;
    return () => {
      cancelled = true;
    };
  }, [url]);
  return ok;
}
