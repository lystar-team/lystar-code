import { CircleAlert, Clock3, Info, LoaderCircle } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { webApi } from "../../adapters/host-protocol/api";
import { toCodemodeToolViewModel } from "../../adapters/codemode-tool-view-model";
import { toLiveToolViewModel } from "../../adapters/live-tool-view-model";
import { hasActiveSessionWork } from "../../state/chat-lifecycle";
import type { WorkbenchState } from "../../state/workbench-types";
import { runtimeNow, type RuntimeClock } from "../../state/runtime-clock.ts";
import type { ToolBatchTool, WebSessionSnapshot } from "../../types";
import { Button } from "../ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";
import { formatElapsedDuration } from "./conversation-format";

const SILENCE_NOTICE_MS = 30_000;
const STATUS_CHECK_INTERVAL_MS = 10_000;
const STATUS_CHECK_TIMEOUT_MS = 8_000;
type Execution = NonNullable<WebSessionSnapshot["execution"]>;
type StatusCheck = { session?: WebSessionSnapshot; receivedAt?: number; clock?: RuntimeClock; error?: string };

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

const toolStatusTitles: Record<string, string> = {
	read: "读取文件",
	edit: "编辑文件",
	write: "写入文件",
	apply_patch: "应用补丁",
	ls: "查看目录",
	grep: "搜索内容",
	find: "查找文件",
	bash: "执行命令",
	web_search: "搜索网页",
	codemode: "执行脚本",
	codemode_wait: "等待脚本返回结果",
	mcp: "调用 MCP 工具",
	session_create: "派发智能体任务",
	session_send: "发送智能体消息",
	session_wait: "等待智能体返回结果",
	session_stop: "停止智能体任务",
	session_accept_result: "接收智能体产物",
	session_workspaces: "查看协作工作区",
	session_list: "查看智能体会话",
	session_profiles: "查看智能体配置",
	room_create: "创建协作空间",
	room_join: "加入协作空间",
	room_leave: "退出协作空间",
	room_list: "查看协作空间",
	room_send: "发送协作消息",
	room_read: "读取协作消息",
	room_task_list: "查看协作任务",
	room_task_create: "创建协作任务",
	room_task_update: "更新协作任务",
	room_claim: "领取协作任务",
};

function toolStatusTitle(tool: ToolBatchTool): string {
	if (tool.name === "image_gen") return tool.images?.length ? `已生成 ${tool.images.length} 张图片` : "生成图片";
	return toolStatusTitles[tool.name] ?? `调用 ${tool.name}`;
}

export function ComposerExecutionStatus({ state, onVisibilityChange }: { state: WorkbenchState; onVisibilityChange: (visible: boolean) => void }) {
	const { sessionId, connected, sessionReady } = state;
	const waitingForInput = state.session?.phase === "waiting_for_input" || state.session?.activity === "waiting_for_input" ||
		state.currentOperation?.status === "waiting_for_input" ||
		state.pendingUiRequests.some((request) => request.operationId === state.currentOperation?.operationId);
	const stopping = Boolean(sessionId && state.stoppingSessionIds[sessionId]);
	const active = hasActiveSessionWork(state) || waitingForInput || stopping || Boolean(sessionId && connected && !sessionReady);
	const [now, setNow] = useState(() => Date.now());
	const [check, setCheck] = useState<StatusCheck>({});
	const [detailsOpen, setDetailsOpen] = useState(false);
	const detailsTriggerRef = useRef<HTMLButtonElement>(null);
	const clickOpenedRef = useRef(false);

	useLayoutEffect(() => {
		onVisibilityChange(active);
	}, [active, onVisibilityChange]);
	useEffect(() => {
		if (!active) return;
		setNow(Date.now());
		const timer = window.setInterval(() => setNow(Date.now()), 1_000);
		return () => window.clearInterval(timer);
	}, [active]);

	useEffect(() => {
		setCheck({});
		if (!active || !connected || !sessionId) return;
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
				if (!disposed) setCheck({
					session: result.session,
					receivedAt: Date.now(),
					clock: result.session.observedAt === undefined ? undefined : { serverAt: result.session.observedAt, receivedAt: performance.now() },
				});
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
	}, [active, connected, sessionId]);

	if (!active) return null;
	const liveExecution = state.session?.execution;
	const checked = check.session?.id === sessionId ? check : undefined;
	const checkedExecution = checked?.session?.execution;
	const candidateExecution = checkedExecution && (!liveExecution ||
		(checkedExecution.lastProgressAt ?? 0) > (liveExecution.lastProgressAt ?? 0))
		? checkedExecution : liveExecution;
	const operation = state.currentOperation && state.currentOperation.sessionId === sessionId &&
		["prompt", "compact", "run_bash"].includes(state.currentOperation.type) &&
		["accepted", "running", "waiting_for_input"].includes(state.currentOperation.status) ? state.currentOperation : undefined;
	const execution = operation && candidateExecution &&
		operation.acceptedAt > candidateExecution.lastProgressAt ? undefined : candidateExecution;
	const activeTools = execution?.phase === "tool" ? Object.values(state.liveTools).reverse() : [];
	const liveTool = activeTools.find((tool) => tool.name === execution?.toolName && tool.state === "running");
	const nestedCall = liveTool ? undefined : activeTools.flatMap((tool) => tool.codemode?.calls ?? []).reverse()
		.find((call) => call.name === execution?.toolName && call.status === "running");
	const currentTool = liveTool ? toLiveToolViewModel(liveTool) : nestedCall ? toCodemodeToolViewModel(nestedCall)
		: execution?.toolName ? { id: execution.toolName, name: execution.toolName, summary: "", state: "input-available" as const } : undefined;
	const toolLabel = currentTool ? toolStatusTitle(currentTool) : undefined;
	const observedAt = checked?.session?.observedAt;
	const clock = checked?.clock && checked.clock.serverAt > (state.runtimeClock?.serverAt ?? -Infinity)
		? checked.clock : state.runtimeClock;
	const serverNow = clock ? runtimeNow(clock) : undefined;
	const syncing = connected && !sessionReady && !state.sessionError;
	const phaseStartedAt = waitingForInput && execution?.phase !== "waiting_input" ? undefined : execution?.phaseStartedAt;
	const elapsedStartedAt = phaseStartedAt ?? operation?.acceptedAt;
	const elapsed = syncing
		? state.sessionSyncStartedAt === undefined ? undefined : formatElapsedDuration(Math.max(0, performance.now() - state.sessionSyncStartedAt))
		: !connected || !sessionReady || serverNow === undefined || elapsedStartedAt === undefined ? undefined
			: formatElapsedDuration(Math.max(0, serverNow - elapsedStartedAt));
	const elapsedLabel = syncing ? "同步耗时" : phaseStartedAt !== undefined ? "阶段耗时" : "任务已等待";
	const silenceMs = serverNow === undefined || execution?.lastProgressAt === undefined ? undefined : Math.max(0, serverNow - execution.lastProgressAt);
	const silence = silenceMs === undefined ? undefined : formatElapsedDuration(silenceMs);
	const retryRemaining = serverNow === undefined || execution?.retryAt === undefined ? undefined : Math.max(0, Math.ceil((execution.retryAt - serverNow) / 1_000));
	const waiting = waitingForInput || execution?.phase === "waiting_input";
	const scheduledRetry = execution?.phase === "retry" && retryRemaining !== undefined && retryRemaining > 0;
	const stale = connected && sessionReady && !waiting && !scheduledRetry && execution?.phase !== "idle" &&
		silenceMs !== undefined && silenceMs >= SILENCE_NOTICE_MS;
	let label = !connected ? "连接中断，运行状态未知" : state.sessionError ? state.sessionError : !sessionReady ? "正在同步运行状态"
		: stopping ? "正在停止，等待运行端确认" : waiting ? "等待你的确认"
		: execution ? phaseLabels[execution.phase] : "运行状态尚未确认";
	if (connected && sessionReady && !stopping && !waiting && execution) {
		if (stale && execution.phase === "thinking") label = "等待新的思考内容";
		if (stale && execution.phase === "responding") label = "等待新的回复内容";
		if (execution.phase === "tool" && toolLabel) label = toolLabel.startsWith("正在") ? toolLabel : `正在${toolLabel}`;
		if (execution.phase === "retry" && retryRemaining === 0) label = "等待重试进展";
	}
	const statusUnknown = !connected || !sessionReady || check.error !== undefined;
	const connectionLabel = !connected ? "连接已断开" : check.error ? "运行端状态暂未确认"
		: observedAt !== undefined && check.receivedAt !== undefined
			? `运行端 ${formatElapsedDuration(Math.max(0, now - check.receivedAt))}前确认`
			: check.receivedAt !== undefined ? "服务可联系，会话运行状态未确认" : "正在核对运行端状态";
	const Icon = stale || statusUnknown ? CircleAlert : waiting || scheduledRetry || execution?.phase === "waiting_model" ? Clock3 : LoaderCircle;

	return (
		<div className="flex min-h-8 min-w-0 items-center gap-2 text-sm text-muted-foreground" data-testid="composer-execution-status">
			<Icon aria-hidden="true" className={`size-4 shrink-0 ${Icon === LoaderCircle ? "animate-spin motion-reduce:animate-none" : ""} ${stale || statusUnknown ? "text-[var(--warning)]" : ""}`} />
			<span className="min-w-0 truncate" role="status" aria-live="polite" title={label}>{label}</span>
			{elapsed ? <span className="shrink-0 tabular-nums" aria-label={`${elapsedLabel} ${elapsed}`}>{elapsed}</span> : null}
			<Tooltip open={detailsOpen} onOpenChange={(open) => {
				if (!open) clickOpenedRef.current = false;
				setDetailsOpen(open);
			}}>
				<TooltipTrigger asChild>
					<Button
						ref={detailsTriggerRef}
						type="button"
						variant="ghost"
						size="icon-sm"
						className="relative size-8 shrink-0 bg-transparent text-muted-foreground hover:bg-transparent hover:text-foreground before:absolute before:-inset-1.5 before:content-[''] focus-visible:border-ring"
						aria-label="查看运行状态详情"
						aria-expanded={detailsOpen}
						onPointerDown={(event) => event.preventDefault()}
						onClick={(event) => {
							event.preventDefault();
							clickOpenedRef.current = !clickOpenedRef.current;
							setDetailsOpen(clickOpenedRef.current);
						}}
					>
						<Info className="size-4" />
					</Button>
				</TooltipTrigger>
				<TooltipContent
					align="end"
					side="top"
					sideOffset={8}
					collisionPadding={8}
					onPointerDownOutside={(event) => {
						if (event.target instanceof Node && detailsTriggerRef.current?.contains(event.target)) event.preventDefault();
					}}
					className="max-h-[var(--radix-tooltip-content-available-height)] w-64 max-w-[calc(100vw-1rem)] overflow-y-auto rounded-xl border border-border bg-popover p-3 text-popover-foreground shadow-md [&_svg]:bg-popover [&_svg]:fill-popover"
				>
					<div className="mb-3 text-sm font-medium">运行状态</div>
					<div className="space-y-2">
						<StatusDetail label="当前阶段" value={label} />
						<StatusDetail label={elapsedLabel} value={elapsed ?? "尚未确认"} />
						<StatusDetail label="最后进展" value={silence ? `${silence}前` : "尚未确认"} />
						<StatusDetail label="模型最近事件" value={serverNow === undefined || execution?.lastModelEventAt === undefined ? "尚未收到" : `${formatElapsedDuration(Math.max(0, serverNow - execution.lastModelEventAt))}前`} />
						{execution?.retryAttempt ? <StatusDetail label="重试次数" value={execution.retryMaxAttempts ? `${execution.retryAttempt}/${execution.retryMaxAttempts}` : String(execution.retryAttempt)} /> : null}
						{scheduledRetry ? <StatusDetail label="下次重试" value={`${retryRemaining}秒后`} /> : null}
						<StatusDetail label="连接确认" value={connectionLabel} />
					</div>
					{stale && silence ? <p className="mt-3 text-xs text-[var(--warning)]">已 {silence}未收到新进展</p> : null}
					{check.error ? <p className="mt-3 break-words text-xs text-[var(--warning)]">{check.error}</p> : null}
				</TooltipContent>
			</Tooltip>
		</div>
	);
}
