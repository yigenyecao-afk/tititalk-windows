import { useEffect, useState } from "react";
import { getAccountState, onAccountState, reloadMe, type AccountSnapshot } from "../lib/account";

/// (v0.9 Editorial Chinese) 历史 tab 顶部云端 quota 横条 —— 跟 Mac
/// HistoryQuotaBanner 同款。砍 emoji 📊；加 1px 朱砂顶部进度条 + 仿宋
/// metric label + JetBrains Mono caption。
///
/// AccountSnapshot 没单独 reloadMe 命令，登录态变化会自动 push 新 snapshot；
/// 这里通过订阅 onAccountState 拿到最新 quota。manual refresh 按钮拉个 fresh
/// snapshot 触发后端 /api/me 透传。
export default function HistoryQuotaBanner() {
  const [account, setAccount] = useState<AccountSnapshot | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    getAccountState().then(setAccount).catch(() => {});
    const un = onAccountState(setAccount);
    // (v0.7.8) 挂载时主动 reload，跟 Mac HistoryQuotaBanner.onAppear 对齐
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
      <div className="relative px-5 pt-3 pb-2.5 border-b border-ink-200 bg-white">
        <div className="absolute top-0 left-0 right-0 h-px bg-ink-100" />
        <div className="font-mono text-[11px] text-ink-400">额度加载中…</div>
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
    const danger = pct >= 0.95;
    const warn = pct >= 0.8 && !danger;
    const tone = danger ? "text-signal-500" : warn ? "text-amber-600" : "text-ink-400";
    const barColor = danger ? "bg-signal-500" : warn ? "bg-amber-500" : "bg-signal-500/80";

    return (
      <div className="relative px-5 pt-3 pb-2.5 border-b border-ink-200 bg-white">
        {/* (v0.9) 1px 顶部进度条 —— 编辑器风的进度反馈，不抢主体注意力 */}
        <div className="absolute top-0 left-0 right-0 h-[2px] bg-ink-100">
          <div
            className={`h-full ${barColor} transition-all duration-300`}
            style={{ width: `${pct * 100}%` }}
          />
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          <span className="font-mono text-[10px] tracking-[0.25em] text-signal-500 font-medium uppercase">
            今日额度
          </span>
          <span className="font-serif text-[14px] text-ink-900 tabular-nums">
            还能录约 <span className="font-medium">{fmtTokenSeconds(remaining)}</span>
          </span>
          <span className="font-mono text-[11px] text-ink-400">
            / {fmtTokenSeconds(limit)}
          </span>
          <span className={`font-mono text-[11px] tabular-nums ${tone}`}>
            {Math.round(pct * 100)}%
          </span>
          <div className="flex-1" />
          <span className="font-mono text-[10px] tracking-wider text-ink-500 uppercase">
            {planLabel(planRaw)}
          </span>
          <button
            type="button"
            onClick={handleRefresh}
            disabled={refreshing}
            className="text-ink-400 hover:text-signal-500 disabled:opacity-40 transition-colors"
            title="刷新额度"
          >
            <span className={refreshing ? "inline-block animate-spin" : "inline-block"}>↻</span>
          </button>
        </div>
      </div>
    );
  }

  // 付费档无 limit 字段
  return (
    <div className="relative px-5 pt-3 pb-2.5 border-b border-ink-200 bg-white">
      <div className="absolute top-0 left-0 right-0 h-[2px] bg-signal-500/30" />
      <div className="flex items-center gap-3 flex-wrap">
        <span className="font-mono text-[10px] tracking-[0.25em] text-signal-500 font-medium uppercase">
          今日已用
        </span>
        <span className="font-serif text-[14px] text-ink-900 tabular-nums">
          {fmtTokenSeconds(quota?.used_tokens ?? 0)}
        </span>
        <div className="flex-1" />
        <span className="font-mono text-[10px] tracking-wider text-ink-500 uppercase">
          {planLabel(planRaw)}
        </span>
        <button
          type="button"
          onClick={handleRefresh}
          disabled={refreshing}
          className="text-ink-400 hover:text-signal-500 disabled:opacity-40 transition-colors"
          title="刷新额度"
        >
          <span className={refreshing ? "inline-block animate-spin" : "inline-block"}>↻</span>
        </button>
      </div>
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
