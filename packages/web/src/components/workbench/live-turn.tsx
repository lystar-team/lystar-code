import { toLiveToolViewModel } from "../../adapters/live-tool-view-model.ts";
import { committedToolCallIds } from "../../state/chat-lifecycle.ts";
import { Message, MessageContent } from "../ai-elements/message";
import { Shimmer } from "../ai-elements/shimmer";
import { ToolBatch, type ToolBatchAutoCollapse } from "../ai-elements/tool-batch";
import { CompactionActivity } from "./compaction-card";
import type { LiveTurnItem, WorkbenchState } from "../../state/use-workbench";
import type { WorkbenchActions } from "./types";

type LiveTextItem = Extract<LiveTurnItem, { kind: "text" | "thinking" }>;

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

export function LiveTurn({
	state,
	actions,
	autoCollapseTools = true,
}: {
	state: WorkbenchState;
	actions: WorkbenchActions;
	autoCollapseTools?: ToolBatchAutoCollapse;
}) {
	const callIds = committedToolCallIds(state.transcript);
	const liveItems = state.liveTurnItems.filter((item) => item.kind !== "thinking");
	const failed = state.liveTurnActive === false &&
		["failed", "aborted", "interrupted"].includes(state.currentOperation?.status ?? "");
	const thinkingItem = latestThinkingItem(state.liveTurnItems);
	const showStatus = Boolean(
		state.statusText &&
		!state.liveCompaction &&
		(failed || (!liveItems.length && !thinkingItem && state.liveTurnActive !== false)),
	);
	if (!liveItems.length && !showStatus && !state.liveCompaction) return null;

	return (
		<div className="live-turn grid gap-3" aria-live="polite">
			{liveItems.map((item) => {
				if (item.kind === "text") {
					return item.parts.length ? (
						<Message key={item.id} from="assistant">
							<MessageContent>
								<div className="whitespace-pre-wrap break-words text-sm leading-6">
									{item.parts.map((part, index) => (
										<span key={`${item.id}:${index}`}>{part}</span>
									))}
								</div>
							</MessageContent>
						</Message>
					) : null;
				}

				const tools = item.toolIds.flatMap((toolId) => {
					const tool = state.liveTools[toolId];
					if (!tool || callIds.has(toolId)) return [];
					return [toLiveToolViewModel(tool)];
				});
				if (!tools.length) return null;
				return (
					<ToolBatch
						key={`${item.id}:${item.batchId}`}
						className="tool-batch-render-item"
						onOpenPath={(path) => void actions.openResource(path)}
						tools={tools}
						sessionId={state.sessionId}
						autoCollapseWhenComplete={autoCollapseTools}
					/>
				);
			})}
			{state.liveCompaction ? <CompactionActivity state={state.liveCompaction} /> : null}
			{showStatus ? failed ? (
				<div role="alert" className="text-sm text-destructive">{state.statusText}</div>
			) : <Shimmer>{state.statusText}</Shimmer> : null}
		</div>
	);
}

export function ThinkingActivity({ state }: { state: WorkbenchState }) {
	const thinkingItem = latestThinkingItem(state.liveTurnItems);
	if (!thinkingItem) return null;
	const thinkingLine = latestThinkingLine(thinkingItem.parts);
	return (
		<div className="mx-auto w-full max-w-[var(--conversation-width)] shrink-0 px-5 py-2 text-sm font-normal text-muted-foreground sm:px-10" aria-live="polite" role="status">
			<Shimmer as="span" className="block truncate text-sm font-normal">
				{thinkingLine}
			</Shimmer>
		</div>
	);
}
