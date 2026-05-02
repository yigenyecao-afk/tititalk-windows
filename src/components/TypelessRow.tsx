import type { ReactNode } from "react";

/// 仿 Typeless 设置行 —— 跟 Mac TypelessRow 同款：
/// 左 icon + 标题 + 灰描述（小白能看懂的一句话）+ 右控件。
/// 卡片 (TypelessCard) 在 row 之间补 0.5px 灰线，不要 macOS Form .grouped 风。
export function TypelessRow({
  icon,
  title,
  subtitle,
  trailing,
}: {
  icon?: string; // emoji or single char
  title: string;
  subtitle?: string;
  trailing?: ReactNode;
}) {
  return (
    <div className="flex items-center gap-3 px-4 py-3.5">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 text-[14px] font-semibold text-ink-900">
          {icon && (
            <span className="inline-flex w-4 justify-center text-ink-500 text-[13px]">
              {icon}
            </span>
          )}
          <span>{title}</span>
        </div>
        {subtitle && (
          <div
            className={
              "text-[12px] text-ink-500 mt-1 leading-relaxed " +
              (icon ? "pl-6" : "")
            }
          >
            {subtitle}
          </div>
        )}
      </div>
      {trailing && <div className="shrink-0">{trailing}</div>}
    </div>
  );
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
