import { toLiveToolViewModel } from "../../adapters/live-tool-view-model.ts";
import { committedToolCallIds } from "../../state/chat-lifecycle.ts";
import { Message, MessageContent, MessageResponse } from "../ai-elements/message";
import { Shimmer } from "../ai-elements/shimmer";
import { ToolBatch, type ToolBatchAutoCollapse } from "../ai-elements/tool-batch";
import type { WorkbenchState } from "../../state/use-workbench";
import type { WorkbenchActions } from "./types";

function latestThinkingLine(text: string): string {
	const lines = text
		.replace(/\r\n?/gu, "\n")
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
	const line = lines[lines.length - 1] ?? text.trim();
	return line.replace(/\*\*\s*(.*?)\s*\*\*/gu, "$1").replace(/__\s*(.*?)\s*__/gu, "$1");
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
	const showStatus = Boolean(state.statusText && (failed ||
		(!liveItems.length && !state.liveThinking && state.liveTurnActive !== false)));
	if (!liveItems.length && !showStatus) return null;

	return (
		<div className="live-turn grid gap-3" aria-live="polite">
			{liveItems.map((item) => {
				if (item.kind === "text") {
					return item.text ? (
						<Message key={item.id} from="assistant">
							<MessageContent>
								<MessageResponse
									mode="streaming"
									parseIncompleteMarkdown
									onOpenPath={(path) => void actions.openResource(path)}
								>
									{item.text}
								</MessageResponse>
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
						tools={tools}
						sessionId={state.sessionId}
						onOpenPath={(path) => void actions.openResource(path)}
						initialOpen={tools.some(
							(tool) => tool.state === "input-available" || tool.state === "input-queued",
						)}
						autoCollapseWhenComplete={autoCollapseTools}
					/>
				);
			})}
			{showStatus ? failed ? (
				<div role="alert" className="text-sm text-destructive">{state.statusText}</div>
			) : <Shimmer>{state.statusText}</Shimmer> : null}
		</div>
	);
}

export function ThinkingActivity({ state }: { state: WorkbenchState }) {
	if (!state.liveThinking) return null;
	return (
		<div className="mx-auto w-full max-w-[var(--conversation-width)] shrink-0 px-5 py-2 text-sm font-normal text-muted-foreground sm:px-10" aria-live="polite" role="status">
			<Shimmer as="span" className="block truncate text-sm font-normal">
				{latestThinkingLine(state.liveThinking)}
			</Shimmer>
		</div>
	);
}
