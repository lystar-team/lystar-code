import { mergeWebSearchProgress } from "@lystar/code-web-protocol";
import type {
	AgentStep,
	SessionProgress,
	ToolActivity,
	ToolActivityState,
	ToolDiff,
} from "@lystar/code-web-protocol";
import type {
	QueuedUserPrompt,
	SubagentSnapshot,
	WebSessionSnapshot,
	WebTranscriptItem,
} from "../types.ts";
import {
	committedToolCallIds,
	hasActiveSessionSnapshot,
	matchPendingUserPrompts,
	promptDisplayText,
	reconcilePendingUserPrompts,
	reconcileQueuedUserPromptCounts,
} from "./chat-lifecycle.ts";
import { restoreCompactionState, updateCompactionState } from "./compaction-state.ts";
import { mergeImageGenerationSummary, mergeWebSearchToolSummary, shouldJoinLiveToolBatch } from "./tool-batching.ts";
import type {
	LiveTool,
	LiveTurnItem,
	SubagentConversationState,
	WorkbenchState,
} from "./workbench-types.ts";

export function appendLiveTextBlock(
	items: LiveTurnItem[],
	kind: "text" | "thinking",
	text: string,
	id: string,
	turnId: number,
	stepId?: string,
	blockId?: string,
): LiveTurnItem[] {
	if (!text) return items;
	const last = items.at(-1);
	if (last?.kind === kind && last.turnId === turnId && last.stepId === stepId && last.blockId === blockId)
		return [...items.slice(0, -1), { ...last, parts: [...last.parts, text] }];
	return [...items, { id, kind, parts: [text], turnId, ...(stepId ? { stepId } : {}), ...(blockId ? { blockId } : {}) }];
}

export function restoreLiveMessage(
	current: WorkbenchState,
	blocks: ReadonlyArray<{ blockId: string; kind: "text" | "thinking"; text: string } | { blockId: string; kind: "tool"; toolCallId: string }>,
	stepId?: string,
): WorkbenchState {
	const items: LiveTurnItem[] = current.liveTurnItems.filter((item) => item.kind === "user" || item.kind === "compaction");
	const persistedTools = committedToolCallIds(current.transcript);
	for (const block of blocks) {
		if (block.kind === "tool") {
			if (persistedTools.has(block.toolCallId)) continue;
			const existing = current.liveTurnItems.find((item) => item.kind === "tools" && item.toolIds.includes(block.toolCallId));
			const tool = current.liveTools[block.toolCallId];
			if (existing?.kind === "tools") items.push({ ...existing, toolIds: [block.toolCallId] });
			else items.push({ id: `restored-tool:${block.toolCallId}`, kind: "tools", turnId: current.liveTurnId, batchId: tool?.batchId ?? `restored-tool:${block.toolCallId}`, toolIds: [block.toolCallId] });
			continue;
		}
		const existing = current.liveTurnItems.find((item) => (item.kind === "text" || item.kind === "thinking") && item.blockId === block.blockId);
		items.push({ id: existing?.id ?? `restored:${block.blockId}`, kind: block.kind, blockId: block.blockId, parts: [block.text], turnId: current.liveTurnId, ...(stepId ? { stepId } : {}) });
	}
	const recoveredTools = new Set(items.flatMap((item) => item.kind === "tools" ? item.toolIds : []));
	for (const item of current.liveTurnItems) {
		if (item.kind === "tools") {
			const toolIds = item.toolIds.filter((id) => !persistedTools.has(id) && !recoveredTools.has(id));
			if (toolIds.length) items.push({ ...item, toolIds });
		}
	}
	return { ...current, liveTurnItems: items, liveTurnActive: items.some((item) => item.kind !== "user") };
}

export function appendLiveToolBlock(
	items: LiveTurnItem[],
	batchId: string,
	toolCallId: string,
	id: string,
	turnId: number,
): LiveTurnItem[] {
	const last = items.at(-1);
	if (last?.kind === "tools" && last.turnId === turnId && last.batchId === batchId) {
		if (last.toolIds.includes(toolCallId)) return items;
		return [...items.slice(0, -1), { ...last, toolIds: [...last.toolIds, toolCallId] }];
	}
	return [...items, { id, kind: "tools", turnId, batchId, toolIds: [toolCallId] }];
}

export function ensureLiveCompactionMarker(
	items: LiveTurnItem[],
	turnId: number,
	stepId?: string,
): LiveTurnItem[] {
	const markerId = `live-compaction:${turnId}`;
	const existingIndex = items.findIndex((item) => item.kind === "compaction" && item.id === markerId);
	if (existingIndex < 0) return [...items, { id: markerId, kind: "compaction", turnId, ...(stepId ? { stepId } : {}) }];
	const existing = items[existingIndex];
	if (existing?.kind !== "compaction" || existing.stepId || !stepId) return items;
	return [...items.slice(0, existingIndex), { ...existing, stepId }, ...items.slice(existingIndex + 1)];
}

export function runningAgentStepId(steps: Readonly<Record<string, AgentStep>>): string | undefined {
	const runningSteps = Object.values(steps).filter((step) => step.status === "running");
	return runningSteps.length === 1 ? runningSteps[0]?.id : undefined;
}

export function detachFinalTextFromCompletedStep(
	items: LiveTurnItem[],
	steps: Readonly<Record<string, AgentStep>>,
): LiveTurnItem[] {
	const lastCompletedStep = Object.values(steps)
		.reverse()
		.find((step) => step.status === "completed");
	if (!lastCompletedStep) return items;

	for (let index = items.length - 1; index >= 0; index--) {
		const item = items[index];
		if (item?.kind !== "text") continue;
		if (item.stepId !== lastCompletedStep.id) return items;
		const { stepId: _stepId, ...detached } = item;
		return [...items.slice(0, index), detached, ...items.slice(index + 1)];
	}
	return items;
}

export function appendLiveUserPrompt(
	items: LiveTurnItem[],
	prompt: QueuedUserPrompt,
	turnId: number,
	afterEntryId: string | undefined,
	stepId?: string,
): LiveTurnItem[] {
	const id = `optimistic-user:${prompt.id}`;
	if (items.some((item) => item.id === id)) return items;
	return [
		...items,
		{
			id,
			kind: "user",
			turnId,
			queueId: prompt.id,
			text: prompt.text,
			displayText: prompt.displayText,
			attachments: prompt.attachments,
			afterEntryId,
			sentAt: Date.now(),
			...(stepId ? { stepId } : {}),
			status: "queued",
		},
	];
}

export function removeLiveUserPrompt(items: LiveTurnItem[], queueId: string): LiveTurnItem[] {
	return items.filter((item) => item.kind !== "user" || item.queueId !== queueId);
}

export function markLiveUserPromptProcessing(items: LiveTurnItem[], queueId: string | undefined, text: string): LiveTurnItem[] {
	let matched = false;
	return items.map((item) => {
		if (matched || item.kind !== "user" || item.status === "processing") return item;
		if (queueId ? item.queueId !== queueId : item.text !== text) return item;
		matched = true;
		return { ...item, status: "processing" };
	});
}

/** 记住每个已落盘用户消息对应的客户端发送时刻。 */
export function withPromptSendTimes(
	current: WorkbenchState,
	transcript: readonly WebTranscriptItem[],
): Record<string, number> {
	const matches = matchPendingUserPrompts(current.pendingUserPrompts, transcript);
	if (matches.length === 0) return current.promptSendTimes;
	let next: Record<string, number> | undefined;
	for (const match of matches) {
		if (match.prompt.sentAt === undefined) continue;
		next ??= { ...current.promptSendTimes };
		next[match.entryId] = match.prompt.sentAt;
	}
	return next ?? current.promptSendTimes;
}

export function reconcileLiveUserPrompts(items: LiveTurnItem[], transcript: readonly WebTranscriptItem[]): LiveTurnItem[] {
	const liveUsers = items.filter((item): item is Extract<LiveTurnItem, { kind: "user" }> => item.kind === "user");
	if (!liveUsers.length) return items;
	const remainingIds = new Set(
		reconcilePendingUserPrompts(
			liveUsers.map((item) => ({
				id: item.id,
				text: item.text,
				attachments: item.attachments,
				afterEntryId: item.afterEntryId,
				queueId: item.queueId,
			})),
			transcript,
		).map((item) => item.id),
	);
	return items.filter((item) => item.kind !== "user" || remainingIds.has(item.id));
}

export function mergeToolDiff(previous: ToolDiff | undefined, next: ToolDiff | undefined): ToolDiff | undefined {
	if (!next) return previous;
	if (!previous) return next;

	return {
		files: next.files.map((file, index) => {
			const previousFile = file.path
				? previous.files.find((candidate) => candidate.path === file.path)
				: previous.files[index];
			return {
				...(previousFile ?? {}),
				...file,
				...(file.path === undefined && previousFile?.path ? { path: previousFile.path } : {}),
			};
		}),
	};
}

export function toolActivityStatus(state: ToolActivityState): LiveTool["status"] {
	return state === "success"
		? "success"
		: state === "error" || state === "cancelled" || state === "interrupted"
			? "error"
			: "running";
}

export function toolActivityLabel(activity: ToolActivity): string {
	switch (activity.state) {
		case "preparing":
			return `准备 ${activity.name}`;
		case "queued":
			return `${activity.name} 已排队`;
		case "running":
			return `正在执行 ${activity.name}`;
		case "success":
			return `${activity.name} 已完成`;
		case "error":
			return `${activity.name} 执行失败`;
		case "cancelled":
			return `${activity.name} 已取消`;
		case "interrupted":
			return `${activity.name} 已中断`;
	}
}

function stableFileToolSummary(name: string, summary: string | undefined, previous: string | undefined): string {
	const next = summary?.trim();
	if (
		(name === "edit" || name === "write" || name === "apply_patch") &&
		(!next || next === name) &&
		previous?.trim() &&
		previous.trim() !== name
	)
		return previous.trim();
	return next || previous?.trim() || name;
}

export function liveToolFromActivity(activity: ToolActivity, previous: LiveTool | undefined, batchId: string): LiveTool {
	const terminal =
		activity.state === "success" ||
		activity.state === "error" ||
		activity.state === "cancelled" ||
		activity.state === "interrupted";
	const webSearch = activity.name === "web_search" ? previous?.webSearch : undefined;
	return {
		id: activity.toolCallId,
		name: activity.name,
		batchId,
		summary: activity.name === "web_search"
			? mergeWebSearchToolSummary(previous?.summary, activity.summary, webSearch)
			: activity.name === "image_gen"
				? mergeImageGenerationSummary(previous?.summary, activity.summary)
				: stableFileToolSummary(activity.name, activity.summary, previous?.summary),
		state: activity.state,
		status: toolActivityStatus(activity.state),
		stepId: activity.stepId ?? previous?.stepId,
		inputPreview: activity.inputPreview,
		result: activity.output ?? activity.progress ?? activity.error ?? previous?.result,
		...(webSearch ? { webSearch } : {}),
		...(terminal ? { diff: activity.diff } : { diff: mergeToolDiff(previous?.diff, activity.diff) }),
	};
}

export function liveToolFromUpdate(
	progress: Extract<SessionProgress, { type: "tool_update" }>,
	previous: LiveTool | undefined,
	batchId: string,
	summary: string,
	webSearch?: LiveTool["webSearch"],
): LiveTool {
	return {
		id: progress.toolCallId,
		name: progress.name,
		batchId,
		summary:
			previous?.state === "running" && previous.name === progress.name && progress.name !== "web_search"
				? previous.summary
				: progress.name === "image_gen"
					? mergeImageGenerationSummary(previous?.summary, summary)
					: stableFileToolSummary(progress.name, summary, previous?.summary),
		state: previous?.state ?? (progress.name === "web_search" ? "running" : "preparing"),
		status: "running",
		result: progress.summary,
		stepId: progress.stepId ?? previous?.stepId,
		inputPreview: previous?.inputPreview,
		...(webSearch ? { webSearch } : {}),
		diff: mergeToolDiff(previous?.diff, progress.diff),
	};
}

export function nextLiveToolBatchId(
	current: WorkbenchState,
	toolName: string,
	toolSummary: string,
	stepId: string | undefined,
	turnId: number,
	fallback: string,
): string {
	const last = current.liveTurnItems.at(-1);
	if (last?.kind !== "tools" || last.turnId !== turnId) return fallback;
	const previousToolId = last.toolIds.at(-1);
	const previousTool = previousToolId ? current.liveTools[previousToolId] : undefined;
	if (previousTool?.stepId !== stepId) return fallback;
	return shouldJoinLiveToolBatch(previousTool, { name: toolName, summary: toolSummary }, last?.turnId, turnId)
		? last.batchId
		: fallback;
}

export function applyToolActivityState(current: WorkbenchState, activity: ToolActivity): WorkbenchState {
	if (
		current.toolActivityEpoch === activity.activityEpoch &&
		(current.toolActivityRevision ?? -1) >= activity.revision
	) {
		return current;
	}
	const newEpoch = current.toolActivityEpoch !== activity.activityEpoch;
	const liveTools = newEpoch ? {} : current.liveTools;
	const previous = liveTools[activity.toolCallId];
	const batchId =
		previous?.batchId ??
		nextLiveToolBatchId(
			current,
			activity.name,
			activity.summary,
			activity.stepId,
			current.liveTurnId,
			`live-tool-batch:${activity.activityEpoch}:${activity.toolCallId}`,
		);
	return {
		...current,
		toolActivityEpoch: activity.activityEpoch,
		toolActivityRevision: activity.revision,
		liveTools: {
			...liveTools,
			[activity.toolCallId]: liveToolFromActivity(activity, previous, batchId),
		},
		liveTurnItems: previous
			? current.liveTurnItems
			: appendLiveToolBlock(
					newEpoch ? current.liveTurnItems.filter((item) => item.kind !== "tools") : current.liveTurnItems,
					batchId,
					activity.toolCallId,
					`live-tools:${activity.activityEpoch}:${activity.toolCallId}`,
					current.liveTurnId,
				),
		statusText: toolActivityLabel(activity),
	};
}

export function restoreToolActivities(current: WorkbenchState, snapshot: WebSessionSnapshot): WorkbenchState {
	if (!snapshot.toolActivityEpoch || snapshot.toolActivityRevision === undefined) {
		if (hasActiveSessionSnapshot(snapshot)) return current;
		return {
			...current,
			toolActivityEpoch: undefined,
			toolActivityRevision: undefined,
			liveTools: {},
			liveTurnItems: current.liveTurnItems.filter((item) => item.kind !== "tools"),
		};
	}
	if (
		current.toolActivityEpoch === snapshot.toolActivityEpoch &&
		(current.toolActivityRevision ?? -1) > snapshot.toolActivityRevision
	) {
		return current;
	}
	// 快照恢复只更新工具状态，不重排已有块：保留文本与工具的相对顺序，只补快照新增的工具。
	const incoming = new Map((snapshot.toolActivities ?? []).map((activity) => [activity.toolCallId, activity]));
	const liveTools: WorkbenchState["liveTools"] = {};
	for (const [toolCallId, tool] of Object.entries(current.liveTools)) {
		if (incoming.has(toolCallId)) liveTools[toolCallId] = tool;
	}
	let next: WorkbenchState = {
		...current,
		toolActivityEpoch: snapshot.toolActivityEpoch,
		toolActivityRevision: snapshot.toolActivityRevision,
		liveTools,
		liveTurnItems: current.liveTurnItems.flatMap((item): LiveTurnItem[] => {
			if (item.kind !== "tools") return [item];
			const toolIds = item.toolIds.filter((id) => incoming.has(id));
			return toolIds.length ? [{ ...item, toolIds }] : [];
		}),
	};
	for (const activity of snapshot.toolActivities ?? []) {
		// 已有工具块保留位置，只更新状态；快照新增的工具才追加到末尾。
		if (next.liveTools[activity.toolCallId]) {
			next = {
				...next,
				liveTools: {
					...next.liveTools,
					[activity.toolCallId]: liveToolFromActivity(
						activity,
						next.liveTools[activity.toolCallId],
						next.liveTools[activity.toolCallId]?.batchId ??
							`live-tool-batch:${activity.activityEpoch}:${activity.toolCallId}`,
					),
				},
			};
			continue;
		}
		const batchId = nextLiveToolBatchId(
			next,
			activity.name,
			activity.summary,
			activity.stepId,
			next.liveTurnId,
			`live-tool-batch:${activity.activityEpoch}:${activity.toolCallId}`,
		);
		next = {
			...next,
			liveTools: {
				...next.liveTools,
				[activity.toolCallId]: liveToolFromActivity(activity, undefined, batchId),
			},
			liveTurnItems: appendLiveToolBlock(
				next.liveTurnItems,
				batchId,
				activity.toolCallId,
				`live-tools:${activity.activityEpoch}:${activity.toolCallId}`,
				next.liveTurnId,
			),
		};
	}
	const persisted = committedToolCallIds(next.transcript);
	return {
		...next,
		liveTurnItems: next.liveTurnItems.flatMap((item): LiveTurnItem[] => {
			if (item.kind !== "tools") return [item];
			const toolIds = item.toolIds.filter((id) => !persisted.has(id));
			return toolIds.length ? [{ ...item, toolIds }] : [];
		}),
	};
}

export function queuedPromptsFromSnapshot(
	snapshot: WebSessionSnapshot,
	fallback: readonly QueuedUserPrompt[],
): QueuedUserPrompt[] {
	const reconciled = reconcileQueuedUserPromptCounts(
		fallback,
		snapshot.queuedSteerCount ?? 0,
		snapshot.queuedFollowUpCount,
	);
	if (snapshot.queuedFollowUpMessages !== undefined) {
		const steering = reconciled.filter((prompt) => prompt.delivery === "steer");
		const fallbackById = new Map(fallback.map((prompt) => [prompt.id, prompt]));
		const followUp = snapshot.queuedFollowUpMessages.map(({ id, text }) => {
			const previous = fallbackById.get(id);
			return {
				id,
				text,
				displayText: previous?.displayText || promptDisplayText(text) || "附件消息",
				delivery: "follow-up" as const,
				attachments: previous?.attachments ?? [],
			};
		});
		return [...steering, ...followUp];
	}
	return reconciled;
}

export function restoreRuntimeActivities(current: WorkbenchState, snapshot: WebSessionSnapshot): WorkbenchState {
	const queuedUserPrompts = queuedPromptsFromSnapshot(snapshot, current.queuedUserPrompts ?? []);
	const queuedPromptIds = new Set(queuedUserPrompts.map((prompt) => prompt.id));
	const liveTurnItems = current.liveTurnItems.map((item) =>
		item.kind === "user" && item.status === "queued" && !queuedPromptIds.has(item.queueId)
			? { ...item, status: "processing" as const }
			: item,
	);
	const liveSteps = snapshot.activeStep
		? { [snapshot.activeStep.id]: snapshot.activeStep }
		: hasActiveSessionSnapshot(snapshot)
			? Object.fromEntries(Object.entries(current.liveSteps ?? {}).filter(([, step]) => step.status !== "running"))
			: {};
	const liveCompaction = restoreCompactionState(current.liveCompaction, snapshot.phase, current.transcript);
	const next = {
		...current,
		queuedUserPrompts,
		liveSteps,
		liveTurnItems:
			liveCompaction && snapshot.phase === "compaction"
				? ensureLiveCompactionMarker(liveTurnItems, current.liveTurnId, runningAgentStepId(liveSteps))
				: liveTurnItems,
		pendingUserPrompts: (current.pendingUserPrompts ?? []).filter(
			(prompt) => !prompt.queueId || !queuedPromptIds.has(prompt.queueId),
		),
		liveCompaction,
		...(hasActiveSessionSnapshot(snapshot) ? {} : { liveTurnActive: false }),
	};
	return restoreToolActivities(next, snapshot);
}

export function createSubagentConversationState(snapshot: SubagentSnapshot): SubagentConversationState {
	return {
		snapshot,
		transcript: [],
		agentSteps: {},
		transcriptPageLoaded: false,
		transcriptLoading: false,
		hasMorePrevious: false,
		loadingEarlier: false,
		liveTools: {},
		liveSteps: {},
		liveTurnItems: [],
		liveTurnId: 0,
		liveTurnActive: snapshot.state === "queued" || snapshot.state === "running" || snapshot.state === "waiting",
		statusText: snapshot.currentAction ?? "",
	};
}

export function mergeSubagentSnapshots(
	current: readonly SubagentSnapshot[],
	incoming: readonly SubagentSnapshot[],
): SubagentSnapshot[] {
	const byAgent = new Map(current.map((snapshot) => [snapshot.agentId, snapshot]));
	for (const snapshot of incoming) {
		const previous = byAgent.get(snapshot.agentId);
		if (!previous || snapshot.runId !== previous.runId || snapshot.updatedAt >= previous.updatedAt)
			byAgent.set(snapshot.agentId, snapshot);
	}
	return [...byAgent.values()].sort(
		(left, right) =>
			right.updatedAt - left.updatedAt ||
			left.runId.localeCompare(right.runId) ||
			left.agentId.localeCompare(right.agentId),
	);
}

export function subagentToolBatchId(
	current: SubagentConversationState,
	name: string,
	summary: string,
	stepId: string | undefined,
	fallback: string,
): string {
	const last = current.liveTurnItems.at(-1);
	if (last?.kind !== "tools" || last.turnId !== current.liveTurnId) return fallback;
	const previousTool = current.liveTools[last.toolIds.at(-1) ?? ""];
	if (previousTool?.stepId !== stepId) return fallback;
	return shouldJoinLiveToolBatch(previousTool, { name, summary }, last.turnId, current.liveTurnId)
		? last.batchId
		: fallback;
}

export function applySubagentProgress(
	current: SubagentConversationState,
	progress: SessionProgress,
	nextLiveItemId: () => string,
	nextLiveToolId: () => string,
): SubagentConversationState {
	switch (progress.type) {
		case "assistant_delta":
			return {
				...current,
				liveTurnActive: true,
				liveTurnItems: appendLiveTextBlock(
					current.liveTurnItems,
					"text",
					progress.text,
					nextLiveItemId(),
					current.liveTurnId,
					progress.stepId,
					progress.blockId,
				),
				statusText: "正在生成回复",
			};
		case "thinking_delta":
			return {
				...current,
				liveTurnActive: true,
				liveTurnItems: appendLiveTextBlock(
					current.liveTurnItems,
					"thinking",
					progress.text,
					nextLiveItemId(),
					current.liveTurnId,
					progress.stepId,
					progress.blockId,
					),
				statusText: "正在思考",
				};
		case "user_message": {
				if (current.liveTurnItems.some((item) => item.kind === "user" && item.text === progress.text)) return current;
				const id = nextLiveItemId();
				return {
					...current,
					liveTurnItems: [
						...current.liveTurnItems,
						{
							id,
							kind: "user",
							turnId: current.liveTurnId,
							queueId: id,
							text: progress.text,
							displayText: progress.text || "附件消息",
							attachments: [],
							status: "processing",
						},
					],
					statusText: "正在处理",
				};
			}
		case "agent_step":
			return {
				...current,
				liveTurnActive: true,
				liveSteps: { ...current.liveSteps, [progress.step.id]: progress.step },
				statusText: progress.step.status === "running" ? progress.step.title : current.statusText,
			};
		case "tool_state": {
				if (
					current.toolActivityEpoch === progress.activity.activityEpoch &&
					(current.toolActivityRevision ?? -1) >= progress.activity.revision
				)
					return current;
				const newEpoch = current.toolActivityEpoch !== progress.activity.activityEpoch;
				const liveTools = newEpoch ? {} : current.liveTools;
				const previous = liveTools[progress.activity.toolCallId];
				const batchId =
					previous?.batchId ??
					subagentToolBatchId(
						{ ...current, liveTools },
						progress.activity.name,
						progress.activity.summary,
						progress.activity.stepId,
						`subagent-tool:${nextLiveToolId()}`,
					);
				return {
					...current,
					toolActivityEpoch: progress.activity.activityEpoch,
					toolActivityRevision: progress.activity.revision,
					liveTools: {
						...liveTools,
						[progress.activity.toolCallId]: liveToolFromActivity(progress.activity, previous, batchId),
					},
					liveTurnItems: previous
						? current.liveTurnItems
						: appendLiveToolBlock(
								newEpoch ? current.liveTurnItems.filter((item) => item.kind !== "tools") : current.liveTurnItems,
								batchId,
								progress.activity.toolCallId,
								nextLiveItemId(),
								current.liveTurnId,
							),
					statusText: toolActivityLabel(progress.activity),
				};
			}
		case "tool_start":
		case "tool_update":
		case "tool_end": {
			const previous = current.liveTools[progress.toolCallId];
			if (progress.type === "tool_update" && previous && previous.status !== "running") return current;
			const webSearch =
				progress.name === "web_search" ? mergeWebSearchProgress(previous?.webSearch, progress.webSearch) : undefined;
			const summary =
				progress.name === "web_search"
					? mergeWebSearchToolSummary(previous?.summary, progress.summary, webSearch)
					: progress.name === "image_gen"
						? mergeImageGenerationSummary(previous?.summary, progress.summary)
						: progress.summary || previous?.summary || "正在执行";
			const batchId =
				previous?.batchId ??
				subagentToolBatchId(current, progress.name, summary, progress.stepId, `subagent-tool:${nextLiveToolId()}`);
			const status: LiveTool["status"] = progress.type === "tool_end" ? progress.status : "running";
			const tool =
				progress.type === "tool_update"
					? liveToolFromUpdate(progress, previous, batchId, summary, webSearch)
					: {
						id: progress.toolCallId,
						name: progress.name,
						batchId,
						summary,
						state: status === "success" ? "success" as const : status === "error" ? "error" as const : "running" as const,
						status,
						stepId: progress.stepId ?? previous?.stepId,
						result: progress.summary,
						...(progress.type === "tool_start" && previous?.inputPreview ? { inputPreview: true } : {}),
						...(webSearch ? { webSearch } : {}),
						diff: mergeToolDiff(previous?.diff, progress.diff),
					};
			return {
				...current,
				liveTools: {
					...current.liveTools,
					[progress.toolCallId]: tool,
				},
				liveTurnItems: previous
					? current.liveTurnItems
					: appendLiveToolBlock(
							current.liveTurnItems,
							batchId,
							progress.toolCallId,
							nextLiveItemId(),
							current.liveTurnId,
						),
				statusText:
					progress.type === "tool_end"
						? `${progress.name} 已完成`
						: tool.state === "running"
							? `正在执行 ${progress.name}`
							: current.statusText,
			};
		}
		case "queue_update":
			return {
				...current,
				statusText:
					progress.steeringCount + progress.followUpCount > 0
						? `队列中 ${progress.steeringCount + progress.followUpCount} 项`
						: "正在处理",
			};
		case "phase": {
			const liveCompaction =
				progress.phase === "compaction"
					? restoreCompactionState(current.liveCompaction, progress.phase, current.transcript)
					: progress.phase === "turn" || progress.phase === "idle" || progress.phase === "interrupted"
						? undefined
						: current.liveCompaction;
			const settledItems = current.liveTurnItems.filter((item) => item.kind !== "compaction");
			const liveTurnItems =
				progress.phase === "turn"
					? current.liveTurnItems.filter((item) => item.kind === "user")
					: progress.phase === "compaction"
						? ensureLiveCompactionMarker(current.liveTurnItems, current.liveTurnId, runningAgentStepId(current.liveSteps))
						: progress.phase === "idle"
							? detachFinalTextFromCompletedStep(settledItems, current.liveSteps)
							: progress.phase === "interrupted"
								? settledItems
								: current.liveTurnItems;
			return {
				...current,
				liveTurnId: progress.phase === "turn" ? current.liveTurnId + 1 : current.liveTurnId,
				liveTurnActive:
					progress.phase === "turn"
						? true
						: progress.phase === "idle" || progress.phase === "interrupted"
							? false
							: current.liveTurnActive,
				liveTurnItems,
				...(progress.phase === "turn"
					? {
							liveTools: {},
							toolActivityEpoch: undefined,
							toolActivityRevision: undefined,
							liveSteps: {},
					  }
					: {}),
				liveTurnStartRevision: progress.phase === "turn" ? current.transcriptRevision : current.liveTurnStartRevision,
				liveCompaction,
				statusText:
					progress.phase === "idle"
						? ""
						: progress.phase === "waiting_for_input"
							? "等待输入"
							: progress.phase === "compaction"
								? "正在整理上下文"
								: "正在处理",
			};
		}
		case "compaction":
			return {
				...current,
				liveCompaction: updateCompactionState(current.liveCompaction, progress, current.transcript),
				statusText: progress.status === "running" ? "正在整理上下文" : progress.status === "completed" ? "上下文已整理" : "上下文整理已停止",
			};
		case "retry":
			return {
				...current,
				liveCompaction: updateCompactionState(current.liveCompaction, progress, current.transcript),
				statusText: progress.status === "running" ? "正在重试" : progress.status === "waiting" ? "等待重试" : "重试完成",
			};
		case "bash":
			return { ...current, statusText: "正在运行命令" };
		case "status":
			return { ...current, statusText: progress.status };
		case "usage":
			return current;
	}
}
