import { ChevronDown, CircleAlert, TriangleAlert, Wrench } from "lucide-react";
import { type ReactNode, useState } from "react";
import type { ExtensionEntryGroupRenderItem, TranscriptItemRenderItem } from "./conversation-render-model";
import { Collapsible, CollapsibleTrigger } from "../ui/collapsible";
import { GsapCollapsibleContent } from "../ui/gsap-collapsible-content";

export function ExtensionEntryGroup({
	entry,
	initialOpen,
	onOpenChange,
	renderItem,
}: {
	entry: ExtensionEntryGroupRenderItem;
	initialOpen: boolean;
	onOpenChange: (open: boolean) => void;
	renderItem: (item: TranscriptItemRenderItem) => ReactNode;
}) {
	const [open, setOpen] = useState(initialOpen);
	const notifications = entry.items.flatMap(({ item }) =>
		item.view?.type === "extension_entry" && item.view.notification ? [item.view.notification] : [],
	);
	const errors = notifications.filter((notification) => notification.type === "error").length;
	const warnings = notifications.filter((notification) => notification.type === "warning").length;
	const names = [...new Set(entry.items.flatMap(({ item }) =>
		item.view?.type === "extension_entry"
			? [item.view.notification ? { info: "扩展提示", warning: "扩展警告", error: "扩展错误" }[item.view.notification.type] : item.view.customType]
			: [],
	))];
	const summary = `${names.slice(0, 2).join("、")}${names.length > 2 ? " 等" : ""}`;
	const issueLabel = [errors ? `${errors} 条错误` : "", warnings ? `${warnings} 条警告` : ""].filter(Boolean).join("，");
	return (
		<Collapsible className="group/extension-entries min-w-0" open={open} onOpenChange={(nextOpen) => {
			setOpen(nextOpen);
			onOpenChange(nextOpen);
		}}>
			<CollapsibleTrigger asChild>
				<button
					aria-label={`扩展记录：${summary}，${entry.items.length} 条${issueLabel ? `，${issueLabel}` : ""}，${open ? "收起" : "展开"}`}
					className="flex min-h-7 w-full min-w-0 items-center gap-1.5 rounded-md px-1 py-0.5 text-left text-sm text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
					data-transcript-anchor-key={entry.key}
					data-transcript-resize-anchor
					type="button"
				>
					{errors ? <CircleAlert className="size-4 shrink-0 text-destructive" /> : warnings ? <TriangleAlert className="size-4 shrink-0 text-[var(--warning)]" /> : <Wrench className="size-4 shrink-0" />}
					<span className="min-w-0 flex-1 truncate text-[13px]" title={names.join("、")}>
						扩展记录：{summary}
					</span>
					<span className="shrink-0 text-xs tabular-nums">{entry.items.length} 条</span>
					{issueLabel ? <span className={`shrink-0 text-xs ${errors ? "text-destructive" : "text-[var(--warning)]"}`}>{issueLabel}</span> : null}
					<ChevronDown className="size-4 shrink-0 transition-transform group-data-[state=open]/extension-entries:rotate-180" />
				</button>
			</CollapsibleTrigger>
			<GsapCollapsibleContent open={open} className="min-w-0 pl-5 pt-1" data-transcript-resize-anchor>
				{entry.items.map((item) => <div className="min-w-0" key={item.key}>{renderItem(item)}</div>)}
			</GsapCollapsibleContent>
		</Collapsible>
	);
}
