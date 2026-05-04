// Settings → 账号 section. Mirrors macOS AccountSettingsView's 4
// states (unauthenticated / authenticating / authenticated / error)
// and the same panels (plan badge / license row / quota bar / devices).

import { useEffect, useRef, useState } from "react";
import {
  billingCheckout,
  billingGetOrder,
  fmtCents,
  getAccountState,
  getBillingPlans,
  getDevices,
  logout,
  onAccountState,
  openPayUrl,
  reloadMe,
  reloadMeAtomic,
  selectRole,
  startLogin,
  unbindDevice,
  type AccountSnapshot,
  type CheckoutResp,
  type DeviceInfo,
  type LicenseInfo,
  type OrderInfo,
  type PlanInfo,
  type PlansCatalog,
  type QuotaInfo,
  type User,
} from "../lib/account";
import {
  fetchRoleCatalog,
  findRole,
  getCachedRoles,
  type Role,
} from "../lib/role-catalog";

export default function AccountSection() {
  const [snap, setSnap] = useState<AccountSnapshot | null>(null);
  const [devices, setDevices] = useState<DeviceInfo[] | null>(null);
  const [busy, setBusy] = useState(false);
  /// (C6) unbind device 的失败提示。null = 没失败；string = 给用户看的 toast。
  /// 单独维护而不是塞进 lastError —— lastError 是登录类错误，用户对解绑
  /// 失败的预期是「这条具体设备没解掉」，希望提示在设备列表附近。
  const [unbindError, setUnbindError] = useState("");
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
          onSwitchAccount={async () => {
            // 「换账号」= logout + 立刻拉新 desktop session 一气呵成。
            // 比让用户先点退出再点登录少一步，且明确告诉用户即将切走。
            setBusy(true);
            try {
              await logout();
              setDevices(null);
              await startLogin();
            } catch (e) {
              console.warn("switch account:", e);
            } finally {
              setBusy(false);
            }
          }}
          onUnbind={async (id) => {
            // (C6) try/catch 包起 unbind + reload —— 401/403/网络断时给
            // 用户看得到的反馈，不是默默失败。setUnbindError 会让 UI 在
            // 设备列表上方渲染一行红字。
            setUnbindError("");
            try {
              await unbindDevice(id);
              const fresh = await getDevices();
              setDevices(fresh);
            } catch (e) {
              setUnbindError(`解绑失败：${String(e)}`);
              // 还是 try 重新拉一次列表 —— 也许 unbind 实际成功了只是 reload 网断
              try {
                const fresh = await getDevices();
                setDevices(fresh);
              } catch {
                /* 静默；用户下次刷新自然会看到 */
              }
            }
          }}
          unbindError={unbindError}
          onDismissUnbindError={() => setUnbindError("")}
          busy={busy}
        />
      )}

      <div className="text-[11px] text-ink-400 leading-relaxed pt-1 space-y-0.5">
        <div>
          独立开发者运营 · <a href="https://tititalk.com" target="_blank" rel="noreferrer" className="underline">tititalk.com</a>
          ·  暂无密码找回功能，请妥善保管账号密码。
        </div>
        {/* PIPL：把隐私政策入口紧贴账号信息后面 —— 用户找数据处理说明
            的本能位置。无登录态 / 已登录态都看得见。 */}
        <div>
          <a href="https://tititalk.com/privacy" target="_blank" rel="noreferrer" className="underline">隐私政策</a>
          {" · "}
          <a href="https://tititalk.com/terms" target="_blank" rel="noreferrer" className="underline">服务条款</a>
        </div>
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
        在浏览器登录 tititalk.com 账号后，可同步设置、查看每日额度、管理已登录的设备。
      </div>
      <button
        className="px-4 py-2 rounded-md bg-ink-900 text-white text-sm hover:bg-ink-700 disabled:opacity-50"
        onClick={onLogin}
        disabled={busy}
      >
        在浏览器登录
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
  onSwitchAccount,
  onUnbind,
  unbindError,
  onDismissUnbindError,
  busy,
}: {
  user: User;
  license: LicenseInfo | null;
  quota: QuotaInfo | null;
  devices: DeviceInfo[] | null;
  onLogout: () => void;
  onSwitchAccount: () => void;
  onUnbind: (id: number) => Promise<void>;
  unbindError: string;
  onDismissUnbindError: () => void;
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
        <div className="flex items-center gap-1.5">
          <PlanBadge plan={user.plan} />
          {user.pro_unlocked_at && (
            <span className="text-xs px-2 py-0.5 rounded border font-medium bg-amber-50 text-amber-700 border-amber-200">
              专业解锁
            </span>
          )}
        </div>
      </div>

      {/* (角色身份系统 v1) 决策 #3 「改一次进 Settings」唯一入口 ——
          pill 上故意不加快捷切换。下拉切角色后立即调 cmd_role_select
          → 后端写库 → reload_me → user.role 更新到 React state。 */}
      <RoleRow user={user} />

      {license && <LicenseRow lic={license} />}
      {quota ? (
        <QuotaBar q={quota} />
      ) : (
        // (B5) quota=null 表示后台 3 次 retry 都失败。原来不显示 → 用户
        // 以为无限额。改成显式 warning + 重试，让用户至少知道「这数字
        // 可能不准」，避免误以为额度无限然后突然 429。
        <div className="flex items-center gap-2 px-3 py-2 rounded border border-amber-200 bg-amber-50 text-xs">
          <span className="text-amber-700">⚠️</span>
          <div className="flex-1">
            <div className="font-medium text-amber-800">额度信息加载失败</div>
            <div className="text-amber-700">
              可能是网络问题。功能仍可用，但显示的剩余额度可能不准。
            </div>
          </div>
          <button
            type="button"
            className="px-2 py-1 rounded bg-amber-600 text-white text-xs hover:bg-amber-700"
            onClick={() => reloadMe()}
          >
            重试
          </button>
        </div>
      )}

      <UpgradeCard />

      {unbindError && (
        <div className="flex items-start gap-2 text-xs px-3 py-2 rounded border border-red-200 bg-red-50 text-red-700">
          <span>⚠</span>
          <div className="flex-1">{unbindError}</div>
          <button
            type="button"
            className="text-red-500 hover:text-red-700"
            onClick={onDismissUnbindError}
            aria-label="关闭"
          >
            ✕
          </button>
        </div>
      )}

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

      <div className="flex items-center gap-3 pt-1 flex-wrap">
        <button
          className="px-3 py-1.5 rounded border border-ink-300 text-sm hover:bg-ink-100 disabled:opacity-50"
          onClick={onLogout}
          disabled={busy}
        >
          退出登录
        </button>
        <button
          className="px-3 py-1.5 rounded border border-ink-300 text-sm hover:bg-ink-100 disabled:opacity-50"
          onClick={onSwitchAccount}
          disabled={busy}
          title="退出当前账号 + 立刻打开浏览器登录另一个账号"
        >
          换账号
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

/// (v0.9 Editorial Chinese) 朱砂方印形 plan badge —— 壹/贰/叁号读者。
/// 跟网站定价 spine（字字珠玑/笔走龙蛇/著作等身）同序号。
/// 副标签（终身/旗舰/年订）用 monospaced caption 跟在 章 后面。
function PlanBadge({ plan }: { plan: string }) {
  const map: Record<string, { numeral: string; sub: string; tone: "ink" | "signal" }> = {
    pro_lifetime: { numeral: "叁", sub: "终身", tone: "signal" },
    pro_flagship: { numeral: "叁", sub: "旗舰", tone: "signal" },
    pro_annual:   { numeral: "贰", sub: "年订", tone: "signal" },
    free:         { numeral: "壹", sub: "免费", tone: "ink" },
  };
  const m = map[plan] || { numeral: "—", sub: plan, tone: "ink" as const };
  const fill = m.tone === "signal" ? "#D7392E" : "#7993A8";
  return (
    <span className="inline-flex items-center gap-1.5 align-middle">
      {/* 朱砂方印 SVG —— 12×12 圆角小章，篆体 numeral，单字镌刻 */}
      <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden>
        <rect x="1" y="1" width="12" height="12" rx="1.5"
              fill={fill}
              stroke={fill} strokeWidth="0.6" />
        <text x="7" y="9.8" textAnchor="middle"
              fontFamily='"Noto Serif SC","STSong",serif'
              fontSize="8.5" fontWeight="700" fill="#FFFFFF" letterSpacing="-0.4">
          {m.numeral}
        </text>
      </svg>
      <span className="font-serif text-[12px] font-medium text-ink-800">
        {m.numeral}号读者
      </span>
      <span className="font-mono text-[10px] tracking-wider text-ink-400 uppercase">
        · {m.sub}
      </span>
    </span>
  );
}

/**
 * 完全 server-driven UpgradeCard. 拉 /api/billing/plans 拿目录 + 当前用户
 * ownership，渲染购买行；点行触发 checkout (POST /api/billing/checkout) →
 * 打开浏览器扫码 → 启动 2s 轮询 /api/billing/orders/{id} → 看到 paid 拉
 * /me + license + quota 全刷一次。
 *
 * 客户端零硬编码 plan / 价格 / 文案 — 服务端 PLAN_META 改完客户端下次
 * 启动直接拿。
 */
function UpgradeCard() {
  const [catalog, setCatalog] = useState<PlansCatalog | null>(null);
  const [loadErr, setLoadErr] = useState<string>("");
  const [pending, setPending] = useState<{
    order: CheckoutResp;
    status: OrderInfo["status"];
    startedAt: number;
  } | null>(null);
  const [payErr, setPayErr] = useState<string>("");
  /// (A1/A3) 轮询连续失败 3 次后显示的「网络不稳」warning；成功一次清空。
  /// 区别于 payErr —— 那是终态错误（超时 / 下单失败 / 已解锁），这只是
  /// 中间态提示，让用户至少知道「我没死，在重试」。
  const [pollWarn, setPollWarn] = useState<string>("");
  const pollRef = useRef<number | null>(null);

  // Pull catalog on mount + whenever account state changes upstream.
  useEffect(() => {
    let cancelled = false;
    getBillingPlans()
      .then((c) => { if (!cancelled) setCatalog(c); })
      .catch((e) => { if (!cancelled) setLoadErr(String(e)); });
    return () => { cancelled = true; };
  }, []);

  // Stop polling on unmount.
  useEffect(() => {
    return () => {
      if (pollRef.current) window.clearInterval(pollRef.current);
    };
  }, []);

  const purchasable = catalog
    ? catalog.plans.filter((p) => !catalog.current_user?.owns.includes(p.code))
    : [];

  async function handleBuy(plan: PlanInfo) {
    setPayErr("");
    try {
      const order = await billingCheckout(plan.code);
      setPending({ order, status: "pending", startedAt: Date.now() });
      try { await openPayUrl(order.pay_url); } catch (e) { console.warn(e); }
      startPolling(order.order_id);
    } catch (e) {
      const msg = String(e);
      if (msg.includes("pro_already_unlocked") || msg.includes("409")) {
        setPayErr("你已是专业版，无需重复购买。");
      } else if (msg.includes("payment_provider")) {
        setPayErr("支付通道暂时不可用，请稍后再试。");
      } else {
        setPayErr("下单失败：" + msg);
      }
    }
  }

  function startPolling(orderId: number) {
    if (pollRef.current) window.clearInterval(pollRef.current);
    // (A1/A3) 轮询失败的累计计数 —— 单次失败不打扰用户，连续 ≥3 次
    // （6s 还在抖）才提示「网络不稳，重试中」。这样既不噪也不沉默。
    // FIX-30: fast 阶段 15min × 2s = 450 次；超时进 slow 阶段 30s × 60 次 = 30min。
    // 总检测窗口 45min，仍 < 服务端 Order 1h 过期。pollWarn 持续提示「正在检测」，
    // 不立即标 expired —— 让付完款的用户也能等到 webhook 自动激活。
    let consecutiveFails = 0;
    let inSlowMode = false;
    let slowStartAt = 0;
    pollRef.current = window.setInterval(async () => {
      try {
        const o = await billingGetOrder(orderId);
        consecutiveFails = 0;
        if (!inSlowMode) setPollWarn("");
        setPending((cur) => cur ? { ...cur, status: o.status } : cur);
        if (o.status === "paid") {
          stopPolling();
          // Fresh /me + catalog so plan/owns flip in UI immediately.
          // FIX-25: 用原子 snapshot 拉 me+license+quota，避免 UI 半态。
          await reloadMeAtomic();
          const fresh = await getBillingPlans();
          setCatalog(fresh);
          window.setTimeout(() => setPending(null), 1500);
          return;
        }
        if (o.status === "expired" || o.status === "failed" || o.status === "refunded") {
          stopPolling();
          return;
        }
        const elapsed = Date.now() - (pending?.startedAt ?? Date.now());
        if (!inSlowMode && elapsed > 15 * 60_000) {
          // 进入慢轮询模式：30s 一次再等 30min，共 45min 检测窗口。
          inSlowMode = true;
          slowStartAt = Date.now();
          setPollWarn("支付检测较慢（已 15 分钟）。如已付款，正继续后台检测，可点「立即检查」主动重试。");
          stopPolling();
          pollRef.current = window.setInterval(slowTick, 30000) as unknown as number;
        }
      } catch (e) {
        consecutiveFails += 1;
        console.info("billing poll:", e);
        if (consecutiveFails === 3) {
          setPollWarn("网络不稳，正在持续重试…如果你已付完款，15 分钟内会自动检测到。");
        }
      }
    }, 2000) as unknown as number;

    // 慢轮询 tick：30s 一次直到 paid / 终态 / 30min 累计超时。
    async function slowTick() {
      try {
        const o = await billingGetOrder(orderId);
        setPending((cur) => cur ? { ...cur, status: o.status } : cur);
        if (o.status === "paid") {
          stopPolling();
          // FIX-25: 用原子 snapshot 拉 me+license+quota，避免 UI 半态。
          await reloadMeAtomic();
          const fresh = await getBillingPlans();
          setCatalog(fresh);
          window.setTimeout(() => setPending(null), 1500);
          return;
        }
        if (o.status === "expired" || o.status === "failed" || o.status === "refunded") {
          stopPolling();
          return;
        }
        if (Date.now() - slowStartAt > 30 * 60_000) {
          stopPolling();
          setPayErr("订单已超过最长检测窗口（45 分钟）。如已付款请联系 hi@tititalk.com。");
        }
      } catch (e) {
        console.info("billing slow poll:", e);
      }
    }
  }

  function stopPolling() {
    if (pollRef.current) {
      window.clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }

  if (loadErr && !catalog) {
    return (
      <div className="text-xs text-ink-400">升级方案加载失败：{loadErr}</div>
    );
  }
  if (!catalog) {
    return (
      <div className="text-xs text-ink-400">加载升级方案…</div>
    );
  }
  if (purchasable.length === 0) {
    return null;
  }

  return (
    <>
      {/* (v0.9 Editorial Chinese) 订阅明信片 —— 暖黄 paper-warm 卡纸 + 朱砂
          方印 plan numeral + 仿宋大字 title + monospaced 价格栏。每张片代表一档
          订阅，点击即下单。 */}
      <div className="space-y-3">
        <div className="flex items-center gap-2 mb-1">
          <span className="font-mono text-[10px] tracking-[0.3em] text-signal-500 font-medium uppercase">
            CHAPTER · 订阅
          </span>
          <div className="flex-1 h-px bg-ink-200" />
          <span className="font-mono text-[10px] tracking-wider text-ink-400 uppercase">
            postcard subscription
          </span>
        </div>
        {payErr && (
          <div className="font-mono text-[11px] text-signal-500 bg-signal-100/40 border border-signal-500/30 rounded px-2.5 py-1.5">
            {payErr}
          </div>
        )}
        {pollWarn && !payErr && (
          <div className="font-mono text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-2.5 py-1.5">
            {pollWarn}
          </div>
        )}
        <div className="grid grid-cols-1 gap-3">
          {purchasable.map((p) => {
            const numeral = p.code === "pro_annual" ? "贰" : (p.code.startsWith("pro_") ? "叁" : "壹");
            return (
              <button
                key={p.code}
                onClick={() => handleBuy(p)}
                disabled={!!pending}
                className={
                  "group relative w-full text-left transition disabled:opacity-50 " +
                  "rounded-md border bg-paper-warm/60 hover:bg-paper-warm/90 hover:border-signal-500/50 " +
                  "shadow-[0_1px_0_rgba(0,0,0,0.04)] hover:shadow-[2px_3px_0_rgba(215,57,46,0.15)] " +
                  (p.recommended ? "border-signal-500/40" : "border-ink-200")
                }
                style={{ aspectRatio: "1.62 / 1" }}
              >
                {/* 邮票位 — 朱砂方印 plan numeral */}
                <div className="absolute top-3 right-3 w-12 h-14 flex flex-col items-center justify-between
                                border border-signal-500/40 bg-paper-warm rounded-sm">
                  <div className="font-mono text-[7px] tracking-widest text-signal-500/70 mt-1">TT</div>
                  <div className="flex-1 flex items-center justify-center">
                    <span className="font-serif text-[26px] font-bold text-signal-500 leading-none">
                      {numeral}
                    </span>
                  </div>
                  <div className="font-mono text-[6px] tracking-wider text-signal-500/50 mb-1">
                    {p.code === "pro_annual" ? "ANN" : p.code.startsWith("pro_") ? "PRO" : "FREE"}
                  </div>
                </div>

                {/* 内容 */}
                <div className="p-5 pr-20 h-full flex flex-col justify-between">
                  <div>
                    <div className="flex items-center gap-2 mb-2">
                      <span className="font-mono text-[9px] tracking-[0.25em] text-signal-500 uppercase font-medium">
                        {numeral}号订阅
                      </span>
                      {p.recommended && (
                        <span className="font-mono text-[9px] tracking-wider px-1.5 py-px rounded-sm bg-signal-500 text-white">
                          推荐
                        </span>
                      )}
                    </div>
                    <div className="font-serif text-[20px] font-medium text-ink-900 leading-snug">
                      {p.title}
                    </div>
                    <div className="text-[12px] text-ink-500 mt-1 leading-relaxed line-clamp-2">
                      {p.subtitle}
                    </div>
                  </div>
                  <div className="flex items-end justify-between mt-3">
                    {p.features.length > 0 && (
                      <div className="text-[11px] text-ink-500 leading-relaxed flex-1 mr-3">
                        {p.features.slice(0, 2).map((f, i) => (
                          <div key={i} className="font-serif">· {f}</div>
                        ))}
                      </div>
                    )}
                    <div className="text-right shrink-0">
                      <div className="font-serif text-[28px] font-semibold text-ink-900 tabular-nums leading-none">
                        ¥{(p.price_cents / 100).toFixed(0)}
                      </div>
                      <div className="font-mono text-[10px] tracking-wider text-signal-500 mt-1 uppercase group-hover:underline">
                        立即升级 →
                      </div>
                    </div>
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {pending && (
        <PaymentDialog
          pending={pending}
          onClose={() => { stopPolling(); setPending(null); }}
          onReopen={() => openPayUrl(pending.order.pay_url)}
          onForceCheck={async () => {
            try {
              const o = await billingGetOrder(pending.order.order_id);
              setPending((cur) => cur ? { ...cur, status: o.status } : cur);
              if (o.status === "paid") {
                stopPolling();
                await reloadMe();
                const fresh = await getBillingPlans();
                setCatalog(fresh);
                window.setTimeout(() => setPending(null), 1500);
              }
            } catch (e) {
              console.warn(e);
            }
          }}
        />
      )}
    </>
  );
}

function PaymentDialog({
  pending,
  onClose,
  onReopen,
  onForceCheck,
}: {
  pending: { order: CheckoutResp; status: OrderInfo["status"]; startedAt: number };
  onClose: () => void;
  onReopen: () => void;
  onForceCheck: () => void;
}) {
  const { order, status } = pending;
  const isPaid = status === "paid";
  const isFailed = status === "expired" || status === "failed" || status === "refunded";
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-white rounded-lg shadow-xl w-[460px] max-w-[92vw] p-5 space-y-4">
        <div className="flex items-start gap-3">
          <div className={
            "w-9 h-9 rounded-full flex items-center justify-center text-white text-lg " +
            (isPaid ? "bg-emerald-500" : isFailed ? "bg-red-500" : "bg-indigo-500")
          }>
            {isPaid ? "✓" : isFailed ? "!" : "¥"}
          </div>
          <div className="flex-1">
            <div className="font-medium text-ink-900">{order.plan}</div>
            <div className="text-sm text-ink-500 tabular-nums">
              ¥{(order.total_fee_cents / 100).toFixed(2)}
            </div>
          </div>
          <span className={
            "text-[10px] px-2 py-0.5 rounded font-medium " +
            (isPaid
              ? "bg-emerald-50 text-emerald-700 border border-emerald-200"
              : isFailed
                ? "bg-red-50 text-red-700 border border-red-200"
                : "bg-amber-50 text-amber-700 border border-amber-200")
          }>
            {status === "pending" ? "等待支付" : status === "paid" ? "已付款" : status}
          </span>
        </div>

        <div className="border-t border-ink-100 pt-3">
          {status === "pending" && (
            <>
              <div className="text-sm text-ink-700">
                已在浏览器打开微信 / 支付宝扫码页 — 完成付款后这里会自动确认。
              </div>
              <div className="text-xs text-ink-500 mt-2 leading-relaxed">
                订单 1 小时有效。付完款 2-5 秒内会自动检测；如果一直没动静，按「立即检查」。
              </div>
            </>
          )}
          {isPaid && (
            <div className="text-sm text-emerald-700">
              支付成功 — 已为你刷新 plan / 解锁状态。
            </div>
          )}
          {isFailed && (
            <div className="text-sm text-red-700">
              订单未完成（{status}）。请重新发起，或联系 hi@tititalk.com。
            </div>
          )}
        </div>

        <div className="flex items-center gap-2 pt-1">
          {status === "pending" ? (
            <>
              <button
                className="px-3 py-1.5 rounded border border-ink-300 text-sm hover:bg-ink-50"
                onClick={onClose}
              >取消</button>
              <div className="flex-1" />
              <button
                className="px-3 py-1.5 rounded border border-ink-300 text-sm hover:bg-ink-50"
                onClick={onReopen}
              >重新打开支付页</button>
              <button
                className="px-3 py-1.5 rounded bg-indigo-600 text-white text-sm hover:bg-indigo-700"
                onClick={onForceCheck}
              >已付款，立即检查</button>
            </>
          ) : (
            <>
              <div className="flex-1" />
              <button
                className="px-3 py-1.5 rounded bg-indigo-600 text-white text-sm hover:bg-indigo-700"
                onClick={onClose}
              >{isPaid ? "完成" : "关闭"}</button>
            </>
          )}
        </div>
      </div>
    </div>
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

/// (角色身份系统 v1) Settings 里的角色行。catalog 进入时拉一次 + localStorage
/// 7d cache 兜底。下拉选角色立即提交，成功 toast，失败 toast。
function RoleRow({ user }: { user: User }) {
  const [roles, setRoles] = useState<Role[]>(() => getCachedRoles());
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<string>("");

  useEffect(() => {
    fetchRoleCatalog().then((list) => setRoles(list));
  }, []);

  const current = findRole(user.role, roles);
  const label = current
    ? `${current.emoji} ${current.title}`
    : user.role
    ? user.role
    : "尚未选择";

  async function pick(roleId: string) {
    if (busy) return;
    setBusy(true);
    setFeedback("");
    try {
      await selectRole(roleId);
      setFeedback("已更新");
    } catch (e) {
      setFeedback(`失败：${String(e)}`);
    } finally {
      setBusy(false);
      setTimeout(() => setFeedback(""), 2500);
    }
  }

  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="text-ink-500">角色身份</span>
      <span className="text-ink-700">{label}</span>
      <div className="flex-1" />
      {feedback && <span className="text-ink-400 text-[11px]">{feedback}</span>}
      <select
        className="text-xs px-2 py-1 rounded border border-ink-200 bg-white disabled:opacity-50"
        value={user.role ?? ""}
        disabled={busy || roles.length === 0}
        onChange={(e) => {
          const v = e.target.value;
          if (v && v !== user.role) pick(v);
        }}
      >
        {!user.role && <option value="">(请选择)</option>}
        {roles.map((r) => (
          <option key={r.id} value={r.id}>
            {r.emoji} {r.title}
          </option>
        ))}
      </select>
    </div>
  );
}

/// 把 ISO8601 reset_at 翻成本地「今天 00:00 / 明天 00:30」。
/// 用户读取 quota「明天 0 点」抽象，看到具体时间更踏实。
function fmtResetAt(iso: string | null | undefined): string {
  if (!iso) return "次日 0 点重置";
  const t = new Date(iso);
  if (isNaN(t.getTime())) return "次日 0 点重置";
  const now = new Date();
  const sameDay =
    t.getFullYear() === now.getFullYear() &&
    t.getMonth() === now.getMonth() &&
    t.getDate() === now.getDate();
  const hh = t.getHours().toString().padStart(2, "0");
  const mm = t.getMinutes().toString().padStart(2, "0");
  return `${sameDay ? "今天" : "明天"} ${hh}:${mm} 重置`;
}

function QuotaBar({ q }: { q: QuotaInfo }) {
  const resetCopy = fmtResetAt(q.reset_at);
  // 优先 token 口径（v0.6+）。0.1s 说话 ≈ 1 token，10 token ≈ 1 秒录音。
  const hasTokens = q.limit_tokens != null && q.used_tokens != null && q.remaining_tokens != null;
  if (hasTokens) {
    const used = q.used_tokens!;
    const limit = Math.max(1, q.limit_tokens!);
    const remaining = q.remaining_tokens!;
    const pct = Math.min(1, used / limit);
    const empty = remaining === 0;
    return (
      <div>
        <div className="flex items-center justify-between text-xs">
          <span className="font-medium text-ink-700">今日剩余额度</span>
          <span className={"tabular-nums " + (empty ? "text-red-600" : "text-ink-900")}>
            还能录约 {fmtTokenSeconds(remaining)}
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
        {empty ? (
          <div className="text-[11px] text-ink-500 mt-1">
            今日额度用完了。可以升级专业版，或切到本地引擎 / 自带 API 密钥继续录。{resetCopy}。
          </div>
        ) : pct > 0.8 ? (
          <div className="text-[11px] text-ink-500 mt-1">
            快用完了：还能录约 {fmtTokenSeconds(remaining)}。{resetCopy}。
          </div>
        ) : (
          <div className="text-[11px] text-ink-400 mt-1">{resetCopy}。</div>
        )}
      </div>
    );
  }
  // 旧 cents 口径（兼容）。
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
      {empty ? (
        <div className="text-[11px] text-ink-500 mt-1">
          今日额度用完了，已自动切到本地引擎继续录。{resetCopy}。
        </div>
      ) : (
        <div className="text-[11px] text-ink-400 mt-1">{resetCopy}。</div>
      )}
    </div>
  );
}

function fmtTokenSeconds(tokens: number): string {
  const secs = Math.max(0, Math.floor(tokens / 10));
  if (secs >= 60) {
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return s === 0 ? `${m} 分钟` : `${m}分${s}秒`;
  }
  return `${secs} 秒`;
}

function prettyDate(iso: string): string {
  try {
    return new Date(iso).toISOString().slice(0, 10);
  } catch {
    return iso;
  }
}
