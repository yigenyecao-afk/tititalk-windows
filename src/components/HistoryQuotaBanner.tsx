import { useEffect, useState } from "react";
import { getAccountState, onAccountState, reloadMe, type AccountSnapshot } from "../lib/account";

/// 历史 tab 顶部的云端 quota 横条 —— 跟 Mac HistoryQuotaBanner 同款。
/// 显示今日 used/limit + ProgressView + 手动刷新。数据从 AccountSnapshot
/// 拿，挂载时主动 reload 一次。
///
/// AccountSnapshot 里没单独 reloadMe 命令，登录态变化会自动 push 新 snapshot；
/// 这里通过订阅 onAccountState 拿到最新 quota。manual refresh 按钮拉个 fresh
/// snapshot 触发后端 /api/me 透传。
export default function HistoryQuotaBanner() {
  const [account, setAccount] = useState<AccountSnapshot | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    getAccountState().then(setAccount).catch(() => {});
    const un = onAccountState(setAccount);
    // (v0.7.8) 挂载时主动 reload，跟 Mac HistoryQuotaBanner.onAppear 对齐 ——
    // 用户切到历史 tab 立刻看到最新 quota，不依赖被动事件推送。
    reloadMe().catch(() => {});
    return () => {
      un.then((fn) => fn());
    };
  }, []);

  async function handleRefresh() {
    setRefreshing(true);
    try {
      await reloadMe();
    } finally {
      window.setTimeout(() => setRefreshing(false), 400);
    }
  }

  if (!account) {
    return (
      <div className="px-5 py-2.5 bg-ink-50 border-b border-ink-200 text-xs text-ink-500">
        额度加载中…
      </div>
    );
  }

  const quota = account.quota ?? null;
  const planRaw = account.license?.plan ?? "free";

  // free 档显示进度条；付费档只显示 used + plan。
  if (
    quota &&
    quota.limit_tokens != null &&
    quota.remaining_tokens != null
  ) {
    const limit = quota.limit_tokens;
    const remaining = quota.remaining_tokens;
    const used = quota.used_tokens ?? Math.max(0, limit - remaining);
    const pct = limit > 0 ? Math.min(1, Math.max(0, used / limit)) : 0;
    const tone =
      pct >= 0.95 ? "text-red-600" : pct >= 0.8 ? "text-amber-600" : "text-ink-500";
    const barTone =
      pct >= 0.95 ? "bg-red-500" : pct >= 0.8 ? "bg-amber-500" : "bg-indigo-500";

    return (
      <div className="px-5 py-2.5 bg-ink-50 border-b border-ink-200 flex items-center gap-3 text-xs">
        <span className="text-ink-700 font-medium">📊 今日剩余</span>
        <span className="text-ink-500 font-mono tabular-nums">
          还能录约 {fmtTokenSeconds(remaining)}（共 {fmtTokenSeconds(limit)}）
        </span>
        <div className="flex-1 max-w-xs h-1.5 rounded-full bg-ink-200 overflow-hidden">
          <div
            className={`h-full ${barTone} transition-all duration-300`}
            style={{ width: `${pct * 100}%` }}
          />
        </div>
        <span className={`font-mono tabular-nums ${tone}`}>
          {Math.round(pct * 100)}%
        </span>
        <span className="text-ink-400">·</span>
        <span className="text-ink-500">{planLabel(planRaw)}</span>
        <button
          type="button"
          onClick={handleRefresh}
          disabled={refreshing}
          className="ml-auto text-ink-400 hover:text-ink-700 disabled:opacity-40"
          title="刷新额度"
        >
          <span className={refreshing ? "inline-block animate-spin" : "inline-block"}>↻</span>
        </button>
      </div>
    );
  }

  // 付费档无 limit 字段
  return (
    <div className="px-5 py-2.5 bg-ink-50 border-b border-ink-200 flex items-center gap-3 text-xs">
      <span className="text-ink-700 font-medium">📊 今日已用</span>
      <span className="text-ink-500 font-mono tabular-nums">
        {fmtTokenSeconds(quota?.used_tokens ?? 0)}
      </span>
      <span className="text-ink-400">·</span>
      <span className="text-ink-500">{planLabel(planRaw)}</span>
      <button
        type="button"
        onClick={handleRefresh}
        disabled={refreshing}
        className="ml-auto text-ink-400 hover:text-ink-700 disabled:opacity-40"
        title="刷新额度"
      >
        <span className={refreshing ? "inline-block animate-spin" : "inline-block"}>↻</span>
      </button>
    </div>
  );
}

function fmtTokenSeconds(tokens: number): string {
  const secs = Math.max(0, Math.floor(tokens / 10));
  if (secs < 60) return `${secs} 秒`;
  if (secs < 3600) return `${Math.floor(secs / 60)} 分钟`;
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  return m === 0 ? `${h} 小时` : `${h} 小时 ${m} 分`;
}

function planLabel(plan: string): string {
  const p = plan.toLowerCase();
  if (p.includes("flagship")) return "旗舰版";
  if (p.includes("annual"))   return "年度专业版";
  if (p.includes("lifetime")) return "终身专业版";
  if (p.includes("pro"))      return "专业版";
  return "免费版";
}
