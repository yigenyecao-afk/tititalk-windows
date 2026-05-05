// P0 wave 3 #13 — 全局 Ctrl+K 跨记录搜索。
// Mac 同源：UI/CrossHistorySearchSheet.swift。

import { useEffect, useRef, useState } from "react";
import { HistorySearchHitDTO, searchHistory } from "../lib/wave3-api";

interface Props {
  open: boolean;
  onClose: () => void;
  onJump?: (hitId: number) => void;
}

export function CrossSearchSheet({ open, onClose, onJump }: Props) {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<HistorySearchHitDTO[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (open) {
      setQuery("");
      setHits([]);
      setError(null);
      setTimeout(() => inputRef.current?.focus(), 30);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    if (debounce.current) clearTimeout(debounce.current);
    if (!query.trim()) {
      setHits([]);
      return;
    }
    debounce.current = setTimeout(async () => {
      setLoading(true);
      try {
        const res = await searchHistory(query.trim(), 30);
        setHits(res);
        setError(null);
      } catch {
        setError("搜索失败，请稍后再试");
      } finally {
        setLoading(false);
      }
    }, 400);
    return () => {
      if (debounce.current) clearTimeout(debounce.current);
    };
  }, [query, open]);

  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-24"
      onClick={onClose}
    >
      <div
        className="flex w-[600px] max-w-[90vw] flex-col rounded-xl border border-zinc-200 bg-white shadow-2xl dark:border-zinc-800 dark:bg-zinc-900"
        style={{ maxHeight: "70vh" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
          <span className="text-zinc-400">🔍</span>
          <input
            ref={inputRef}
            type="text"
            placeholder="搜索全部转写历史…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") onClose();
            }}
            className="flex-1 bg-transparent text-sm outline-none"
          />
          {loading && <span className="text-xs text-zinc-400">加载中…</span>}
          <button
            type="button"
            onClick={onClose}
            className="text-zinc-400 hover:text-zinc-600"
          >
            ✕
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-2 py-2">
          {error && <div className="px-3 py-2 text-sm text-red-500">{error}</div>}
          {!error && hits.length === 0 && query.trim() && !loading && (
            <div className="flex h-32 items-center justify-center text-sm text-zinc-400">
              未找到匹配结果
            </div>
          )}
          {hits.map((h) => (
            <div
              key={h.id}
              className="cursor-pointer rounded-md px-3 py-2 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800"
              onClick={() => {
                onJump?.(h.id);
                onClose();
              }}
            >
              <div className="line-clamp-2">{h.snippet}</div>
              <div className="mt-1 flex items-center gap-2 text-[10px] text-zinc-400">
                {h.role && <span>{h.role}</span>}
                <span>{new Date(h.created_at).toLocaleString("zh-CN")}</span>
                <span className="rounded-full bg-purple-500/15 px-1.5 py-px text-purple-600">
                  {h.matched_field === "corrected" ? "已修正" : "原文"}
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
