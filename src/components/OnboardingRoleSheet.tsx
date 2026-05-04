/**
 * (角色身份系统 v1) Post-login 全屏强制角色选择。
 *
 * 渲染时机：App.tsx 检查 account.state.kind==='authenticated' && user.role==null
 * 时 hijack 整个根 DOM。决策 #1 强制选不能跳过、不显示关闭按钮、ESC 不响应。
 *
 * 选完点确认 → cmd_role_select → 后端 PUT /api/me/role + reload_me →
 * account-state-changed 事件让 App.tsx 看到 user.role 非 null → 自动切走
 * 让位主界面。
 *
 * Catalog server-driven：8 卡内容从 /api/roles 拉，客户端不硬编码角色清单。
 */
import { useEffect, useState } from "react";
import {
  fetchRoleCatalog,
  getCachedRoles,
  type Role,
} from "../lib/role-catalog";
import { selectRole as apiSelectRole } from "../lib/account";

export interface OnboardingRoleSheetProps {
  /** 选完成功后调（App.tsx 用于关 toast 等收尾）。state 通过 account-state-changed
   *  事件流自动更新，无需 props 传 callback。 */
  onSelected?: (roleId: string) => void;
}

export default function OnboardingRoleSheet({ onSelected }: OnboardingRoleSheetProps) {
  const [roles, setRoles] = useState<Role[]>(() => getCachedRoles());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchRoleCatalog(true).then((list) => {
      if (!cancelled) setRoles(list);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleConfirm() {
    if (!selectedId || submitting) return;
    setSubmitting(true);
    setErrorMessage(null);
    try {
      await apiSelectRole(selectedId);
      onSelected?.(selectedId);
      // 不需要手动 close —— App.tsx 收到 account-state-changed 后会切走。
    } catch (e) {
      setErrorMessage(`保存失败：${String(e)}，请重试。`);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-start overflow-y-auto bg-[var(--bg-base,#fafafa)] dark:bg-[#1a1a1a]">
      <div className="w-full max-w-3xl px-8 py-8 flex flex-col gap-7">
        <header className="text-center flex flex-col gap-2 mt-4">
          <h1 className="text-3xl font-semibold tracking-tight">你是？</h1>
          <p className="text-sm text-zinc-500 dark:text-zinc-400 leading-relaxed">
            选一个角色，我们会按你的工作语境定制 ASR 热词 + 润色风格。
            <br />
            之后可在 设置 → 账号 改。
          </p>
        </header>

        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
          {roles.length === 0 ? (
            <div className="col-span-full text-center text-sm text-zinc-400 py-12">
              加载角色列表…
            </div>
          ) : (
            roles.map((role) => (
              <RoleCard
                key={role.id}
                role={role}
                selected={selectedId === role.id}
                onClick={() => {
                  setErrorMessage(null);
                  setSelectedId(role.id);
                }}
              />
            ))
          )}
        </div>

        {errorMessage && (
          <div className="rounded-md bg-red-50 dark:bg-red-900/20 px-3 py-2 text-sm text-red-700 dark:text-red-300">
            {errorMessage}
          </div>
        )}

        <button
          type="button"
          onClick={handleConfirm}
          disabled={submitting || !selectedId}
          className="w-full py-3 rounded-md bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition"
        >
          {submitting ? "保存中…" : selectedId ? "确认" : "请先选一个角色"}
        </button>
      </div>
    </div>
  );
}

interface RoleCardProps {
  role: Role;
  selected: boolean;
  onClick: () => void;
}

function RoleCard({ role, selected, onClick }: RoleCardProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex flex-col items-start gap-2 p-3 min-h-[110px] rounded-lg border text-left transition ${
        selected
          ? "bg-blue-600 text-white border-blue-600"
          : "bg-white dark:bg-zinc-800 border-zinc-200 dark:border-zinc-700 hover:border-blue-400"
      }`}
    >
      <div className="flex w-full items-start justify-between">
        <div className="text-2xl leading-none">{role.emoji}</div>
        {selected && (
          <span className="text-xs">✓</span>
        )}
      </div>
      <div className="font-semibold text-sm">{role.title}</div>
      <div
        className={`text-xs leading-snug ${
          selected ? "text-white/85" : "text-zinc-500 dark:text-zinc-400"
        }`}
      >
        {role.subtitle}
      </div>
    </button>
  );
}
