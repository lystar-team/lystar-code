import type { AgentStep } from "@lystar/code-web-protocol";
import { toLiveToolViewModel } from "../../adapters/live-tool-view-model.ts";
import { toSessionItemViewModel } from "../../adapters/session-view-model";
import { formatElapsedDuration } from "./conversation-format";
import type { LiveCompactionState } from "../../state/compaction-state";
import { agentStepsFromIndex } from "../../state/session-timeline";
import { shouldJoinToolBatch, skillNameFromTool } from "../../state/tool-batching";
import type { LiveTurnItem, WorkbenchState } from "../../state/use-workbench";
import type { PromptAttachmentPreview } from "../../types";
import type { ToolBatchTool } from "../ai-elements/tool-batch";

export type MessageRenderItem = {
	kind: "message";
	key: string;
	entryId?: string;
	live: boolean;
	role: "user" | "assistant" | "system";
	text: string;
	timestamp?: string;
	sentAt?: number;
	durationLabel?: string;
	statusLabel?: string;
	queueId?: string;
	attachments: PromptAttachmentPreview[];
	sources: string[];
	copyVisible: boolean;
	editable: boolean;
};
export type TranscriptItemRenderItem = { kind: "item"; key: string; item: WorkbenchState["transcript"][number] };
type TranscriptBatchRenderItem = {
	kind: "tool-batch";
	key: string;
	entryId?: string;
	tools: ToolBatchTool[];
	stepId?: string;
};
type ActivityBoundaryRenderItem = { kind: "activity-boundary"; key: string };
type AgentStepAnchorRenderItem = { kind: "agent-step-anchor"; key: string; step: AgentStep };
export type ResultBoundaryRenderItem = { kind: "result-boundary"; key: string };
export type TranscriptToolStackRenderItem = {
	kind: "tool-stack";
	key: string;
	live: boolean;
	collapseForResult: boolean;
	stepId?: string;
	batches: TranscriptBatchRenderItem[];
};
export type CompactionRenderItem = {
	kind: "compaction";
	key: string;
	entryId?: string;
	timestamp?: string;
	live: boolean;
	state?: LiveCompactionState;
	text?: string;
	tokensBefore?: number;
};
export type HookActivityGroupRenderItem = {
	kind: "hook-group";
	key: string;
	items: TranscriptItemRenderItem[];
};
export type AgentStepChildRenderItem = MessageRenderItem | TranscriptToolStackRenderItem | CompactionRenderItem;
export type AgentStepRenderItem = {
	kind: "agent-step";
	key: string;
	live: boolean;
	step: AgentStep;
	items: AgentStepChildRenderItem[];
};
export type ConversationContentRenderItem =
	| MessageRenderItem
	| TranscriptItemRenderItem
	| TranscriptToolStackRenderItem
	| AgentStepRenderItem
	| CompactionRenderItem
	| HookActivityGroupRenderItem;
type WorkProcessRenderItem = {
	kind: "work-process";
	key: string;
	items: ConversationContentRenderItem[];
};
type LiveElapsedRenderItem = { kind: "live-elapsed"; key: string; startedAt: number };
export type ConversationRenderItem =
	| ConversationContentRenderItem
	| WorkProcessRenderItem
	| ResultBoundaryRenderItem
	| LiveElapsedRenderItem;
type RawRenderItem =
	| MessageRenderItem
	| TranscriptItemRenderItem
	| TranscriptBatchRenderItem
	| ActivityBoundaryRenderItem
	| AgentStepAnchorRenderItem
	| CompactionRenderItem;

export type ToolIndex = {
	callIds: ReadonlySet<string>;
	results: ReadonlyMap<string, ToolBatchTool>;
	statuses: ReadonlyMap<string, "success" | "error">;
};

type PersistedToolBatchKind = "read" | "skill" | "generated-image" | "image" | "search" | "action";

function persistedToolBatchKind(batch: TranscriptBatchRenderItem): PersistedToolBatchKind {
	if (batch.tools.length > 0 && batch.tools.every((tool) => Boolean(skillNameFromTool(tool)))) return "skill";
	if (batch.tools.length > 0 && batch.tools.every((tool) => tool.name === "web_search")) return "search";
	if (batch.tools.length > 0 && batch.tools.every((tool) => tool.name === "image_gen")) return "generated-image";
	if (batch.tools.length > 0 && batch.tools.every((tool) => tool.name === "read" && Boolean(tool.images?.length))) return "image";
	if (batch.tools.length > 0 && batch.tools.every((tool) => tool.name === "read")) return "read";
	return "action";
}

type GroupedPersistedRenderItem = ConversationContentRenderItem | AgentStepAnchorRenderItem;

function groupPersistedToolBatches(rendered: Array<RawRenderItem>): GroupedPersistedRenderItem[] {
	const grouped: GroupedPersistedRenderItem[] = [];
	let previousToolStack: TranscriptToolStackRenderItem | undefined;
	let previousToolBatchKind: PersistedToolBatchKind | undefined;
	for (const entry of rendered) {
		if (entry.kind === "activity-boundary") {
			previousToolStack = undefined;
			previousToolBatchKind = undefined;
			continue;
		}
		if (entry.kind === "tool-batch") {
			const toolBatchKind = persistedToolBatchKind(entry);
			if (
				previousToolStack &&
				previousToolStack.stepId === entry.stepId &&
				previousToolBatchKind === toolBatchKind &&
				toolBatchKind !== "skill"
			) {
				previousToolStack.batches.push(entry);
			} else {
				previousToolStack = {
					kind: "tool-stack",
					key: `tool-stack:${entry.key}`,
					live: false,
					collapseForResult: false,
					stepId: entry.stepId,
					batches: [entry],
				};
				grouped.push(previousToolStack);
			}
			previousToolBatchKind = toolBatchKind;
			continue;
		}
		grouped.push(entry);
		previousToolStack = undefined;
		previousToolBatchKind = undefined;
	}
	return grouped;
}

function groupAgentSteps(
	items: GroupedPersistedRenderItem[],
	steps: ReadonlyMap<string, AgentStep>,
): ConversationContentRenderItem[] {
	const grouped: ConversationContentRenderItem[] = [];
	const renderedSteps = new Map<string, AgentStepRenderItem>();
	const stepIdByToolCallId = new Map<string, string>();
	const stepIdByMessageEntryId = new Map<string, string>();
	for (const step of steps.values()) {
		for (const toolCallId of step.toolCallIds) stepIdByToolCallId.set(toolCallId, step.id);
		for (const messageEntryId of step.messageEntryIds ?? []) stepIdByMessageEntryId.set(messageEntryId, step.id);
	}
	const ensureStep = (stepId: string, fallback?: AgentStep): AgentStepRenderItem | undefined => {
		const step = steps.get(stepId) ?? fallback;
		if (!step) return undefined;
		const existing = renderedSteps.get(stepId);
		if (existing) {
			existing.step = step;
			return existing;
		}
		const entry: AgentStepRenderItem = {
			kind: "agent-step",
			key: `agent-step:${stepId}`,
			live: false,
			step,
			items: [],
		};
		renderedSteps.set(stepId, entry);
		grouped.push(entry);
		return entry;
	};
	for (const item of items) {
		if (item.kind === "agent-step-anchor") {
			ensureStep(item.step.id, item.step);
			continue;
		}
		if (item.kind === "message" && item.entryId) {
			const stepId = stepIdByMessageEntryId.get(item.entryId);
			if (stepId) {
				const step = ensureStep(stepId);
				if (step && !step.items.some((candidate) => candidate.key === item.key)) {
					step.items.push(item);
					continue;
				}
			}
		}
		if (item.kind === "tool-stack") {
			const inferredStepIds = new Set(
				item.batches.flatMap((batch) =>
					batch.tools.flatMap((tool) => {
						const stepId = stepIdByToolCallId.get(tool.id);
						return stepId ? [stepId] : [];
					}),
				),
			);
			const inferredMessageStepIds = new Set(
				item.batches.flatMap((batch) => {
					const stepId = batch.entryId ? stepIdByMessageEntryId.get(batch.entryId) : undefined;
					return stepId ? [stepId] : [];
				}),
			);
			const inferredStepId = inferredStepIds.size === 1 ? inferredStepIds.values().next().value : undefined;
			const inferredMessageStepId =
				inferredMessageStepIds.size === 1 ? inferredMessageStepIds.values().next().value : undefined;
			const stepId = item.stepId ?? inferredStepId ?? inferredMessageStepId;
			if (stepId) {
				const step = ensureStep(stepId);
				const stepItem = item.stepId ? item : { ...item, stepId };
				if (step && !step.items.some((candidate) => candidate.key === item.key)) step.items.push(stepItem);
				else if (!step) grouped.push(item);
				continue;
			}
		}
		grouped.push(item);
	}
	return grouped;
}

export function buildPersistedRenderItems(
	items: WorkbenchState["transcript"],
	toolIndex: ToolIndex,
	pendingUserPrompts: WorkbenchState["pendingUserPrompts"] = [],
	promptSendTimes: WorkbenchState["promptSendTimes"] = {},
	agentSteps: WorkbenchState["agentSteps"] = {},
): ConversationContentRenderItem[] {
	const rendered: Array<RawRenderItem> = [];
	let batchTools: ToolBatchTool[] = [];
	let batchKey = "";
	let batchEntryId: string | undefined;
	let batchStepId: string | undefined;
	const latestSteps = new Map<string, { entryId: string; step: AgentStep }>(
		agentStepsFromIndex(agentSteps).map((step) => [step.id, { entryId: `agent-step-index:${step.id}`, step }]),
	);
	for (const item of items) {
		if (item.view?.type === "agent_step" && !latestSteps.has(item.view.step.id))
			latestSteps.set(item.view.step.id, { entryId: item.entryId, step: item.view.step });
	}
	const stepIdByEntryId = new Map<string, string>();
	const stepIdByToolCallId = new Map<string, string>();
	for (const [stepId, value] of latestSteps) {
		for (const entryId of value.step.messageEntryIds ?? []) stepIdByEntryId.set(entryId, stepId);
		for (const toolCallId of value.step.toolCallIds) stepIdByToolCallId.set(toolCallId, stepId);
	}
	const renderedStepIds = new Set<string>();
	const appendPersistedStepAnchor = (stepId: string | undefined, key: string) => {
		if (!stepId || renderedStepIds.has(stepId)) return;
		const latest = latestSteps.get(stepId);
		if (!latest) return;
		flushBatch();
		renderedStepIds.add(stepId);
		rendered.push({ kind: "agent-step-anchor", key: `agent-step-index-anchor:${key}:${stepId}`, step: latest.step });
	};

	const pendingAtIndex = new Map<number, WorkbenchState["pendingUserPrompts"]>();
	for (const prompt of pendingUserPrompts) {
		let insertIndex = prompt.afterEntryId ? items.length : 0;
		if (prompt.afterEntryId) {
			for (let index = items.length - 1; index >= 0; index--) {
				if (items[index]?.entryId === prompt.afterEntryId) {
					insertIndex = index + 1;
					break;
				}
			}
		}
		const prompts = pendingAtIndex.get(insertIndex) ?? [];
		prompts.push(prompt);
		pendingAtIndex.set(insertIndex, prompts);
	}

	const flushBatch = () => {
		if (batchTools.length > 0) {
			rendered.push({ kind: "tool-batch", key: batchKey, entryId: batchEntryId, tools: batchTools, stepId: batchStepId });
			batchTools = [];
			batchKey = "";
			batchEntryId = undefined;
			batchStepId = undefined;
		}
	};
	const appendPendingPrompts = (index: number) => {
		const prompts = pendingAtIndex.get(index);
		if (!prompts?.length) return;
		flushBatch();
		for (const prompt of prompts) {
			rendered.push({
				kind: "message",
				key: prompt.id,
				live: false,
				role: "user",
				text: prompt.text,
				sentAt: prompt.sentAt,
				attachments: prompt.attachments,
				sources: [],
				copyVisible: false,
				editable: false,
			});
		}
	};

	for (let index = 0; index <= items.length; index++) {
		appendPendingPrompts(index);
		if (index === items.length) break;
		const item = items[index]!;
		if (item.view?.type === "agent_step") {
			const latest = latestSteps.get(item.view.step.id);
			if (latest) latest.entryId = item.entryId;
			appendPersistedStepAnchor(item.view.step.id, item.renderId);
			continue;
		}
		appendPersistedStepAnchor(item.entryId ? stepIdByEntryId.get(item.entryId) : undefined, item.renderId);
		const viewModel = toSessionItemViewModel(item, toolIndex.statuses);
		if (viewModel.kind === "reasoning") {
			flushBatch();
			rendered.push({ kind: "activity-boundary", key: `activity-boundary:${item.renderId}` });
			continue;
		}
		if (viewModel.kind === "message") {
			flushBatch();
			rendered.push({
				kind: "message",
				key: item.renderId,
				entryId: item.entryId,
				live: false,
				role: viewModel.role,
				text: viewModel.text,
				timestamp: viewModel.timestamp,
				sentAt: promptSendTimes[item.entryId],
				attachments: viewModel.attachments,
				sources: viewModel.sources,
				copyVisible: false,
				editable: false,
			});
			continue;
		}
		if (viewModel.kind === "tools" && item.view?.type === "web_search") {
			flushBatch();
			const searchTool = viewModel.tools[0];
			if (searchTool) {
				appendPersistedStepAnchor(stepIdByToolCallId.get(searchTool.id), item.renderId);
				rendered.push({
					kind: "tool-batch",
					key: `web-search:${item.renderId}:${searchTool.id}`,
					entryId: item.entryId,
					tools: [searchTool],
				});
			}
			continue;
		}
		if (viewModel.kind === "tools" && item.view?.type === "tool_call") {
			for (const tool of viewModel.tools) {
				const stepId =
					item.view.calls.find((call) => call.id === tool.id)?.stepId ??
					stepIdByToolCallId.get(tool.id) ??
					stepIdByEntryId.get(item.entryId);
				appendPersistedStepAnchor(stepId, item.renderId);
				const result = toolIndex.results.get(tool.id);
				const resolvedTool = result
					? { ...tool, ...result, summary: tool.name === "image_gen" ? result.summary || tool.summary : tool.summary || result.summary }
					: tool;
				const previous = batchTools.at(-1);
				if (
					!previous ||
					batchEntryId !== item.entryId ||
					batchStepId !== stepId ||
					!shouldJoinToolBatch(previous, resolvedTool)
				) {
					flushBatch();
					batchEntryId = item.entryId;
					batchStepId = stepId;
					batchKey = `tool-batch:${item.renderId}:${resolvedTool.id}`;
				}
				batchTools.push(resolvedTool);
			}
			continue;
		}
		if (viewModel.kind === "tools" && item.view?.type === "tool_result") {
			if (toolIndex.callIds.has(item.view.callId)) continue;
			flushBatch();
			const resultTool = viewModel.tools[0];
			if (resultTool) {
				appendPersistedStepAnchor(item.view.stepId ?? stepIdByToolCallId.get(resultTool.id), item.renderId);
				rendered.push({
					kind: "tool-batch",
					key: `tool-result:${item.renderId}:${resultTool.id}`,
					entryId: item.entryId,
					tools: [resultTool],
					stepId: item.view.stepId,
				});
			}
			continue;
		}
		flushBatch();
		if (viewModel.kind === "summary" && (viewModel.variant === "compaction" || viewModel.title === "上下文压缩")) {
			rendered.push({
				kind: "compaction",
				key: item.renderId,
				entryId: item.entryId,
				timestamp: item.timestamp,
				live: false,
				text: viewModel.text,
				tokensBefore: viewModel.tokensBefore,
			});
		} else {
			rendered.push({ kind: "item", key: item.renderId, item });
		}
	}
	flushBatch();
	return groupAgentSteps(
		groupPersistedToolBatches(rendered),
		new Map([...latestSteps].map(([stepId, value]) => [stepId, value.step])),
	);
}

function updateLiveCompactionRenderItem(
	items: Array<ConversationContentRenderItem | AgentStepChildRenderItem>,
	key: string,
	state: LiveCompactionState,
): boolean {
	for (const entry of items) {
		if (entry.kind === "compaction" && entry.key === key) {
			entry.live = true;
			entry.state = state;
			return true;
		}
		if (entry.kind === "agent-step" && updateLiveCompactionRenderItem(entry.items, key, state)) return true;
	}
	return false;
}

export function appendLiveRenderItems(
	rendered: ConversationContentRenderItem[],
	liveItems: readonly LiveTurnItem[],
	liveTools: WorkbenchState["liveTools"],
	committedToolCallIds: ReadonlySet<string>,
	liveCompaction: LiveCompactionState | undefined,
	liveTurnId: number,
	liveSteps: WorkbenchState["liveSteps"] = {},
): ConversationContentRenderItem[] {
	const next = [...rendered];
	const stepIdByToolCallId = new Map<string, string>();
	for (const step of Object.values(liveSteps)) {
		for (const toolCallId of step.toolCallIds) stepIdByToolCallId.set(toolCallId, step.id);
	}
	const hasRenderItemKey = (key: string) =>
		next.some((entry) => entry.key === key || (entry.kind === "agent-step" && entry.items.some((item) => item.key === key)));
	const appendStepItem = (stepId: string, item: AgentStepChildRenderItem): boolean => {
		const step = liveSteps[stepId];
		if (!step) return false;
		const key = `agent-step:${stepId}`;
		const existing = next.find((entry): entry is AgentStepRenderItem => entry.kind === "agent-step" && entry.key === key);
		if (existing) {
			existing.live = true;
			existing.step = step;
			if (!existing.items.some((candidate) => candidate.key === item.key)) existing.items.push(item);
		} else {
			next.push({ kind: "agent-step", key, live: true, step, items: [item] });
		}
		return true;
	};
	for (const item of liveItems) {
		if (item.kind === "user") {
			if (hasRenderItemKey(item.id)) continue;
			const message: MessageRenderItem = {
				kind: "message",
				key: item.id,
				live: false,
				role: "user",
				text: item.displayText,
				sentAt: item.sentAt,
				statusLabel: item.status === "queued" ? "已发出 · 等待当前步骤结束" : "已发出 · Agent 正在处理",
				queueId: item.status === "queued" ? item.queueId : undefined,
				attachments: item.attachments,
				sources: [],
				copyVisible: false,
				editable: false,
			};
			if (!item.stepId || !appendStepItem(item.stepId, message)) next.push(message);
			continue;
		}
		if (item.kind === "thinking") continue;
		if (item.kind === "compaction") {
			if (item.turnId !== liveTurnId || !liveCompaction) continue;
			const compaction: CompactionRenderItem = { kind: "compaction", key: item.id, live: true, state: liveCompaction };
			if (updateLiveCompactionRenderItem(next, item.id, liveCompaction)) continue;
			if (item.stepId && appendStepItem(item.stepId, compaction)) continue;
			next.push(compaction);
			continue;
		}
		if (item.kind === "text") {
			const text = item.parts.join("");
			if (!text.trim() || hasRenderItemKey(item.id)) continue;
			const message: MessageRenderItem = {
				kind: "message",
				key: item.id,
				live: true,
				role: "assistant",
				text,
				attachments: [],
				sources: [],
				copyVisible: false,
				editable: false,
			};
			if (!item.stepId || !appendStepItem(item.stepId, message)) next.push(message);
			continue;
		}
		if (item.kind !== "tools") continue;
		const tools = item.toolIds.flatMap((toolId) => {
			const tool = liveTools[toolId];
			if (!tool || committedToolCallIds.has(toolId)) return [];
			return [toLiveToolViewModel(tool)];
		});
		if (!tools.length) continue;
		const batchKey = `tool-batch:${item.id}:${tools[0]?.id ?? item.batchId}`;
		if (next.some((entry) => entry.key === `tool-stack:${batchKey}`)) continue;
		const candidateStepIds = new Set(
			tools.flatMap((tool) => {
				const stepId = tool.stepId ?? stepIdByToolCallId.get(tool.id);
				return stepId ? [stepId] : [];
			}),
		);
		const explicitStepId = candidateStepIds.size === 1 ? candidateStepIds.values().next().value : undefined;
		const stepId = explicitStepId;
		const toolsWithStep = stepId
			? tools.map((tool) => (tool.stepId ? tool : { ...tool, stepId }))
			: tools;
		const stack: TranscriptToolStackRenderItem = {
			kind: "tool-stack",
			key: `tool-stack:${batchKey}`,
			live: true,
			collapseForResult: false,
			stepId,
			batches: [{ kind: "tool-batch", key: batchKey, tools: toolsWithStep, stepId }],
		};
		if (!stepId || !appendStepItem(stepId, stack)) next.push(stack);
	}
	for (const step of Object.values(liveSteps)) {
		const key = `agent-step:${step.id}`;
		const existing = next.find((entry): entry is AgentStepRenderItem => entry.kind === "agent-step" && entry.key === key);
		if (existing) {
			existing.live = true;
			existing.step = step;
		} else {
			next.push({ kind: "agent-step", key, live: true, step, items: [] });
		}
	}
	return next;
}

function messageStartedAt(message: MessageRenderItem): number | undefined {
	if (message.sentAt !== undefined) return message.sentAt;
	if (!message.timestamp) return undefined;
	const parsed = Date.parse(message.timestamp);
	return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * 回合结束后位于最终回复下方的耗时。
 * 优先用客户端亲眼看到的实时值，保证与上方「已处理」完全一致；
 * 其次从用户消息的发送时刻算到末条文本回复，历史回合回退到会话时间戳。
 */
function completedTurnDurationLabel(
	userMessage: MessageRenderItem | undefined,
	finalMessage: MessageRenderItem,
	observedElapsed?: (sentAt: number) => number | undefined,
): string | undefined {
	if (!userMessage) return undefined;
	const observed = userMessage.sentAt === undefined ? undefined : observedElapsed?.(userMessage.sentAt);
	if (observed !== undefined) return formatElapsedDuration(observed);
	const start = messageStartedAt(userMessage);
	const end = finalMessage.timestamp ? Date.parse(finalMessage.timestamp) : Number.NaN;
	if (start === undefined || !Number.isFinite(end) || end < start) return undefined;
	return formatElapsedDuration(end - start);
}

function markCompletedTurnResult(
	turn: ConversationContentRenderItem[],
	completed: boolean,
	observedElapsed?: (sentAt: number) => number | undefined,
): ConversationRenderItem[] {
	const hooks = turn.filter(
		(entry): entry is TranscriptItemRenderItem =>
			entry.kind === "item" && entry.item.view?.type === "extension_activity",
	);
	const errors = hooks.filter(
		(entry) => entry.item.view?.type === "extension_activity" &&
			(entry.item.view.status === "failed" || entry.item.view.status === "interrupted"),
	);
	const content = hooks.length
		? turn.filter((entry) => entry.kind !== "item" || entry.item.view?.type !== "extension_activity")
		: turn;
	const firstEntry = content[0];
	const userMessage =
		firstEntry?.kind === "message" && firstEntry.role === "user" ? firstEntry : undefined;
	const hookGroup: HookActivityGroupRenderItem | undefined = errors.length
		? { kind: "hook-group", key: `hook-group:${userMessage?.key ?? errors[0]!.key}`, items: errors }
		: undefined;
	if (!completed) {
		const startedAt = userMessage ? messageStartedAt(userMessage) : undefined;
		if (!userMessage || startedAt === undefined) return hookGroup ? [...content, hookGroup] : content;
		return [
			userMessage,
			{ kind: "live-elapsed", key: `live-elapsed:${userMessage.key}`, startedAt },
			...content.slice(1),
			...(hookGroup ? [hookGroup] : []),
		];
	}
	let finalMessageIndex = -1;
	for (let index = content.length - 1; index >= 0; index--) {
		const entry = content[index];
		if (entry?.kind === "message" && entry.role === "assistant" && entry.text) {
			finalMessageIndex = index;
			break;
		}
	}
	if (finalMessageIndex < 0) return hookGroup ? [...content, hookGroup] : content;
	const finalMessage = content[finalMessageIndex];
	if (!finalMessage || finalMessage.kind !== "message") return content;
	const durationLabel = completedTurnDurationLabel(userMessage, finalMessage, observedElapsed);
	const completedTurn = durationLabel
		? content.map((entry, index) => (index === finalMessageIndex ? { ...entry, durationLabel } : entry))
		: content;
	const processStartIndex = userMessage ? 1 : 0;
	if (finalMessageIndex <= processStartIndex && !hookGroup) return completedTurn;
	const processItems = completedTurn.slice(processStartIndex, finalMessageIndex);
	if (completedTurn.slice(finalMessageIndex + 1).some((entry) => entry.kind === "tool-stack"))
		return hookGroup ? [...completedTurn, hookGroup] : completedTurn;
	const completedFinalMessage = completedTurn[finalMessageIndex];
	if (!completedFinalMessage || completedFinalMessage.kind !== "message") return completedTurn;

	const completedItems: ConversationRenderItem[] = [];
	if (userMessage) completedItems.push(userMessage);
	if (processItems.length) {
		completedItems.push({
			kind: "work-process",
			key: `work-process:${completedFinalMessage.key}:0`,
			items: processItems.map((entry) =>
				entry.kind === "tool-stack" ? { ...entry, collapseForResult: true } : entry,
			),
		});
	}
	if (hookGroup) completedItems.push(hookGroup);
	if (processItems.length) completedItems.push({ kind: "result-boundary", key: `result-boundary:${completedFinalMessage.key}` });
	completedItems.push(completedFinalMessage, ...completedTurn.slice(finalMessageIndex + 1));
	return completedItems;
}

function markCompletedTurnResults(
	rendered: ConversationContentRenderItem[],
	responseActive: boolean,
	observedElapsed?: (sentAt: number) => number | undefined,
): ConversationRenderItem[] {
	const next: ConversationRenderItem[] = [];
	let turn: ConversationContentRenderItem[] = [];
	for (const entry of rendered) {
		if (entry.kind === "message" && entry.role === "user") {
			if (turn.length) next.push(...markCompletedTurnResult(turn, true, observedElapsed));
			turn = [entry];
		} else {
			turn.push(entry);
		}
	}
	if (turn.length) next.push(...markCompletedTurnResult(turn, !responseActive, observedElapsed));
	return next;
}

export function buildConversationRenderItems(
	persistedItems: ConversationContentRenderItem[],
	liveItems: readonly LiveTurnItem[],
	liveTools: WorkbenchState["liveTools"],
	committedToolCallIds: ReadonlySet<string>,
	liveCompaction: LiveCompactionState | undefined,
	liveTurnId: number,
	responseActive: boolean,
	canEditPrompts = false,
	liveSteps: WorkbenchState["liveSteps"] = {},
	observedElapsed?: (sentAt: number) => number | undefined,
): ConversationRenderItem[] {
	const withLive = appendLiveRenderItems(
		persistedItems,
		liveItems,
		liveTools,
		committedToolCallIds,
		liveCompaction,
		liveTurnId,
		liveSteps,
	);
	for (let index = 0; index < withLive.length; index++) {
		const entry = withLive[index];
		if (entry?.kind !== "message" || entry.role !== "user") continue;
		const editable = canEditPrompts && Boolean(entry.entryId);
		if (entry.editable !== editable) withLive[index] = { ...entry, editable };
	}
	if (!responseActive) {
		for (let index = withLive.length - 1; index >= 0; index--) {
			const entry = withLive[index];
			if (entry?.kind !== "message" || entry.role !== "assistant" || !entry.text) continue;
			withLive[index] = { ...entry, copyVisible: true };
			break;
		}
	}
	return markCompletedTurnResults(withLive, responseActive, observedElapsed);
}
