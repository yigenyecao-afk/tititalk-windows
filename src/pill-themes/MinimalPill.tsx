// (v0.13.4 砍 ✓ confirm) 极简录音浮窗 —— 跟 Mac MinimalPill.swift 同源。
//
// 视觉契约：
//   • 黑色 capsule 背景（#1f2026）
//   • 左：✕ 仅在 transcribing/polishing/inserting/error 阶段出现（取消进行中
//     的转写/插入有意义）。recording 时 ✕ 收起，靠 hotkey 释放/再按/静音超
//     阈值/双击 fn 自然结束。
//   • 中：白色等宽竖条 16 根，按 RMS 历史滑动窗实时抖
//   • 无 ✓ confirm 按钮 —— 录完用户已经决策完了，再让他点一次确认是侮辱用户。
//   • 无 label / 无 status text / 无录音时长
//
// 状态切换：
//   • recording: 波形条按 RMS 抖（中间高两端低 cos 包络）+ ✕ 隐藏
//   • polishing/transcribing/inserting: 波形静止低 baseline + alpha 慢呼吸 + ✕ 显
//   • error: 波形变橙红 + ✕ 显
//   • idle: window 隐藏（不会进入此组件）

import { useEffect, useState } from "react";
import type { PillThemeProps } from "./types";
import { forceCancel } from "../lib/api";

const BAR_COUNT = 16;

export default function MinimalPill({ mode, rms, phase }: PillThemeProps) {
  // 16 帧 RMS 滑动窗
  const [history, setHistory] = useState<number[]>(() =>
    new Array(BAR_COUNT).fill(0),
  );
  const isPolishingPhase = phase === "transcribing" || phase === "polishing" || phase === "inserting";
  const isError = phase === "failed";
  const isRecording = phase === "recording" || phase === "stopping";
  // ✕ 仅在「进行中可取消」阶段出现，录音中藏起来逼用 hotkey 自然结束。
  const showCancel = isPolishingPhase || isError;

  useEffect(() => {
    const v = Math.max(0, Math.min(1, rms));
    setHistory((prev) => {
      const next = prev.slice(1);
      next.push(v);
      return next;
    });
  }, [rms]);

  function barHeight(i: number): number {
    const baseline = 4;
    const maxHeight = 22;
    const center = 7.5;
    const dist = Math.abs(i - center) / center;
    const envelope = (Math.cos(dist * Math.PI) + 1) / 2;
    const v = history[i] ?? 0;
    if (isRecording) {
      return Math.max(baseline, baseline + v * maxHeight * envelope);
    }
    return baseline + 2;
  }

  void mode; // PillThemeProps 兼容性保留
  return (
    <div className="pill-minimal">
      {showCancel && (
        <button
          className="pill-minimal-btn pill-minimal-cancel"
          onClick={() => { void forceCancel(); }}
          aria-label="取消"
          title="取消（Esc）"
        >
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round">
            <path d="M6 6 L18 18 M18 6 L6 18" />
          </svg>
        </button>
      )}

      <div
        className={
          "pill-minimal-bars" +
          (isPolishingPhase ? " pill-minimal-bars-breath" : "") +
          (isError ? " pill-minimal-bars-error" : "")
        }
      >
        {Array.from({ length: BAR_COUNT }).map((_, i) => (
          <span
            key={i}
            className="pill-minimal-bar"
            style={{ height: `${barHeight(i)}px` }}
          />
        ))}
      </div>
    </div>
  );
}
