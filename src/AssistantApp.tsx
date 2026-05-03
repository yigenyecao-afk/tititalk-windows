// (v0.8.4 backlog #5) 「随便问」浮窗 React 组件 ——
// 跟 Mac AssistantCoordinator 同源 4 action：翻译 / 润色 / 写邮件 / 问答
// 流程：
//   1. window 打开时监听 "assistant://show" 事件，把后端拷的选区填进 context
//   2. 用户输入 prompt + 选 action（默认 qa），按 ⏎ 或点「执行」
//   3. 调 cmd_assistant_run_action，结果填到下方
//   4. 点「插入到原 app」走 Ctrl+V 模拟，「复制」走 clipboard
//   5. ESC 关窗

import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

type Action = "qa" | "translate" | "polish" | "email";

const ACTIONS: { key: Action; label: string; icon: string; hint: string }[] = [
  { key: "qa", label: "问答", icon: "💬", hint: "随便问 AI · 默认" },
  { key: "translate", label: "翻译", icon: "🌐", hint: "翻译选中文字 / 输入" },
  { key: "polish", label: "润色", icon: "✨", hint: "把口语改通顺" },
  { key: "email", label: "写邮件", icon: "✉️", hint: "根据描述写中文邮件" },
];

export default function AssistantApp() {
  const [selection, setSelection] = useState<string>("");
  const [userInput, setUserInput] = useState<string>("");
  const [action, setAction] = useState<Action>("qa");
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<string>("");
  const [error, setError] = useState<string>("");
  const inputRef = useRef<HTMLInputElement>(null);

  // 监听后端 emit 的 show 事件 —— 重置状态 + 填选区 + 聚焦输入框
  useEffect(() => {
    const off = listen<{ selection: string }>("assistant://show", (ev) => {
      setSelection(ev.payload.selection || "");
      setUserInput("");
      setResult("");
      setError("");
      setRunning(false);
      // 默认 action：有选区 → 翻译，否则 → 问答
      setAction(ev.payload.selection?.trim() ? "translate" : "qa");
      requestAnimationFrame(() => inputRef.current?.focus());
    });
    return () => {
      off.then((fn) => fn());
    };
  }, []);

  // ESC 关窗
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        invoke("cmd_assistant_hide").catch(() => {});
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const canRun = !running && (userInput.trim().length > 0 || selection.trim().length > 0);

  const run = async () => {
    if (!canRun) return;
    setRunning(true);
    setResult("");
    setError("");
    try {
      const out = await invoke<string>("cmd_assistant_run_action", {
        action,
        userInput,
        selection,
      });
      setResult(out);
    } catch (e) {
      setError(String(e));
    } finally {
      setRunning(false);
    }
  };

  const insertToApp = async () => {
    if (!result.trim()) return;
    try {
      await invoke("cmd_assistant_hide");
      // 给 OS 一拍切回原 app
      await new Promise((r) => setTimeout(r, 120));
      await invoke("cmd_assistant_insert_to_app", { text: result });
    } catch (e) {
      setError(String(e));
    }
  };

  const copyToClipboard = async () => {
    if (!result.trim()) return;
    try {
      await navigator.clipboard.writeText(result);
      await invoke("cmd_assistant_hide");
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <div className="h-screen w-screen bg-white text-ink-900 flex flex-col">
      {/* 顶部 action chips */}
      <div className="flex items-center gap-2 px-4 pt-3 pb-2 border-b border-ink-200">
        {ACTIONS.map((a) => (
          <button
            key={a.key}
            onClick={() => setAction(a.key)}
            className={
              "px-3 py-1.5 rounded-full text-xs flex items-center gap-1.5 transition " +
              (action === a.key
                ? "bg-indigo-600 text-white shadow-sm"
                : "bg-ink-100 text-ink-700 hover:bg-ink-200")
            }
            title={a.hint}
          >
            <span>{a.icon}</span>
            <span>{a.label}</span>
          </button>
        ))}
        <div className="ml-auto text-xs text-ink-400">ESC 关闭</div>
      </div>

      {/* 选区预览 */}
      {selection.trim() && (
        <div className="mx-4 mt-2 mb-1 rounded-md border border-ink-200 bg-ink-50 px-3 py-2 text-xs text-ink-700 max-h-20 overflow-y-auto">
          <span className="font-semibold mr-1">选区：</span>
          <span className="font-mono whitespace-pre-wrap">{selection}</span>
        </div>
      )}

      {/* 输入 */}
      <div className="px-4 py-3 flex items-center gap-2">
        <input
          ref={inputRef}
          type="text"
          className="flex-1 border border-ink-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
          placeholder={inputPlaceholder(action, !!selection.trim())}
          value={userInput}
          onChange={(e) => setUserInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              run();
            }
          }}
        />
        <button
          onClick={run}
          disabled={!canRun}
          className={
            "px-4 py-2 rounded-lg text-sm font-medium transition " +
            (canRun
              ? "bg-indigo-600 text-white hover:bg-indigo-700"
              : "bg-ink-200 text-ink-400 cursor-not-allowed")
          }
        >
          {running ? "执行中…" : "执行 ⏎"}
        </button>
      </div>

      {/* 结果区 */}
      <div className="flex-1 overflow-y-auto px-4 pb-3">
        {error && (
          <div className="mt-1 mb-2 rounded-md border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-700">
            {error}
          </div>
        )}
        {result && (
          <div className="rounded-lg border border-ink-200 bg-ink-50 p-3 whitespace-pre-wrap text-sm leading-relaxed">
            {result}
          </div>
        )}
        {!result && !error && !running && (
          <div className="text-center text-xs text-ink-400 mt-12">
            选 action · 输入指令 · ⏎ 执行
          </div>
        )}
      </div>

      {/* 底部动作栏 */}
      {result && !running && (
        <div className="border-t border-ink-200 px-4 py-2 flex items-center gap-2 justify-end">
          <button
            onClick={copyToClipboard}
            className="px-3 py-1.5 rounded-md text-xs bg-ink-100 hover:bg-ink-200 text-ink-700"
          >
            复制
          </button>
          <button
            onClick={insertToApp}
            className="px-3 py-1.5 rounded-md text-xs bg-emerald-600 text-white hover:bg-emerald-700"
          >
            插入到原 app
          </button>
        </div>
      )}
    </div>
  );
}

function inputPlaceholder(action: Action, hasSelection: boolean): string {
  switch (action) {
    case "translate":
      return hasSelection ? "（已带选区）回车翻译；输入框可加翻译指令" : "输入要翻译的内容";
    case "polish":
      return hasSelection ? "（已带选区）回车润色；输入框可加风格说明" : "输入要润色的口语";
    case "email":
      return "用一句话描述邮件意图：例如「跟客户致歉昨天会议迟到」";
    default:
      return hasSelection ? "围绕选区问点什么" : "随便问点什么";
  }
}
