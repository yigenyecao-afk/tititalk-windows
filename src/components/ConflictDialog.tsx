// (v0.13.4 用户反馈砍弹窗) ConflictDialog 不再渲染 UI —— 用户明确「天天
// 重复弹出我烦了」。收到 cloud-config-conflict 事件立即调 resolveConflict("merge")
// 静默处理（推荐选项 = 合并云端跟本地）。组件保留是为了 App.tsx 不用改 import；
// 永远返回 null。
//
// 失败时仅 console.warn，不打扰用户。如果用户想覆盖远端就直接改本地设置，
// 下次 push 自然会上行。

import { useEffect } from "react";
import { onConflict, resolveConflict } from "../lib/account";

export default function ConflictDialog() {
  useEffect(() => {
    const un = onConflict(async (_p) => {
      try {
        await resolveConflict("merge");
        // FIX-23: 解决冲突后广播刷新——SettingsSheet 重拉新值
        window.dispatchEvent(new CustomEvent("titi:config-changed"));
      } catch (e) {
        console.warn("auto-resolve conflict failed:", e);
      }
    });
    return () => {
      un.then((fn) => fn());
    };
  }, []);
  return null;
}
