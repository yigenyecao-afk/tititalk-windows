import { useEffect, useMemo, useState } from "react";
import { getConfig, onPipeline, saveConfig, testAsr, VK_CHOICES } from "./lib/api";
import type { AppConfig, PipelineEvent } from "./lib/types";
import {
  checkForUpdate,
  downloadAndInstall,
  restart,
  type UpdateStatus,
} from "./lib/updater";

const VERSION = "0.2.0";

type Tab = "home" | "settings" | "history" | "about";

export default function App() {
  const [tab, setTab] = useState<Tab>("home");
  const [cfg, setCfg] = useState<AppConfig | null>(null);
  const [recent, setRecent] = useState<{ at: string; text: string }[]>([]);
  const [statusLine, setStatusLine] = useState<string>("准备中");
  const [update, setUpdate] = useState<UpdateStatus>({ state: "idle" });

  useEffect(() => {
    getConfig().then(setCfg).catch((e) => console.error(e));
    const un = onPipeline((ev: PipelineEvent) => {
      if (ev.kind === "phase") {
        setStatusLine(phaseLabel(ev.phase));
      } else if (ev.kind === "transcript") {
        setRecent((r) => [{ at: new Date().toISOString(), text: ev.text }, ...r].slice(0, 50));
        setStatusLine("已转写：" + ev.text.slice(0, 30));
      } else if (ev.kind === "error") {
        setStatusLine("错误：" + ev.message);
      }
    });
    // Check for update on launch (silent if up-to-date or offline)
    checkForUpdate().then(setUpdate);
    return () => {
      un.then((fn) => fn());
    };
  }, []);

  if (!cfg) return <div className="p-10 text-ink-500">加载中…</div>;

  return (
    <div className="min-h-screen flex flex-col">
      <UpdateBanner status={update} setStatus={setUpdate} />
      <div className="flex-1 flex">
      <aside className="w-56 shrink-0 border-r border-ink-200 bg-white">
        <div className="px-5 pt-5 pb-3">
          <div className="text-lg font-semibold text-ink-900">TiTiTalk</div>
          <div className="text-xs text-ink-400">Windows · v{VERSION}</div>
        </div>
        <nav className="px-2 mt-2 space-y-1">
          <NavBtn active={tab === "home"} onClick={() => setTab("home")}>首页</NavBtn>
          <NavBtn active={tab === "settings"} onClick={() => setTab("settings")}>设置</NavBtn>
          <NavBtn active={tab === "history"} onClick={() => setTab("history")}>历史</NavBtn>
          <NavBtn active={tab === "about"} onClick={() => setTab("about")}>关于</NavBtn>
        </nav>
        <div className="absolute bottom-3 left-3 right-3 text-[11px] text-ink-400 px-2">
          状态：{statusLine}
        </div>
      </aside>
      <main className="flex-1 p-8 overflow-y-auto">
        {tab === "home" && <HomePane cfg={cfg} />}
        {tab === "settings" && (
          <SettingsPane
            cfg={cfg}
            onSave={async (next) => {
              await saveConfig(next);
              setCfg(next);
            }}
          />
        )}
        {tab === "history" && <HistoryPane items={recent} />}
        {tab === "about" && <AboutPane />}
      </main>
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
    // Silent on error — startup check shouldn't nag
    return null;
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

function HomePane({ cfg }: { cfg: AppConfig }) {
  const hotkeyLabel = useMemo(
    () => VK_CHOICES.find((c) => c.vk === cfg.hotkey_vk)?.label ?? "F1",
    [cfg.hotkey_vk],
  );
  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">按住 {hotkeyLabel} 说话</h1>
        <p className="text-ink-500 mt-1 text-sm">
          松开自动转写并插入到光标处。微信、邮件、IDE、Notion 都能用。
        </p>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <Card title="当前热键" body={hotkeyLabel} />
        <Card title="ASR 引擎" body={cfg.engine === "qwen" ? "百炼 Qwen" : "OpenAI Whisper"} />
        <Card title="模型" body={cfg.model} />
        <Card title="自动插入" body={cfg.auto_insert ? "已启用" : "已关闭（仅复制到剪贴板）"} />
      </div>
      <div className="text-sm text-ink-500">
        想换热键、API key 或语言？去左侧「设置」。
      </div>
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
  cfg, onSave,
}: { cfg: AppConfig; onSave: (next: AppConfig) => Promise<void> }) {
  const [draft, setDraft] = useState<AppConfig>(cfg);
  const [saving, setSaving] = useState(false);
  const [testResult, setTestResult] = useState<string>("");

  function patch<K extends keyof AppConfig>(k: K, v: AppConfig[K]) {
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
            <option value="qwen">百炼 Qwen（推荐 · 中文最强）</option>
            <option value="openai">OpenAI Whisper</option>
          </select>
        </Field>
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
        <Field label="按住说话">
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

function HistoryPane({ items }: { items: { at: string; text: string }[] }) {
  if (items.length === 0) {
    return (
      <div className="max-w-2xl">
        <h1 className="text-2xl font-semibold">历史</h1>
        <p className="text-ink-500 mt-2 text-sm">
          按住热键说话后，最近的转写会出现在这里（仅当前会话；持久化在 v0.2 上）。
        </p>
      </div>
    );
  }
  return (
    <div className="max-w-2xl space-y-3">
      <h1 className="text-2xl font-semibold">历史（本次启动）</h1>
      {items.map((it, i) => (
        <div key={i} className="rounded-lg border border-ink-200 bg-white p-3">
          <div className="text-[11px] text-ink-400">{new Date(it.at).toLocaleTimeString()}</div>
          <div className="text-sm text-ink-900 mt-1">{it.text}</div>
        </div>
      ))}
    </div>
  );
}

function AboutPane() {
  return (
    <div className="max-w-2xl space-y-3 text-sm text-ink-700">
      <h1 className="text-2xl font-semibold text-ink-900">关于</h1>
      <p>TiTiTalk Windows v{VERSION} — 跨平台语音输入法 Windows 端首版。</p>
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
