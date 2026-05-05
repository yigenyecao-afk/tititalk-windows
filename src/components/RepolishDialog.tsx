// P0 wave 3 #43 — 后台批量重润色对话框。
// Mac 同源：UI/RepolishDialog.swift。

import { useState } from "react";
import { repolishBatch, RepolishItemIn } from "../lib/wave3-api";

interface Props {
  open: boolean;
  items: RepolishItemIn[];
  onClose: () => void;
  onComplete: (newTextById: Record<string, string>) => void;
}

export function RepolishDialog({ open, items, onClose, onComplete }: Props) {
  const [persona, setPersona] = useState<"friendly" | "formal" | "mixed_zh_en" | "code">(
    "friendly"
  );
  const [intensity, setIntensity] = useState<"light" | "normal" | "heavy">("normal");
  const [stripFillers, setStripFillers] = useState(false);
  const [running, setRunning] = useState(false);
  const [summary, setSummary] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!open) return null;

  const run = async () => {
    setRunning(true);
    setError(null);
    setSummary(null);
    try {
      const res = await repolishBatch({
        items,
        persona,
        model: "qwen-flash",
        intensity,
        output_language: "",
        strip_fillers: stripFillers,
      });
      const byId: Record<string, string> = {};
      let failed = 0;
      for (const r of res.results) {
        if (r.polished) byId[r.id] = r.polished;
        else failed += 1;
      }
      setSummary(
        `成功 ${Object.keys(byId).length} 条，失败 ${failed} 条；用 token ${res.total_cost_tokens}`
      );
      onComplete(byId);
      setTimeout(onClose, 1500);
    } catch (e: any) {
      setError(`失败：${e?.message ?? String(e)}`);
    } finally {
      setRunning(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={onClose}
    >
      <div
        className="w-[420px] rounded-xl border border-zinc-200 bg-white p-5 shadow-2xl dark:border-zinc-800 dark:bg-zinc-900"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-bold">批量重润色 — {items.length} 条</h2>
        <div className="mt-4 space-y-3 text-sm">
          <Row label="风格">
            <select
              value={persona}
              onChange={(e) => setPersona(e.target.value as any)}
              disabled={running}
              className="rounded border border-zinc-300 px-2 py-1 dark:border-zinc-700 dark:bg-zinc-800"
            >
              <option value="friendly">友好 · 自然口语</option>
              <option value="formal">正式 · 商务邮件</option>
              <option value="mixed_zh_en">中英混排 · 技术</option>
              <option value="code">代码 · 技术文档</option>
            </select>
          </Row>
          <Row label="力度">
            <select
              value={intensity}
              onChange={(e) => setIntensity(e.target.value as any)}
              disabled={running}
              className="rounded border border-zinc-300 px-2 py-1 dark:border-zinc-700 dark:bg-zinc-800"
            >
              <option value="light">轻</option>
              <option value="normal">正常</option>
              <option value="heavy">重</option>
            </select>
          </Row>
          <Row label="过滤口头禅">
            <input
              type="checkbox"
              checked={stripFillers}
              onChange={(e) => setStripFillers(e.target.checked)}
              disabled={running}
            />
          </Row>
        </div>
        {running && <p className="mt-4 text-sm text-zinc-500">正在重润色…</p>}
        {error && <p className="mt-4 text-sm text-red-500">{error}</p>}
        {summary && <p className="mt-4 text-sm text-emerald-600">{summary}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={running}
            className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
          >
            取消
          </button>
          <button
            type="button"
            onClick={run}
            disabled={running || items.length === 0}
            className="rounded-md bg-purple-600 px-3 py-1.5 text-sm text-white hover:bg-purple-700 disabled:opacity-50"
          >
            开始
          </button>
        </div>
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-zinc-600 dark:text-zinc-300">{label}</span>
      {children}
    </div>
  );
}
