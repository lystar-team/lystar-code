import type { SessionProgress } from "@lystar/code-web-protocol";
import type { WebTranscriptItem } from "../types.ts";
import type { LiveTurnItem, WorkbenchState } from "./use-workbench.ts";

export function clearsThinking(progress: SessionProgress): boolean {
	return (
		progress.type === "assistant_delta" ||
		progress.type === "user_message" ||
		progress.type === "tool_start" ||
		progress.type === "tool_update" ||
		(progress.type === "tool_state" &&
			["preparing", "queued", "running"].includes(progress.activity.state)) ||
		progress.type === "phase"
	);
}

export function committedToolCallIds(items: readonly WebTranscriptItem[]): Set<string> {
	return new Set(
		items.flatMap((item) =>
			item.view?.type === "tool_call"
				? item.view.calls.map((call) => call.id)
				: item.view?.type === "tool_result"
					? [item.view.callId]
					: [],
		),
	);
}

// 流式内容只覆盖尚未落盘的 Assistant 消息；工具结果留在原调用位置更新。
export function reconcileCommittedTurn(
	current: WorkbenchState,
	items: readonly WebTranscriptItem[],
	revision: number,
): WorkbenchState {
	const assistantCommitted =
		revision > (current.liveTurnStartRevision ?? -1) &&
		items.some((item) => ["assistant", "thinking", "tool_call"].includes(item.view?.type ?? ""));
	const callIds = committedToolCallIds(items);
	return {
		...current,
		...(assistantCommitted ? { liveTurnStartRevision: revision } : {}),
		liveTurnItems: current.liveTurnItems.flatMap((item): LiveTurnItem[] => {
			if (item.kind !== "tools") return assistantCommitted ? [] : [item];
			const toolIds = item.toolIds.filter((id) => !callIds.has(id));
			return toolIds.length ? [{ ...item, toolIds }] : [];
		}),
	};
}

export function applyPromptAccepted(
	current: WorkbenchState,
	sessionId: string,
	operation: WorkbenchState["currentOperation"],
): WorkbenchState {
	if (current.sessionId !== sessionId) return current;
	// WebSocket 可以先于 HTTP 响应到达，不能用 Accepted 覆盖运行中或终态。
	const latest = current.currentOperation;
	if (latest && (!operation || latest.updatedAt >= operation.updatedAt)) return current;
	return { ...current, currentOperation: operation ?? latest };
}
