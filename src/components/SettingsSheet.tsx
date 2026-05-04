import { useEffect, useState } from "react";
import {
  testAsr,
  VK_CHOICES,
  getHotwordCandidates,
  dismissHotwordCandidate,
  clearAllHotwordCandidates,
} from "../lib/api";
import type { AppConfig } from "../lib/types";
import TypelessSheet from "./TypelessSheet";
import {
  TypelessCard,
  TypelessRow,
  TypelessSectionHeader,
} from "./TypelessRow";
import { Icon } from "./Icon";

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
              iconNode={<Icon name="engine" />}
              iconColor="#6366F1"
              title="识别引擎"
              subtitle="默认走 TiTiTalk 云端；用自带 API 密钥需要先解锁专业版"
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
            {/* (v0.8.5 第三轮 Cut#6) 「语言」picker 挪到高级 disclosure ——
                默认 auto 即最优；改成单语反而漏识别。@field draft.language
                留生效，下方高级里仍可调。 */}
          </TypelessCard>
          {!proUnlocked && (
            <div className="mt-3 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-3 py-2">
              🔒 用自带 API 密钥需要先解锁专业版（¥49 一次性）。
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
              iconNode={<Icon name="keyboard" />}
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
              iconNode={<Icon name="hand" />}
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
            {/* (v0.8.4 P2-2) 双修饰键 hotkey —— 默认关 */}
            <TypelessRow
              iconNode={<Icon name="modifier" />}
              iconColor="#6366F1"
              title="双击修饰键触发"
              subtitle={
                draft.double_modifier_key === ""
                  ? "300ms 内连按两次同一个修饰键开始/停止录音"
                  : `已开 · 双击 ${doubleModifierLabel(draft.double_modifier_key)}`
              }
              trailing={
                <select
                  className="border border-ink-300 rounded px-2 py-1.5 text-sm bg-white"
                  value={draft.double_modifier_key}
                  onChange={(e) => patch("double_modifier_key", e.target.value)}
                >
                  <option value="">关</option>
                  <option value="shift">⇧⇧</option>
                  <option value="ctrl">⌃⌃</option>
                  <option value="opt">⌥⌥（Alt）</option>
                  <option value="cmd">⊞⊞（Win 键）</option>
                </select>
              }
            />
            {/* (v0.8.4 P2-1) 鼠标侧键 hotkey —— 默认关 */}
            <TypelessRow
              iconNode={<Icon name="mouse" />}
              iconColor="#0EA5E9"
              title="鼠标侧键触发"
              subtitle={
                draft.mouse_side_button === 0
                  ? "用鼠标左侧两个侧键开始/停止录音（需带侧键的鼠标）"
                  : `已开 · ${mouseSideLabel(draft.mouse_side_button)}`
              }
              trailing={
                <select
                  className="border border-ink-300 rounded px-2 py-1.5 text-sm bg-white"
                  value={String(draft.mouse_side_button)}
                  onChange={(e) => patch("mouse_side_button", Number(e.target.value))}
                >
                  <option value="0">关</option>
                  <option value="1">侧键 1（后退）</option>
                  <option value="2">侧键 2（前进）</option>
                </select>
              }
            />
            {/* (v0.8.4 backlog #4) Ctrl+Alt+T 翻译开关 + 目标语言 */}
            <TypelessRow
              iconNode={<Icon name="globe" />}
              iconColor="#10B981"
              title="Ctrl+Alt+T 一键翻译选中"
              subtitle="选中文字 → 按 Ctrl+Alt+T → 自动翻译并替换。需要在「自带 API 密钥」里配百炼 API 密钥"
              trailing={
                <Switch
                  checked={draft.translate_hotkey_enabled}
                  onChange={(v) => patch("translate_hotkey_enabled", v)}
                />
              }
            />
            {draft.translate_hotkey_enabled && (
              <TypelessRow
                iconNode={<Icon name="speak" />}
                iconColor="#10B981"
                title="翻译目标语言"
                subtitle="自然语言写法（English / 日本語 / Français / 粤语 等）"
                trailing={
                  <input
                    type="text"
                    className="border border-ink-300 rounded px-2 py-1.5 text-sm w-32"
                    value={draft.translation_target}
                    onChange={(e) => patch("translation_target", e.target.value)}
                    placeholder="English"
                  />
                }
              />
            )}
            {/* (v0.8.4 backlog #5) Ctrl+Alt+/ 「随便问」浮窗开关 */}
            <TypelessRow
              iconNode={<Icon name="magic" />}
              iconColor="#A855F7"
              title="Ctrl+Alt+/ 「随便问」浮窗"
              subtitle="按一下弹起浮窗，输入指令做翻译/整理/写邮件等。需要在「自带 API 密钥」里配百炼 API 密钥"
              trailing={
                <Switch
                  checked={draft.assistant_hotkey_enabled}
                  onChange={(v) => patch("assistant_hotkey_enabled", v)}
                />
              }
            />
          </TypelessCard>
        </section>

        {/* 风格 */}
        <section>
          <TypelessSectionHeader title="整理风格" subtitle="AI 把口语整理成什么样" />
          <TypelessCard>
            <TypelessRow
              iconNode={<Icon name="sparkle" />}
              iconColor="#8B5CF6"
              title="开启自动整理"
              subtitle="识别完再让 AI 调通顺；失败自动用原文"
              trailing={
                <Switch
                  checked={draft.stylist_enabled}
                  onChange={(v) => patch("stylist_enabled", v)}
                />
              }
            />
            <TypelessRow
              iconNode={<Icon name="palette" />}
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
            {/* (v0.9 Editorial Chinese) 整理风格实时案例预览 —— 让用户一眼看见
                4 个 persona 把同一句口语会处理成什么样，省去先保存再录一段才知道
                差异。例句故意带口语啰嗦 + 中英混 + 一个数字，4 种处理风格一目了然。 */}
            {draft.stylist_enabled && (
              <div className="px-4 pb-4 pt-1">
                <PersonaPreview persona={draft.stylist_persona} />
              </div>
            )}
            {/* (v0.8.4 typeless 学习 P1 #4) 输出语言覆盖 */}
            <TypelessRow
              iconNode={<Icon name="earth" />}
              iconColor="#0EA5E9"
              title="输出语言"
              subtitle="说一种语言、自动翻译成另一种语言后插入。空 = 跟随说话语言不翻译"
              trailing={
                <select
                  className="border border-ink-300 rounded px-2 py-1.5 text-sm bg-white"
                  value={draft.output_language_override}
                  onChange={(e) => patch("output_language_override", e.target.value)}
                >
                  <option value="">跟随实际</option>
                  <option value="中文">→ 中文</option>
                  <option value="English">→ English</option>
                  <option value="日本語">→ 日本語</option>
                  <option value="한국어">→ 한국어</option>
                  <option value="粤语">→ 粤语</option>
                  <option value="Français">→ Français</option>
                  <option value="Deutsch">→ Deutsch</option>
                  <option value="Español">→ Español</option>
                </select>
              }
            />
          </TypelessCard>
        </section>

        {/* 录音浮窗外观 — Editorial 4 主题 */}
        <section>
          <TypelessSectionHeader title="录音浮窗" subtitle="说话时屏幕上出现的小窗" />
          <TypelessCard>
            <TypelessRow
              title="浮窗主题"
              subtitle={pillThemeHint(draft.pill_theme)}
              trailing={
                <select
                  className="border border-ink-300 rounded px-2 py-1.5 text-sm bg-white"
                  value={draft.pill_theme}
                  onChange={(e) => patch("pill_theme", e.target.value as typeof draft.pill_theme)}
                >
                  <option value="lantern">灯笼 · 默认（朱砂呼吸光晕）</option>
                  <option value="annotation">批注 · 暖黄信纸便签</option>
                  <option value="telegraph">电报 · 屏幕底等宽 ticker</option>
                  <option value="seal">印章 · 朱砂方印章</option>
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
              iconNode={<Icon name="enter" />}
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
              iconNode={<Icon name="clipboard" />}
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
              iconNode={<Icon name="space" />}
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
              iconNode={<Icon name="esc" />}
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
              iconNode={<Icon name="mute" />}
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
            {/* (v0.8.5 第三轮 Cut#7) 「云端不可用切 BYOK」toggle UI 移除 ——
                默认开就该开（云端飘网络时引导切 BYOK 是体验，不是用户该
                选项）。cloud_auto_fallback_to_local @field 留生效。 */}
          </TypelessCard>
        </section>

        {/* (v0.8.5 第三轮 Cut#8) 「润色强度」整 Section 挪到高级 disclosure ——
            normal 是 90% 用户最优档，light/heavy 是边界探索。 */}

        {/* 提示音 */}
        <section>
          <TypelessSectionHeader title="提示音" subtitle="录音开始/结束的反馈" />
          <TypelessCard>
            <TypelessRow
              iconNode={<Icon name="bell" />}
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
                iconNode={<Icon name="volume" />}
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
            className="flex items-center gap-2 text-sm text-ink-700 hover:text-ink-900 px-1 w-full"
          >
            <span className="text-base">{advanced ? "▾" : "▸"}</span>
            <span className="font-semibold">高级</span>
            {/* (v0.9 Editorial Chinese) 折叠时显示真实状态徽章 —— 用户能一眼看
                出当前哪些高级项已经在生效（API 密钥已填 / 词典 N 条 / 整理模型已改
                / 整理强度非默认）。展开时不显，避免视觉干扰。 */}
            {!advanced && (
              <div className="flex items-center gap-1.5 flex-wrap">
                {advancedBadges(draft).map((b) => (
                  <span
                    key={b}
                    className="text-[10px] font-mono px-1.5 py-0.5 rounded border border-signal-500/40 text-signal-500"
                  >
                    {b}
                  </span>
                ))}
                {advancedBadges(draft).length === 0 && (
                  <span className="text-xs text-ink-400">
                    自带 API 密钥 · 模型 · 词典 · 自动清理
                  </span>
                )}
              </div>
            )}
          </button>

          {advanced && (
            <div className="mt-3 space-y-4">
              {/* (v0.8.5 第三轮 Cut#6) 语言 picker 挪入高级——日常 auto 即最优 */}
              <TypelessCard>
                <TypelessRow
                  iconNode={<Icon name="globe" />}
                  title="识别语言"
                  subtitle="默认自动适合中英混说；改单语在外文比例高时偶尔提升识别率"
                  trailing={
                    <select
                      className="border border-ink-300 rounded px-2 py-1.5 text-sm bg-white"
                      value={draft.language}
                      onChange={(e) => patch("language", e.target.value)}
                    >
                      <option value="auto">自动</option>
                      <option value="zh">中文</option>
                      <option value="en">英文</option>
                    </select>
                  }
                />
              </TypelessCard>

              {draft.engine !== "tititalk_cloud" && (
                <TypelessCard>
                  <TypelessRow
                    iconNode={<Icon name="tag" />}
                    title="识别模型"
                    subtitle="留空走默认（百炼用 qwen3-asr-flash / OpenAI 用 whisper-1）"
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
                    iconNode={<Icon name="key" />}
                    title="API 密钥"
                    subtitle="只存本地，不上传"
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
                  iconNode={<Icon name="edit" />}
                  title="整理模型"
                  subtitle="留空走 qwen-turbo；用了自带 API 密钥就走你的"
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
                {/* (v0.8.5 第三轮 Cut#8) 润色强度从主面挪进来——边界探索档 */}
                {draft.stylist_enabled && (
                  <TypelessRow
                    iconNode={<Icon name="slider" />}
                    title="整理强度"
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
                        className="border border-ink-300 rounded px-2 py-1.5 text-sm bg-white"
                      >
                        <option value="light">轻</option>
                        <option value="normal">标准</option>
                        <option value="heavy">重</option>
                      </select>
                    }
                  />
                )}
              </TypelessCard>

              <TypelessCard>
                <TypelessRow
                  iconNode={<Icon name="book" />}
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
                {/* (v0.8.4 P1-2) 词汇检测建议加词典 toggle + banner */}
                <TypelessRow
                  iconNode={<Icon name="sparkle" />}
                  iconColor="#F59E0B"
                  title="建议加词典"
                  subtitle="重复出现的英文术语攒满 3 次后，词典上方冒「+ 加进词典」"
                  trailing={
                    <Switch
                      checked={draft.hotword_suggestion_enabled}
                      onChange={(v) => patch("hotword_suggestion_enabled", v)}
                    />
                  }
                />
                {draft.hotword_suggestion_enabled && (
                  <HotwordCandidateBanner
                    onAdd={(token) => {
                      const next = [...draft.dictionary];
                      if (!next.some((w) => w.toLowerCase() === token.toLowerCase())) {
                        next.push(token);
                        patch("dictionary", next);
                      }
                    }}
                  />
                )}
              </TypelessCard>

              {/* (v0.8.5 第三轮 Cut#9) 「自动清理历史」toggle + 「保留天数」
                  number UI 移除 —— 30 天默认 + 启动自动跑 cleanup_history.rs 已足；
                  history_cleanup_enabled / history_retention_days @field 留生效。
                  (v0.8.5 第三轮 Cut#10) 「最小按住时长 (ms)」row UI 移除 ——
                  150ms 默认是基于 typeless 测试出来的最佳值，调它=把热键玩坏；
                  min_hold_ms @field 留生效。 */}
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
            测试 API 密钥
          </button>
          <span className="text-sm text-ink-500">{testResult}</span>
        </div>
      </div>
    </TypelessSheet>
  );
}

function pillThemeHint(theme: AppConfig["pill_theme"]): string {
  switch (theme) {
    case "annotation": return "暖黄便签贴桌角，仿宋体大字适合写作者";
    case "telegraph":  return "屏幕底部一条 ticker，等宽字 + 状态电码，程序员路线";
    case "seal":       return "朱砂方印「听 / 校 / 记」单字配题款，仪式感";
    case "lantern":
    default:           return "球形朱砂呼吸光晕；说话越大光越亮（默认）";
  }
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

function doubleModifierLabel(key: string): string {
  switch (key) {
    case "shift": return "⇧";
    case "ctrl":  return "⌃";
    case "opt":   return "⌥（Alt）";
    case "cmd":   return "⊞（Win 键）";
    default:      return "";
  }
}

function mouseSideLabel(n: number): string {
  switch (n) {
    case 1: return "侧键 1（后退）";
    case 2: return "侧键 2（前进）";
    default: return "";
  }
}

/// (v0.9 Editorial Chinese) 整理风格实时案例预览 —— 同一句口语 4 种 persona
/// 处理结果对照。input 选用真实场景：带「呃」「然后」语气词 + 中英混 + 数字。
/// 输出是手工硬编码（不是 LLM 实时跑），节省请求成本，4 个 persona 差异稳定可控。
function PersonaPreview({
  persona,
}: {
  persona: AppConfig["stylist_persona"];
}) {
  const input = "呃就是说 我们今天 review 一下那个 v0.9 release，然后 ETA 大概是 周五 5 点之前要把 changelog 搞定";
  const outputs: Record<AppConfig["stylist_persona"], string> = {
    friendly: "我们今天 review 一下 v0.9 release，周五五点前要把 changelog 搞定。",
    formal: "请于本周五 17:00 前完成 v0.9 release review 与 changelog 整理。",
    mixed_zh_en: "今天 review v0.9 release，周五 5 PM 前完成 changelog。",
    code: "// review v0.9 release\n// deadline: Friday 5pm — finalize changelog",
  };
  const label: Record<AppConfig["stylist_persona"], string> = {
    friendly: "友好口语",
    formal: "正式书面",
    mixed_zh_en: "中英混排",
    code: "代码注释",
  };
  return (
    <div className="rounded-lg border border-ink-200 bg-paper-warm/30 px-3 py-2.5 text-[12px] leading-relaxed">
      <div className="flex items-center gap-2 mb-1.5">
        <span className="font-mono text-[10px] tracking-widest text-signal-500 font-medium">
          PREVIEW
        </span>
        <span className="text-ink-400">·</span>
        <span className="font-serif text-[12px] font-medium text-ink-800">
          {label[persona]}
        </span>
      </div>
      <div className="text-ink-400 line-through decoration-ink-300 mb-1.5">
        {input}
      </div>
      <div className="font-serif text-ink-900 whitespace-pre-line">
        {outputs[persona]}
      </div>
    </div>
  );
}

/// (v0.9 Editorial Chinese) 高级 disclosure 折叠时显示的真实状态徽章。
/// 哪些 power-user 设置已经被改过、就显示对应短标签。展开时不显（避免重复）。
function advancedBadges(draft: AppConfig): string[] {
  const out: string[] = [];
  if (draft.api_key && draft.api_key.trim().length > 0) out.push("自带密钥");
  if (draft.dictionary && draft.dictionary.length > 0) out.push(`词典 ${draft.dictionary.length} 条`);
  if (draft.model && draft.model.trim().length > 0) out.push(`识别模型 ${shortModel(draft.model)}`);
  if (draft.stylist_model && draft.stylist_model.trim().length > 0) out.push(`整理模型 ${shortModel(draft.stylist_model)}`);
  if (draft.polish_intensity && draft.polish_intensity !== "normal") out.push(`整理 ${draft.polish_intensity === "light" ? "轻" : "重"}`);
  if (draft.language && draft.language !== "auto") out.push(`语言 ${draft.language === "zh" ? "中文" : "英文"}`);
  return out;
}

function shortModel(m: string): string {
  // 长 model name 截到 ≤14 字符，免徽章撑爆
  if (m.length <= 14) return m;
  return m.slice(0, 13) + "…";
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

/// (v0.8.4 P1-2) 词汇候选 banner —— 拉服务端 candidates，给「+ 加进词典」跟
/// 「忽略」两个动作。Sheet 打开时拉一次；用户点动作后本地乐观更新。
function HotwordCandidateBanner({
  onAdd,
}: {
  onAdd: (token: string) => void;
}) {
  const [items, setItems] = useState<[string, number][]>([]);
  useEffect(() => {
    getHotwordCandidates()
      .then(setItems)
      .catch(() => setItems([]));
  }, []);
  if (items.length === 0) return null;
  return (
    <div className="mx-4 mb-4 rounded-lg border border-amber-300 bg-amber-50 px-3 py-3">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-semibold text-amber-900">
          ✨ 发现 {items.length} 个反复出现的新词
        </span>
        <button
          className="text-xs text-amber-800 hover:underline"
          onClick={() => {
            clearAllHotwordCandidates().then(() => setItems([]));
          }}
        >
          全部清掉
        </button>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {items.slice(0, 20).map(([token, n]) => (
          <span
            key={token}
            className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-1 text-xs"
            title={`出现 ${n} 次`}
          >
            <span className="font-mono">{token}</span>
            <button
              className="text-emerald-600 hover:text-emerald-800"
              onClick={() => {
                onAdd(token);
                dismissHotwordCandidate(token).then(() => {
                  setItems((prev) => prev.filter(([t]) => t !== token));
                });
              }}
              title="加进词典"
            >
              ＋
            </button>
            <button
              className="text-ink-500 hover:text-ink-800"
              onClick={() => {
                dismissHotwordCandidate(token).then(() => {
                  setItems((prev) => prev.filter(([t]) => t !== token));
                });
              }}
              title="忽略这个词"
            >
              ✕
            </button>
          </span>
        ))}
      </div>
    </div>
  );
}
