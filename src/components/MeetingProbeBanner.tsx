// P0 wave 3 #12 — 会议探针 banner。监听 `app_context_changed` 事件，
// 当检测到 Zoom/Teams/钉钉/腾讯会议/飞书 启动 → 顶部 banner 询问录制。
// 用户点忽略 → 1 小时内不再重复弹同 source。

import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { startMeeting, MeetingDTO } from "../lib/wave3-api";

interface AppContextEvent {
  exe: string;
  window_title: string;
}

const KNOWN_MEETING: Array<{
  exe: RegExp;
  source: "zoom" | "teams" | "dingtalk" | "tencent_meeting" | "feishu";
  label: string;
}> = [
  { exe: /^Zoom\.exe$/i, source: "zoom", label: "Zoom" },
  { exe: /^Teams(\.|$)/i, source: "teams", label: "Teams" },
  { exe: /^DingTalk\.exe$/i, source: "dingtalk", label: "钉钉" },
  { exe: /^(WemeetApp|wemeetapp|TencentMeeting)\.exe$/i, source: "tencent_meeting", label: "腾讯会议" },
  { exe: /^Feishu\.exe$/i, source: "feishu", label: "飞书会议" },
];

const DISMISS_KEY_PREFIX = "meeting_probe_dismiss_";

interface Props {
  loggedIn: boolean;
  onMeetingStarted?: (m: MeetingDTO) => void;
}

export function MeetingProbeBanner({ loggedIn, onMeetingStarted }: Props) {
  const [pending, setPending] = useState<{
    source: "zoom" | "teams" | "dingtalk" | "tencent_meeting" | "feishu";
    label: string;
  } | null>(null);

  useEffect(() => {
    if (!loggedIn) return;
    let unlisten: (() => void) | null = null;
    let active = false;
    listen<AppContextEvent>("app_context_changed", (e) => {
      const exe = e.payload.exe || "";
      const match = KNOWN_MEETING.find((m) => m.exe.test(exe));
      if (!match) return;
      if (active) return;
      // 1h dismiss check
      const until = localStorage.getItem(DISMISS_KEY_PREFIX + match.source);
      if (until && Number(until) > Date.now()) return;
      setPending({ source: match.source, label: match.label });
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      active = true;
      unlisten?.();
    };
  }, [loggedIn]);

  if (!pending) return null;

  const dismiss = () => {
    localStorage.setItem(DISMISS_KEY_PREFIX + pending.source, String(Date.now() + 3600_000));
    setPending(null);
  };

  const accept = async () => {
    try {
      const m = await startMeeting({ source: pending.source, title: null });
      onMeetingStarted?.(m);
    } catch {
      // 失败时也清，让用户可以重新唤起
    } finally {
      setPending(null);
    }
  };

  return (
    <div className="flex items-center justify-between gap-3 border-b border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-900/40 dark:text-amber-200">
      <span>
        🎙 检测到 <strong>{pending.label}</strong> 启动 — 这次需要会议录音 + 自动转录吗？
      </span>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={accept}
          className="rounded-md bg-amber-600 px-3 py-1 text-xs text-white hover:bg-amber-700"
        >
          录制
        </button>
        <button
          type="button"
          onClick={dismiss}
          className="rounded-md border border-amber-300 px-3 py-1 text-xs hover:bg-amber-100 dark:border-amber-700 dark:hover:bg-amber-900/60"
        >
          1 小时不再问
        </button>
      </div>
    </div>
  );
}
