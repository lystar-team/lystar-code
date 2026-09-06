import { Message, MessageContent, MessageResponse } from "../ai-elements/message";
import { Shimmer } from "../ai-elements/shimmer";
import { ToolBatch } from "../ai-elements/tool-batch";
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

export function LiveTurn({ state, actions }: { state: WorkbenchState; actions: WorkbenchActions }) {
	const liveItems = state.liveTurnItems.filter((item) => item.kind !== "thinking");
	const hasLive = Boolean(state.liveText || state.liveThinking || liveItems.length || state.statusText);
	if (!hasLive) return null;

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
					if (!tool) return [];
					return [
						{
							id: tool.id,
							name: tool.name,
							summary: tool.summary,
							state:
								tool.state === "success"
									? ("output-available" as const)
									: tool.state === "error"
										? ("output-error" as const)
										: tool.state === "cancelled"
											? ("output-cancelled" as const)
											: tool.state === "interrupted"
												? ("output-interrupted" as const)
												: tool.state === "preparing" || tool.state === "queued"
													? ("input-queued" as const)
													: ("input-available" as const),
							detail: tool.result,
							inputPreview: tool.inputPreview,
							diff: tool.diff,
						},
					];
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
						autoCollapseWhenComplete
					/>
				);
			})}
			{state.liveThinking ? (
				<div className="text-sm font-normal text-muted-foreground" aria-live="polite">
					<Shimmer as="span" className="text-sm font-normal">
						{latestThinkingLine(state.liveThinking)}
					</Shimmer>
				</div>
			) : null}
			{!liveItems.length && !state.liveThinking && state.statusText ? <Shimmer>{state.statusText}</Shimmer> : null}
		</div>
	);
}
