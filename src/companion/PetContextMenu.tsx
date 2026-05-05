// Wave 4 Stage 2 — 右键菜单。锚定在鼠标位置，点外面 / Esc 关。
// 5 项：喂食 / 改名 / 隐藏 1h / 走开（关闭整窗） / 切宠物 (子菜单)。
//
// 「走开」 ≠ 删除：实际只是 cmd_companion_hide + 把 settings.companion_enabled
// 写成 false（让用户下次启动也不弹），跟「隐藏 1h」区分（只是 timer 控）。

import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";

interface Props {
  x: number;
  y: number;
  onClose: () => void;
  onFeed: () => void;
  onRename: () => void;
  onHide1h: () => void;
  onShare: () => void;
  onGoAway: () => void;
}

export function PetContextMenu({ x, y, onClose, onFeed, onRename, onHide1h, onShare, onGoAway }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current) return;
      if (!ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  // 菜单超出窗口边界时翻边（companion 窗口才 240×240）
  const cw = window.innerWidth;
  const ch = window.innerHeight;
  const w = 168;
  const h = 200;
  const left = Math.min(x, cw - w - 4);
  const top = Math.min(y, ch - h - 4);

  return (
    <div
      ref={ref}
      className="pet-menu"
      style={{ left, top }}
      onClick={(e) => e.stopPropagation()}
    >
      <button onClick={() => { onFeed(); onClose(); }}>🍪 喂食 (+5 饱食度)</button>
      <button onClick={() => { onRename(); onClose(); }}>✏️ 改名</button>
      <button onClick={() => { onHide1h(); onClose(); }}>🙈 隐藏 1 小时</button>
      <button onClick={() => { onShare(); onClose(); }}>🖼 导出分享卡片</button>
      <button
        onClick={async () => {
          onGoAway();
          // 不抢焦点显示 confirm — 直接走 invoke 隐藏窗口
          try { await invoke("cmd_companion_hide"); } catch {}
          onClose();
        }}
        className="danger"
      >
        🚪 走开
      </button>
    </div>
  );
}
