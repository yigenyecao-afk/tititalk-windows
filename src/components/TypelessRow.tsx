import type { ReactNode } from "react";

/// 仿 Typeless 设置行 —— 跟 Mac TypelessRow 同款：
/// 左 SVG icon 带浅色 badge + 标题 + 灰描述（小白能看懂的一句话）+ 右控件。
/// 卡片 (TypelessCard) 在 row 之间补 0.5px 灰线。
///
/// `icon` 接收单字 / emoji（默认 indigo 渐变 badge），`iconColor` 用 hex 染 badge：
/// 例如 `iconColor="#EC4899"` → pink 风格栏目。
export function TypelessRow({
  icon,
  iconColor = "#6366F1",
  title,
  subtitle,
  trailing,
}: {
  icon?: string;
  iconColor?: string;
  title: string;
  subtitle?: string;
  trailing?: ReactNode;
}) {
  return (
    <div className="flex items-center gap-3.5 px-4 py-3.5">
      {icon && (
        <div
          className="shrink-0 w-7 h-7 rounded-lg flex items-center justify-center text-[14px] font-semibold"
          style={{
            backgroundColor: hexAlpha(iconColor, 0.14),
            color: iconColor,
          }}
        >
          {icon}
        </div>
      )}
      <div className="flex-1 min-w-0">
        <div className="text-[14px] font-semibold text-ink-900 leading-tight">
          {title}
        </div>
        {subtitle && (
          <div className="text-[12px] text-ink-500 mt-1 leading-relaxed">
            {subtitle}
          </div>
        )}
      </div>
      {trailing && <div className="shrink-0">{trailing}</div>}
    </div>
  );
}

function hexAlpha(hex: string, alpha: number): string {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

export function TypelessCard({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-xl bg-white border border-ink-200/70 divide-y divide-ink-200/60">
      {children}
    </div>
  );
}

export function TypelessSectionHeader({
  title,
  subtitle,
}: {
  title: string;
  subtitle?: string;
}) {
  return (
    <div className="px-1 mb-2">
      <div className="text-[11px] font-semibold tracking-[0.06em] uppercase text-ink-500">
        {title}
      </div>
      {subtitle && <div className="text-xs text-ink-400 mt-0.5">{subtitle}</div>}
    </div>
  );
}
