// C1+C3 (2026-05-06) — 装饰商店 modal。
// 显示当前可用的节日装饰（free，时间窗内）+ 永久 paid 装饰（用专注币买）。
// 左下角显示当前余额；点装饰 → 调 spendForDecoration；成功后 callback 拿新 state。

import { useEffect, useState } from "react";
import {
  getSeasonalDecorations,
  spendForDecoration,
  type SeasonalDecorationDTO,
  type CompanionStateDTO,
} from "../lib/wave3-api";

interface Props {
  state: CompanionStateDTO;
  onClose: () => void;
  onUpdate: (s: CompanionStateDTO) => void;
}

export function DecorationStore({ state, onClose, onUpdate }: Props) {
  const [items, setItems] = useState<SeasonalDecorationDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    getSeasonalDecorations()
      .then((r) => { if (alive) { setItems(r.items); setLoading(false); } })
      .catch((e) => { if (alive) { setErr(String(e)); setLoading(false); } });
    return () => { alive = false; };
  }, []);

  const unlocked = new Set(state.unlocked_decorations);
  const balance = state.coins_balance;

  const onBuy = async (slug: string, cost: number) => {
    if (busy) return;
    setBusy(slug);
    try {
      const next = await spendForDecoration(slug);
      onUpdate(next);
    } catch (e: any) {
      const detail = e?.body?.detail || e?.message || String(e);
      const reason = typeof detail === "object" ? detail?.reason : String(detail);
      const msg = typeof detail === "object" ? detail?.message : null;
      setErr(msg || `${reason}: 解锁失败 (${cost})`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="store-overlay" onClick={onClose}>
      <div className="store-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="store-header">
          <div className="store-title">装饰商店</div>
          <div className="store-balance">💰 {balance} 专注币</div>
          <button className="store-close" onClick={onClose}>×</button>
        </div>
        {loading && <div className="store-empty">加载中…</div>}
        {err && <div className="store-error">{err}</div>}
        <div className="store-grid">
          {items.map((it) => {
            const owned = unlocked.has(it.slug);
            const affordable = it.is_free || balance >= it.cost;
            const label = owned
              ? "已拥有"
              : it.is_free
              ? `领取（限时${it.end_date ? "到 " + it.end_date : ""}）`
              : `${it.cost} 专注币`;
            return (
              <button
                key={it.slug}
                className={`store-item ${owned ? "owned" : affordable ? "" : "locked"}`}
                disabled={owned || !affordable || busy === it.slug}
                onClick={() => onBuy(it.slug, it.cost)}
                title={it.name}
              >
                <div className="store-emoji">{it.emoji}</div>
                <div className="store-name">{it.name}</div>
                <div className="store-price">{busy === it.slug ? "解锁中…" : label}</div>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
