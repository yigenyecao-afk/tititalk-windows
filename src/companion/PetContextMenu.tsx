// Wave 4 Stage 2 — 右键菜单。锚定在鼠标位置，点外面 / Esc 关。
//
// v2 (2026-05-06) 砍掉「改名 / 隐藏 1h / 分享卡片」三项 — 跟「宠物互动」无关
// 只剩 3 项纯宠物动作：喂食 / 装饰商店 / 走开

import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";

interface Props {
  x: number;
  y: number;
  onClose: () => void;
  onFeed: () => void;
  onGoAway: () => void;
  onShop: () => void;
}

export function PetContextMenu({ x, y, onClose, onFeed, onGoAway, onShop }: Props) {
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
  const h = 110; // 砍掉 3 项后高度变小
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
      <button onClick={() => { onShop(); onClose(); }}>🛍️ 装饰商店</button>
      <button
        onClick={async () => {
          onGoAway();
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
