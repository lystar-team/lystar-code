import { CircleAlert, Clock3, LoaderCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { webApi } from "../../adapters/host-protocol/api";
import { hasActiveSessionWork } from "../../state/chat-lifecycle";
import type { WorkbenchState } from "../../state/workbench-types";
import type { WebSessionSnapshot } from "../../types";
import { Button } from "../ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { formatElapsedDuration } from "./conversation-format";

const SILENCE_NOTICE_MS = 30_000;
const STATUS_CHECK_INTERVAL_MS = 10_000;
const STATUS_CHECK_TIMEOUT_MS = 8_000;
type Execution = NonNullable<WebSessionSnapshot["execution"]>;
type StatusCheck = { session?: WebSessionSnapshot; receivedAt?: number; error?: string };

const phaseLabels: Record<Execution["phase"], string> = {
	preparing: "正在准备请求",
	waiting_model: "等待模型响应",
	thinking: "正在接收思考内容",
	responding: "正在生成回复",
	tool: "正在执行工具",
	compaction: "正在整理上下文",
	retry: "等待重试",
	waiting_input: "等待你的确认",
	finishing: "正在完成后续处理",
	idle: "等待任务状态更新",
};

function StatusDetail({ label, value }: { label: string; value: string }) {
	return (
		<div className="flex items-start justify-between gap-4 text-xs">
			<span className="shrink-0 text-muted-foreground">{label}</span>
			<span className="min-w-0 break-words text-right tabular-nums text-foreground">{value}</span>
		</div>
	);
}

export function ComposerExecutionStatus({ state }: { state: WorkbenchState }) {
	const { sessionId, connected, sessionReady } = state;
	const waitingForInput = state.session?.phase === "waiting_for_input" || state.session?.activity === "waiting_for_input" ||
		state.currentOperation?.status === "waiting_for_input" ||
		state.pendingUiRequests.some((request) => request.operationId === state.currentOperation?.operationId);
	const stopping = Boolean(sessionId && state.stoppingSessionIds[sessionId]);
	const active = hasActiveSessionWork(state) || waitingForInput || stopping;
	const [now, setNow] = useState(() => Date.now());
	const [check, setCheck] = useState<StatusCheck>({});

	useEffect(() => {
		if (!active) return;
		setNow(Date.now());
		const timer = window.setInterval(() => setNow(Date.now()), 1_000);
		return () => window.clearInterval(timer);
	}, [active]);

	useEffect(() => {
		if (!active || !connected || !sessionReady || !sessionId) return;
		setCheck({});
		let disposed = false;
		let timer: number | undefined;
		let request: AbortController | undefined;
		const inspect = async () => {
			if (disposed || request || document.visibilityState === "hidden") return;
			const controller = new AbortController();
			request = controller;
			const timeout = window.setTimeout(() => controller.abort(), STATUS_CHECK_TIMEOUT_MS);
			try {
				const result = await webApi.session(sessionId, controller.signal);
				if (!disposed) setCheck({ session: result.session, receivedAt: Date.now() });
			} catch (error: unknown) {
				if (!disposed) setCheck((previous) => ({
					...previous,
					error: controller.signal.aborted ? "运行状态核对超时" : error instanceof Error ? error.message : String(error),
				}));
			} finally {
				window.clearTimeout(timeout);
				request = undefined;
				if (!disposed) timer = window.setTimeout(() => void inspect(), STATUS_CHECK_INTERVAL_MS);
			}
		};
		const onVisibilityChange = () => {
			if (document.visibilityState === "hidden") return;
			if (timer !== undefined) window.clearTimeout(timer);
			void inspect();
		};
		void inspect();
		document.addEventListener("visibilitychange", onVisibilityChange);
		return () => {
			disposed = true;
			if (timer !== undefined) window.clearTimeout(timer);
			request?.abort();
			document.removeEventListener("visibilitychange", onVisibilityChange);
		};
	}, [active, connected, sessionId, sessionReady]);

	if (!active) return null;
	const liveExecution = state.session?.execution;
	const checkedExecution = check.session?.execution;
	const candidateExecution = checkedExecution && (!liveExecution ||
		(checkedExecution.lastProgressAt ?? 0) > (liveExecution.lastProgressAt ?? 0))
		? checkedExecution : liveExecution;
	const operation = state.currentOperation && state.currentOperation.sessionId === sessionId &&
		["prompt", "compact", "run_bash"].includes(state.currentOperation.type) &&
		["accepted", "running", "waiting_for_input"].includes(state.currentOperation.status) ? state.currentOperation : undefined;
	const execution = operation && candidateExecution &&
		operation.acceptedAt > candidateExecution.lastProgressAt ? undefined : candidateExecution;
	const observedAt = check.session?.observedAt;
	const clockOffset = observedAt !== undefined && check.receivedAt !== undefined ? check.receivedAt - observedAt : 0;
	const serverNow = now - clockOffset;
	const phaseStartedAt = waitingForInput && execution?.phase !== "waiting_input" ? undefined : execution?.phaseStartedAt;
	const elapsedStartedAt = phaseStartedAt ?? operation?.acceptedAt;
	const elapsed = elapsedStartedAt === undefined ? undefined
		: formatElapsedDuration(Math.max(0, serverNow - elapsedStartedAt));
	const silenceMs = execution?.lastProgressAt === undefined ? undefined : Math.max(0, serverNow - execution.lastProgressAt);
	const silence = silenceMs === undefined ? undefined : formatElapsedDuration(silenceMs);
	const retryRemaining = execution?.retryAt === undefined ? undefined : Math.max(0, Math.ceil((execution.retryAt - serverNow) / 1_000));
	const waiting = waitingForInput || execution?.phase === "waiting_input";
	const scheduledRetry = execution?.phase === "retry" && retryRemaining !== undefined && retryRemaining > 0;
	const stale = connected && sessionReady && !waiting && !scheduledRetry && execution?.phase !== "idle" &&
		silenceMs !== undefined && silenceMs >= SILENCE_NOTICE_MS;
	let label = !connected ? "连接中断，运行状态未知" : !sessionReady ? "正在同步运行状态"
		: stopping ? "正在停止，等待运行端确认" : waiting ? "等待你的确认"
		: execution ? phaseLabels[execution.phase] : "运行状态尚未确认";
	if (connected && sessionReady && !stopping && !waiting && execution) {
		if (stale && execution.phase === "thinking") label = "等待新的思考内容";
		if (stale && execution.phase === "responding") label = "等待新的回复内容";
		if (execution.phase === "tool" && execution.toolName) label = `正在执行 ${execution.toolName}`;
		if (execution.phase === "retry" && retryRemaining === 0) label = "等待重试进展";
	}
	const statusUnknown = !connected || !sessionReady || check.error !== undefined;
	const connectionLabel = !connected ? "连接已断开" : check.error ? "运行端状态暂未确认"
		: observedAt !== undefined && check.receivedAt !== undefined
			? `运行端 ${formatElapsedDuration(Math.max(0, now - check.receivedAt))}前确认`
			: check.receivedAt !== undefined ? "服务可联系，会话运行状态未确认" : "正在核对运行端状态";
	const Icon = stale || statusUnknown ? CircleAlert : waiting || scheduledRetry || execution?.phase === "waiting_model" ? Clock3 : LoaderCircle;

	return (
		<div className="mb-2 min-w-0 px-1 text-xs text-muted-foreground" data-testid="composer-execution-status">
			<div className="flex min-h-7 min-w-0 items-center gap-2">
				<Icon aria-hidden="true" className={`size-3.5 shrink-0 ${stale || statusUnknown ? "text-[var(--warning)]" : ""}`} />
				<span className="min-w-0 flex-1 truncate" role="status" aria-live="polite" title={label}>{label}</span>
				{elapsed ? <span className="shrink-0 tabular-nums" aria-label={`${phaseStartedAt !== undefined ? "当前阶段耗时" : "任务已等待"} ${elapsed}`}>{elapsed}</span> : null}
				<Popover>
					<PopoverTrigger asChild>
						<Button type="button" variant="ghost" size="sm" className="h-7 shrink-0 px-1.5 text-xs text-muted-foreground" aria-label="查看运行状态详情">详情</Button>
					</PopoverTrigger>
					<PopoverContent align="end" side="top" sideOffset={8} collisionPadding={8} className="w-72 max-w-[calc(100vw-1rem)] rounded-xl border-border bg-popover p-3 shadow-md">
						<div className="mb-3 text-sm font-medium">运行状态</div>
						<div className="space-y-2">
							<StatusDetail label="当前阶段" value={label} />
							<StatusDetail label={phaseStartedAt !== undefined ? "阶段耗时" : "任务已等待"} value={elapsed ?? "尚未确认"} />
							<StatusDetail label="最后进展" value={silence ? `${silence}前` : "尚未确认"} />
							<StatusDetail label="模型最近事件" value={execution?.lastModelEventAt === undefined ? "尚未收到" : `${formatElapsedDuration(Math.max(0, serverNow - execution.lastModelEventAt))}前`} />
							{execution?.toolName ? <StatusDetail label="当前工具" value={execution.toolName} /> : null}
							{execution?.retryAttempt ? <StatusDetail label="重试次数" value={execution.retryMaxAttempts ? `${execution.retryAttempt}/${execution.retryMaxAttempts}` : String(execution.retryAttempt)} /> : null}
							{scheduledRetry ? <StatusDetail label="下次重试" value={`${retryRemaining}秒后`} /> : null}
							<StatusDetail label="连接确认" value={connectionLabel} />
						</div>
						{check.error ? <p className="mt-3 break-words text-xs text-[var(--warning)]">{check.error}</p> : null}
					</PopoverContent>
				</Popover>
			</div>
			<div className="flex min-w-0 flex-wrap gap-x-3 gap-y-1 pl-[22px] py-0.5">
				{silence ? <span className={`tabular-nums ${stale ? "text-[var(--warning)]" : ""}`}>{stale ? `已 ${silence}未收到新进展` : `最后进展 ${silence}前`}</span> : null}
				{scheduledRetry ? <span className="tabular-nums">{retryRemaining}秒后重试</span> : null}
				<span>{connectionLabel}</span>
			</div>
		</div>
	);
}
