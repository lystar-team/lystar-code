import { ChevronDown, LoaderCircle, Wrench } from "lucide-react";
import { useState } from "react";
import type { SessionItemViewModel } from "../../adapters/session-view-model";
import { cn } from "../../lib/utils";
import { Collapsible, CollapsibleTrigger } from "../ui/collapsible";
import { GsapCollapsibleContent } from "../ui/gsap-collapsible-content";
import { CodeBlockView } from "./code-block-view";

export function ExtensionActivityCard({
	activity,
}: {
	activity: Extract<SessionItemViewModel, { kind: "extension_activity" }>;
}) {
	const statusLabel = {
		running: "运行中",
		completed: "已调用",
		failed: "出错",
		interrupted: "已中断",
	}[activity.status];
	const durationLabel =
		activity.durationMs === undefined
			? undefined
			: activity.durationMs < 1000
				? `${activity.durationMs} 毫秒`
				: `${(activity.durationMs / 1000).toFixed(1)} 秒`;
	const extensionName = activity.extensionPath.split(/[\\/]/u).at(-1) || activity.extensionPath;
	const hasDetails = Boolean(activity.details || activity.error);
	const failed = activity.status === "failed" || activity.status === "interrupted";
	const [open, setOpen] = useState(false);

	return (
		<div className="extension-activity-card min-w-0" data-testid="extension-activity-card">
			<Collapsible className="group min-w-0" open={open} onOpenChange={setOpen}>
				<CollapsibleTrigger asChild disabled={!hasDetails}>
					<button
						aria-label={`${activity.hook} · ${extensionName}，${statusLabel}${hasDetails ? `，${open ? "收起" : "展开"}详情` : ""}`}
						className="flex min-h-7 w-full min-w-0 items-center gap-1.5 rounded-md px-1 py-0.5 text-left text-sm transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none"
						type="button"
					>
						{activity.status === "running" ? (
							<LoaderCircle className="size-4 shrink-0 animate-spin text-muted-foreground" />
						) : (
							<Wrench className="size-4 shrink-0 text-muted-foreground" />
						)}
						<span
							className="min-w-0 flex-1 truncate font-mono text-[13px] leading-5"
							title={activity.extensionPath}
						>
							{activity.status === "completed" ? "已调用 " : ""}{activity.hook} · {extensionName}
						</span>
						<span className="flex shrink-0 items-center gap-1.5 whitespace-nowrap">
							{failed ? <span aria-label={statusLabel} className="size-1.5 rounded-full bg-destructive" role="img" /> : null}
							{activity.status !== "completed" ? (
								<span className="text-xs text-muted-foreground">{statusLabel}</span>
							) : null}
							{durationLabel ? <span className="text-xs tabular-nums text-muted-foreground">{durationLabel}</span> : null}
							{hasDetails ? (
								<ChevronDown
									className={cn(
										"size-4 shrink-0 text-muted-foreground transition-transform",
										open && "rotate-180",
									)}
								/>
							) : null}
						</span>
					</button>
				</CollapsibleTrigger>
				{hasDetails ? (
					<GsapCollapsibleContent
						className="min-w-0 max-h-[min(32rem,60vh)] overflow-y-auto overflow-x-hidden overscroll-y-auto pb-0.5 pl-6 pr-0 pt-0"
						open={open}
					>
						<div className="grid min-w-0 gap-2">
							{activity.error ? <p className="break-words text-destructive text-sm">{activity.error}</p> : null}
							{activity.details ? (
								<div className="grid min-w-0 gap-1">
									<span className="text-xs text-muted-foreground">Hook 输出</span>
									<CodeBlockView code={activity.details} language="json" showActions={false} />
								</div>
							) : null}
						</div>
					</GsapCollapsibleContent>
				) : null}
			</Collapsible>
		</div>
	);
}
