import { useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import {
  deepPress,
  doubleTap,
  dragEnd,
  listPets,
  longPress,
  onCompanionState,
  savePosition,
  tap,
  type CompanionState,
  type PetEntry,
} from "./lib/companion-api";
import { onPipeline, getConfig } from "./lib/api";
import type { PipelinePhase } from "./lib/types";
import { PetView } from "./companion/PetView";

/// Companion webview 入口——监听 companion-state event 切 mood/facing；
/// 监听 pipeline event 切 phase；交互（tap/double/drag）调后端 command。
///
/// 拖动实现：mousedown 起记录初始 cursor 位置 + 当前窗口位置；mousemove 算 delta
/// 调 cmd_companion_save_position（每帧 ~16ms）；mouseup 调 cmd_companion_drag_end
/// 落盘 + 暂停巡游 1.2s。
///
/// 注意 pell 拖：webview 内拿不到屏幕坐标，要走 screenX / Win32 GetCursorPos
/// 等价。Tauri 2 提供 currentMonitor / cursorPosition；这里用 screenX/Y
/// （绝对屏幕坐标）减去 mousedown 时的 screenX/Y 算 delta，加到当前窗口 outer position。
export default function CompanionApp() {
  const [companion, setCompanion] = useState<CompanionState>({
    mood: "stationary",
    facing: "right",
  });
  const [phase, setPhase] = useState<PipelinePhase>("idle");
  const [spriteUrl, setSpriteUrl] = useState<string>("");

  // pets 列表 + 当前 slug（来自 cfg.companion_pet_slug）
  const cfgSlugRef = useRef<string>("boba");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const cfg = await getConfig();
        cfgSlugRef.current = cfg.companion_pet_slug || "boba";
      } catch {}
      try {
        const pets: PetEntry[] = await listPets();
        if (cancelled) return;
        const chosen =
          pets.find((p) => p.slug === cfgSlugRef.current) ?? pets[0];
        if (chosen) {
          setSpriteUrl(convertFileSrc(chosen.spritesheet_path));
        }
      } catch (e) {
        console.error("companion: listPets failed", e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // companion-state event 订阅
  useEffect(() => {
    const un = onCompanionState((s) => setCompanion(s));
    return () => {
      un.then((fn) => fn());
    };
  }, []);

  // pipeline event 订阅（用于 stationary mood 下决定 row）
  useEffect(() => {
    const un = onPipeline((ev) => {
      if (ev.kind === "phase") setPhase(ev.phase);
    });
    return () => {
      un.then((fn) => fn());
    };
  }, []);

  // 拖动 ----------------------------------------------------------------
  const dragRef = useRef<{ startSX: number; startSY: number; startOX: number; startOY: number } | null>(
    null,
  );

  const onDragStart = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    // outerPosition via Tauri API
    let startOX = 0;
    let startOY = 0;
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const w = getCurrentWindow();
      const pos = await w.outerPosition();
      startOX = pos.x;
      startOY = pos.y;
    } catch (err) {
      console.error("companion: outerPosition failed", err);
      return;
    }
    dragRef.current = {
      startSX: e.screenX,
      startSY: e.screenY,
      startOX,
      startOY,
    };
    window.addEventListener("mousemove", onDragMove);
    window.addEventListener("mouseup", onDragEnd, { once: true });
  };

  const onDragMove = (e: MouseEvent) => {
    const ref = dragRef.current;
    if (!ref) return;
    const dx = e.screenX - ref.startSX;
    const dy = e.screenY - ref.startSY;
    void savePosition(ref.startOX + dx, ref.startOY + dy);
  };

  const onDragEnd = () => {
    window.removeEventListener("mousemove", onDragMove);
    if (dragRef.current) {
      void dragEnd();
    }
    dragRef.current = null;
  };

  if (!spriteUrl) {
    return null;
  }

  return (
    <div
      style={{
        width: "100vw",
        height: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "transparent",
      }}
    >
      <PetView
        companion={companion}
        phase={phase}
        spriteUrl={spriteUrl}
        onTap={() => void tap()}
        onDoubleTap={() => void doubleTap()}
        onLongPress={() => void longPress()}
        onDeepPress={() => void deepPress()}
        onDragStart={onDragStart}
      />
    </div>
  );
}
