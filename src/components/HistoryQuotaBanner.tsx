import { useEffect, useState } from "react";
import { getAccountState, onAccountState, type AccountSnapshot } from "../lib/account";

/// 历史 tab 顶部的云端 quota 横条 —— 跟 Mac HistoryQuotaBanner 同款。
/// 显示今日 used/limit + ProgressView + 手动刷新。数据从 AccountSnapshot
/// 拿，挂载时主动 reload 一次。
///
/// AccountSnapshot 里没单独 reloadMe 命令，登录态变化会自动 push 新 snapshot；
/// 这里通过订阅 onAccountState 拿到最新 quota。manual refresh 按钮拉个 fresh
/// snapshot 触发后端 /api/me 透传。
export default function HistoryQuotaBanner() {
  const [account, setAccount] = useState<AccountSnapshot | null>(null);

  useEffect(() => {
    getAccountState().then(setAccount).catch(() => {});
    const un = onAccountState(setAccount);
    return () => {
      un.then((fn) => fn());
    };
  }, []);

  if (!account) {
    return (
      <div className="px-5 py-2.5 bg-ink-50 border-b border-ink-200 text-xs text-ink-500">
        云端用量加载中…
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
        <span className="text-ink-700 font-medium">📊 今日云端用量</span>
        <span className="text-ink-500 font-mono tabular-nums">
          {used.toLocaleString()} / {limit.toLocaleString()} tokens
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
        <span className="text-ink-500 uppercase tracking-wide">{planRaw}</span>
      </div>
    );
  }

  // 付费档无 limit 字段
  return (
    <div className="px-5 py-2.5 bg-ink-50 border-b border-ink-200 flex items-center gap-3 text-xs">
      <span className="text-ink-700 font-medium">📊 云端用量</span>
      <span className="text-ink-500 font-mono tabular-nums">
        {(quota?.used_tokens ?? 0).toLocaleString()} tokens 已用
      </span>
      <span className="text-ink-400">·</span>
      <span className="text-ink-500 uppercase tracking-wide">{planRaw}</span>
    </div>
  );
}
