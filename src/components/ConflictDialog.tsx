// Modal for the §9.6 step 3 cloud config conflict — pops over any tab.
// Listens for `cloud-config-conflict` from the Rust sync engine, shows
// 3 options (保留本地 / 用云端 / 合并), routes user choice back via
// `cmd_account_resolve_conflict`. Mirror of macOS ConflictResolutionView.

import { useEffect, useState } from "react";
import {
  onConflict,
  resolveConflict,
  type ConflictAction,
  type ConflictPayload,
} from "../lib/account";

export default function ConflictDialog() {
  const [payload, setPayload] = useState<ConflictPayload | null>(null);
  const [resolving, setResolving] = useState(false);

  useEffect(() => {
    const un = onConflict((p) => setPayload(p));
    return () => {
      un.then((fn) => fn());
    };
  }, []);

  if (!payload) return null;

  const dictDiff = arrayDiff(
    asStringList(payload.local["dictionaries"]),
    asStringList(payload.cloud["dictionaries"]),
  );
  const personaDiff = mapKeyDiff(
    payload.local["polish_prompts"],
    payload.cloud["polish_prompts"],
  );

  async function pick(action: ConflictAction) {
    setResolving(true);
    try {
      await resolveConflict(action);
      setPayload(null);
      // FIX-23 (qa-2026-05-03): 解决冲突后广播刷新——SettingsSheet / 各
      // useConfig hook 监听这个事件后重新拉一遍 cmd_get_config，立马显示
      // 新值，不需用户手动关再开 (WIN-006)。
      window.dispatchEvent(new CustomEvent("titi:config-changed"));
    } catch (e) {
      console.error("resolveConflict:", e);
    } finally {
      setResolving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-white rounded-lg shadow-xl w-[460px] max-w-[92vw] p-6 space-y-4">
        <div className="flex items-start gap-3">
          <div className="text-xl">☁️</div>
          <div className="flex-1">
            <div className="font-semibold text-ink-900">云端配置有更新</div>
            <div className="text-xs text-ink-500 mt-0.5">
              另一台设备改过配置后云端版本前进了。请选择如何处理：
            </div>
          </div>
        </div>

        <div className="rounded border border-ink-200 bg-ink-50 p-3 text-xs space-y-1">
          <div className="text-ink-500 mb-1">差异概览</div>
          <DiffRow label="词典" localOnly={dictDiff.localOnly} cloudOnly={dictDiff.cloudOnly} />
          <DiffRow
            label="润色 prompts"
            localOnly={personaDiff.localOnly}
            cloudOnly={personaDiff.cloudOnly}
          />
          <DiffRow label="其他偏好" localOnly={0} cloudOnly={0} trailing="云端为主（合并模式下整体覆盖）" />
        </div>

        <div className="space-y-2">
          <ChoiceRow
            icon="💻"
            title="保留本地（覆盖云端）"
            body="本机当前的设置写入云端，其他设备下次启动会拉到这套。"
            onClick={() => pick("keep_local")}
            disabled={resolving}
          />
          <ChoiceRow
            icon="☁️"
            title="用云端（覆盖本机）"
            body="拉云端版本到本机；本机未保存的改动会丢。"
            onClick={() => pick("use_cloud")}
            disabled={resolving}
          />
          <ChoiceRow
            icon="🔀"
            title="合并（推荐）"
            body="词典和润色 prompts 取并集（云端为主，本地新条目追加），其他偏好以云端为准。"
            onClick={() => pick("merge")}
            disabled={resolving}
            highlight
          />
        </div>
      </div>
    </div>
  );
}

function ChoiceRow({
  icon,
  title,
  body,
  onClick,
  disabled,
  highlight,
}: {
  icon: string;
  title: string;
  body: string;
  onClick: () => void;
  disabled: boolean;
  highlight?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={
        "w-full text-left p-3 rounded border transition disabled:opacity-50 " +
        (highlight
          ? "border-emerald-400 bg-emerald-50 hover:bg-emerald-100"
          : "border-ink-300 hover:bg-ink-50")
      }
    >
      <div className="flex items-start gap-2">
        <div className="text-base leading-none mt-0.5">{icon}</div>
        <div className="flex-1">
          <div className="text-sm font-medium text-ink-900">{title}</div>
          <div className="text-xs text-ink-500 mt-0.5">{body}</div>
        </div>
      </div>
    </button>
  );
}

function DiffRow({
  label,
  localOnly,
  cloudOnly,
  trailing,
}: {
  label: string;
  localOnly: number;
  cloudOnly: number;
  trailing?: string;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-24 text-ink-700">{label}</span>
      {localOnly > 0 || cloudOnly > 0 ? (
        <span className="text-ink-500">
          本地独有 {localOnly} · 云端独有 {cloudOnly}
        </span>
      ) : (
        <span className="text-ink-400">{trailing || "无差异"}</span>
      )}
    </div>
  );
}

function asStringList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string");
}

function arrayDiff(local: string[], cloud: string[]) {
  const l = new Set(local);
  const c = new Set(cloud);
  let lOnly = 0;
  let cOnly = 0;
  for (const x of l) if (!c.has(x)) lOnly++;
  for (const x of c) if (!l.has(x)) cOnly++;
  return { localOnly: lOnly, cloudOnly: cOnly };
}

function mapKeyDiff(local: unknown, cloud: unknown) {
  const lk = isObject(local) ? Object.keys(local) : [];
  const ck = isObject(cloud) ? Object.keys(cloud) : [];
  const ls = new Set(lk);
  const cs = new Set(ck);
  let lOnly = 0;
  let cOnly = 0;
  for (const k of ls) if (!cs.has(k)) lOnly++;
  for (const k of cs) if (!ls.has(k)) cOnly++;
  return { localOnly: lOnly, cloudOnly: cOnly };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
