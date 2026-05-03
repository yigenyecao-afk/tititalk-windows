import type { ReactNode } from "react";

/// 仿 Mac sheet — 整屏 modal overlay，里面 720 max-width 内容居中，关闭键
/// 右上角。背景半透明灰，点空白处或按 Esc 关。
export default function TypelessSheet({
  open,
  title,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 bg-ink-900/40 flex items-start justify-center pt-12 pb-8 px-6"
      onMouseDown={(e) => {
        // 点 sheet 外（背景）才关，sheet 内部 click 不冒泡过来
        if (e.target === e.currentTarget) onClose();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
    >
      <div
        className="bg-white rounded-2xl shadow-2xl w-full max-w-3xl max-h-full overflow-hidden flex flex-col"
        role="dialog"
        aria-modal="true"
      >
        <div className="flex items-center justify-between px-7 pt-6 pb-3">
          <div className="flex items-center gap-3">
            <img
              src="/logo-mark.png"
              alt="TiTiTalk"
              className="w-8 h-8 rounded-lg"
              draggable={false}
            />
            <h1 className="text-2xl font-bold text-ink-900">{title}</h1>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="w-9 h-9 rounded-full flex items-center justify-center text-ink-500 hover:bg-ink-100 hover:text-ink-700"
            aria-label="关闭"
          >
            ✕
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-7 pb-8">{children}</div>
      </div>
    </div>
  );
}
