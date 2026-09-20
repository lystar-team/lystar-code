import { ArrowLeft, CheckCircle2, CircleX, Clock3, LoaderCircle, Play, Square } from "lucide-react";
import { useMemo, useState } from "react";
import { cn } from "../../lib/utils";
import type { SubagentConversationState, WorkbenchState } from "../../state/use-workbench";
import { formatElapsedDuration, ConversationView, type ConversationActions, type ConversationState } from "./conversation";
import type { WorkbenchActions } from "./types";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";

function snapshotActivity(state: SubagentConversationState["snapshot"]["state"]): "running" | "waiting_for_input" | "idle" {
	if (state === "waiting") return "waiting_for_input";
	if (state === "queued" || state === "running") return "running";
	return "idle";
}

function snapshotStateLabel(state: SubagentConversationState["snapshot"]["state"]): string {
	return {
		queued: "排队中",
		running: "运行中",
		waiting: "等待输入",
		succeeded: "已完成",
		failed: "失败",
		cancelled: "已停止",
	}[state];
}

function snapshotStateIcon(state: SubagentConversationState["snapshot"]["state"]) {
	if (state === "queued" || state === "running") return LoaderCircle;
	if (state === "waiting") return Clock3;
	if (state === "succeeded") return CheckCircle2;
	return CircleX;
}

function conversationState(parent: WorkbenchState, view: SubagentConversationState): ConversationState {
	const snapshot = view.snapshot;
	const hasSessionFile = Boolean(snapshot.session);
	return {
		sessionId: `subagent:${snapshot.runId}:${snapshot.agentId}`,
		currentProjectId: parent.currentProjectId,
		loading: view.transcriptLoading && !view.transcriptPageLoaded && hasSessionFile,
		connected: parent.connected,
		sessionReady: view.transcriptPageLoaded || !hasSessionFile,
		readOnly: true,
		session: { activity: snapshotActivity(snapshot.state) },
		sessionError: undefined,
		transcript: view.transcript,
		agentSteps: view.agentSteps,
		transcriptPageLoaded: view.transcriptPageLoaded || !hasSessionFile,
		transcriptLoading: view.transcriptLoading && hasSessionFile,
		transcriptError: view.transcriptError,
		previousCursor: view.previousCursor,
		hasMorePrevious: view.hasMorePrevious,
		loadingEarlier: view.loadingEarlier,
		pendingUserPrompts: [],
		queuedUserPrompts: [],
		promptSendTimes: {},
		promptScrollRequest: 0,
		currentOperation: undefined,
		liveTools: view.liveTools,
		liveSteps: view.liveSteps,
		liveTurnItems: view.liveTurnItems,
		liveCompaction: view.liveCompaction,
		liveTurnId: view.liveTurnId,
	};
}

export function SubagentPanel({ state, actions }: { state: WorkbenchState; actions: WorkbenchActions }) {
	const selectedId = state.selectedSubagentId;
	const view = selectedId ? state.subagentViews[selectedId] : undefined;
	const [continuation, setContinuation] = useState("");
	const [busy, setBusy] = useState<"abort" | "continue">();
	const selectedSnapshot = view?.snapshot;
	const Icon = selectedSnapshot ? snapshotStateIcon(selectedSnapshot.state) : LoaderCircle;
	const active = selectedSnapshot?.state === "queued" || selectedSnapshot?.state === "running";
	const canContinue = Boolean(selectedSnapshot?.controllable && selectedSnapshot.session && !active);
	const conversation = useMemo(
		() => (view ? conversationState(state, view) : undefined),
		[state, view],
	);
	const conversationActions = useMemo<ConversationActions>(
		() => ({
			openResource: actions.openResource,
			queueAction: async () => {},
			showToast: actions.showToast,
			loadEarlier: actions.loadEarlierSubagent,
			loadTranscript: async () => {
				if (!selectedId) return;
				await actions.openSubagent(selectedId);
			},
		}),
		[actions.loadEarlierSubagent, actions.openResource, actions.openSubagent, actions.showToast, selectedId],
	);
	const elapsed = selectedSnapshot ? formatElapsedDuration(selectedSnapshot.elapsedMs) : undefined;

	const handleAbort = async () => {
		setBusy("abort");
		try {
			await actions.abortSubagent();
		} catch (error) {
			actions.showToast(error instanceof Error ? error.message : String(error));
		} finally {
			setBusy(undefined);
		}
	};
	const handleContinue = async () => {
		const text = continuation.trim();
		if (!text) return;
		setBusy("continue");
		try {
			await actions.continueSubagent(text);
			setContinuation("");
		} catch (error) {
			actions.showToast(error instanceof Error ? error.message : String(error));
		} finally {
			setBusy(undefined);
		}
	};

	if (!view || !selectedSnapshot || !conversation) {
		return (
			<div className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground">
				选择一个 Subagent 查看子会话
			</div>
		);
	}

	return (
		<div className="flex h-full min-h-0 flex-col bg-background">
			<div className="shrink-0 border-b border-border/60 px-4 py-3">
				<div className="flex min-w-0 items-start gap-2">
					<Button
						aria-label="返回运行列表"
						className="mt-0.5 size-7 shrink-0"
						onClick={actions.closeSubagent}
						size="icon"
						variant="ghost"
					>
						<ArrowLeft className="size-4" />
					</Button>
					<div className="min-w-0 flex-1">
						<div className="flex min-w-0 items-center gap-2">
							<Icon className={cn("size-4 shrink-0 text-muted-foreground", active && "animate-spin")} />
							<h3 className="truncate text-sm font-semibold">{selectedSnapshot.agent}</h3>
							<span className="shrink-0 text-xs text-muted-foreground">{snapshotStateLabel(selectedSnapshot.state)}</span>
						</div>
						<div className="mt-1 flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
							<Clock3 className="size-3 shrink-0" />
							<span>{elapsed ? `已运行 ${elapsed}` : "正在计时"}</span>
							<span className="truncate">{selectedSnapshot.currentAction || selectedSnapshot.task}</span>
						</div>
					</div>
				</div>
				<p className="mt-2 line-clamp-2 pl-9 text-xs leading-5 text-muted-foreground">{selectedSnapshot.task}</p>
			</div>
			<div className="min-h-0 flex-1">
				<ConversationView
					state={conversation}
					actions={conversationActions}
					sessionTitleText={selectedSnapshot.agent}
					onEditPrompt={() => {}}
					allowPromptEditing={false}
				/>
			</div>
			<div className="shrink-0 border-t border-border/60 bg-background/95 px-4 py-3">
				{active ? (
					<Button className="w-full" disabled={busy !== undefined} onClick={() => void handleAbort()} variant="outline">
						{busy === "abort" ? <LoaderCircle className="size-4 animate-spin" /> : <Square className="size-3.5 fill-current" />}
						停止 Subagent
					</Button>
				) : canContinue ? (
					<form
						className="grid gap-2"
						onSubmit={(event) => {
							event.preventDefault();
							void handleContinue();
						}}
					>
						<Textarea
							aria-label="继续 Subagent"
								disabled={busy !== undefined}
								maxLength={16_000}
								onChange={(event) => setContinuation(event.target.value)}
								onKeyDown={(event) => {
									if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
										event.preventDefault();
										void handleContinue();
									}
								}}
								placeholder="输入补充要求，继续这个 Subagent"
								rows={2}
								value={continuation}
						/>
						<Button disabled={busy !== undefined || !continuation.trim()} type="submit">
							{busy === "continue" ? <LoaderCircle className="size-4 animate-spin" /> : <Play className="size-4" />}
							继续 Subagent
						</Button>
					</form>
				) : (
					<div className="text-center text-xs text-muted-foreground">
						{view.statusText || (selectedSnapshot.state === "waiting" ? "等待主会话输入" : "该 Subagent 已结束")}
					</div>
				)}
			</div>
		</div>
	);
}
