import { ArrowDownToLine, LoaderCircle, Sparkles } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { useStickToBottomContext } from "use-stick-to-bottom";
import { type TranscriptToolViewModel, toSessionItemViewModel } from "../../adapters/session-view-model";
import { shouldJoinToolBatch } from "../../state/tool-batching";
import type { WorkbenchState } from "../../state/use-workbench";
import { Conversation, ConversationContent, ConversationEmptyState, ConversationScrollButton } from "../ai-elements/conversation";
import { ToolBatch, type ToolBatchTool } from "../ai-elements/tool-batch";
import { Button } from "../ui/button";
import { ACTIVE_OPERATION_STATUSES } from "./constants";
import { LiveTurn } from "./live-turn";
import { AgentErrorCard, TranscriptItemView } from "./transcript";
import type { WorkbenchActions } from "./types";

type TranscriptRenderItem =
	| { kind: "item"; item: WorkbenchState["transcript"][number] }
	| { kind: "tool-batch"; key: string; tools: ToolBatchTool[] };

function buildTranscriptRenderItems(
	items: WorkbenchState["transcript"],
	toolIndex: {
		callIds: ReadonlySet<string>;
		results: ReadonlyMap<string, TranscriptToolViewModel>;
		statuses: ReadonlyMap<string, "success" | "error">;
	},
): TranscriptRenderItem[] {
	const rendered: TranscriptRenderItem[] = [];
	let batchTools: ToolBatchTool[] = [];
	let batchKey = "";
	let batchEntryId: string | undefined;

	const flushBatch = () => {
		if (batchTools.length > 0) {
			rendered.push({ kind: "tool-batch", key: batchKey, tools: batchTools });
			batchTools = [];
			batchKey = "";
			batchEntryId = undefined;
		}
	};

	for (const item of items) {
		const viewModel = toSessionItemViewModel(item, toolIndex.statuses);
		if (viewModel.kind === "reasoning") continue;
		if (viewModel.kind === "tools" && item.view?.type === "tool_call") {
			for (const tool of viewModel.tools) {
				const result = toolIndex.results.get(tool.id);
				const resolvedTool = result
					? { ...tool, state: result.state, detail: result.detail, images: result.images, diff: result.diff }
					: tool;
				const previous = batchTools.at(-1);
				if (!previous || batchEntryId !== item.entryId || !shouldJoinToolBatch(previous.name, resolvedTool.name)) {
					flushBatch();
					batchEntryId = item.entryId;
					batchKey = `tool-batch:${item.entryId}:${item.renderId}:${resolvedTool.id}`;
				}
				batchTools.push(resolvedTool);
			}
			continue;
		}
		if (viewModel.kind === "tools" && item.view?.type === "tool_result") {
			if (toolIndex.callIds.has(item.view.callId)) continue;
			flushBatch();
			rendered.push({ kind: "item", item });
			continue;
		}
		flushBatch();
		rendered.push({ kind: "item", item });
	}
	flushBatch();
	return rendered;
}

export function ConversationView({
	state,
	actions,
	sessionTitleText,
}: {
	state: WorkbenchState;
	actions: WorkbenchActions;
	sessionTitleText: string;
}) {
	const toolIndex = useMemo(() => {
		const callIds = new Set<string>();
		const results = new Map<string, TranscriptToolViewModel>();
		const statuses = new Map<string, "success" | "error">();
		for (const item of state.transcript) {
			if (item.view?.type === "tool_call") {
				for (const call of item.view.calls) callIds.add(call.id);
			}
			if (item.view?.type === "tool_result") {
				const tool: TranscriptToolViewModel = {
					id: item.view.callId,
					name: item.view.name,
					summary: item.view.summary,
					state: item.view.status === "success" ? "output-available" : "output-error",
					detail: item.view.detail,
					images: item.view.images,
					diff: item.view.diff,
				};
				results.set(item.view.callId, tool);
				statuses.set(item.view.callId, item.view.status);
			}
		}
		return { callIds, results, statuses };
	}, [state.transcript]);
	const renderItems = useMemo(
		() => buildTranscriptRenderItems(state.transcript, toolIndex),
		[state.transcript, toolIndex],
	);

	return (
		<Conversation key={state.sessionId ?? "empty"} className="min-h-0 flex-1">
			<ConversationBody
				state={state}
				actions={actions}
				sessionTitleText={sessionTitleText}
				renderItems={renderItems}
				toolStatuses={toolIndex.statuses}
			/>
			<ConversationScrollButton aria-label="回到最新消息" />
		</Conversation>
	);
}

function ConversationBody({
	state,
	actions,
	sessionTitleText,
	renderItems,
	toolStatuses,
}: {
	state: WorkbenchState;
	actions: WorkbenchActions;
	sessionTitleText: string;
	renderItems: TranscriptRenderItem[];
	toolStatuses: ReadonlyMap<string, "success" | "error">;
}) {
	const { scrollRef, scrollToBottom, isAtBottom } = useStickToBottomContext();
	const pendingScrollRef = useRef<{ top: number; height: number } | undefined>(undefined);
	const responseActive = Boolean(
		state.liveText ||
			state.liveThinking ||
			state.liveTurnItems.length ||
			state.session?.activity === "running" ||
			state.session?.activity === "waiting_for_input" ||
			(state.currentOperation && ACTIVE_OPERATION_STATUSES.has(state.currentOperation.status)),
	);
	const lastAssistantMessageIndex = renderItems.reduce<number>((lastIndex, entry, index) => {
		if (entry.kind !== "item") return lastIndex;
		const viewModel = toSessionItemViewModel(entry.item, toolStatuses);
		return viewModel.kind === "message" && viewModel.role === "assistant" && viewModel.text ? index : lastIndex;
	}, -1);
	const autoScrollFrameRef = useRef<number | undefined>(undefined);

	useLayoutEffect(() => {
		if (!isAtBottom || !scrollRef.current || autoScrollFrameRef.current !== undefined) return;
		autoScrollFrameRef.current = window.requestAnimationFrame(() => {
			autoScrollFrameRef.current = undefined;
			void scrollToBottom({ animation: "instant", preserveScrollPosition: true });
		});
	}, [
		isAtBottom,
		scrollRef,
		scrollToBottom,
		state.hasMorePrevious,
		state.liveText,
		state.liveThinking,
		state.liveTools,
		state.liveTurnItems,
		state.statusText,
		state.transcript,
	]);

	useEffect(() => {
		return () => {
			if (autoScrollFrameRef.current !== undefined) {
				window.cancelAnimationFrame(autoScrollFrameRef.current);
				autoScrollFrameRef.current = undefined;
			}
		};
	}, []);

	const loadEarlier = useCallback(async () => {
		const scroller = scrollRef.current;
		if (scroller) pendingScrollRef.current = { top: scroller.scrollTop, height: scroller.scrollHeight };
		try {
			await actions.loadEarlier();
		} catch (error) {
			pendingScrollRef.current = undefined;
			throw error;
		}
	}, [actions.loadEarlier, scrollRef]);

	useLayoutEffect(() => {
		if (state.loadingEarlier || !pendingScrollRef.current) return;
		const frame = window.requestAnimationFrame(() => {
			const scroller = scrollRef.current;
			const pending = pendingScrollRef.current;
			if (scroller && pending) {
				scroller.scrollTop = pending.top + (scroller.scrollHeight - pending.height);
			}
			pendingScrollRef.current = undefined;
		});
		return () => window.cancelAnimationFrame(frame);
	}, [scrollRef, state.loadingEarlier]);

	const transcriptNodes: ReactNode[] = [];
	for (let index = 0; index < renderItems.length; index++) {
		const entry = renderItems[index];
		if (entry.kind === "tool-batch") {
			const batches = [entry];
			while (index + 1 < renderItems.length) {
				const next = renderItems[index + 1];
				if (next.kind !== "tool-batch") break;
				batches.push(next);
				index += 1;
			}
			transcriptNodes.push(
				<div className="tool-batch-stack" key={`tool-stack:${batches[0].key}`}>
					{batches.map((batch) => (
						<ToolBatch
							key={batch.key}
							className="tool-batch-render-item"
							tools={batch.tools}
							sessionId={state.sessionId}
							onOpenPath={(path) => void actions.openResource(path)}
						/>
					))}
				</div>,
			);
			continue;
		}
		transcriptNodes.push(
			<TranscriptItemView
				key={entry.item.renderId}
				item={entry.item}
				showCopy={!responseActive && index === lastAssistantMessageIndex}
				toolStatuses={toolStatuses}
				actions={actions}
				sessionId={state.sessionId}
			/>,
		);
	}

	return (
		<ConversationContent className="conversation-content mx-auto w-full max-w-[var(--conversation-width)] gap-3 px-5 py-10 sm:px-10 sm:py-12">
			{state.hasMorePrevious ? (
				<Button
					className="mx-auto"
					size="sm"
					variant="outline"
					disabled={state.loadingEarlier}
					onClick={() => void loadEarlier()}
				>
					{state.loadingEarlier ? (
						<LoaderCircle className="size-4 animate-spin" />
					) : (
						<ArrowDownToLine className="size-4" />
					)}
					{state.loadingEarlier ? "正在加载" : "加载更早消息"}
				</Button>
			) : null}
			{state.loading ? (
				<div
					className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground"
					aria-live="polite"
					aria-busy="true"
				>
					<LoaderCircle className="size-4 animate-spin" />
					正在加载项目与会话
				</div>
			) : state.sessionError ? (
				<AgentErrorCard
					title="会话信息加载失败"
					message={state.sessionError}
					onRetry={state.sessionId ? () => void actions.selectSession(state.sessionId!) : undefined}
				/>
			) : state.transcriptLoading && !state.transcript.length ? (
				<div
					className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground"
					aria-live="polite"
					aria-busy="true"
				>
					<LoaderCircle className="size-4 animate-spin" />
					正在加载会话记录
				</div>
			) : state.transcriptError && !state.transcript.length ? (
				<AgentErrorCard
					title="会话记录加载失败"
					message={state.transcriptError}
					onRetry={() => void actions.loadTranscript()}
				/>
			) : state.transcript.length ? (
				transcriptNodes
			) : (
				<ConversationEmptyState
					className="min-h-[56vh]"
					icon={<Sparkles className="size-6" />}
					title={state.session ? sessionTitleText : "选择一个会话"}
					description={state.session ? "从底部输入任务，运行进展会显示在这里。" : "从左侧选择会话或新建会话。"}
				/>
			)}
			<LiveTurn state={state} actions={actions} />
		</ConversationContent>
	);
}
