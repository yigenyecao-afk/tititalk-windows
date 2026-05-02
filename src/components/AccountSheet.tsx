import AccountSection from "./AccountSection";
import TypelessSheet from "./TypelessSheet";

/// 账户与计费 sheet —— 把现有 AccountSection（登录/quota/升级 catalog）整体
/// 嵌进来，外面套 TypelessSheet 容器跟设置 sheet 视觉一致。
export default function AccountSheet({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  return (
    <TypelessSheet open={open} title="账户与计费" onClose={onClose}>
      <AccountSection />
    </TypelessSheet>
  );
}
