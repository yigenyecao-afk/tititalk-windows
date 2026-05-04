import { useEffect, useMemo, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import {
  checkMicrophone,
  clearHistory,
  forceCancel,
  forceStart,
  forceStop,
  getConfig,
  getHistoryRecent,
  onPipeline,
  openMicSettings,
  saveConfig,
  VK_CHOICES,
} from "./lib/api";
import type { AppConfig, PipelineEvent, PipelinePhase } from "./lib/types";
import {
  checkForUpdate,
  downloadAndInstall,
  restart,
  type UpdateStatus,
} from "./lib/updater";
import ConflictDialog from "./components/ConflictDialog";
import SettingsSheet from "./components/SettingsSheet";
import AccountSheet from "./components/AccountSheet";
import OnboardingRoleSheet from "./components/OnboardingRoleSheet";
import HistoryQuotaBanner from "./components/HistoryQuotaBanner";
import {
  getAccountState,
  isProUnlocked,
  onAccountState,
  startLogin,
  type AccountSnapshot,
} from "./lib/account";

/// (v0.7.5) Typeless 风 IA — 侧栏只 2 项核心入口（首页/历史），
/// 账户/设置/帮助沉到侧栏底部 toolbar 弹 sheet。
type Tab = "home" | "history";

export default function App() {
  const [tab, setTab] = useState<Tab>("home");
  const [showSettings, setShowSettings] = useState(false);
  const [showAccount, setShowAccount] = useState(false);
  const [cfg, setCfg] = useState<AppConfig | null>(null);
  const [recent, setRecent] = useState<{ at: string; text: string }[]>([]);
  const [statusLine, setStatusLine] = useState<string>("待命中");
  const [phase, setPhase] = useState<PipelinePhase>("idle");
  const [lastError, setLastError] = useState<string>("");
  /// Transient soft toast — auto-clears after 3s. Used for graceful
  /// degradations (stylist failed but raw inserted; hotkey pressed while
  /// logged out). Distinct from `lastError` which sticks until the next
  /// successful session.
  const [notice, setNotice] = useState<string>("");
  const [update, setUpdate] = useState<UpdateStatus>({ state: "idle" });
  /// Set when the most recent ASR call returned 402 pro_locked or 429
  /// quota_exceeded. Renders a sticky UpgradeBanner above the app body
  /// with a one-click jump to the pricing page. Cleared by the user
  /// (✕ button) or when the next session succeeds.
  const [upgrade, setUpgrade] = useState<UpgradeReason | null>(null);
  /// Mirror of the Rust-side AccountSnapshot. Drives `isProUnlocked` in the
  /// Settings pane (gates the BYOK options) + plan badges in HomePane.
  const [account, setAccount] = useState<AccountSnapshot | null>(null);
  /// 运行时拉的真实版本号（来自 Tauri bundle）—— 比硬编码 const 可靠，
  /// 之前 const VERSION 跟 package.json/Cargo.toml/tauri.conf.json 四头
  /// 不同步过一次，发新版后 UI 还显示旧号。
  const [version, setVersion] = useState<string>("");

  useEffect(() => {
    getConfig().then(setCfg).catch((e) => console.error(e));
    getAccountState().then(setAccount).catch((e) => console.error(e));
    getVersion().then(setVersion).catch((e) => console.warn("getVersion:", e));
    // FIX-23 (qa-2026-05-03): ConflictDialog 解冲突后会 dispatch
    // titi:request-config-reload，这里重新拉 cfg → 通过 prop 流回 SettingsSheet
    // 让 sheet 在打开时也实时刷 (WIN-006)。
    const reloadHandler = () => {
      getConfig().then(setCfg).catch((e) => console.error("reload cfg:", e));
    };
    window.addEventListener("titi:request-config-reload", reloadHandler);
    // 启动时拉持久化历史（最近 50 条）—— transcript 增量再走 onPipeline。
    getHistoryRecent(50)
      .then((items) => setRecent(items.map((it) => ({ at: it.at, text: it.text }))))
      .catch((e) => console.warn("history load:", e));
    const accountUn = onAccountState(setAccount);
    const un = onPipeline((ev: PipelineEvent) => {
      if (ev.kind === "phase") {
        setPhase(ev.phase);
        setStatusLine(phaseLabel(ev.phase));
        // (v0.7.3 audit fix) lastError 只在「新 session 开始」(recording) 时清。
        // 之前还在 transcribing 时也清 → 录音中途音频设备断开 / 网络飘的 Error
        // 在松手瞬间被擦掉，用户只看到「success」假象。Notice transient toast
        // 仍 3.5s 自动消，错误 Banner 留到下一次成功开始为止。
        if (ev.phase === "recording") {
          setLastError("");
        }
      } else if (ev.kind === "partial") {
        // (v0.7.6) 流式 ASR 进行中文本 — 顶部状态条实时显示，跟 pill 跑马灯一致
        setStatusLine("识别中：" + ev.text.slice(0, 30));
      } else if (ev.kind === "transcript") {
        setRecent((r) => [{ at: new Date().toISOString(), text: ev.text }, ...r].slice(0, 50));
        setStatusLine("已转写：" + ev.text.slice(0, 30));
        setUpgrade(null); // success — clear any stale upgrade banner
        // (v0.7.5 lastError-stale fix) transcript 成功也清 lastError —— 跟 Mac
        // 2.10.25 同源 fix。原版 lastError 只在 phase=recording 清，但用户做完
        // 一次失败后停顿不立即录下一段，banner 永久挂着「润色超时」之类旧文。
        // 一次成功 transcript 是「上一次的烦恼已过去」最强信号。
        setLastError("");
      } else if (ev.kind === "error") {
        setStatusLine("错误：" + ev.message);
        setLastError(ev.message);
        const reason = detectUpgradeReason(ev.message);
        if (reason) setUpgrade(reason);
        // (v0.7.5 lastError-stale fix) error banner 8s 自动消，跟 Mac 2.10.25
        // scheduleErrorAutoClear 同口径。用户没立即录下一段也别让红色文案挂着。
        // 新 error 来时旧 timeout 仍然 fire 但 setLastError(cur=>...) 用最新值
        // 比对，旧 timeout 不会误清新错误。
        const errMsg = ev.message;
        window.setTimeout(() => {
          setLastError((cur) => (cur === errMsg ? "" : cur));
        }, 8000);
      } else if (ev.kind === "notice") {
        setNotice(ev.message);
        setStatusLine(ev.message);
        // Auto-clear so the toast doesn't stick. 3.5s = standard read time.
        // Each new notice resets the timer (latest msg wins) by replacing
        // the visible text; the older timer still fires but `setNotice("")`
        // is no-op if `notice` already changed past that point.
        window.setTimeout(() => {
          setNotice((cur) => (cur === ev.message ? "" : cur));
        }, 3500);
      } else if (ev.kind === "sound") {
        // 后端在 Recording / Stopping 转换时发；frontend 拦 cfg 决定是否真播。
        // 用 setCfg 当时的最新值（cfg 在闭包里是初始 null，必须用 ref-style）
        // —— 这里用 functional setCfg 同步读，不引入额外 state hook。
        setCfg((cur) => {
          if (cur && cur.sound_feedback_enabled) {
            playFeedbackTone(ev.sound, cur.sound_feedback_volume);
          }
          return cur;
        });
      }
    });
    // Check for update on launch (silent if up-to-date or offline)
    checkForUpdate().then(setUpdate);
    return () => {
      un.then((fn) => fn());
      accountUn.then((fn) => fn());
      // FIX-23: 清 conflict reload 监听
      window.removeEventListener("titi:request-config-reload", reloadHandler);
    };
  }, []);

  // (v0.8.3 P0-3) ESC 取消录音/转写。独立 useEffect 跟着 cfg.esc_cancel + phase
  // 重新挂，闭包永远拿到最新值。聚焦输入框时不吞 ESC（用户日常关弹窗仍可用）。
  useEffect(() => {
    if (!cfg?.esc_cancel) return;
    const busy = phase !== "idle" && phase !== "done" && phase !== "failed";
    if (!busy) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      e.preventDefault();
      forceCancel().catch((err) => console.warn("ESC cancel:", err));
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [cfg?.esc_cancel, phase]);

  const proUnlocked = isProUnlocked(account);

  if (!cfg) return <div className="p-10 text-ink-500">加载中…</div>;

  // First-launch gate — TiTiTalk's core feature is cloud ASR + cloud
  // settings sync, both of which need an account. Until login completes
  // we show a full-screen welcome instead of letting the user wander
  // into a half-broken main UI. Account state arrives async via
  // `getAccountState() + onAccountState`; we render a minimal "loading"
  // screen until the first snapshot lands so we don't flash the welcome
  // screen at someone who's actually already logged in.
  const isAuthed = account?.state.kind === "authenticated";
  if (!isAuthed) {
    return (
      <div className="min-h-screen flex flex-col">
        <UpdateBanner status={update} setStatus={setUpdate} />
        <ConflictDialog />
        <WelcomeGate account={account} version={version} />
      </div>
    );
  }

  // (角色身份系统 v1) authenticated 但 user.role 为 null —— 老用户没做过
  // onboarding 或新注册。决策 #1 强制选不能跳过：全屏 hijack OnboardingRoleSheet
  // 接管整个 UI，等 cmd_role_select 成功 → reload_me → 这里 user.role 不再是
  // null → 自动切到主界面（无需手动 close）。
  const authedUser =
    account!.state.kind === "authenticated" ? account!.state.user : null;
  if (authedUser && authedUser.role == null) {
    return (
      <div className="min-h-screen flex flex-col">
        <UpdateBanner status={update} setStatus={setUpdate} />
        <ConflictDialog />
        <OnboardingRoleSheet />
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col">
      <UpdateBanner status={update} setStatus={setUpdate} />
      {upgrade && <UpgradeBanner reason={upgrade} onDismiss={() => setUpgrade(null)} />}
      <ConflictDialog />
      <NoticeToast message={notice} />
      <div className="flex-1 flex">
      <aside className="w-56 shrink-0 border-r border-ink-200 bg-white flex flex-col">
        {/* 品牌头：logo + 名字 + plan chip */}
        <div className="px-5 pt-5 pb-3 flex items-center gap-2">
          <img
            src="/logo-mark.png"
            alt="TiTiTalk"
            className="w-6 h-6 rounded-md"
            draggable={false}
          />
          <span className="text-base font-bold text-ink-900">TiTiTalk</span>
          <span className="ml-auto text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-ink-100 text-ink-500">
            {planChip(account)}
          </span>
        </div>
        <nav className="px-2 mt-1 space-y-1 flex-1">
          <NavBtn active={tab === "home"} onClick={() => setTab("home")}>首页</NavBtn>
          <NavBtn active={tab === "history"} onClick={() => setTab("history")}>历史记录</NavBtn>
        </nav>

        {/* 状态指示器 */}
        <div className="px-3 pb-2">
          <div className={"flex items-center gap-1.5 text-[11px] " + (
            phase === "recording" ? "text-red-600" :
            phase === "failed" ? "text-red-500" :
            phase === "done" ? "text-emerald-600" :
            "text-ink-400"
          )}>
            <span className={"inline-block w-1.5 h-1.5 rounded-full " + (
              phase === "recording" ? "bg-red-500 animate-pulse" :
              phase === "failed" ? "bg-red-400" :
              phase === "done" ? "bg-emerald-500" :
              phase === "idle" ? "bg-ink-300" : "bg-indigo-400"
            )} />
            <span className="truncate">{statusLine}</span>
          </div>
        </div>

        {/* 底部 icon-only toolbar：账户 / 设置 / 帮助 — 跟 Mac TypelessSettingsSheet 入口对齐 */}
        <div className="px-3 py-2.5 border-t border-ink-200 bg-ink-50/60 flex items-center gap-3">
          <SidebarIconBtn
            icon="👤"
            tooltip="账户与计费"
            onClick={() => setShowAccount(true)}
          />
          <SidebarIconBtn
            icon="⚙"
            tooltip="设置"
            onClick={() => setShowSettings(true)}
          />
          <SidebarIconBtn
            icon="?"
            tooltip="帮助与反馈"
            onClick={() => window.open("https://tititalk.com/docs", "_blank")}
          />
          <span className="ml-auto text-[10px] text-ink-400">v{version || "…"}</span>
        </div>
      </aside>
      <main className="flex-1 overflow-y-auto bg-ink-50/30">
        {tab === "home" && (
          <div className="p-8">
            <HomePane
              cfg={cfg}
              account={account}
              phase={phase}
              lastError={lastError}
              recent={recent}
              onGoSettings={() => setShowSettings(true)}
              onGoAccount={() => setShowAccount(true)}
              onGoHistory={() => setTab("history")}
              onDismissError={() => setLastError("")}
              onPatchCfg={async (patch) => {
                const next = { ...cfg, ...patch };
                try {
                  await saveConfig(next);
                  setCfg(next);
                } catch (e) {
                  console.error("patch cfg:", e);
                }
              }}
            />
          </div>
        )}
        {tab === "history" && (
          <div className="flex flex-col h-full">
            <HistoryQuotaBanner />
            <div className="flex-1 p-8 overflow-y-auto">
              <HistoryPane items={recent} onClear={() => setRecent([])} />
            </div>
          </div>
        )}
      </main>
      </div>

      {/* Sheets — 跟 Mac TypelessSettingsSheet / AccountSettingsView 一一对应 */}
      <SettingsSheet
        open={showSettings}
        cfg={cfg}
        proUnlocked={proUnlocked}
        onClose={() => setShowSettings(false)}
        onSave={async (next) => {
          await saveConfig(next);
          setCfg(next);
        }}
      />
      <AccountSheet
        open={showAccount}
        onClose={() => setShowAccount(false)}
      />
    </div>
  );
}

function fmtUsageMinutesWin(tokens: number): string {
  const secs = Math.max(0, Math.floor(tokens / 10));
  if (secs < 60) return `${secs} 秒`;
  if (secs < 3600) return `${Math.floor(secs / 60)} 分钟`;
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  return m === 0 ? `${h} 小时` : `${h} 小时 ${m} 分`;
}

function planChip(account: AccountSnapshot | null): string {
  const plan = (account?.license?.plan ?? "free").toLowerCase();
  if (plan.includes("flagship")) return "旗舰";
  if (plan.includes("pro"))      return "Pro";
  return "Free";
}

function SidebarIconBtn({
  icon, tooltip, onClick,
}: { icon: string; tooltip: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={tooltip}
      aria-label={tooltip}
      className="w-7 h-7 rounded-md flex items-center justify-center text-ink-500 hover:bg-ink-200 hover:text-ink-800 transition-colors"
    >
      <span className="text-[15px] leading-none">{icon}</span>
    </button>
  );
}

type UpgradeReason = "quota_exceeded" | "pro_locked";

/// 用 Web Audio 合成短「ding」提示音 —— 不打包 WAV 资源，volume 用户可调。
/// start = 上行双音（A5→C6 100ms），stop = 下行双音（C6→A5 100ms），
/// 听感上能区分。共享一个 AudioContext，避免每次新建（Chromium 4 个上限）。
let __audioCtx: AudioContext | null = null;
function playFeedbackTone(kind: "start" | "stop", volume: number) {
  try {
    if (!__audioCtx) {
      // Lazy init —— Web Audio 在用户手势前 suspended，hotkey 触发不算手势，
      // 但用户已经点过界面（Welcome 登录、Settings 等）所以基本能 resume。
      const Ctor = (window.AudioContext ??
        // @ts-expect-error vendor prefix on older webview
        window.webkitAudioContext) as typeof AudioContext | undefined;
      if (!Ctor) return;
      __audioCtx = new Ctor();
    }
    const ctx = __audioCtx;
    if (ctx.state === "suspended") void ctx.resume();
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    if (kind === "start") {
      osc.frequency.setValueAtTime(880, now);            // A5
      osc.frequency.exponentialRampToValueAtTime(1047, now + 0.08); // 上滑到 C6
    } else {
      osc.frequency.setValueAtTime(1047, now);
      osc.frequency.exponentialRampToValueAtTime(659, now + 0.08);  // 下滑到 E5
    }
    // 限幅 0..1 防止用户手输 1.5 之类的把 webview 喇叭炸了。
    const v = Math.max(0, Math.min(1, volume)) * 0.6;
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(v, now + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.12);
    osc.connect(gain).connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.13);
  } catch (e) {
    console.debug("playFeedbackTone failed:", e);
  }
}

/// Match common shapes from the backend error: `{"error":"quota_exceeded",...}`
/// JSON, the friendly Chinese strings produced by `asr.rs`, and the raw HTTP
/// status. Returns null when the error doesn't warrant an upgrade prompt.
function detectUpgradeReason(msg: string): UpgradeReason | null {
  const lower = msg.toLowerCase();
  if (lower.includes("quota_exceeded") || msg.includes("额度已用完") || msg.includes("额度用完")) {
    return "quota_exceeded";
  }
  if (lower.includes("pro_locked") || msg.includes("专业解锁包")) {
    return "pro_locked";
  }
  // 402 / 429 fallthrough — server returns code in body but if a transport
  // layer truncated, lean on the raw status digits.
  if (msg.includes(" 402 ") || msg.includes(" 429 ")) {
    return msg.includes("402") ? "pro_locked" : "quota_exceeded";
  }
  return null;
}

function UpgradeBanner({ reason, onDismiss }: { reason: UpgradeReason; onDismiss: () => void }) {
  const copy =
    reason === "quota_exceeded"
      ? "今日云端额度用完了。三个选择：① 升级 Pro / 旗舰；② 切到本地引擎（免费但慢一点）；③ 用自己的 API 密钥按你账户付费。"
      : "这个引擎需要先一次性付费 ¥49 解锁专业版。本地引擎和自带 API 密钥都会跟着解锁。";
  const open = () => {
    // Tauri opener — fall back to window.open for dev mode.
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const opener = (window as unknown as { __TAURI__?: { opener?: { openUrl: (u: string) => Promise<void> } } }).__TAURI__?.opener;
      if (opener) {
        void opener.openUrl("https://tititalk.com/pricing");
        return;
      }
    } catch {/* fallthrough */}
    window.open("https://tititalk.com/pricing", "_blank");
  };
  return (
    <div className="bg-amber-500 text-white px-5 py-2.5 flex items-center gap-3 text-sm">
      <span className="text-base">⚠</span>
      <div className="flex-1">{copy}</div>
      <button
        className="px-3 py-1 rounded bg-white text-amber-700 text-xs font-medium hover:bg-amber-50"
        onClick={open}
      >去升级</button>
      <button
        className="text-white/80 hover:text-white text-xs"
        onClick={onDismiss}
        aria-label="关闭"
      >✕</button>
    </div>
  );
}

/// Floating soft notice — non-blocking, auto-dismisses. Bottom-right
/// like macOS notifications. Distinct visual from `UpgradeBanner` (paid
/// upsell, sticky) and `Banner` inside HomePane (per-pane warning).
function NoticeToast({ message }: { message: string }) {
  if (!message) return null;
  return (
    <div className="fixed bottom-5 right-5 z-50 pointer-events-none">
      <div className="bg-ink-900/95 text-white px-4 py-2.5 rounded-lg shadow-lg text-sm max-w-sm">
        {message}
      </div>
    </div>
  );
}

function UpdateBanner({
  status, setStatus,
}: { status: UpdateStatus; setStatus: (s: UpdateStatus) => void }) {
  if (status.state === "idle" || status.state === "checking" || status.state === "uptodate") {
    return null;
  }
  if (status.state === "error") {
    // 不像 available 那样占主色 banner —— 浅色 + dismiss 按钮，告诉用户
    // 「更新通道有问题」但不打断主流程。完全静默会把「服务端 appcast
    // 挂了」这种事故藏起来。
    return (
      <div className="bg-amber-50 text-amber-900 px-5 py-2 flex items-center gap-3 text-xs border-b border-amber-200">
        <span className="flex-1">
          无法检查更新（{status.message.slice(0, 80)}）—— 网络或服务暂时不通，下次启动会再试。
        </span>
        <button
          className="text-amber-700 hover:text-amber-900 underline"
          onClick={() => {
            setStatus({ state: "checking" });
            checkForUpdate().then(setStatus);
          }}
        >重试</button>
        <button
          className="text-amber-700 hover:text-amber-900"
          onClick={() => setStatus({ state: "idle" })}
          aria-label="关闭"
        >×</button>
      </div>
    );
  }
  if (status.state === "available") {
    const { version, notes, update } = status;
    return (
      <div className="bg-ink-900 text-white px-5 py-2.5 flex items-center gap-3 text-sm">
        <div className="flex-1">
          <span className="font-medium">TiTiTalk v{version}</span>
          <span className="text-ink-300 ml-2">已发布{notes ? `：${notes.slice(0, 60)}` : ""}</span>
        </div>
        <button
          className="px-3 py-1 rounded bg-white text-ink-900 text-xs font-medium hover:bg-ink-100"
          onClick={async () => {
            setStatus({ state: "downloading", version, bytes: 0 });
            try {
              await downloadAndInstall(update, (bytes, total) =>
                setStatus({ state: "downloading", version, bytes, total }),
              );
              setStatus({ state: "ready", version });
            } catch (e) {
              setStatus({ state: "error", message: String(e) });
            }
          }}
        >立即更新</button>
        <button
          className="text-ink-300 hover:text-white text-xs"
          onClick={() => setStatus({ state: "idle" })}
        >稍后</button>
      </div>
    );
  }
  if (status.state === "downloading") {
    const pct = status.total ? Math.floor((status.bytes / status.total) * 100) : null;
    return (
      <div className="bg-ink-900 text-white px-5 py-2.5 text-sm">
        正在下载 v{status.version}…{pct !== null ? ` ${pct}%` : ""}
      </div>
    );
  }
  if (status.state === "ready") {
    return (
      <div className="bg-emerald-700 text-white px-5 py-2.5 flex items-center gap-3 text-sm">
        <div className="flex-1">v{status.version} 已就绪，重启应用即可生效</div>
        <button
          className="px-3 py-1 rounded bg-white text-emerald-900 text-xs font-medium hover:bg-emerald-50"
          onClick={() => restart()}
        >立即重启</button>
      </div>
    );
  }
  return null;
}

function NavBtn({
  active, onClick, children,
}: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={
        "w-full text-left px-3 py-2 rounded-md text-sm transition " +
        (active ? "bg-ink-900 text-white" : "text-ink-700 hover:bg-ink-100")
      }
    >
      {children}
    </button>
  );
}

/// Pre-login full-screen gate. Three states:
///   1. account === null → still loading the snapshot. Spinner. (≤ ~50ms.)
///   2. account.state.kind === "authenticating" → browser is open, waiting
///      for the deep-link callback. Show a "completing in browser…" CTA
///      with a manual fallback (Settings → Account) in case the URL Scheme
///      handshake stalls.
///   3. account.state.kind === "unauthenticated" / "error" → Welcome.
///      Login button + brief explainer. Error message rendered when present.
function WelcomeGate({ account, version }: { account: AccountSnapshot | null; version: string }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>("");

  const status = account?.state.kind ?? "loading";
  const errMsg =
    account?.state.kind === "error" ? account.state.message : "";
  // 优先用后端结构化 code/manage_url，避免 string sniffing。
  const errCode =
    account?.state.kind === "error" ? account.state.code : undefined;
  const errManageUrl =
    account?.state.kind === "error" ? account.state.manage_url : undefined;

  async function login() {
    setBusy(true);
    setErr("");
    try {
      await startLogin();
      // Don't flip busy off — the deep-link callback will transition the
      // shared `account` state to authenticated and unmount us.
    } catch (e) {
      setErr(String(e));
      setBusy(false);
    }
  }

  // `loading` covers TWO conditions: the snapshot hasn't arrived yet
  // (account === null), and the snapshot says bootstrap is mid-swap.
  // Without the second branch, users with a stored refresh token would
  // see the login screen flash for ~200ms before being kicked into the
  // authenticated UI — looks broken.
  const stillBooting = account?.bootstrap_in_flight === true;
  if (status === "loading" || stillBooting) {
    return (
      <div className="flex-1 flex items-center justify-center text-ink-400 text-sm">
        正在恢复账号…
      </div>
    );
  }

  return (
    <div className="flex-1 flex items-center justify-center px-6">
      <div className="w-full max-w-md text-center space-y-7">
        <div>
          <div className="text-3xl font-semibold text-ink-900 tracking-tight">
            TiTiTalk
          </div>
          <div className="text-sm text-ink-500 mt-1">
            按住快捷键说话 · 自动整理后插入到光标
          </div>
        </div>

        {status === "authenticating" ? (
          <div className="rounded-xl border border-indigo-200 bg-indigo-50 px-5 py-4 text-sm text-indigo-900 space-y-2 text-left">
            <div className="font-medium">浏览器已打开，请完成登录…</div>
            <div className="text-xs text-indigo-700/80 leading-relaxed">
              网页登录完成后会自动跳回。
              如果浏览器没自动打开，点下方按钮重试。
            </div>
            <button
              className="mt-2 w-full px-4 py-2.5 rounded-md bg-white border border-indigo-200 text-indigo-700 text-sm font-medium hover:bg-indigo-100"
              onClick={login}
              disabled={busy}
            >
              {busy ? "正在打开…" : "重新打开登录页"}
            </button>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="text-sm text-ink-600 leading-relaxed">
              首次使用需要登录。
              免费版每天 30 分钟云端识别，付费版可解锁更多额度和本地离线引擎。
            </div>
            <button
              className="w-full px-4 py-3 rounded-md bg-ink-900 text-white text-sm font-medium hover:bg-ink-700 disabled:opacity-50"
              onClick={login}
              disabled={busy}
            >
              {busy ? "正在打开浏览器…" : "在浏览器登录 / 注册"}
            </button>
            {(err || errMsg) && (
              <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2 text-left space-y-2">
                <div>{err || errMsg}</div>
                {/* 优先用后端结构化的 manage_url（device_limit_reached
                    detail 里直给）；fallback 到 hardcoded URL。code 字段
                    确保 button 只在 device_limit_reached 时显示，不会因
                    其他错误碰巧含 "dashboard" 误命中。
                    (C5) 登录路径里 list_devices 走 authed endpoint 拿不到，
                    只能引导去 web 解绑；解绑完点「我已解绑，重试登录」
                    → 重走 startLogin 一气呵成。 */}
                {errCode === "device_limit_reached" && (
                  <div className="flex flex-wrap gap-2">
                    <button
                      className="px-2.5 py-1 rounded bg-red-600 text-white text-xs hover:bg-red-700"
                      onClick={() =>
                        window.open(
                          errManageUrl ?? "https://tititalk.com/dashboard/devices",
                          "_blank",
                        )
                      }
                    >
                      打开「我的设备」管理 →
                    </button>
                    <button
                      className="px-2.5 py-1 rounded border border-red-400 text-red-700 text-xs hover:bg-red-100"
                      onClick={login}
                      disabled={busy}
                    >
                      我已解绑，重试登录
                    </button>
                  </div>
                )}
              </div>
            )}
            <div className="text-[11px] text-ink-400 leading-relaxed space-y-1">
              <div>
                没账号？登录页可以一键注册（用户名 + 密码就行）。
                你的设置会跟着账号在所有设备同步。
              </div>
              <div>
                忘记密码？{" "}
                <a
                  href="https://tititalk.com/auth/forgot-password"
                  target="_blank"
                  rel="noreferrer"
                  className="text-ink-600 underline hover:text-ink-900"
                >
                  在网页找回 →
                </a>
              </div>
            </div>
          </div>
        )}

        <div className="text-[11px] text-ink-400">
          v{version || "…"} · <a className="hover:underline" href="https://tititalk.com" target="_blank" rel="noreferrer">tititalk.com</a>
        </div>
      </div>
    </div>
  );
}

function HomeQuotaCard({
  account,
  onUpgrade,
}: {
  account: AccountSnapshot | null;
  onUpgrade: () => void;
}) {
  const plan = ((account?.license?.plan ?? "free") + "").toLowerCase();
  const isFlagship = plan.includes("flagship");
  const isPro = plan.includes("pro") && !isFlagship;
  const planLabel = isFlagship ? "旗舰版" : isPro ? "Pro 版" : "免费版";
  const planColor = isFlagship ? "#EC4899" : isPro ? "#6366F1" : "#94A3B8";

  const q = account?.quota ?? null;
  const limit = q?.limit_tokens ?? null;
  const remaining = q?.remaining_tokens ?? null;
  const used =
    q?.used_tokens ?? (limit != null && remaining != null ? Math.max(0, limit - remaining) : null);
  const pct = limit && limit > 0 && used != null ? Math.min(1, Math.max(0, used / limit)) : 0;

  const barColors =
    pct >= 0.95
      ? "from-red-500 to-rose-600"
      : pct >= 0.8
        ? "from-amber-500 to-orange-600"
        : "from-indigo-500 to-pink-500";

  return (
    <div className="rounded-xl bg-white border border-ink-200/70 p-4 flex items-center gap-4">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-2">
          <span className="text-[13px] font-semibold text-ink-900">今日云端用量</span>
          <span
            className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full"
            style={{
              backgroundColor: planColor + "26",
              color: planColor,
            }}
          >
            {planLabel}
          </span>
        </div>
        {limit != null && used != null ? (
          <>
            <div className="flex items-center gap-2 mb-2 tabular-nums">
              <span className="text-[12px] text-ink-500">
                剩余 {fmtUsageMinutesWin(remaining ?? Math.max(0, limit - used))}
              </span>
              <span
                className={
                  "text-[11px] " +
                  (pct >= 0.95 ? "text-red-600" : pct >= 0.8 ? "text-amber-600" : "text-ink-400")
                }
              >
                ({Math.round(pct * 100)}%)
              </span>
            </div>
            <div className="h-2 rounded-full bg-ink-100 overflow-hidden">
              <div
                className={"h-full bg-gradient-to-r " + barColors + " rounded-full transition-all"}
                style={{ width: `${Math.max(2, pct * 100)}%` }}
              />
            </div>
          </>
        ) : (
          <div className="text-[12px] text-ink-400">云端额度加载中…</div>
        )}
      </div>
      {!isFlagship && (
        <button
          type="button"
          onClick={onUpgrade}
          className="shrink-0 px-3 py-1.5 rounded-full text-white text-[12px] font-medium bg-gradient-to-r from-indigo-500 to-pink-500 hover:opacity-90"
        >
          ✨ {isPro ? "升级旗舰" : "升级 Pro"}
        </button>
      )}
    </div>
  );
}

/**
 * (typeoff 吸收 #10) 把润色风格从 Settings sheet 深处搬到首页 chip 行 ——
 * 用户随时切「关闭/口语/书面/中英混合/代码」。绑回 cfg.stylist_enabled +
 * cfg.stylist_persona（与 SettingsSheet 同源）。
 */
function HomeStylePicker({
  cfg, onPatch,
}: {
  cfg: AppConfig;
  onPatch: (patch: Partial<AppConfig>) => void;
}) {
  type Opt = { id: string; label: string; persona?: AppConfig["stylist_persona"]; off?: boolean };
  const opts: Opt[] = [
    { id: "off",          label: "原文",     off: true },
    { id: "friendly",     label: "口语",     persona: "friendly" },
    { id: "formal",       label: "书面",     persona: "formal" },
    { id: "mixed_zh_en",  label: "中英混合", persona: "mixed_zh_en" },
    { id: "code",         label: "代码",     persona: "code" },
  ];
  const currentId = !cfg.stylist_enabled ? "off" : cfg.stylist_persona;

  return (
    <div className="rounded-lg bg-white/[0.02] border border-white/5 p-3">
      <div className="flex items-center gap-2 mb-2">
        <span className="text-[11px] font-semibold text-ink-400 uppercase tracking-wider">当前风格</span>
        {currentId !== "off" && currentId !== "friendly" && (
          <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-violet-500/15 text-violet-300">
            已锁定
          </span>
        )}
        <div className="flex-1" />
        {currentId !== "friendly" && (
          <button
            onClick={() => onPatch({ stylist_enabled: true, stylist_persona: "friendly" })}
            className="text-[11px] text-ink-500 hover:text-ink-300"
          >
            重置默认
          </button>
        )}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {opts.map((o) => {
          const isSelected = currentId === o.id;
          return (
            <button
              key={o.id}
              onClick={() =>
                onPatch(
                  o.off
                    ? { stylist_enabled: false }
                    : { stylist_enabled: true, stylist_persona: o.persona! },
                )
              }
              className={
                "px-2.5 py-1 rounded-full text-[12px] transition " +
                (isSelected
                  ? "bg-violet-500/20 text-violet-300 ring-1 ring-violet-500/40 font-medium"
                  : "bg-white/[0.04] text-ink-300 hover:bg-white/[0.08]")
              }
            >
              {o.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function HomePane({
  cfg, account, phase, lastError, recent, onGoSettings, onGoAccount, onGoHistory, onDismissError, onPatchCfg,
}: {
  cfg: AppConfig;
  account: AccountSnapshot | null;
  phase: PipelinePhase;
  lastError: string;
  recent: { at: string; text: string }[];
  onGoSettings: () => void;
  onGoAccount: () => void;
  onGoHistory: () => void;
  onDismissError: () => void;
  onPatchCfg: (patch: Partial<AppConfig>) => void;
}) {
  // 麦克风权限自检 —— 首次启动 + phase 回到 idle 时各自检一次。
  // null = 还在检；true = 可用；false = 不可用（reason 是给用户看的人话）。
  const [micCheck, setMicCheck] = useState<{ ok: boolean; reason?: string } | null>(null);
  useEffect(() => {
    let cancelled = false;
    checkMicrophone().then((r) => {
      if (cancelled) return;
      setMicCheck(r.ok ? { ok: true } : { ok: false, reason: r.reason });
    });
    return () => {
      cancelled = true;
    };
    // (v0.7.8) 旧版 [phase === "idle"] 是 boolean —— React diff 后只在
    // true↔false 翻转时 re-run。phase=recording→transcribing→done→idle 一圈
    // 后 boolean 仍是 true→false→false→true，但 stale recheck 只在「回到 idle」
    // 那一拍触发。改 [phase] 让每次 phase 变化都 recheck，麦克风插拔 / 设备
    // 占用变化能更早被发现。
  }, [phase]);
  const hotkeyLabel = useMemo(
    () => VK_CHOICES.find((c) => c.vk === cfg.hotkey_vk)?.label ?? "F1",
    [cfg.hotkey_vk],
  );
  // toggle / hybrid 模式下「按住」不准确；按 mode 切换文案。
  const hotkeyVerb = useMemo(() => {
    switch (cfg.hotkey_mode) {
      case "toggle":
        return "按一下";
      case "hybrid":
        return "按一下或按住";
      default:
        return "按住";
    }
  }, [cfg.hotkey_mode]);
  const engineLabel = useMemo(() => {
    if (cfg.engine === "tititalk_cloud") return "TiTiTalk 云端（计平台额度）";
    if (cfg.engine === "qwen") return "百炼 Qwen 直连（自带 API 密钥）";
    if (cfg.engine === "openai") return "OpenAI 直连（自带 API 密钥）";
    return cfg.engine;
  }, [cfg.engine]);

  const isRecording = phase === "recording" || phase === "stopping";
  const isBusy = phase === "transcribing" || phase === "polishing" || phase === "inserting";

  // Block conditions — UI shows them as actionable banners instead of letting
  // the user press the button and watch it silently fail.
  const cloudEngine = cfg.engine === "tititalk_cloud";
  const needsLogin = cloudEngine && account?.state.kind !== "authenticated";
  const needsKey = (cfg.engine === "qwen" || cfg.engine === "openai") && !cfg.api_key.trim();

  async function handleMouseDown() {
    // mic 失败也挡 —— 跟后端预检语义一致，避免点了等 200ms 才看到 Notice
    // 弹出来。前端先卡，体感更利落。
    if (needsLogin || needsKey || (micCheck && !micCheck.ok) || isRecording || isBusy) return;
    try { await forceStart(); } catch (e) { console.warn("forceStart:", e); }
  }
  async function handleMouseUp() {
    if (!isRecording) return;
    try { await forceStop(); } catch (e) { console.warn("forceStop:", e); }
  }

  // (v0.9 Editorial Chinese) HomeView 改造 —— 跟 Mac HomeView.swift 的
  // editorialHero / dailyTimeline / recentBubbles 同源。
  // 数据有限：Win 历史只持久化 {at,text}，没有 durationMs，所以 hero 用「段
  // 数 + 字符数」代替 Mac 的「分钟数」；24h timeline 用 session count 桶代
  // 替 audio-minutes 桶；语义一致。
  const today = new Date();
  const isToday = (iso: string) => {
    const d = new Date(iso);
    return d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth() && d.getDate() === today.getDate();
  };
  const todayItems = recent.filter((it) => isToday(it.at));
  const todaySegments = todayItems.length;
  const todayChars = todayItems.reduce((acc, it) => acc + (it.text?.length ?? 0), 0);
  // 24-bucket histogram by hour of day
  const hourBuckets = useMemo(() => {
    const arr = new Array(24).fill(0) as number[];
    for (const it of todayItems) {
      const h = new Date(it.at).getHours();
      if (h >= 0 && h < 24) arr[h]++;
    }
    const max = Math.max(1, ...arr);
    return arr.map((v) => v / max); // normalized 0..1
  }, [todayItems]);

  return (
    <div className="max-w-3xl space-y-6">
      {/* (v0.9 editorial) Hero —— 章节 eyebrow + 宋体大字 metric + 仿宋 caption + 当前热键 chip */}
      <section>
        <div className="flex items-center gap-2 mb-3">
          <span className="font-mono text-[10px] tracking-[0.3em] text-signal-500 font-medium">
            CHAPTER · 今日
          </span>
          <div className="flex-1 h-px bg-ink-200" />
          <span className="font-mono text-[10px] tracking-[0.15em] text-ink-500 uppercase">
            {phaseLabel(phase)}
          </span>
        </div>
        <div className="flex items-baseline gap-3 mb-2 flex-wrap">
          {todaySegments > 0 ? (
            <>
              <span className="font-serif text-[56px] leading-none font-semibold text-ink-900 tabular-nums">
                {todayChars.toLocaleString("zh-CN")}
              </span>
              <span className="font-serif text-[18px] text-ink-500">字 · {todaySegments} 段</span>
            </>
          ) : (
            <span className="font-serif text-[40px] leading-tight font-medium text-ink-700">
              今天还没说话
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 flex-wrap text-[12px] text-ink-500 font-mono">
          <span>{hotkeyVerb} {hotkeyLabel} 即可开口</span>
          <span className="text-ink-300">·</span>
          <span>{cfg.hotkey_mode === "toggle" ? "再按一次结束" : "松开自动转写"}</span>
          <div className="flex-1" />
          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded border border-signal-500/40 text-signal-500 text-[11px]">
            <span className="text-ink-500 font-mono text-[10px] tracking-wider">按住</span>
            <span className="font-medium">{hotkeyLabel}</span>
          </span>
        </div>
      </section>

      <HomeQuotaCard account={account} onUpgrade={onGoAccount} />

      {/* (v0.9 editorial) 24h 时间轴 —— 替换之前 4 张 stat card。一眼看出今日
          说话的时间分布。点「全部」跳到 history pane。 */}
      <section className="rounded-xl border border-ink-200 bg-white p-4">
        <div className="flex items-center gap-2 mb-2">
          <span className="font-serif text-[14px] font-semibold text-ink-900">今日时间轴</span>
          <span className="font-mono text-[11px] text-ink-400">/ 0:00 ─ 24:00</span>
          <div className="flex-1" />
          <button onClick={onGoHistory} className="font-mono text-[11px] text-ink-500 hover:text-signal-500">
            全部 →
          </button>
        </div>
        <div className="flex items-end gap-px h-8 mb-1">
          {hourBuckets.map((v, h) => {
            const has = v > 0;
            return (
              <div key={h} className="flex-1 relative h-full bg-ink-100/60 rounded-sm overflow-hidden">
                <div
                  className={"absolute left-0 right-0 bottom-0 " + (has ? "bg-signal-500/85" : "bg-signal-500/15")}
                  style={{ height: `${Math.max(6, v * 100)}%` }}
                />
              </div>
            );
          })}
        </div>
        <div className="flex font-mono text-[9px] text-ink-300">
          <span className="flex-1 text-left">00</span>
          <span className="flex-1 text-center">06</span>
          <span className="flex-1 text-center">12</span>
          <span className="flex-1 text-center">18</span>
          <span className="flex-1 text-right">24</span>
        </div>
      </section>

      <HomeStylePicker cfg={cfg} onPatch={onPatchCfg} />

      {/* Status / blocker banners — show ONE at a time, top→bottom priority.
          mic 权限放最高 —— 没麦克风后面什么都白搭；其次是登录；其次是 BYOK key；
          最后是上次会话的错误。 */}
      {micCheck && !micCheck.ok && (
        <Banner
          tone="warn"
          title="麦克风暂不可用"
          body={micCheck.reason ?? "未授权或被独占。开启权限后可正常说话。"}
          actionLabel="打开 Windows 麦克风设置"
          onAction={async () => {
            try {
              await openMicSettings();
            } catch (e) {
              console.warn("open mic settings:", e);
            }
          }}
        />
      )}
      {needsLogin && (
        <Banner
          tone="warn"
          title="需要登录后才能使用云端 ASR"
          body="TiTiTalk 云端引擎免费每天 30 分钟。点右侧按钮在浏览器一步完成登录。"
          actionLabel="在浏览器登录"
          onAction={onGoAccount}
        />
      )}
      {!needsLogin && needsKey && (
        <Banner
          tone="warn"
          title={`${cfg.engine === "qwen" ? "百炼" : "OpenAI"} 引擎缺 API 密钥`}
          body="自带 API 密钥需要你自己的密钥。也可以切到「TiTiTalk 云端」走平台额度。"
          actionLabel="去填密钥"
          onAction={onGoSettings}
        />
      )}
      {!needsLogin && !needsKey && lastError && (
        <Banner
          tone="error"
          title="上次会话出错"
          body={lastError}
          onDismiss={onDismissError}
        />
      )}

      {/* Big push-to-talk button — works as F1 fallback when hotkey is hijacked
          by another app, AND as first-launch tutorial: user sees ONE thing to
          click, no confusion. */}
      <PushToTalkButton
        phase={phase}
        disabled={!!needsLogin || !!needsKey || !!(micCheck && !micCheck.ok)}
        disabledReason={
          micCheck && !micCheck.ok ? "需要先开启麦克风权限" :
          needsLogin ? "需要先登录 TiTiTalk 账号" :
          needsKey ? "需要先填自带 API 密钥" : undefined
        }
        hotkeyLabel={hotkeyLabel}
        onMouseDown={handleMouseDown}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
      />

      {/* (v0.9 editorial) 最近 3 条 —— 砍掉旧的 4 张状态 Card（信息冗余 ——
          热键/引擎/语言已经在 hero 跟 settings 里）；改成「文章片段」气泡，
          2px 朱砂 leading bar + 宋体 14px preview。点跳到 history。 */}
      {recent.length > 0 && (
        <section className="space-y-2">
          <div className="flex items-center gap-2 mb-1">
            <span className="font-mono text-[10px] tracking-[0.3em] text-signal-500 font-medium">
              CHAPTER · 最近
            </span>
            <div className="flex-1 h-px bg-ink-200" />
            <button onClick={onGoHistory} className="font-mono text-[11px] text-ink-500 hover:text-signal-500">
              全部 →
            </button>
          </div>
          {recent.slice(0, 3).map((it, i) => {
            const t = new Date(it.at);
            const time = `${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}`;
            const date = isToday(it.at) ? "今天" : `${t.getMonth() + 1} 月 ${t.getDate()} 日`;
            const preview = (it.text ?? "").trim().slice(0, 80);
            return (
              <button
                key={i}
                onClick={onGoHistory}
                className="w-full text-left flex gap-3 px-3 py-2.5 rounded-md hover:bg-paper-warm/40 transition group"
              >
                <div className="w-[2px] bg-signal-500/80 rounded-full self-stretch shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1 font-mono text-[10px] text-ink-400">
                    <span>{date}</span>
                    <span>·</span>
                    <span>{time}</span>
                  </div>
                  <div className="font-serif text-[14px] leading-[1.65] text-ink-800 line-clamp-2">
                    {preview || <span className="text-ink-400">（空）</span>}
                  </div>
                </div>
              </button>
            );
          })}
        </section>
      )}

      <div className="text-sm text-ink-500 flex items-center gap-3 pt-2 border-t border-ink-100">
        <span className="font-mono text-[11px] uppercase tracking-wider">{engineLabel}</span>
        <div className="flex-1" />
        <button onClick={onGoSettings} className="font-mono text-[11px] text-ink-500 hover:text-signal-500">
          调整设置 →
        </button>
      </div>
    </div>
  );
}

function PushToTalkButton({
  phase, disabled, disabledReason, hotkeyLabel, onMouseDown, onMouseUp, onMouseLeave,
}: {
  phase: PipelinePhase;
  disabled: boolean;
  disabledReason?: string;
  hotkeyLabel: string;
  onMouseDown: () => void;
  onMouseUp: () => void;
  onMouseLeave: () => void;
}) {
  const isRecording = phase === "recording" || phase === "stopping";
  const isBusy = phase === "transcribing" || phase === "polishing" || phase === "inserting";

  const bg = disabled
    ? "bg-ink-100 text-ink-400 cursor-not-allowed"
    : isRecording
      ? "bg-red-500 text-white shadow-lg shadow-red-200 scale-[1.02]"
      : isBusy
        ? "bg-indigo-100 text-indigo-700"
        : "bg-ink-900 text-white hover:bg-ink-800 active:bg-red-500 active:scale-[1.02]";

  const dotPulse = isRecording ? "animate-pulse" : "";

  let label: string;
  let sub: string;
  if (disabled) {
    // (v0.7.8) 旧版统一「需要先解决上面的提示」对小白模糊；按 caller 优先级
    // 传具体原因，按钮直接告诉用户「为啥点不了」。
    label = disabledReason ?? "暂时无法录音";
    sub = "请处理上方红色提示后再试";
  }
  else if (phase === "recording") { label = "听着… 松开转写"; sub = "麦克风录音中"; }
  else if (phase === "stopping") { label = "处理中…"; sub = "停止录音"; }
  else if (phase === "transcribing") { label = "正在转写…"; sub = "上传到云端 ASR"; }
  else if (phase === "polishing") { label = "正在润色…"; sub = "Stylist 处理中"; }
  else if (phase === "inserting") { label = "正在插入…"; sub = "粘贴到光标处"; }
  else if (phase === "done") { label = "完成 ✓"; sub = `按住按钮 或 ${hotkeyLabel} 再说一次`; }
  else if (phase === "failed") { label = "失败 — 按住试试"; sub = `或按 ${hotkeyLabel}`; }
  else { label = "按住此处说话"; sub = `也可以按住 ${hotkeyLabel}（在任何应用里都能用）`; }

  return (
    <div className="flex flex-col items-center py-4">
      <button
        onMouseDown={onMouseDown}
        onMouseUp={onMouseUp}
        onMouseLeave={onMouseLeave}
        onTouchStart={(e) => { e.preventDefault(); onMouseDown(); }}
        onTouchEnd={(e) => { e.preventDefault(); onMouseUp(); }}
        disabled={disabled || isBusy}
        className={
          "select-none w-full max-w-md rounded-2xl px-6 py-8 transition-all duration-150 " +
          "flex flex-col items-center justify-center gap-2 text-lg font-medium " + bg
        }
        style={{ touchAction: "manipulation" }}
      >
        <div className="flex items-center gap-2">
          <span className={"inline-block w-3 h-3 rounded-full " + (isRecording ? "bg-white " + dotPulse : disabled ? "bg-ink-300" : "bg-emerald-400")} />
          <span>{label}</span>
        </div>
        {sub && <div className="text-xs opacity-80">{sub}</div>}
      </button>
    </div>
  );
}

function Banner({
  tone, title, body, actionLabel, onAction, onDismiss,
}: {
  tone: "info" | "warn" | "error";
  title: string;
  body: string;
  actionLabel?: string;
  onAction?: () => void;
  /// When provided, render a "✕" in the top-right that calls this. Used by
  /// the error banner so the user can clear a stale failure message
  /// without being forced to start another recording.
  onDismiss?: () => void;
}) {
  const cls =
    tone === "error" ? "bg-red-50 border-red-200 text-red-900"
    : tone === "warn" ? "bg-amber-50 border-amber-200 text-amber-900"
    : "bg-indigo-50 border-indigo-200 text-indigo-900";
  const btn =
    tone === "error" ? "bg-red-600 hover:bg-red-700"
    : tone === "warn" ? "bg-amber-600 hover:bg-amber-700"
    : "bg-indigo-600 hover:bg-indigo-700";
  return (
    <div className={"rounded-lg border px-4 py-3 flex items-start gap-3 " + cls}>
      <div className="flex-1">
        <div className="font-medium text-sm">{title}</div>
        <div className="text-xs mt-0.5 opacity-90 leading-relaxed">{body}</div>
      </div>
      {actionLabel && onAction && (
        <button
          className={"px-3 py-1.5 rounded text-white text-sm font-medium " + btn}
          onClick={onAction}
        >{actionLabel}</button>
      )}
      {onDismiss && (
        <button
          className="text-current/60 hover:text-current text-base leading-none"
          onClick={onDismiss}
          aria-label="关闭"
        >✕</button>
      )}
    </div>
  );
}

function HistoryPane({
  items,
  onClear,
}: {
  items: { at: string; text: string }[];
  onClear: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  // FIX-22 (qa-2026-05-03): 清空历史加 success toast，让用户知道操作真的发生
  // 了 (SET-013)。失败也提示，原本失败 silent 让用户疑「卡了？」。
  const handleClear = async () => {
    setBusy(true);
    const count = items.length;
    try {
      await clearHistory();
      onClear();
      // 用浏览器原生 alert 是 placeholder——本仓库无统一 toast 组件；
      // 后续 B6 文案抛光会接 react-hot-toast 等。短期至少给反馈。
      console.info(`history cleared: ${count} entries`);
      setTimeout(() => {
        try { alert(`已清空 ${count} 条历史记录`); } catch {}
      }, 100);
    } catch (e) {
      try { alert(`清空失败：${(e as Error)?.message ?? e}`); } catch {}
    } finally {
      setBusy(false);
      setConfirmOpen(false);
    }
  };

  if (items.length === 0) {
    return (
      <div className="max-w-2xl">
        <div className="font-mono text-[10px] tracking-[0.3em] text-signal-500 font-medium mb-2">
          ARCHIVE · 历史
        </div>
        <h1 className="font-serif text-[40px] leading-tight font-medium text-ink-700">
          还没说过话
        </h1>
        <p className="text-ink-500 mt-3 text-sm leading-relaxed max-w-md">
          按住热键说话后，转写会自动收进这里。本地 JSONL 存储；可在「设置 · 高级 · 自动清理」打开 30 天滚动删除。
        </p>
      </div>
    );
  }
  return (
    <div className="max-w-3xl">
      {/* (v0.9 Editorial Chinese) 编辑器化档案 —— 章节 eyebrow + 宋体大字
          metric + monospaced 副标题；砍掉旧 「历史（N 条）」按钮卡组。 */}
      <header className="mb-6 flex items-end gap-4">
        <div className="flex-1">
          <div className="font-mono text-[10px] tracking-[0.3em] text-signal-500 font-medium mb-2">
            ARCHIVE · 已记
          </div>
          <h1 className="font-serif text-[44px] leading-none font-semibold text-ink-900 tabular-nums">
            {items.length.toLocaleString("zh-CN")}
            <span className="font-serif text-[18px] text-ink-500 font-normal ml-2">篇</span>
          </h1>
          <div className="font-mono text-[11px] text-ink-400 mt-2">
            最近 {Math.min(50, items.length)} 篇 · 本地 JSONL
          </div>
        </div>
        <button
          type="button"
          className="font-mono text-[11px] tracking-wider px-3 py-1.5 rounded border border-ink-200 text-ink-500 hover:text-signal-500 hover:border-signal-500/40 disabled:opacity-40"
          disabled={busy}
          onClick={() => setConfirmOpen(true)}
        >
          清空全部
        </button>
      </header>
      {confirmOpen && (
        <div className="mb-4 rounded-md border border-signal-500/40 bg-signal-100/40 p-3 text-sm text-signal-600">
          <div>确定清空所有本地历史？此操作不可恢复。</div>
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              className="px-3 py-1 rounded bg-signal-500 text-white hover:bg-signal-600 disabled:opacity-50"
              disabled={busy}
              onClick={handleClear}
            >
              确认清空
            </button>
            <button
              type="button"
              className="px-3 py-1 rounded border border-ink-300 hover:bg-ink-50"
              onClick={() => setConfirmOpen(false)}
            >
              取消
            </button>
          </div>
        </div>
      )}
      <div className="divide-y divide-ink-100">
        {items.map((it, i) => {
          const t = new Date(it.at);
          const time = `${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}`;
          const date = `${t.getFullYear()}.${String(t.getMonth() + 1).padStart(2, "0")}.${String(t.getDate()).padStart(2, "0")}`;
          return (
            <article key={i} className="flex gap-3 py-4 group">
              <div className="w-[2px] bg-signal-500/70 group-hover:bg-signal-500 self-stretch shrink-0 rounded-full transition-colors" />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1.5 font-mono text-[10px] tracking-wider text-ink-400">
                  <span>{date}</span>
                  <span>·</span>
                  <span>{time}</span>
                  <span>·</span>
                  <span className="tabular-nums">{(it.text ?? "").length} 字</span>
                </div>
                <div className="font-serif text-[15px] leading-[1.75] text-ink-900 whitespace-pre-wrap break-words">
                  {it.text}
                </div>
              </div>
            </article>
          );
        })}
      </div>
    </div>
  );
}

// AboutPane removed — 关于信息合并到 AccountSheet 底部 footer / 侧栏 v 版本号。

function phaseLabel(p: string): string {
  return ({
    idle: "空闲",
    recording: "录音中…",
    stopping: "结束录音…",
    transcribing: "转写中…",
    polishing: "润色中…",
    inserting: "插入到光标…",
    done: "完成",
    failed: "失败",
  } as Record<string, string>)[p] || p;
}
