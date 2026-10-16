import { CheckCircle2, ChevronDownIcon, CircleX, LoaderCircle, WrenchIcon } from "lucide-react";
import { useEffect, useState } from "react";
import type { AgentStepRenderItem } from "./conversation-render-model";
import type { ConversationGroupLayout } from "./conversation-list";
import { Collapsible, CollapsibleTrigger } from "../ui/collapsible";
import { GsapCollapsibleContent } from "../ui/gsap-collapsible-content";
import { formatElapsedDuration } from "./conversation-format";

function AgentStepDuration({ step, clientClockOffsetMs }: Pick<AgentStepRenderItem, "step" | "clientClockOffsetMs">) {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (step.status !== "running") return;
		setNow(Date.now());
		const timer = window.setInterval(() => setNow(Date.now()), 1_000);
		return () => window.clearInterval(timer);
	}, [step.startedAt, step.status]);
	const duration = formatElapsedDuration((step.endedAt ?? now - (clientClockOffsetMs ?? 0)) - step.startedAt);
	return duration ? <span className="shrink-0 text-xs text-muted-foreground">{duration}</span> : null;
}

/** 沿用原分组外观与动画；内部可见行由列表投影提供。 */
export function ConversationGroup({ entry, open, headerRef, headerIndex, padding, children, onOpenChange, onCollapseComplete }: ConversationGroupLayout & {
	entry: Exclude<ConversationGroupLayout["entry"], { kind: "tool-stack" }>;
	onOpenChange: (open: boolean) => void;
	onCollapseComplete: () => void;
}) {
	if (entry.kind === "agent-step") {
		const StatusIcon = entry.step.status === "running" ? LoaderCircle : entry.step.status === "completed" ? CheckCircle2 : CircleX;
		return <Collapsible className="group/agent-step min-w-0 w-full" onOpenChange={onOpenChange} open={open}>
			<CollapsibleTrigger asChild>
				<button ref={headerRef} data-index={headerIndex} data-conversation-row={entry.key}
					aria-label={entry.step.title + "，" + (open ? "收起" : "展开")}
					className={"flex min-h-7 w-full min-w-0 items-center gap-2 rounded-md px-1 py-0.5 text-left transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring " + (open ? "sticky top-0 z-[5] bg-background" : "")}
					data-transcript-resize-anchor type="button">
					<StatusIcon className={"size-4 shrink-0 " + (entry.step.status === "running" ? "animate-spin text-muted-foreground" : entry.step.status === "completed" ? "text-emerald-600 dark:text-emerald-500" : "text-muted-foreground")} />
					<span className="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground">{entry.step.title}</span>
					<AgentStepDuration step={entry.step} clientClockOffsetMs={entry.clientClockOffsetMs} />
					<ChevronDownIcon className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]/agent-step:rotate-180" />
				</button>
			</CollapsibleTrigger>
			<GsapCollapsibleContent open={open} onCollapseComplete={onCollapseComplete} data-transcript-resize-anchor>
				{padding}
				<div className="ml-[7px] grid min-w-0 gap-0 border-l border-border/60 pl-4">{children}</div>
			</GsapCollapsibleContent>
		</Collapsible>;
	}
	return <Collapsible className="group/work-process min-w-0 w-full" onOpenChange={onOpenChange} open={open}>
		<CollapsibleTrigger asChild>
			<button ref={headerRef} data-index={headerIndex} data-conversation-row={entry.key}
				aria-label={"工作过程，" + (open ? "收起" : "展开")}
				className="flex min-h-7 w-full min-w-0 items-center gap-1.5 rounded-md px-1 py-0.5 text-left text-sm text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
				data-transcript-resize-anchor type="button">
				<WrenchIcon className="size-4 shrink-0" />
				<span className="min-w-0 flex-1 text-[13px]">工作过程</span>
				<ChevronDownIcon className="size-4 shrink-0 transition-transform group-data-[state=open]/work-process:rotate-180" />
			</button>
		</CollapsibleTrigger>
		<GsapCollapsibleContent open={open} onCollapseComplete={onCollapseComplete} data-transcript-resize-anchor>
			{padding}<div className="grid min-w-0">{children}</div>
		</GsapCollapsibleContent>
	</Collapsible>;
}
