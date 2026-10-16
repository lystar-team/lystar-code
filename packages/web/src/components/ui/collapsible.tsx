import { useControllableState } from "@radix-ui/react-use-controllable-state";
import { Collapsible as CollapsiblePrimitive } from "radix-ui";

type CollapsibleProps = React.ComponentProps<typeof CollapsiblePrimitive.Root> & {
  collapseOnContentClick?: boolean;
};

function Collapsible({
  collapseOnContentClick = false,
  open: controlledOpen,
  defaultOpen = false,
  onOpenChange,
  onClick,
  disabled,
  ...props
}: CollapsibleProps) {
  const [open, setOpen] = useControllableState({
    prop: controlledOpen,
    defaultProp: defaultOpen,
    onChange: onOpenChange,
  });

  return (
    <CollapsiblePrimitive.Root
      data-slot="collapsible"
      {...props}
      disabled={disabled}
      open={open}
      onOpenChange={setOpen}
      onClick={(event) => {
        onClick?.(event);
        if (!collapseOnContentClick || !open || disabled || event.defaultPrevented || event.button !== 0) return;
        const target = event.target;
        if (!(target instanceof Element)) return;
        // 嵌套卡片只处理自身点击，保留按钮、页签、链接和文本选择操作。
        if (target.closest('[data-slot="collapsible"]') !== event.currentTarget) return;
        if (target.closest('button, a, input, textarea, select, label, summary, details, [role="button"], [role="tab"], [role="checkbox"], [role="switch"], [role="slider"], [contenteditable]:not([contenteditable="false"])')) return;
        const selection = event.currentTarget.ownerDocument.getSelection();
        if (selection && !selection.isCollapsed) return;
        event.stopPropagation();
        setOpen(false);
      }}
    />
  );
}

function CollapsibleTrigger({
  ...props
}: React.ComponentProps<typeof CollapsiblePrimitive.CollapsibleTrigger>) {
  return (
    <CollapsiblePrimitive.CollapsibleTrigger
      data-slot="collapsible-trigger"
      {...props}
    />
  )
}

function CollapsibleContent({
  ...props
}: React.ComponentProps<typeof CollapsiblePrimitive.CollapsibleContent>) {
  return (
    <CollapsiblePrimitive.CollapsibleContent
      data-slot="collapsible-content"
      {...props}
    />
  )
}

export { Collapsible, CollapsibleTrigger, CollapsibleContent }
