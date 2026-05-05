// P0 wave 3 #9 — 批量音频文件转录 panel。
// Mac 同源：UI/BatchTranscribeView.swift。
//
// 后端：cmd_transcribe_file(path) → 文本（symphonia 解码 + 现有 ASR 走流式）
// 这里做 UI 队列 + 拖文件 + 进度 + 完成后导出 .txt。

import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { writeText as clipboardWrite } from "@tauri-apps/plugin-clipboard-manager";

interface Job {
  id: string;
  path: string;
  fileName: string;
  status: "pending" | "running" | "done" | "failed";
  transcript: string;
  error?: string;
}

interface Props {
  loggedIn: boolean;
  onClose?: () => void;
}

export function BatchTranscribePanel({ loggedIn, onClose }: Props) {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [busy, setBusy] = useState(false);

  const pickFiles = async () => {
    const picked = await openFileDialog({
      multiple: true,
      filters: [
        { name: "音频", extensions: ["wav", "mp3", "m4a", "opus", "aac", "flac"] },
      ],
    });
    if (!picked) return;
    const list = Array.isArray(picked) ? picked : [picked];
    setJobs((prev) => [
      ...prev,
      ...list.map((p) => ({
        id: crypto.randomUUID(),
        path: p,
        fileName: p.split(/[\\/]/).pop() || p,
        status: "pending" as const,
        transcript: "",
      })),
    ]);
  };

  const runAll = async () => {
    if (busy) return;
    setBusy(true);
    try {
      for (const job of jobs.filter((j) => j.status === "pending")) {
        setJobs((prev) =>
          prev.map((j) => (j.id === job.id ? { ...j, status: "running" } : j))
        );
        try {
          const transcript = await invoke<string>("cmd_transcribe_file", {
            path: job.path,
          });
          setJobs((prev) =>
            prev.map((j) =>
              j.id === job.id ? { ...j, status: "done", transcript } : j
            )
          );
        } catch (e: any) {
          setJobs((prev) =>
            prev.map((j) =>
              j.id === job.id
                ? { ...j, status: "failed", error: String(e?.message ?? e) }
                : j
            )
          );
        }
      }
    } finally {
      setBusy(false);
    }
  };

  // Win Tauri plugin-fs 没装；批量结果通过剪贴板拷出，跟 Mac 走 NSSavePanel 路径不同
  // 但「转录完即拿到文本」的核心需求 ok。后续如果上 plugin-fs 再切回 saveFileDialog。
  const exportJob = async (job: Job) => {
    try {
      await clipboardWrite(job.transcript);
    } catch (e) {
      console.warn("clipboard write failed:", e);
    }
  };

  const clearFinished = () => {
    setJobs((prev) => prev.filter((j) => j.status !== "done" && j.status !== "failed"));
  };

  if (!loggedIn) {
    return (
      <div className="p-6 text-sm text-zinc-500">
        批量转录需要登录账号（共享云端 ASR 配额）。
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col gap-3 p-4">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-bold">批量音频转录</h2>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={clearFinished}
            disabled={!jobs.some((j) => j.status === "done" || j.status === "failed")}
            className="rounded-md border border-zinc-300 px-3 py-1 text-xs hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
          >
            清理已完成
          </button>
          <button
            type="button"
            onClick={runAll}
            disabled={busy || !jobs.some((j) => j.status === "pending")}
            className="rounded-md bg-purple-600 px-3 py-1 text-xs text-white hover:bg-purple-700 disabled:opacity-50"
          >
            {busy ? "进行中…" : "全部转录"}
          </button>
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border border-zinc-300 px-3 py-1 text-xs hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
            >
              关闭
            </button>
          )}
        </div>
      </div>

      <button
        type="button"
        onClick={pickFiles}
        className="flex h-32 flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-zinc-300 text-sm text-zinc-500 hover:border-purple-500 hover:text-purple-600 dark:border-zinc-700"
      >
        <span className="text-2xl">📂</span>
        <span>点击选择音频文件（wav / mp3 / m4a / opus / aac / flac）</span>
      </button>

      <div className="flex-1 overflow-y-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
        {jobs.length === 0 ? (
          <div className="flex h-full items-center justify-center text-sm text-zinc-400">
            队列为空 — 选择文件后点「全部转录」
          </div>
        ) : (
          <ul>
            {jobs.map((j) => (
              <li
                key={j.id}
                className="flex items-center gap-3 border-b border-zinc-100 px-3 py-2 last:border-0 dark:border-zinc-800"
              >
                <StatusBadge status={j.status} />
                <div className="flex-1 min-w-0">
                  <div className="truncate text-sm">{j.fileName}</div>
                  {j.transcript && (
                    <div className="truncate text-xs text-zinc-500">{j.transcript}</div>
                  )}
                  {j.error && (
                    <div className="truncate text-xs text-red-500">{j.error}</div>
                  )}
                </div>
                {j.status === "done" && (
                  <button
                    type="button"
                    onClick={() => exportJob(j)}
                    className="rounded-md border border-zinc-300 px-2 py-0.5 text-xs hover:bg-zinc-100 dark:border-zinc-700"
                  >
                    复制文本
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: Job["status"] }) {
  const map: Record<Job["status"], { label: string; cls: string }> = {
    pending: { label: "待转录", cls: "bg-zinc-200 text-zinc-700" },
    running: { label: "进行中", cls: "bg-amber-200 text-amber-900" },
    done: { label: "完成", cls: "bg-emerald-200 text-emerald-900" },
    failed: { label: "失败", cls: "bg-red-200 text-red-900" },
  };
  const m = map[status];
  return (
    <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${m.cls}`}>
      {m.label}
    </span>
  );
}
