import { CircleAlert, CircleCheck, CircleX, ChevronDown, LoaderCircle, RotateCw, Sparkles } from "lucide-react";
import { type MouseEvent as ReactMouseEvent, useState } from "react";
import type { LiveCompactionState } from "../../state/compaction-state";
import { cn } from "../../lib/utils";
import { MessageResponse } from "../ai-elements/message";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../ui/collapsible";

function reasonLabel(reason: LiveCompactionState["reason"]): string | undefined {
	if (reason === "manual") return "手动整理";
	if (reason === "threshold") return "达到阈值";
	if (reason === "overflow") return "上下文已满";
	return undefined;
}

function statusLabel(state: LiveCompactionState): string {
	if (state.status === "running") {
		if (state.retry?.status === "waiting") return "等待重试摘要";
		if (state.retry?.status === "running") return "正在重试摘要";
		if (state.retry?.status === "completed") return "重试完成，继续整理";
		return "正在整理上下文";
	}
	if (state.status === "waiting_retry") return "摘要生成失败，等待重试";
	if (state.status === "completed") return "上下文已整理";
	if (state.status === "cancelled") return "上下文整理已停止";
	return "上下文整理失败";
}

function statusClassName(state: LiveCompactionState): string {
	return state.status === "failed"
		? "text-destructive"
		: state.status === "cancelled"
			? "text-muted-foreground"
			: "text-foreground";
}

function canCollapseFromContent(event: ReactMouseEvent<HTMLElement>): boolean {
	if (event.defaultPrevented) return false;
	const target = event.target;
	if (target instanceof Element && target.closest("button, a, input, textarea, select, [role=button]")) return false;
	const selection = window.getSelection();
	return !selection || selection.isCollapsed;
}

export function CompactionActivity({ state }: { state: LiveCompactionState }) {
	const Icon =
		state.status === "failed"
			? CircleAlert
			: state.status === "cancelled"
				? CircleX
				: state.status === "completed"
					? CircleCheck
					: state.retry?.status === "waiting"
						? RotateCw
						: state.status === "running"
							? LoaderCircle
							: Sparkles;
		const reason = reasonLabel(state.reason);
		const detail = [statusLabel(state), reason].filter(Boolean).join(" · ");

	return (
		<div className="min-w-0" aria-live="polite" role="status">
			<div className="flex min-h-8 w-full min-w-0 items-center gap-1.5 rounded-md px-1 py-1 text-left text-sm">
				<Icon
					className={cn(
						"size-4 shrink-0",
						state.status === "running" && "animate-spin",
						statusClassName(state),
					)}
				/>
				<span className={cn("min-w-0 flex-1 truncate font-medium text-sm", statusClassName(state))}>
					上下文压缩
				</span>
				<span className="min-w-0 shrink-0 truncate text-xs text-muted-foreground" title={detail}>
					{detail}
				</span>
			</div>
			{state.error ? <div className="break-words pl-6 pr-1 text-xs text-destructive">{state.error}</div> : null}
		</div>
	);
}

export function CompactionSummaryCard({
	text,
	tokensBefore,
	onOpenPath,
}: {
	text: string;
	tokensBefore?: number;
	onOpenPath: (path: string) => void;
}) {
	const [open, setOpen] = useState(false);
	const tokenLabel = tokensBefore === undefined ? undefined : `${new Intl.NumberFormat("zh-CN").format(tokensBefore)} Token`;

	return (
		<Collapsible
			className={cn(
				"group/compaction relative min-w-0 w-full",
				open && "overflow-hidden rounded-md border border-border/60 bg-muted/20",
			)}
			open={open}
			onOpenChange={setOpen}
		>
			<CollapsibleTrigger asChild>
				<button
					type="button"
					className="flex min-h-8 w-full min-w-0 items-center gap-1.5 rounded-md px-1 py-1 text-left text-sm transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
					aria-label={`${open ? "收起" : "展开"}上下文压缩摘要`}
				>
					<Sparkles className="size-4 shrink-0 text-muted-foreground" />
					<span className="min-w-0 flex-1 truncate font-medium text-sm text-muted-foreground">上下文压缩</span>
					{tokenLabel ? <span className="shrink-0 text-xs text-muted-foreground">{tokenLabel}</span> : null}
					<ChevronDown
						className={cn("size-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")}
					/>
				</button>
			</CollapsibleTrigger>
			<CollapsibleContent
				className="relative min-w-0 overflow-hidden bg-muted/20 pb-0.5 pl-6 pr-1 pt-0 data-[state=closed]:animate-out data-[state=open]:animate-in"
				onClick={(event) => {
					event.stopPropagation();
					if (canCollapseFromContent(event)) setOpen(false);
				}}
			>
				<div className="min-w-0 pb-2 text-sm">
					<MessageResponse
						mode="static"
						parseIncompleteMarkdown
						linkSafety={{ enabled: true }}
						controls={{ code: { copy: true, download: true }, table: { copy: true, download: true } }}
						onOpenPath={onOpenPath}
					>
						{text || " "}
					</MessageResponse>
				</div>
			</CollapsibleContent>
		</Collapsible>
	);
}
