// Settings → 账号 section. Mirrors macOS AccountSettingsView's 4
// states (unauthenticated / authenticating / authenticated / error)
// and the same panels (plan badge / license row / quota bar / devices).

import { useEffect, useState } from "react";
import {
  fmtCents,
  getAccountState,
  getDevices,
  logout,
  onAccountState,
  startLogin,
  unbindDevice,
  type AccountSnapshot,
  type DeviceInfo,
  type LicenseInfo,
  type QuotaInfo,
  type User,
} from "../lib/account";

export default function AccountSection() {
  const [snap, setSnap] = useState<AccountSnapshot | null>(null);
  const [devices, setDevices] = useState<DeviceInfo[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>("");

  useEffect(() => {
    getAccountState().then(setSnap).catch((e) => setError(String(e)));
    const un = onAccountState((s) => setSnap(s));
    return () => {
      un.then((fn) => fn());
    };
  }, []);

  // Fetch devices once we hit authenticated; refetch when account state flips.
  useEffect(() => {
    if (snap?.state.kind === "authenticated") {
      getDevices().then(setDevices).catch((e) => console.warn("devices:", e));
    } else {
      setDevices(null);
    }
  }, [snap?.state.kind]);

  if (!snap) {
    return <div className="text-sm text-ink-400">加载账号状态…</div>;
  }

  const { state, license, quota } = snap;

  return (
    <div className="space-y-4">
      {state.kind === "unauthenticated" && (
        <UnauthenticatedView
          onLogin={async () => {
            setBusy(true);
            setError("");
            try {
              await startLogin();
            } catch (e) {
              setError(String(e));
            } finally {
              setBusy(false);
            }
          }}
          busy={busy}
          error={error}
        />
      )}

      {state.kind === "authenticating" && <AuthenticatingView />}

      {state.kind === "error" && (
        <ErrorView
          message={state.message}
          onRetry={async () => {
            setBusy(true);
            try {
              await startLogin();
            } catch (e) {
              setError(String(e));
            } finally {
              setBusy(false);
            }
          }}
        />
      )}

      {state.kind === "authenticated" && (
        <AuthenticatedView
          user={state.user}
          license={license}
          quota={quota}
          devices={devices}
          onLogout={async () => {
            setBusy(true);
            try {
              await logout();
              setDevices(null);
            } finally {
              setBusy(false);
            }
          }}
          onUnbind={async (id) => {
            await unbindDevice(id);
            const fresh = await getDevices();
            setDevices(fresh);
          }}
          busy={busy}
        />
      )}

      <div className="text-[11px] text-ink-400 leading-relaxed pt-1">
        独立开发者运营 · <a href="https://tititalk.com" target="_blank" rel="noreferrer" className="underline">tititalk.com</a>
        ·  没有找回流程，请妥善保管账号密码。
      </div>
    </div>
  );
}

function UnauthenticatedView({
  onLogin,
  busy,
  error,
}: {
  onLogin: () => void;
  busy: boolean;
  error: string;
}) {
  return (
    <div>
      <div className="font-medium text-ink-900">尚未登录</div>
      <div className="text-sm text-ink-500 mt-1 mb-3">
        登录 tititalk.com 后可使用云端配置同步、Pro 计费和多设备管理。
      </div>
      <button
        className="px-4 py-2 rounded-md bg-ink-900 text-white text-sm hover:bg-ink-700 disabled:opacity-50"
        onClick={onLogin}
        disabled={busy}
      >
        登录 tititalk.com
      </button>
      {error && <div className="text-sm text-red-600 mt-2">{error}</div>}
    </div>
  );
}

function AuthenticatingView() {
  return (
    <div>
      <div className="flex items-center gap-2 text-sm">
        <span className="inline-block w-3 h-3 rounded-full border-2 border-ink-300 border-t-ink-900 animate-spin" />
        <span>已在浏览器打开登录页，请完成登录…</span>
      </div>
      <div className="text-xs text-ink-400 mt-1">
        登录完成后浏览器会自动跳回 TiTiTalk。如果 10 分钟内未完成，请重新发起。
      </div>
    </div>
  );
}

function ErrorView({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div>
      <div className="text-sm text-red-700">{message}</div>
      <button
        className="mt-2 px-3 py-1.5 rounded border border-ink-300 text-sm hover:bg-ink-100"
        onClick={onRetry}
      >
        重试
      </button>
      {message.includes("dashboard/devices") && (
        <a
          href="https://tititalk.com/dashboard/devices"
          target="_blank"
          rel="noreferrer"
          className="ml-2 text-sm text-ink-600 underline"
        >
          打开设备管理 ↗
        </a>
      )}
    </div>
  );
}

function AuthenticatedView({
  user,
  license,
  quota,
  devices,
  onLogout,
  onUnbind,
  busy,
}: {
  user: User;
  license: LicenseInfo | null;
  quota: QuotaInfo | null;
  devices: DeviceInfo[] | null;
  onLogout: () => void;
  onUnbind: (id: number) => Promise<void>;
  busy: boolean;
}) {
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-full bg-ink-200 flex items-center justify-center text-ink-700 text-base font-medium">
          {(user.display_name || user.username).slice(0, 1).toUpperCase()}
        </div>
        <div className="flex-1">
          <div className="font-medium text-ink-900">
            {user.display_name || user.username}
          </div>
          <div className="text-xs text-ink-400">@{user.username}</div>
        </div>
        <PlanBadge plan={user.plan} />
      </div>

      {license && <LicenseRow lic={license} />}
      {user.plan === "free" && quota && <QuotaBar q={quota} />}

      {devices && devices.length > 0 && (
        <div>
          <div className="text-xs font-medium text-ink-500 mb-2">设备列表</div>
          <ul className="border border-ink-200 rounded divide-y divide-ink-200">
            {devices.map((d) => (
              <li key={d.id} className="flex items-center px-3 py-2 text-sm">
                <div className="flex-1">
                  <span className="text-ink-900">{d.device_name || "未命名设备"}</span>
                  {d.is_current && (
                    <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-700 border border-emerald-200">
                      本机
                    </span>
                  )}
                  <span className="ml-2 text-xs text-ink-400">{d.platform || "?"}</span>
                </div>
                {!d.is_current && (
                  <button
                    className="text-xs text-red-600 hover:underline"
                    onClick={() => onUnbind(d.id)}
                  >
                    解绑
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="flex items-center gap-3 pt-1">
        <button
          className="px-3 py-1.5 rounded border border-ink-300 text-sm hover:bg-ink-100 disabled:opacity-50"
          onClick={onLogout}
          disabled={busy}
        >
          退出登录
        </button>
        <a
          href="https://tititalk.com/dashboard"
          target="_blank"
          rel="noreferrer"
          className="text-sm text-ink-500 hover:text-ink-900 underline"
        >
          打开 dashboard ↗
        </a>
      </div>
    </div>
  );
}

function PlanBadge({ plan }: { plan: string }) {
  const map: Record<string, { label: string; cls: string }> = {
    pro_lifetime: { label: "终身", cls: "bg-purple-50 text-purple-700 border-purple-200" },
    pro_annual: { label: "Pro", cls: "bg-indigo-50 text-indigo-700 border-indigo-200" },
    free: { label: "免费 ¥1/天", cls: "bg-ink-100 text-ink-600 border-ink-200" },
  };
  const m = map[plan] || { label: plan, cls: "bg-ink-100 text-ink-600 border-ink-200" };
  return (
    <span className={"text-xs px-2 py-0.5 rounded border font-medium " + m.cls}>
      {m.label}
    </span>
  );
}

function LicenseRow({ lic }: { lic: LicenseInfo }) {
  return (
    <div className="text-xs text-ink-500">
      已绑定 {lic.device_count} / {lic.device_limit} 台设备
      {lic.expires_at && lic.plan !== "pro_lifetime" && (
        <> · 到期 {prettyDate(lic.expires_at)}</>
      )}
    </div>
  );
}

function QuotaBar({ q }: { q: QuotaInfo }) {
  const used = q.used_cents;
  const limit = Math.max(1, q.limit_cents ?? 100);
  const remaining = q.remaining_cents ?? 0;
  const pct = Math.min(1, used / limit);
  const empty = remaining === 0;
  return (
    <div>
      <div className="flex items-center justify-between text-xs">
        <span className="font-medium text-ink-700">今日云额度</span>
        <span className={"tabular-nums " + (empty ? "text-red-600" : "text-ink-900")}>
          {fmtCents(remaining)} / {fmtCents(q.limit_cents)}
        </span>
      </div>
      <div className="mt-1 h-2 rounded bg-ink-100 overflow-hidden">
        <div
          className={
            "h-full " +
            (empty ? "bg-red-500" : pct > 0.8 ? "bg-amber-500" : "bg-ink-700")
          }
          style={{ width: `${pct * 100}%` }}
        />
      </div>
      {empty && (
        <div className="text-[11px] text-ink-500 mt-1">
          今日额度用完，云调用已自动降级到本地。明天 0 点重置。
        </div>
      )}
    </div>
  );
}

function prettyDate(iso: string): string {
  try {
    return new Date(iso).toISOString().slice(0, 10);
  } catch {
    return iso;
  }
}
