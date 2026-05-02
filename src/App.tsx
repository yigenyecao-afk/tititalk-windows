import { useEffect, useMemo, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import {
  checkMicrophone,
  clearHistory,
  forceStart,
  forceStop,
  getConfig,
  getHistoryRecent,
  onPipeline,
  openMicSettings,
  saveConfig,
  testAsr,
  VK_CHOICES,
} from "./lib/api";
import type { AppConfig, PipelineEvent, PipelinePhase } from "./lib/types";
import {
  checkForUpdate,
  downloadAndInstall,
  restart,
  type UpdateStatus,
} from "./lib/updater";
import AccountSection from "./components/AccountSection";
import ConflictDialog from "./components/ConflictDialog";
import {
  getAccountState,
  isProUnlocked,
  onAccountState,
  startLogin,
  type AccountSnapshot,
} from "./lib/account";

type Tab = "home" | "settings" | "history" | "about";

export default function App() {
  const [tab, setTab] = useState<Tab>("home");
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
    // 启动时拉持久化历史（最近 50 条）—— transcript 增量再走 onPipeline。
    getHistoryRecent(50)
      .then((items) => setRecent(items.map((it) => ({ at: it.at, text: it.text }))))
      .catch((e) => console.warn("history load:", e));
    const accountUn = onAccountState(setAccount);
    const un = onPipeline((ev: PipelineEvent) => {
      if (ev.kind === "phase") {
        setPhase(ev.phase);
        setStatusLine(phaseLabel(ev.phase));
        if (ev.phase === "recording" || ev.phase === "transcribing") {
          setLastError("");
        }
      } else if (ev.kind === "transcript") {
        setRecent((r) => [{ at: new Date().toISOString(), text: ev.text }, ...r].slice(0, 50));
        setStatusLine("已转写：" + ev.text.slice(0, 30));
        setUpgrade(null); // success — clear any stale upgrade banner
      } else if (ev.kind === "error") {
        setStatusLine("错误：" + ev.message);
        setLastError(ev.message);
        const reason = detectUpgradeReason(ev.message);
        if (reason) setUpgrade(reason);
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
    };
  }, []);

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
      <aside className="w-56 shrink-0 border-r border-ink-200 bg-white">
        <div className="px-5 pt-5 pb-3">
          <div className="text-lg font-semibold text-ink-900">TiTiTalk</div>
          <div className="text-xs text-ink-400">Windows · v{version || "…"}</div>
        </div>
        <nav className="px-2 mt-2 space-y-1">
          <NavBtn active={tab === "home"} onClick={() => setTab("home")}>首页</NavBtn>
          <NavBtn active={tab === "settings"} onClick={() => setTab("settings")}>设置</NavBtn>
          <NavBtn active={tab === "history"} onClick={() => setTab("history")}>历史</NavBtn>
          <NavBtn active={tab === "about"} onClick={() => setTab("about")}>关于</NavBtn>
        </nav>
        <div className="absolute bottom-3 left-3 right-3 px-2">
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
      </aside>
      <main className="flex-1 p-8 overflow-y-auto">
        {tab === "home" && (
          <HomePane
            cfg={cfg}
            account={account}
            phase={phase}
            lastError={lastError}
            onGoSettings={() => setTab("settings")}
            onGoAccount={() => setTab("settings")}
            onDismissError={() => setLastError("")}
          />
        )}
        {tab === "settings" && (
          <SettingsPane
            cfg={cfg}
            proUnlocked={proUnlocked}
            onSave={async (next) => {
              await saveConfig(next);
              setCfg(next);
            }}
          />
        )}
        {tab === "history" && <HistoryPane items={recent} onClear={() => setRecent([])} />}
        {tab === "about" && <AboutPane version={version} />}
      </main>
      </div>
    </div>
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

function HomePane({
  cfg, account, phase, lastError, onGoSettings, onGoAccount, onDismissError,
}: {
  cfg: AppConfig;
  account: AccountSnapshot | null;
  phase: PipelinePhase;
  lastError: string;
  onGoSettings: () => void;
  onGoAccount: () => void;
  onDismissError: () => void;
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
  }, [phase === "idle"]);
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
  phase, disabled, hotkeyLabel, onMouseDown, onMouseUp, onMouseLeave,
}: {
  phase: PipelinePhase;
  disabled: boolean;
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
  if (disabled) { label = "需要先解决上面的提示"; sub = ""; }
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

function SettingsPane({
  cfg, proUnlocked, onSave,
}: { cfg: AppConfig; proUnlocked: boolean; onSave: (next: AppConfig) => Promise<void> }) {
  const [draft, setDraft] = useState<AppConfig>(cfg);
  const [saving, setSaving] = useState(false);
  const [testResult, setTestResult] = useState<string>("");

  function patch<K extends keyof AppConfig>(k: K, v: AppConfig[K]) {
    // (commercialization) Gate BYOK on pro_unlocked. Snap silently to the
    // cloud proxy + open the pricing page so user knows why.
    if (k === "engine" && (v === "qwen" || v === "openai") && !proUnlocked) {
      window.open("https://tititalk.com/pricing", "_blank");
      return;
    }
    setDraft((d) => ({ ...d, [k]: v }));
  }

  return (
    <div className="max-w-2xl space-y-6">
      <h1 className="text-2xl font-semibold">设置</h1>

      <Section title="语音识别">
        <Field label="引擎">
          <select
            className="border rounded px-2 py-1.5 text-sm bg-white border-ink-300"
            value={draft.engine}
            onChange={(e) => patch("engine", e.target.value as AppConfig["engine"])}
          >
            <option value="tititalk_cloud">TiTiTalk 云端（推荐 · 需登录 · 计平台额度）</option>
            <option value="qwen">{proUnlocked ? "" : "🔒 "}百炼 Qwen 直连（自带 key · 不计平台额度）</option>
            <option value="openai">{proUnlocked ? "" : "🔒 "}OpenAI Whisper 直连（自带 key）</option>
          </select>
        </Field>
        {!proUnlocked && (
          <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-3 py-2 flex items-center gap-2">
            <span>🔒</span>
            <span className="flex-1">BYOK 直连引擎需要专业解锁包（¥49 一次性，永久解锁）。</span>
            <a
              className="text-amber-900 underline hover:no-underline"
              href="https://tititalk.com/pricing"
              target="_blank"
              rel="noreferrer"
            >去解锁</a>
          </div>
        )}
        {draft.engine !== "tititalk_cloud" && (
          <>
            <Field label="模型">
              <input
                className="border rounded px-2 py-1.5 text-sm bg-white border-ink-300 w-full"
                value={draft.model}
                onChange={(e) => patch("model", e.target.value)}
                placeholder={draft.engine === "qwen" ? "qwen3-asr-flash" : "whisper-1"}
              />
            </Field>
            <Field label="API key">
              <input
                type="password"
                className="border rounded px-2 py-1.5 text-sm bg-white border-ink-300 w-full"
                value={draft.api_key}
                onChange={(e) => patch("api_key", e.target.value)}
                placeholder={draft.engine === "qwen" ? "sk-xxx（百炼）" : "sk-xxx（OpenAI）"}
              />
            </Field>
          </>
        )}
        {draft.engine === "tititalk_cloud" && (
          <div className="text-xs text-ink-500 leading-relaxed">
            云端走 tititalk.com 代理，按 0.1 秒说话 = 1 token 计费。免费档每日 18,000 token（30 分钟）；Pro / 旗舰升级看「账号」标签。
          </div>
        )}
        <Field label="语言">
          <select
            className="border rounded px-2 py-1.5 text-sm bg-white border-ink-300"
            value={draft.language}
            onChange={(e) => patch("language", e.target.value)}
          >
            <option value="zh">中文</option>
            <option value="en">英文</option>
            <option value="auto">自动</option>
          </select>
        </Field>
      </Section>

      <Section title="热键与行为">
        <Field label="触发键">
          <select
            className="border rounded px-2 py-1.5 text-sm bg-white border-ink-300"
            value={draft.hotkey_vk}
            onChange={(e) => patch("hotkey_vk", parseInt(e.target.value, 10))}
          >
            {VK_CHOICES.map((c) => (
              <option key={c.vk} value={c.vk}>{c.label}</option>
            ))}
          </select>
        </Field>
        <Field label="触发方式">
          <select
            className="border rounded px-2 py-1.5 text-sm bg-white border-ink-300"
            value={draft.hotkey_mode}
            onChange={(e) => patch("hotkey_mode", e.target.value as AppConfig["hotkey_mode"])}
          >
            <option value="push_to_talk">按住说话（松手停）</option>
            <option value="toggle">按一下开 · 再按一下停</option>
            <option value="hybrid">混合：短按 toggle / 长按 PTT</option>
          </select>
        </Field>
        {draft.hotkey_mode === "push_to_talk" && (
          <Field label="最小按住时长（ms）">
            <input
              type="number"
              className="border rounded px-2 py-1.5 text-sm bg-white border-ink-300 w-32"
              value={draft.min_hold_ms}
              min={50}
              max={1000}
              onChange={(e) => patch("min_hold_ms", parseInt(e.target.value, 10) || 150)}
            />
          </Field>
        )}
        {draft.hotkey_mode === "hybrid" && (
          <Field label="混合阈值（ms · 短于此为 tap）">
            <input
              type="number"
              className="border rounded px-2 py-1.5 text-sm bg-white border-ink-300 w-32"
              value={draft.hybrid_press_threshold_ms}
              min={150}
              max={2000}
              onChange={(e) => patch("hybrid_press_threshold_ms", parseInt(e.target.value, 10) || 500)}
            />
          </Field>
        )}
        <Field label="自动插入到光标">
          <input
            type="checkbox"
            checked={draft.auto_insert}
            onChange={(e) => patch("auto_insert", e.target.checked)}
          />
        </Field>
        <Field label="同时复制到剪贴板">
          <input
            type="checkbox"
            checked={draft.also_copy}
            onChange={(e) => patch("also_copy", e.target.checked)}
          />
        </Field>
      </Section>

      <Section title="提示音 / 反馈">
        <Field label="启用提示音">
          <input
            type="checkbox"
            checked={draft.sound_feedback_enabled}
            onChange={(e) => patch("sound_feedback_enabled", e.target.checked)}
          />
        </Field>
        <Field label="音量">
          <div className="flex items-center gap-2">
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={draft.sound_feedback_volume}
              onChange={(e) => patch("sound_feedback_volume", parseFloat(e.target.value))}
              disabled={!draft.sound_feedback_enabled}
              className="w-40"
            />
            <span className="text-xs text-ink-500 w-10">
              {Math.round(draft.sound_feedback_volume * 100)}%
            </span>
            <button
              type="button"
              className="text-xs px-2 py-1 rounded border border-ink-300 hover:bg-ink-50 disabled:opacity-40"
              disabled={!draft.sound_feedback_enabled}
              onClick={() => playFeedbackTone("start", draft.sound_feedback_volume)}
            >
              试听
            </button>
          </div>
        </Field>
      </Section>

      <Section title="历史清理">
        <Field label="按保留期清理">
          <input
            type="checkbox"
            checked={draft.history_cleanup_enabled}
            onChange={(e) => patch("history_cleanup_enabled", e.target.checked)}
          />
        </Field>
        <Field label="保留天数">
          <input
            type="number"
            className="border rounded px-2 py-1.5 text-sm bg-white border-ink-300 w-32"
            value={draft.history_retention_days}
            min={1}
            max={3650}
            disabled={!draft.history_cleanup_enabled}
            onChange={(e) =>
              patch("history_retention_days", parseInt(e.target.value, 10) || 30)
            }
          />
        </Field>
        <div className="text-xs text-ink-400 leading-relaxed">
          关闭时不动你的历史。开启后每次启动 + 每天会删除超过保留天数的记录。
          手动「清空全部历史」按钮在「历史」tab 也有。
        </div>
      </Section>

      <Section title="词典（生词/术语，每行一个）">
        <textarea
          className="border rounded px-2 py-1.5 text-sm bg-white border-ink-300 w-full h-32 font-mono"
          value={draft.dictionary.join("\n")}
          onChange={(e) =>
            patch(
              "dictionary",
              e.target.value.split("\n").map((s) => s.trim()).filter(Boolean),
            )
          }
        />
      </Section>

      <Section title="账号（tititalk.com）">
        <AccountSection />
      </Section>

      <Section title="润色（Stylist · 转写后再走一发 LLM 调通顺）">
        <Field label="启用润色">
          <input
            type="checkbox"
            checked={draft.stylist_enabled}
            onChange={(e) => patch("stylist_enabled", e.target.checked)}
          />
        </Field>
        <Field label="风格">
          <select
            className="border rounded px-2 py-1.5 text-sm bg-white border-ink-300"
            value={draft.stylist_persona}
            onChange={(e) => patch("stylist_persona", e.target.value as AppConfig["stylist_persona"])}
            disabled={!draft.stylist_enabled}
          >
            <option value="friendly">友好口语 · 通顺自然</option>
            <option value="formal">正式书面 · 邮件/商务腔</option>
            <option value="mixed_zh_en">中英混说 · 保留英文术语</option>
          </select>
        </Field>
        <Field label="润色模型">
          <input
            className="border rounded px-2 py-1.5 text-sm bg-white border-ink-300 w-48"
            value={draft.stylist_model}
            onChange={(e) => patch("stylist_model", e.target.value)}
            placeholder="qwen-turbo"
            disabled={!draft.stylist_enabled}
          />
        </Field>
        <div className="text-xs text-ink-400 leading-relaxed">
          润色失败（网络/超时 8s）会自动用原文，不会卡插入。短于 4 字的转写跳过润色省 token。
        </div>
      </Section>

      <div className="flex items-center gap-3 pt-2">
        <button
          className="px-4 py-2 rounded-md bg-ink-900 text-white text-sm hover:bg-ink-700 disabled:opacity-50"
          disabled={saving}
          onClick={async () => {
            setSaving(true);
            try {
              await onSave(draft);
              setTestResult("已保存");
            } catch (e) {
              setTestResult("保存失败：" + String(e));
            } finally {
              setSaving(false);
            }
          }}
        >保存</button>
        <button
          className="px-4 py-2 rounded-md border border-ink-300 text-sm hover:bg-ink-100"
          onClick={async () => {
            setTestResult("测试中…");
            try {
              const r = await testAsr();
              setTestResult("测试 " + r);
            } catch (e) {
              setTestResult("测试失败：" + String(e));
            }
          }}
        >测试 API key</button>
        <span className="text-sm text-ink-500">{testResult}</span>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-ink-200 bg-white p-5 space-y-3">
      <div className="font-medium text-ink-900">{title}</div>
      <div className="space-y-3">{children}</div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[180px_1fr] items-center gap-3">
      <div className="text-sm text-ink-600">{label}</div>
      <div>{children}</div>
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

  const handleClear = async () => {
    setBusy(true);
    try {
      await clearHistory();
      onClear();
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

function AboutPane({ version }: { version: string }) {
  return (
    <div className="max-w-2xl space-y-3 text-sm text-ink-700">
      <h1 className="text-2xl font-semibold text-ink-900">关于</h1>
      <p>TiTiTalk Windows v{version || "…"} — 跨平台语音输入法 Windows 端。</p>
      <p>
        Mac 端已上线 v2.10.12（35K LOC SwiftUI），Windows 端基于 Tauri 2 + Rust 重写底层
        音频/热键/插入，UI 与 Mac 端共享设计语言。
      </p>
      <p className="text-ink-500">
        本版本未做代码签名（首次启动会触发 SmartScreen 警告，点击「更多信息 → 仍要运行」即可）。
        EV 证书拿到后会重新签名。
      </p>
    </div>
  );
}

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
