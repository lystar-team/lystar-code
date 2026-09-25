import { CircleAlert } from "lucide-react";
import type { HookActivityGroupRenderItem } from "./conversation-render-model";

export function HookActivityGroup({ entry }: { entry: HookActivityGroupRenderItem }) {
	const error = entry.items.flatMap(({ item }) => {
		const view = item.view;
		return view?.type === "extension_activity" && view.error?.trim() ? [view.error.trim()] : [];
	})[0]?.split(/\r?\n/u, 1)[0];
	const message = error && error.length > 160 ? `${error.slice(0, 160)}…` : error;

	return (
		<div
			className="flex min-w-0 max-w-full items-start gap-2 py-1 text-sm text-destructive"
			data-transcript-anchor-key={entry.key}
			role="status"
		>
			<CircleAlert className="mt-0.5 size-4 shrink-0" />
			<div className="min-w-0 max-w-full">
				<div>Hook 出错或中断 · {entry.items.length} 条</div>
				{message ? <p className="line-clamp-2 max-w-full [overflow-wrap:anywhere]">{message}</p> : null}
			</div>
		</div>
	);
}
