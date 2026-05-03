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
  const [statusLine, setStatusLine] = useState<string>("准备中");
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
              onGoSettings={() => setShowSettings(true)}
              onGoAccount={() => setShowAccount(true)}
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
      ? "今日云端 ASR 额度用完。可升级专业版解锁更多 token，或切到本地 / 自带 API key。"
      : "此引擎需要专业解锁包（¥49 一次性）。本地 Whisper 与 BYOK 路径都解锁。";
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
            按住快捷键说话 · 自动转写到光标处
          </div>
        </div>

        {status === "authenticating" ? (
          <div className="rounded-xl border border-indigo-200 bg-indigo-50 px-5 py-4 text-sm text-indigo-900 space-y-2 text-left">
            <div className="font-medium">浏览器已打开，请完成登录…</div>
            <div className="text-xs text-indigo-700/80 leading-relaxed">
              在网页确认绑定后会自动跳回客户端。
              如果浏览器没自动唤起，回到这里再点一次「打开登录页」。
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
              首次使用需要登录 tititalk.com 账号。
              免费档每日 30 分钟云端转写，付费档解锁更多额度与本地离线引擎。
            </div>
            <button
              className="w-full px-4 py-3 rounded-md bg-ink-900 text-white text-sm font-medium hover:bg-ink-700 disabled:opacity-50"
              onClick={login}
              disabled={busy}
            >
              {busy ? "正在打开浏览器…" : "用浏览器登录 / 注册"}
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
                没有账号？登录页可以一键注册（用户名 + 密码即可）。
                所有设置会通过你的账号在多设备同步。
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
                {used.toLocaleString()} / {limit.toLocaleString()} tokens
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
          <div className="text-[12px] text-ink-400">云端配额加载中…</div>
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
  cfg, account, phase, lastError, onGoSettings, onGoAccount, onDismissError, onPatchCfg,
}: {
  cfg: AppConfig;
  account: AccountSnapshot | null;
  phase: PipelinePhase;
  lastError: string;
  onGoSettings: () => void;
  onGoAccount: () => void;
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
    if (cfg.engine === "qwen") return "百炼 Qwen 直连（自带 key）";
    if (cfg.engine === "openai") return "OpenAI Whisper 直连";
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

  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">{hotkeyVerb} {hotkeyLabel} 说话</h1>
        <p className="text-ink-500 mt-1 text-sm">
          {cfg.hotkey_mode === "toggle"
            ? "再按一次结束并自动转写、插入到光标处。"
            : "松开自动转写并插入到光标处。"}
          微信、邮件、IDE、Notion 都能用。
        </p>
      </div>

      <HomeQuotaCard account={account} onUpgrade={onGoAccount} />

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
          body="TiTiTalk 云端引擎按 token 计费，免费档每日 30 分钟。点右侧「去登录」用浏览器一步完成。"
          actionLabel="去登录"
          onAction={onGoAccount}
        />
      )}
      {!needsLogin && needsKey && (
        <Banner
          tone="warn"
          title={`${cfg.engine === "qwen" ? "百炼" : "OpenAI"} 引擎缺 API key`}
          body="BYOK 直连引擎需要你自己的 key。也可以切到「TiTiTalk 云端」走平台额度。"
          actionLabel="去填 key"
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
          needsKey ? "需要先填 BYOK API key" : undefined
        }
        hotkeyLabel={hotkeyLabel}
        onMouseDown={handleMouseDown}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
      />

      <div className="grid grid-cols-2 gap-4">
        <Card title="当前热键" body={hotkeyLabel} />
        <Card title="ASR 引擎" body={engineLabel} />
        <Card title="语言" body={cfg.language === "zh" ? "中文" : cfg.language === "en" ? "英文" : "自动"} />
        <Card title="自动插入" body={cfg.auto_insert ? "已启用" : "仅复制到剪贴板"} />
      </div>

      <div className="text-sm text-ink-500 flex items-center gap-3">
        <span>想换热键、API key 或语言？</span>
        <button onClick={onGoSettings} className="text-indigo-600 hover:underline">去设置 →</button>
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

function Card({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-lg border border-ink-200 bg-white p-4">
      <div className="text-xs text-ink-400">{title}</div>
      <div className="text-base font-medium text-ink-900 mt-1">{body}</div>
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
        <h1 className="text-2xl font-semibold">历史</h1>
        <p className="text-ink-500 mt-2 text-sm">
          按住热键说话后，转写会自动保存到本地（JSONL，可在「设置 · 历史清理」开启自动清理）。
        </p>
      </div>
    );
  }
  return (
    <div className="max-w-2xl space-y-3">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">历史（{items.length} 条）</h1>
        <button
          type="button"
          className="text-sm px-3 py-1.5 rounded border border-ink-300 hover:bg-ink-50 disabled:opacity-40"
          disabled={busy}
          onClick={() => setConfirmOpen(true)}
        >
          清空全部
        </button>
      </div>
      {confirmOpen && (
        <div className="rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-700">
          <div>确定清空所有本地历史？此操作不可恢复。</div>
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              className="px-3 py-1 rounded bg-red-600 text-white hover:bg-red-700 disabled:opacity-50"
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
      {items.map((it, i) => (
        <div key={i} className="rounded-lg border border-ink-200 bg-white p-3">
          <div className="text-[11px] text-ink-400">{new Date(it.at).toLocaleString()}</div>
          <div className="text-sm text-ink-900 mt-1">{it.text}</div>
        </div>
      ))}
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
