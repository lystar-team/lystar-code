import { Shimmer } from "../ai-elements/shimmer";
import type { LiveTurnItem, WorkbenchState } from "../../state/use-workbench";

function latestThinkingItem(items: readonly LiveTurnItem[]): Extract<LiveTurnItem, { kind: "thinking" }> | undefined {
	for (let index = items.length - 1; index >= 0; index--) {
		const item = items[index];
		if (item?.kind === "thinking") return item;
	}
	return undefined;
}

function latestThinkingLine(parts: readonly string[]): string {
	let line = "";
	for (let index = parts.length - 1; index >= 0; index--) {
		const part = parts[index] ?? "";
		const newline = part.lastIndexOf("\n");
		line = newline >= 0 ? part.slice(newline + 1) + line : part + line;
		if (newline >= 0 || line.length >= 2048) break;
	}
	return line
		.slice(-2048)
		.trim()
		.replace(/\*\*\s*(.*?)\s*\*\*/gu, "$1")
		.replace(/__\s*(.*?)\s*__/gu, "$1");
}

export function LiveStatus({ state }: { state: WorkbenchState }) {
	const failed = state.liveTurnActive === false &&
		["failed", "aborted", "interrupted"].includes(state.currentOperation?.status ?? "");
	const showStatus = Boolean(
		state.statusText &&
		!state.liveCompaction &&
		(failed || (!state.liveTurnItems.some((item) => item.kind === "text" || item.kind === "tools") && state.liveTurnActive !== false)),
	);
	if (!showStatus) return null;
	return failed ? (
		<div role="alert" className="text-sm text-destructive">{state.statusText}</div>
	) : (
		<Shimmer>{state.statusText}</Shimmer>
	);
}

export function ThinkingActivity({ state }: { state: WorkbenchState }) {
	const thinkingItem = latestThinkingItem(state.liveTurnItems);
	if (!thinkingItem) return null;
	const thinkingLine = latestThinkingLine(thinkingItem.parts);
	return (
		<div
			className="mx-auto w-full max-w-[var(--conversation-width)] shrink-0 px-5 py-2 text-sm font-normal text-muted-foreground sm:px-10"
			aria-live="polite"
			role="status"
		>
			<Shimmer as="span" className="block truncate text-sm font-normal">
				{thinkingLine}
			</Shimmer>
		</div>
	);
}
