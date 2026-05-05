// P0 wave 3 #1 + #7 — 进度圆环 + 今日个性卡片（HomePane 顶部）。
// Mac 同源：UI/PersonalizationCard.swift。
//
// 60s 自刷新；登录前直接返 null（不占空间）。

import { useEffect, useState } from "react";
import {
  PersonalizationDTO,
  DailySummaryDTO,
  getPersonalization,
  getDailySummary,
} from "../lib/wave3-api";

interface Props {
  loggedIn: boolean;
}

export function PersonalizationCard({ loggedIn }: Props) {
  const [data, setData] = useState<PersonalizationDTO | null>(null);
  const [daily, setDaily] = useState<DailySummaryDTO | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!loggedIn) return;
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;
    const tick = async () => {
      try {
        const [p, d] = await Promise.all([getPersonalization(), getDailySummary()]);
        if (cancelled) return;
        setData(p);
        setDaily(d);
        setError(null);
      } catch (e) {
        if (!cancelled) setError("个性化数据暂时不可用");
      }
    };
    tick();
    timer = setInterval(tick, 60_000);
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [loggedIn]);

  if (!loggedIn) return null;

  const score = data?.score ?? 0;
  // SVG 圆环：r=36, circumference≈226；按 score 算 stroke-dashoffset
  const circumference = 2 * Math.PI * 36;
  const offset = circumference * (1 - score / 100);
  const savedMin = daily?.saved_minutes ?? 0;
  const savedLabel =
    savedMin < 1 ? `${Math.round(savedMin * 60)}秒` : `${savedMin.toFixed(1)}分`;

  return (
    <div className="flex items-center gap-4 rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
      <div className="relative h-20 w-20 flex-none">
        <svg width={80} height={80} viewBox="0 0 80 80">
          <circle
            cx="40"
            cy="40"
            r="36"
            fill="none"
            stroke="rgba(120,120,120,0.18)"
            strokeWidth="6"
          />
          <circle
            cx="40"
            cy="40"
            r="36"
            fill="none"
            stroke="url(#ring-gradient)"
            strokeWidth="6"
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={offset}
            transform="rotate(-90 40 40)"
            style={{ transition: "stroke-dashoffset 0.6s ease-out" }}
          />
          <defs>
            <linearGradient id="ring-gradient" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stopColor="#8B5CF6" />
              <stop offset="100%" stopColor="#06B6D4" />
            </linearGradient>
          </defs>
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center text-center">
          <div className="text-xl font-bold leading-none">{score}%</div>
          <div className="text-[10px] text-zinc-500">已学你</div>
        </div>
      </div>

      <div className="flex flex-1 flex-col gap-2">
        <div className="grid grid-cols-3 gap-3">
          <Metric label="今日字数" value={`${daily?.chars ?? 0}`} color="#8B5CF6" />
          <Metric label="节省" value={savedLabel} color="#06B6D4" />
          <Metric label="连续" value={`${daily?.streak_days ?? 0}天`} color="#F59E0B" />
        </div>
        <div className="grid grid-cols-3 gap-3">
          <Metric label="我的词典" value={`${data?.dict_count ?? 0}`} color="#10B981" />
          <Metric label="纠正记忆" value={`${data?.corrections_count ?? 0}`} color="#6366F1" />
          <Metric label="活跃 app" value={`${data?.apps_used_30d ?? 0}`} color="#EF4444" />
        </div>
        {error && <div className="text-xs text-red-500/70">{error}</div>}
      </div>
    </div>
  );
}

function Metric({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div className="flex flex-col">
      <span className="text-base font-bold leading-tight" style={{ color }}>
        {value}
      </span>
      <span className="text-[10px] text-zinc-500">{label}</span>
    </div>
  );
}
