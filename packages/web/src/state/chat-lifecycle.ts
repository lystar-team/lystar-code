import type { SessionProgress, ToolActivity } from "@lystar/code-web-protocol";
import type { PromptAttachmentPreview, QueuedUserPrompt, WebTranscriptItem } from "../types.ts";
import type { LiveTurnItem, WorkbenchState } from "./use-workbench.ts";

const ACTIVE_TOOL_ACTIVITY_STATES = new Set<ToolActivity["state"]>(["preparing", "queued", "running"]);

export function hasActiveToolActivities(activities: readonly ToolActivity[] | undefined): boolean {
	return Boolean(activities?.some((activity) => ACTIVE_TOOL_ACTIVITY_STATES.has(activity.state)));
}

const ACTIVE_OPERATION_STATUSES = new Set(["accepted", "running", "waiting_for_input"]);

export function hasActiveSessionWork(
	state: Pick<WorkbenchState, "session" | "currentOperation" | "liveTools" | "liveTurnActive" | "liveCompaction">,
): boolean {
	return Boolean(
		state.session?.activity === "running" ||
		state.session?.activity === "waiting_for_input" ||
		state.liveTurnActive ||
		hasActiveToolActivities(state.session?.toolActivities) ||
		Object.values(state.liveTools).some((tool) => tool.status === "running") ||
		(state.liveCompaction && ["running", "waiting_retry"].includes(state.liveCompaction.status)) ||
		(state.currentOperation && ACTIVE_OPERATION_STATUSES.has(state.currentOperation.status)),
	);
}

export function canSendPrompt(
	state: Pick<WorkbenchState, "sessionId" | "sessionReady" | "readOnly" | "connected">,
): boolean {
	return Boolean(state.sessionId && state.sessionReady && state.connected && !state.readOnly);
}

export interface PendingUserPrompt {
	id: string;
	text: string;
	attachments: PromptAttachmentPreview[];
	afterEntryId?: string;
}

export function reconcilePendingUserPrompts(
	pending: readonly PendingUserPrompt[],
	items: readonly WebTranscriptItem[],
): PendingUserPrompt[] {
	const remaining = [...pending];
	for (const item of items) {
		const view = item.view;
		if (view?.type !== "user") continue;
		const index = remaining.findIndex((prompt) => prompt.text === view.text);
		if (index >= 0) remaining.splice(index, 1);
	}
	return remaining;
}

export function removeQueuedUserPrompt(pending: readonly QueuedUserPrompt[], id: string): QueuedUserPrompt[] {
	return pending.filter((prompt) => prompt.id !== id);
}
export function removeQueuedUserPromptByText(pending: readonly QueuedUserPrompt[], text: string): QueuedUserPrompt[] {
	const index = pending.findIndex((prompt) => prompt.text === text);
	if (index < 0) return [...pending];
	return [...pending.slice(0, index), ...pending.slice(index + 1)];
}

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
	if (operation && operation.sessionId !== sessionId) return current;
	// WebSocket 可以先于 HTTP 响应到达，不能用 Accepted 覆盖运行中或终态。
	const latest = current.currentOperation;
	if (latest && (!operation || latest.updatedAt >= operation.updatedAt)) return current;
	return { ...current, currentOperation: operation ?? latest };
}
