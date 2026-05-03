import { useEffect, useState } from "react";
import { testAsr, VK_CHOICES } from "../lib/api";
import type { AppConfig } from "../lib/types";
import TypelessSheet from "./TypelessSheet";
import {
  TypelessCard,
  TypelessRow,
  TypelessSectionHeader,
} from "./TypelessRow";

/// Typeless 风设置 sheet — 跟 Mac TypelessSettingsSheet 一一对应。
/// 6 sections：听写 / 快捷键 / 风格 / 隐私 / 提示音 / 高级（默认收起）。
/// 每行配「小白能看懂的副标题」；BYOK / 词典 / 自动清理这种偏 power-user 的
/// 选项塞高级 disclosure 默认收起。
export default function SettingsSheet({
  open,
  cfg,
  proUnlocked,
  onClose,
  onSave,
}: {
  open: boolean;
  cfg: AppConfig;
  proUnlocked: boolean;
  onClose: () => void;
  onSave: (next: AppConfig) => Promise<void>;
}) {
  const [draft, setDraft] = useState<AppConfig>(cfg);
  const [saving, setSaving] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [testResult, setTestResult] = useState("");

  // FIX-23 (qa-2026-05-03): 监听 ConflictDialog 解决冲突后广播的事件，把
  // 新 cfg patch 进来覆盖 draft——保证 sheet 在打开状态下也能即时刷新
  // (WIN-006)。父组件传进来的 cfg 也跟着变，所以 useEffect 依赖 cfg 即可。
  useEffect(() => {
    setDraft(cfg);
  }, [cfg]);
  useEffect(() => {
    const handler = () => {
      // 让父组件重新拉 → 通过 cfg prop 流回来。
      window.dispatchEvent(new CustomEvent("titi:request-config-reload"));
    };
    window.addEventListener("titi:config-changed", handler);
    return () => window.removeEventListener("titi:config-changed", handler);
  }, []);

  function patch<K extends keyof AppConfig>(k: K, v: AppConfig[K]) {
    if (k === "engine" && (v === "qwen" || v === "openai") && !proUnlocked) {
      window.open("https://tititalk.com/pricing", "_blank");
      return;
    }
    setDraft((d) => ({ ...d, [k]: v }));
  }

  async function persist() {
    setSaving(true);
    try {
      // (v0.7.8) 只调 onSave —— App.tsx 的 onSave 内已 saveConfig，旧版双写
      // race 偶尔导致 backend cfg ≠ frontend draft，「设置改了不生效」根因。
      await onSave(draft);
      setTestResult("已保存");
    } catch (e) {
      setTestResult("保存失败：" + String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <TypelessSheet open={open} title="设置" onClose={onClose}>
      <div className="space-y-6">
        {/* 听写 */}
        <section>
          <TypelessSectionHeader title="听写" subtitle="语音识别引擎与语言" />
          <TypelessCard>
            <TypelessRow
              icon="✦"
              iconColor="#6366F1"
              title="ASR 引擎"
              subtitle="云端走 tititalk.com 代理；BYOK 直连需要专业解锁包"
              trailing={
                <select
                  className="border border-ink-300 rounded px-2 py-1.5 text-sm bg-white"
                  value={draft.engine}
                  onChange={(e) =>
                    patch("engine", e.target.value as AppConfig["engine"])
                  }
                >
                  <option value="tititalk_cloud">TiTiTalk 云端</option>
                  <option value="qwen">{proUnlocked ? "" : "🔒 "}百炼 Qwen</option>
                  <option value="openai">{proUnlocked ? "" : "🔒 "}OpenAI</option>
                </select>
              }
            />
            <TypelessRow
              icon="🌐"
              iconColor="#0EA5E9"
              title="语言"
              subtitle="自动模式适合中英混说"
              trailing={
                <select
                  className="border border-ink-300 rounded px-2 py-1.5 text-sm bg-white"
                  value={draft.language}
                  onChange={(e) => patch("language", e.target.value)}
                >
                  <option value="zh">中文</option>
                  <option value="en">英文</option>
                  <option value="auto">自动</option>
                </select>
              }
            />
          </TypelessCard>
          {!proUnlocked && (
            <div className="mt-3 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-3 py-2">
              🔒 BYOK 引擎需要专业解锁包（¥49 一次性）。
              <a
                className="ml-1 underline hover:no-underline"
                href="https://tititalk.com/pricing"
                target="_blank"
                rel="noreferrer"
              >
                去解锁
              </a>
            </div>
          )}
        </section>

        {/* 快捷键 */}
        <section>
          <TypelessSectionHeader title="快捷键" subtitle="按一下就能开始说话" />
          <TypelessCard>
            <TypelessRow
              icon="⌘"
              iconColor="#10B981"
              title="录音热键"
              subtitle={
                "当前：" +
                (VK_CHOICES.find((c) => c.vk === draft.hotkey_vk)?.label ?? "F1")
              }
              trailing={
                <select
                  className="border border-ink-300 rounded px-2 py-1.5 text-sm bg-white"
                  value={draft.hotkey_vk}
                  onChange={(e) =>
                    patch("hotkey_vk", parseInt(e.target.value, 10))
                  }
                >
                  {VK_CHOICES.map((c) => (
                    <option key={c.vk} value={c.vk}>
                      {c.label}
                    </option>
                  ))}
                </select>
              }
            />
            <TypelessRow
              icon="✋"
              iconColor="#F59E0B"
              title="触发方式"
              subtitle={hotkeyModeHint(draft.hotkey_mode)}
              trailing={
                <select
                  className="border border-ink-300 rounded px-2 py-1.5 text-sm bg-white"
                  value={draft.hotkey_mode}
                  onChange={(e) =>
                    patch("hotkey_mode", e.target.value as AppConfig["hotkey_mode"])
                  }
                >
                  <option value="toggle">按一下开/关</option>
                  <option value="push_to_talk">按住说话</option>
                  <option value="hybrid">混合</option>
                </select>
              }
            />
          </TypelessCard>
        </section>

        {/* 风格 */}
        <section>
          <TypelessSectionHeader title="润色风格" subtitle="AI 把口语整理成什么样" />
          <TypelessCard>
            <TypelessRow
              icon="✨"
              iconColor="#8B5CF6"
              title="启用润色"
              subtitle="转写后再走一发 LLM 调通顺；失败自动用原文"
              trailing={
                <Switch
                  checked={draft.stylist_enabled}
                  onChange={(v) => patch("stylist_enabled", v)}
                />
              }
            />
            <TypelessRow
              icon="🎨"
              iconColor="#EC4899"
              title="风格"
              subtitle="也可以说「正式一点」「邮件腔」临时切换"
              trailing={
                <select
                  className="border border-ink-300 rounded px-2 py-1.5 text-sm bg-white disabled:opacity-50"
                  value={draft.stylist_persona}
                  onChange={(e) =>
                    patch(
                      "stylist_persona",
                      e.target.value as AppConfig["stylist_persona"],
                    )
                  }
                  disabled={!draft.stylist_enabled}
                >
                  <option value="friendly">友好口语</option>
                  <option value="formal">正式书面</option>
                  <option value="mixed_zh_en">中英混排</option>
                  {/* FIX-20 (qa-2026-05-03): code persona 之前 Win 端漏暴露
                      （WIN-005），Mac 端有但 Win 这个 picker 缺。补齐 4/4。 */}
                  <option value="code">代码注释</option>
                </select>
              }
            />
          </TypelessCard>
        </section>

        {/* 输出 */}
        <section>
          <TypelessSectionHeader title="输出" subtitle="转写完成后的行为" />
          <TypelessCard>
            <TypelessRow
              icon="↵"
              iconColor="#06B6D4"
              title="自动插入到光标"
              subtitle="关闭后只复制到剪贴板，不自动粘贴"
              trailing={
                <Switch
                  checked={draft.auto_insert}
                  onChange={(v) => patch("auto_insert", v)}
                />
              }
            />
            <TypelessRow
              icon="📋"
              iconColor="#64748B"
              title="同时复制到剪贴板"
              subtitle="自动插入失败时仍能 Ctrl+V 粘贴"
              trailing={
                <Switch
                  checked={draft.also_copy}
                  onChange={(v) => patch("also_copy", v)}
                />
              }
            />
          </TypelessCard>
        </section>

        {/* (v0.8.3) 体验增强 */}
        <section>
          <TypelessSectionHeader title="体验增强" subtitle="排版、取消、降噪等小开关" />
          <TypelessCard>
            <TypelessRow
              icon="␣"
              iconColor="#06B6D4"
              title="中英文之间自动加空格"
              subtitle="「打开 VSCode 看代码」自动补空格，更易读"
              trailing={
                <Switch
                  checked={draft.cjk_auto_space}
                  onChange={(v) => patch("cjk_auto_space", v)}
                />
              }
            />
            <TypelessRow
              icon="⎋"
              iconColor="#EF4444"
              title="ESC 取消录音 / 转写"
              subtitle="录音中或处理中按 ESC 立即丢弃，不计配额"
              trailing={
                <Switch
                  checked={draft.esc_cancel}
                  onChange={(v) => patch("esc_cancel", v)}
                />
              }
            />
            <TypelessRow
              icon="🔇"
              iconColor="#8B5CF6"
              title="录音中静音系统输出"
              subtitle="开会/听音乐时按住快捷键自动静音，松开恢复"
              trailing={
                <Switch
                  checked={draft.mute_system_during_recording}
                  onChange={(v) => patch("mute_system_during_recording", v)}
                />
              }
            />
            <TypelessRow
              icon="🌐"
              iconColor="#10B981"
              title="云端不可用时引导切 BYOK"
              subtitle="网络飘 / WS 超时 → Notice 提示切到自带 key 的引擎"
              trailing={
                <Switch
                  checked={draft.cloud_auto_fallback_to_local}
                  onChange={(v) => patch("cloud_auto_fallback_to_local", v)}
                />
              }
            />
          </TypelessCard>
        </section>

        {/* (v0.8.3 P1-3) 润色强度 */}
        {draft.stylist_enabled && (
          <section>
            <TypelessSectionHeader title="润色强度" subtitle="只清理标点 vs 大刀阔斧改写" />
            <TypelessCard>
              <TypelessRow
                icon="🎚"
                iconColor="#6366F1"
                title="强度档位"
                subtitle={
                  draft.polish_intensity === "light" ? "轻 · 只补标点 / 删口头禅" :
                  draft.polish_intensity === "heavy" ? "重 · 改写为正式书面语，可能偏离原意" :
                  "标准 · 当前默认行为"
                }
                trailing={
                  <select
                    value={draft.polish_intensity ?? "normal"}
                    onChange={(e) =>
                      patch("polish_intensity", e.target.value as "light" | "normal" | "heavy")
                    }
                    className="bg-ink-900 border border-ink-700 rounded px-2 py-1 text-sm"
                  >
                    <option value="light">轻</option>
                    <option value="normal">标准</option>
                    <option value="heavy">重</option>
                  </select>
                }
              />
            </TypelessCard>
          </section>
        )}

        {/* 提示音 */}
        <section>
          <TypelessSectionHeader title="提示音" subtitle="录音开始/结束的反馈" />
          <TypelessCard>
            <TypelessRow
              icon="🔔"
              iconColor="#F59E0B"
              title="启用提示音"
              subtitle="开始/结束录音时播放短音提示"
              trailing={
                <Switch
                  checked={draft.sound_feedback_enabled}
                  onChange={(v) => patch("sound_feedback_enabled", v)}
                />
              }
            />
            {draft.sound_feedback_enabled && (
              <TypelessRow
                icon="🔊"
                iconColor="#F59E0B"
                title="音量"
                subtitle={`${Math.round(draft.sound_feedback_volume * 100)}%`}
                trailing={
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.05}
                    value={draft.sound_feedback_volume}
                    onChange={(e) =>
                      patch("sound_feedback_volume", parseFloat(e.target.value))
                    }
                    className="w-32"
                  />
                }
              />
            )}
          </TypelessCard>
        </section>

        {/* 高级 disclosure */}
        <section>
          <button
            type="button"
            onClick={() => setAdvanced((v) => !v)}
            className="flex items-center gap-2 text-sm text-ink-700 hover:text-ink-900 px-1"
          >
            <span className="text-base">{advanced ? "▾" : "▸"}</span>
            <span className="font-semibold">高级</span>
            <span className="text-xs text-ink-400">
              BYOK · 模型 · 词典 · 自动清理
            </span>
          </button>

          {advanced && (
            <div className="mt-3 space-y-4">
              {draft.engine !== "tititalk_cloud" && (
                <TypelessCard>
                  <TypelessRow
                    icon="🏷"
                    title="模型"
                    subtitle="留空走默认（百炼 qwen3-asr-flash / OpenAI whisper-1）"
                    trailing={
                      <input
                        className="border border-ink-300 rounded px-2 py-1.5 text-sm bg-white w-44"
                        value={draft.model}
                        onChange={(e) => patch("model", e.target.value)}
                        placeholder={
                          draft.engine === "qwen" ? "qwen3-asr-flash" : "whisper-1"
                        }
                      />
                    }
                  />
                  <TypelessRow
                    icon="🔑"
                    title="API key"
                    subtitle="只存本地 keystore，不上传"
                    trailing={
                      <input
                        type="password"
                        className="border border-ink-300 rounded px-2 py-1.5 text-sm bg-white w-44"
                        value={draft.api_key}
                        onChange={(e) => patch("api_key", e.target.value)}
                        placeholder="sk-xxx"
                      />
                    }
                  />
                </TypelessCard>
              )}

              <TypelessCard>
                <TypelessRow
                  icon="✏︎"
                  title="润色模型"
                  subtitle="留空走 qwen-turbo；BYOK 时用你的 key 调"
                  trailing={
                    <input
                      className="border border-ink-300 rounded px-2 py-1.5 text-sm bg-white w-44 disabled:opacity-50"
                      value={draft.stylist_model}
                      onChange={(e) => patch("stylist_model", e.target.value)}
                      placeholder="qwen-turbo"
                      disabled={!draft.stylist_enabled}
                    />
                  }
                />
              </TypelessCard>

              <TypelessCard>
                <TypelessRow
                  icon="📖"
                  title="词典 / 热词"
                  subtitle="一行一个；专有名词、人名、术语放这里"
                  trailing={null}
                />
                <div className="px-4 pb-4">
                  <textarea
                    className="border border-ink-300 rounded px-2 py-2 text-sm bg-white w-full h-28 font-mono"
                    value={draft.dictionary.join("\n")}
                    onChange={(e) =>
                      patch(
                        "dictionary",
                        e.target.value
                          .split("\n")
                          .map((s) => s.trim())
                          .filter(Boolean),
                      )
                    }
                  />
                </div>
              </TypelessCard>

              <TypelessCard>
                <TypelessRow
                  icon="🗑"
                  title="自动清理历史"
                  subtitle="超过保留天数的本地历史每次启动 + 每天会被清掉"
                  trailing={
                    <Switch
                      checked={draft.history_cleanup_enabled}
                      onChange={(v) => patch("history_cleanup_enabled", v)}
                    />
                  }
                />
                <TypelessRow
                  icon="📅"
                  title="保留天数"
                  trailing={
                    <input
                      type="number"
                      className="border border-ink-300 rounded px-2 py-1.5 text-sm bg-white w-24 disabled:opacity-50"
                      value={draft.history_retention_days}
                      min={1}
                      max={3650}
                      disabled={!draft.history_cleanup_enabled}
                      onChange={(e) =>
                        patch(
                          "history_retention_days",
                          parseInt(e.target.value, 10) || 30,
                        )
                      }
                    />
                  }
                />
              </TypelessCard>

              {draft.hotkey_mode === "push_to_talk" && (
                <TypelessCard>
                  <TypelessRow
                    icon="⏱"
                    title="最小按住时长（ms）"
                    subtitle="短于此值视为误触不录"
                    trailing={
                      <input
                        type="number"
                        className="border border-ink-300 rounded px-2 py-1.5 text-sm bg-white w-24"
                        value={draft.min_hold_ms}
                        min={50}
                        max={1000}
                        onChange={(e) =>
                          patch(
                            "min_hold_ms",
                            parseInt(e.target.value, 10) || 150,
                          )
                        }
                      />
                    }
                  />
                </TypelessCard>
              )}
            </div>
          )}
        </section>

        {/* footer 操作 */}
        <div className="sticky bottom-0 -mx-7 px-7 py-4 bg-white/90 backdrop-blur border-t border-ink-200 flex items-center gap-3">
          <button
            type="button"
            className="px-4 py-2 rounded-md bg-ink-900 text-white text-sm hover:bg-ink-700 disabled:opacity-50"
            disabled={saving}
            onClick={persist}
          >
            {saving ? "保存中…" : "保存"}
          </button>
          <button
            type="button"
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
          >
            测试 API key
          </button>
          <span className="text-sm text-ink-500">{testResult}</span>
        </div>
      </div>
    </TypelessSheet>
  );
}

function hotkeyModeHint(mode: AppConfig["hotkey_mode"]): string {
  switch (mode) {
    case "push_to_talk":
      return "按住时录音，松开就停 — 想说短话用这个";
    case "hybrid":
      return "短按一次切换，长按时按住说话";
    default:
      return "按一下开始，再按一下结束";
  }
}

/// 自定义 Switch（rangify 浏览器原生 checkbox 看着像移动端开关）。
function Switch({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className={
        "relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border border-transparent transition-colors duration-200 " +
        (checked ? "bg-ink-900" : "bg-ink-300")
      }
      role="switch"
      aria-checked={checked}
    >
      <span
        className={
          "pointer-events-none inline-block h-5 w-5 rounded-full bg-white shadow ring-0 transition duration-200 " +
          (checked ? "translate-x-5" : "translate-x-0.5") +
          " mt-0.5"
        }
      />
    </button>
  );
}
