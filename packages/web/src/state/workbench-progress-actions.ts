import { useCallback } from "react";
import { mergeWebSearchProgress } from "@lystar/code-web-protocol";
import type { SessionProgress } from "@lystar/code-web-protocol";
import {
	removeQueuedUserPrompt,
	removeQueuedUserPromptByText,
	reconcileQueuedUserPromptCounts,
} from "./chat-lifecycle.ts";
import { restoreCompactionState, updateCompactionState } from "./compaction-state.ts";
import {
	appendLiveTextBlock,
	appendLiveToolBlock,
	applyToolActivityState,
	detachFinalTextFromCompletedStep,
	ensureLiveCompactionMarker,
	liveToolFromUpdate,
	markLiveUserPromptProcessing,
	mergeToolDiff,
	nextLiveToolBatchId,
	runningAgentStepId,
} from "./workbench-live-state.ts";
import { mergeImageGenerationSummary, mergeWebSearchToolSummary } from "./tool-batching.ts";
import { gitCredentialAuthorizationMessageFromProgress, sessionActivityFromProgress } from "./workbench-state.ts";
import type { WorkbenchState } from "./workbench-types.ts";

type StateRef = { current: WorkbenchState };
type StateUpdate = WorkbenchState | ((current: WorkbenchState) => WorkbenchState);
type UpdateState = (update: StateUpdate) => WorkbenchState;
type Ref<T> = { current: T };
type LiveTextProgress = Extract<SessionProgress, { type: "assistant_delta" | "thinking_delta" }>;
type PendingTextProgress = { selection: number; sessionId: string; progress: LiveTextProgress };

export interface WorkbenchProgressActionsContext {
	stateRef: StateRef;
	updateState: UpdateState;
	selectionRef: Ref<number>;
	liveToolBatchRef: Ref<number>;
	liveTurnItemRef: Ref<number>;
	pendingTextProgressRef: Ref<PendingTextProgress[]>;
	pendingTextFrameRef: Ref<number | undefined>;
	pendingTextTimeoutRef: Ref<number | undefined>;
}

export function useWorkbenchProgressActions({
	stateRef,
	updateState,
	selectionRef,
	liveToolBatchRef,
	liveTurnItemRef,
	pendingTextProgressRef,
	pendingTextFrameRef,
	pendingTextTimeoutRef,
}: WorkbenchProgressActionsContext) {
	const applyProgressNow = useCallback(
		(progress: SessionProgress) => {
			const gitAuthorizationMessage = gitCredentialAuthorizationMessageFromProgress(progress);
			updateState((current) => {
				if (gitAuthorizationMessage) current = { ...current, gitCredentialAuthorizationMessage: gitAuthorizationMessage };
				const activity = sessionActivityFromProgress(progress);
				if (current.session && activity && current.session.activity !== activity) {
					current = { ...current, session: { ...current.session, activity } };
				}
				switch (progress.type) {
					case "assistant_delta":
						return {
							...current,
							liveTurnActive: true,
							liveTurnItems: appendLiveTextBlock(
								current.liveTurnItems,
								"text",
								progress.text,
								`live-turn:${liveTurnItemRef.current++}`,
								current.liveTurnId,
								progress.stepId,
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
								`live-thinking:${liveTurnItemRef.current++}`,
								current.liveTurnId,
								progress.stepId,
							),
							statusText: "正在思考",
						};
					case "user_message":
						return {
							...current,
							queuedUserPrompts: progress.queueId
								? removeQueuedUserPrompt(current.queuedUserPrompts, progress.queueId)
								: removeQueuedUserPromptByText(current.queuedUserPrompts, progress.text),
							liveTurnItems: markLiveUserPromptProcessing(
								current.liveTurnItems,
								progress.queueId,
								progress.text,
							),
							statusText: "正在处理",
						};
					case "agent_step":
						return {
							...current,
							liveTurnActive: true,
							liveSteps: { ...current.liveSteps, [progress.step.id]: progress.step },
							statusText: progress.step.status === "running" ? progress.step.title : current.statusText,
						};
					case "tool_state":
						return applyToolActivityState(current, progress.activity);
					case "tool_start": {
						const previous = current.liveTools[progress.toolCallId];
						const webSearch =
							progress.name === "web_search"
								? mergeWebSearchProgress(previous?.webSearch, progress.webSearch)
								: undefined;
						const summary =
							progress.name === "web_search"
								? mergeWebSearchToolSummary(previous?.summary, progress.summary, webSearch)
								: progress.name === "image_gen"
									? mergeImageGenerationSummary(previous?.summary, progress.summary)
									: progress.summary ?? previous?.summary ?? "正在执行";
						const batchId =
							previous?.batchId ??
							nextLiveToolBatchId(
								current,
								progress.name,
								summary,
								progress.stepId,
								current.liveTurnId,
								`live-tool-batch:${liveToolBatchRef.current++}`,
							);
						return {
							...current,
							liveTools: {
								...current.liveTools,
								[progress.toolCallId]: {
									id: progress.toolCallId,
									name: progress.name,
									batchId,
									summary,
									state: "running",
									status: "running",
									stepId: progress.stepId ?? previous?.stepId,
									...(previous?.inputPreview ? { inputPreview: true } : {}),
									...(webSearch ? { webSearch } : {}),
									diff: mergeToolDiff(previous?.diff, progress.diff),
								},
							},
							liveTurnItems: previous
								? current.liveTurnItems
								: appendLiveToolBlock(
										current.liveTurnItems,
										batchId,
										progress.toolCallId,
										`live-tools:${liveTurnItemRef.current++}`,
										current.liveTurnId,
									),
							statusText: `正在执行 ${progress.name}`,
						};
					}
					case "tool_update": {
						const previous = current.liveTools[progress.toolCallId];
						if (previous && previous.status !== "running") return current;
						const webSearch =
							progress.name === "web_search"
								? mergeWebSearchProgress(previous?.webSearch, progress.webSearch)
								: undefined;
						const summary =
							progress.name === "web_search"
								? mergeWebSearchToolSummary(previous?.summary, progress.summary, webSearch)
								: progress.name === "image_gen"
									? mergeImageGenerationSummary(previous?.summary, progress.summary)
									: progress.summary || previous?.summary || "正在执行";
						const batchId =
							previous?.batchId ??
							nextLiveToolBatchId(
								current,
								progress.name,
								summary,
								progress.stepId,
								current.liveTurnId,
								`live-tool-batch:${liveToolBatchRef.current++}`,
							);
						return {
							...current,
							liveTools: {
								...current.liveTools,
								[progress.toolCallId]: liveToolFromUpdate(progress, previous, batchId, summary, webSearch),
							},
							liveTurnItems: previous
								? current.liveTurnItems
								: appendLiveToolBlock(
										current.liveTurnItems,
										batchId,
										progress.toolCallId,
										`live-tools:${liveTurnItemRef.current++}`,
										current.liveTurnId,
									),
						};
					}
					case "tool_end": {
						const previous = current.liveTools[progress.toolCallId];
						const webSearch =
							progress.name === "web_search"
								? mergeWebSearchProgress(previous?.webSearch, progress.webSearch)
								: undefined;
						const summary =
							progress.name === "web_search"
								? mergeWebSearchToolSummary(previous?.summary, progress.summary, webSearch)
								: previous?.summary ?? progress.summary;
						const batchId =
							previous?.batchId ??
							nextLiveToolBatchId(
								current,
								progress.name,
								summary,
								progress.stepId,
								current.liveTurnId,
								`live-tool-batch:${liveToolBatchRef.current++}`,
							);
						return {
							...current,
							liveTools: {
								...current.liveTools,
								[progress.toolCallId]: {
									id: progress.toolCallId,
									name: progress.name,
									batchId,
									summary,
									state: progress.status === "success" ? "success" : "error",
									result: progress.summary,
									status: progress.status,
									stepId: progress.stepId ?? previous?.stepId,
									...(webSearch ? { webSearch } : {}),
									diff: mergeToolDiff(previous?.diff, progress.diff),
								},
							},
							liveTurnItems: previous
								? current.liveTurnItems
								: appendLiveToolBlock(
										current.liveTurnItems,
										batchId,
										progress.toolCallId,
										`live-tools:${liveTurnItemRef.current++}`,
										current.liveTurnId,
									),
							statusText: progress.status === "error" ? `${progress.name} 执行失败` : `${progress.name} 已完成`,
						};
					}
					case "queue_update": {
						const queuedUserPrompts = reconcileQueuedUserPromptCounts(
							current.queuedUserPrompts,
							progress.steeringCount,
							progress.followUpCount,
						);
						const queuedPromptIds = new Set(queuedUserPrompts.map((prompt) => prompt.id));
						return {
							...current,
							queuedUserPrompts,
							liveTurnItems: current.liveTurnItems.map((item) =>
								item.kind === "user" && item.status === "queued" && !queuedPromptIds.has(item.queueId)
									? { ...item, status: "processing" as const }
									: item,
							),
							statusText:
								progress.steeringCount + progress.followUpCount > 0
									? `队列中 ${progress.steeringCount + progress.followUpCount} 项`
									: "正在处理",
						};
					}
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
							liveCompaction,
							liveTurnId: progress.phase === "turn" ? current.liveTurnId + 1 : current.liveTurnId,
							...(progress.phase === "turn"
								? {
										liveTurnStartRevision: current.transcriptRevision,
										liveTurnActive: true,
										liveTurnItems,
										liveTools: {},
										toolActivityEpoch: undefined,
										toolActivityRevision: undefined,
										liveSteps: {},
								  }
								: progress.phase === "idle" || progress.phase === "interrupted"
									? { liveTurnActive: false, liveTurnItems }
									: { liveTurnItems }),
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
					case "compaction": {
						const liveCompaction = updateCompactionState(current.liveCompaction, progress, current.transcript);
						return {
							...current,
							liveCompaction,
							statusText:
								progress.status === "running"
									? "正在整理上下文"
									: progress.status === "completed"
										? "上下文已整理"
										: progress.status === "failed"
											? "上下文整理失败"
											: progress.status === "waiting_retry"
												? "等待重试摘要"
												: "上下文整理已停止",
						};
					}
					case "retry": {
						const liveCompaction = updateCompactionState(current.liveCompaction, progress, current.transcript);
						return {
							...current,
							liveCompaction,
							statusText:
								progress.status === "running"
									? "正在重试"
									: progress.status === "failed"
										? "重试失败"
										: progress.status === "completed"
											? "重试完成"
											: "等待重试",
						};
					}
					case "bash":
						return { ...current, statusText: "正在运行命令" };
					case "status":
						return { ...current, statusText: progress.status };
					case "usage":
						return progress.usage.elapsedMs && progress.usage.outputTokens
							? {
									...current,
									lastOutputSpeed: {
										outputTokens: progress.usage.outputTokens,
										elapsedMs: progress.usage.elapsedMs,
									},
								}
							: current;
				}
			});
		},
		[updateState],
	);

	const flushPendingTextProgress = useCallback(() => {
		if (pendingTextFrameRef.current !== undefined) {
			window.cancelAnimationFrame(pendingTextFrameRef.current);
			pendingTextFrameRef.current = undefined;
		}
		if (pendingTextTimeoutRef.current !== undefined) {
			window.clearTimeout(pendingTextTimeoutRef.current);
			pendingTextTimeoutRef.current = undefined;
		}
		const pending = pendingTextProgressRef.current;
		pendingTextProgressRef.current = [];
		const selection = selectionRef.current;
		const sessionId = stateRef.current.sessionId;
		let batch: LiveTextProgress | undefined;
		for (const entry of pending) {
			if (entry.selection !== selection || entry.sessionId !== sessionId) continue;
			const progress = entry.progress;
			if (batch && batch.type === progress.type && batch.stepId === progress.stepId) {
				batch = { ...batch, text: batch.text + progress.text };
				continue;
			}
			if (batch) applyProgressNow(batch);
			batch = progress;
		}
		if (batch) applyProgressNow(batch);
	}, [applyProgressNow]);

	const applyProgress = useCallback(
		(progress: SessionProgress, sessionId: string) => {
			if (progress.type === "assistant_delta" || progress.type === "thinking_delta") {
				const selection = selectionRef.current;
				const pending = pendingTextProgressRef.current;
				const previous = pending.at(-1);
				if (
					previous?.selection === selection &&
					previous.sessionId === sessionId &&
					previous.progress.type === progress.type &&
					previous.progress.stepId === progress.stepId
				) {
					pending[pending.length - 1] = {
						selection,
						sessionId,
						progress: { ...progress, text: previous.progress.text + progress.text },
					};
				} else {
					pending.push({ selection, sessionId, progress });
				}
				if (pendingTextFrameRef.current === undefined && pendingTextTimeoutRef.current === undefined) {
					if (document.visibilityState === "hidden") {
						pendingTextTimeoutRef.current = window.setTimeout(flushPendingTextProgress, 32);
					} else {
						pendingTextFrameRef.current = window.requestAnimationFrame(flushPendingTextProgress);
					}
				}
				return;
			}
			flushPendingTextProgress();
			applyProgressNow(progress);
		},
		[applyProgressNow, flushPendingTextProgress],
	);

	return { flushPendingTextProgress, applyProgress };
}
