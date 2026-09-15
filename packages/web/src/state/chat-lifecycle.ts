import type { SessionProgress, ToolActivity } from "@lystar/code-web-protocol";
import type { PromptAttachmentPreview, QueuedUserPrompt, WebSessionSnapshot, WebTranscriptItem } from "../types.ts";
import type { LiveTurnItem, WorkbenchState } from "./use-workbench.ts";

const INTERNAL_FILE_BLOCK_PATTERN = /<file\b[^>]*>[\s\S]*?<\/file>/gu;
const FILE_NAME_ATTRIBUTE_PATTERN = /\bfilename="([^"]*)"/u;
const FILE_PATH_ATTRIBUTE_PATTERN = /\bname="([^"]*)"/u;
const INTERNAL_PROMPT_BLOCK_PATTERNS = [
	INTERNAL_FILE_BLOCK_PATTERN,
	/<skill\b[^>]*\blocation="[^"]+"[^>]*>[\s\S]*?<\/skill>/gu,
	/<skill_references\b[^>]*>[\s\S]*?<\/skill_references>/gu,
] as const;

function decodeFileAttribute(value: string): string {
	return value.replace(/&quot;/gu, '"').replace(/&apos;/gu, "'").replace(/&lt;/gu, "<").replace(/&gt;/gu, ">");
}

export function stripInternalPromptContent(value: string): string {
	let projected = value;
	for (const pattern of INTERNAL_PROMPT_BLOCK_PATTERNS) projected = projected.replace(pattern, "");
	return projected
		.replace(/[ \t]+\n/gu, "\n")
		.replace(/\n{3,}/gu, "\n\n")
		.trim();
}

export function promptDisplayText(value: string): string {
	const visible = stripInternalPromptContent(value);
	if (visible) return visible;
	const filenames = new Set<string>();
	for (const match of value.matchAll(INTERNAL_FILE_BLOCK_PATTERN)) {
		const tag = match[0];
		const rawFilename = tag.match(FILE_NAME_ATTRIBUTE_PATTERN)?.[1] ?? tag.match(FILE_PATH_ATTRIBUTE_PATTERN)?.[1];
		const filename = decodeFileAttribute(rawFilename ?? "").trim().split(/[\\/]/u).at(-1);
		if (filename) filenames.add(filename);
	}
	return filenames.size > 0 ? `附件：${[...filenames].join("、")}` : "";
}

const ACTIVE_TOOL_ACTIVITY_STATES = new Set<ToolActivity["state"]>(["preparing", "queued", "running"]);

export function hasActiveToolActivities(activities: readonly ToolActivity[] | undefined): boolean {
	return Boolean(activities?.some((activity) => ACTIVE_TOOL_ACTIVITY_STATES.has(activity.state)));
}

export function hasActiveSessionSnapshot(
	snapshot: Pick<WebSessionSnapshot, "activity" | "phase" | "toolActivities">,
): boolean {
	return (
		snapshot.activity === "running" ||
		snapshot.activity === "waiting_for_input" ||
		["turn", "compaction", "retry", "waiting_for_input"].includes(snapshot.phase) ||
		hasActiveToolActivities(snapshot.toolActivities)
	);
}

const ACTIVE_OPERATION_STATUSES = new Set(["accepted", "running", "waiting_for_input"]);

export function hasActiveSessionWork(
	state: Pick<WorkbenchState, "session" | "currentOperation" | "liveTools" | "liveTurnActive" | "liveCompaction">,
): boolean {
	const liveRuntimeMayBeActive = state.liveTurnActive !== false;
	return Boolean(
		(state.session && hasActiveSessionSnapshot(state.session)) ||
		state.liveTurnActive ||
		(liveRuntimeMayBeActive && Object.values(state.liveTools).some((tool) => tool.status === "running")) ||
		(liveRuntimeMayBeActive &&
			state.liveCompaction &&
			["running", "waiting_retry"].includes(state.liveCompaction.status)) ||
		(state.currentOperation && ACTIVE_OPERATION_STATUSES.has(state.currentOperation.status)),
	);
}

export function canSendPrompt(
	state: Pick<WorkbenchState, "sessionId" | "sessionReady" | "readOnly" | "connected">,
): boolean {
	return Boolean(state.sessionId && state.sessionReady && state.connected && !state.readOnly);
}

export async function submitPromptWithFollowUpFallback<T>(
	mode: "prompt" | "steer" | "follow-up",
	submit: (mode: "prompt" | "steer" | "follow-up") => Promise<T>,
): Promise<{ result: T; submittedMode: "prompt" | "steer" | "follow-up" }> {
	try {
		return { result: await submit(mode), submittedMode: mode };
	} catch (error) {
		if (mode !== "prompt" || (error as { code?: unknown }).code !== "session_operation_active") throw error;
		return { result: await submit("follow-up"), submittedMode: "follow-up" };
	}
}

export interface PendingUserPrompt {
	id: string;
	text: string;
	attachments: PromptAttachmentPreview[];
	afterEntryId?: string;
	queueId?: string;
}

type UserTranscriptView = Extract<NonNullable<WebTranscriptItem["view"]>, { type: "user" }>;

function normalizePromptComparisonText(value: string): string {
	return promptDisplayText(value).replace(/\s+/gu, " ").trim();
}

function projectedAttachmentShapeMatches(prompt: PendingUserPrompt, view: UserTranscriptView): boolean {
	const expectedImages = prompt.attachments.filter((attachment) => attachment.mediaType.startsWith("image/")).length;
	if ((view.images?.length ?? 0) !== expectedImages) return false;

	const expectedFiles = prompt.attachments
		.filter((attachment) => !attachment.mediaType.startsWith("image/"))
		.map((attachment) => `${attachment.filename}\u0000${attachment.mediaType}`)
		.filter((key, index, values) => values.indexOf(key) === index)
		.sort();
	const projectedFiles = (view.files ?? [])
		.map((file) => `${file.filename}\u0000${file.mimeType}`)
		.filter((key, index, values) => values.indexOf(key) === index)
		.sort();
	return expectedFiles.length === projectedFiles.length && expectedFiles.every((key, index) => key === projectedFiles[index]);
}

function removeProjectedImageLabels(value: string, view: UserTranscriptView): string {
	let normalized = normalizePromptComparisonText(value);
	for (const alt of [...(view.images ?? [])].reverse().flatMap((image) => (image.alt ? [image.alt] : []))) {
		const label = normalizePromptComparisonText(alt);
		if (!label) continue;
		if (normalized === label) {
			normalized = "";
			continue;
		}
		const suffix = ` ${label}`;
		if (normalized.endsWith(suffix)) normalized = normalized.slice(0, -suffix.length).trim();
	}
	return normalized;
}

function promptTextMatches(prompt: PendingUserPrompt, view: UserTranscriptView): boolean {
	const pendingText = normalizePromptComparisonText(prompt.text);
	const committedText = normalizePromptComparisonText(view.text);
	if (pendingText === committedText) return true;
	return prompt.attachments.length > 0 && pendingText === removeProjectedImageLabels(view.text, view);
}

export function reconcilePendingUserPrompts(
	pending: readonly PendingUserPrompt[],
	items: readonly WebTranscriptItem[],
): PendingUserPrompt[] {
	const remaining = [...pending];
	for (const item of items) {
		const view = item.view;
		if (view?.type !== "user") continue;
		const attachmentMatchIndex = remaining.findIndex(
			(prompt) =>
				prompt.attachments.length > 0 &&
				projectedAttachmentShapeMatches(prompt, view) &&
				(!view.text.trim() || promptTextMatches(prompt, view)),
		);
		const index = attachmentMatchIndex >= 0 ? attachmentMatchIndex : remaining.findIndex((prompt) => promptTextMatches(prompt, view));
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
