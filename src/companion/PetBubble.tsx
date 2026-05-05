// Wave 4 — PetBubble: 出现/消失带 fade+rise 动画。snapshot.bubble 为 null 时
// 不渲染（CSS 让它直接 display:none，避免空白节点）。
//
// 设计：白底 + signal-orange 描边箭头指向宠物头顶；最大 14em；
// chattiness=0 时 PetEngine 永不喂值，这里也不会渲染。

interface Props {
  text: string | null;
}

export function PetBubble({ text }: Props) {
  if (!text) return null;
  return (
    <div className="pet-bubble" role="status" aria-live="polite">
      {text}
    </div>
  );
}
