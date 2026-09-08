import {
	Archive,
	ArrowDownToLine,
	ChevronRight,
	Download,
	FileInput,
	FileOutput,
	ListRestart,
	LoaderCircle,
	MessageSquareText,
	RefreshCw,
	Settings2,
	Share2,
	SquareTerminal,
	Upload,
	Wrench,
} from "lucide-react";
import { memo, useCallback, useMemo, useState } from "react";
import type { ReactNode } from "react";
import type { WebOperation } from "../../types";
import type { WorkbenchState } from "../../state/use-workbench";
import { Task, TaskContent, TaskItem, TaskTrigger } from "../ai-elements/task";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card, CardContent } from "../ui/card";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "../ui/dialog";
import { ACTIVE_OPERATION_STATUSES, THINKING_LEVEL_LABELS } from "./constants";
import { VirtualizedTranscript } from "./virtualized-transcript";
import type { WorkbenchActions } from "./types";

type ScrollRef = { current: HTMLDivElement | null };
type JsonRecord = Record<string, unknown>;
type RunPanelProps = { state: WorkbenchState; actions: WorkbenchActions; scrollRef: ScrollRef };

const operationKey = (operation: WebOperation) => operation.operationId;
const estimateOperationHeight = () => 44;

function runPanelPropsEqual(previous: RunPanelProps, next: RunPanelProps): boolean {
	return (
		previous.scrollRef === next.scrollRef &&
		previous.state.currentOperation === next.state.currentOperation &&
		previous.state.operations === next.state.operations &&
		previous.state.readOnly === next.state.readOnly &&
		previous.state.sessionId === next.state.sessionId
	);
}

const OPERATION_TITLES: Record<string, string> = {
	prompt: "提交任务",
	steer: "引导当前任务",
	follow_up: "追加后续任务",
	clear_queue: "清空任务队列",
	compact: "整理上下文",
	share_session: "分享会话",
	export_session: "导出会话",
	import_session: "导入会话",
	run_bash: "运行命令",
	add_model_provider: "添加模型 Provider",
	add_provider_model: "添加模型",
	sync_model_provider: "同步模型目录",
	login_model_provider: "登录模型 Provider",
	logout_model_provider: "退出模型 Provider",
	rename_session: "重命名会话",
	set_session_model: "切换模型",
	set_session_thinking: "调整思考强度",
	cycle_session_model: "切换模型",
	cycle_session_thinking: "切换思考强度",
	reload_resources: "重新加载资源",
	fork_session: "创建会话分支",
	import_harness_resources: "导入外部工作区资源",
	set_skill_enabled: "更新技能状态",
	save_project_instruction: "保存项目指令",
	save_host_instruction: "保存主机指令",
	set_project_trust: "更新项目授权",
	install_package: "安装扩展包",
	remove_package: "移除扩展包",
	update_packages: "更新扩展包",
	set_entry_label: "设置记录标签",
	navigate_session_tree: "切换会话分支",
	abort_subagent: "停止子任务",
	continue_subagent: "继续子任务",
	write_clipboard_text: "写入剪贴板",
	copy_last_assistant_message: "复制最新回复",
};

function record(value: unknown): JsonRecord | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : undefined;
}

function operationIcon(type: string): ReactNode {
	if (["prompt", "steer", "follow_up"].includes(type)) return <MessageSquareText className="size-3.5 shrink-0" />;
	if (type === "run_bash") return <SquareTerminal className="size-3.5 shrink-0" />;
	if (["compact", "cycle_session_thinking", "set_session_thinking"].includes(type))
		return <ListRestart className="size-3.5 shrink-0" />;
	if (["export_session", "write_clipboard_text", "copy_last_assistant_message"].includes(type))
		return <FileOutput className="size-3.5 shrink-0" />;
	if (["import_session", "import_harness_resources"].includes(type)) return <FileInput className="size-3.5 shrink-0" />;
	if (["share_session"].includes(type)) return <Share2 className="size-3.5 shrink-0" />;
	if (["install_package", "remove_package", "update_packages"].includes(type)) return <Archive className="size-3.5 shrink-0" />;
	if (["set_session_model", "cycle_session_model", "add_model_provider", "add_provider_model"].includes(type))
		return <Settings2 className="size-3.5 shrink-0" />;
	if (["reload_resources", "sync_model_provider"].includes(type)) return <RefreshCw className="size-3.5 shrink-0" />;
	if (["save_project_instruction", "save_host_instruction", "set_project_trust"].includes(type))
		return <Upload className="size-3.5 shrink-0" />;
	return <Wrench className="size-3.5 shrink-0" />;
}

function operationProgressDetail(operation: WebOperation): string | undefined {
	const progress = record(operation.progress);
	if (progress?.type === "message" && typeof progress.text === "string") {
		const label = operation.type === "prompt" ? "提交内容" : operation.type === "steer" ? "引导内容" : "追加内容";
		return `${label}：${progress.text}`;
	}
	if (progress?.type === "bash" && typeof progress.command === "string") return `命令：${progress.command}`;
	if (progress?.type === "status" && typeof progress.status === "string") return progress.status;

	const result = record(operation.result);
	const snapshot = record(result?.snapshot) ?? result;
	if (operation.type === "set_session_thinking" || operation.type === "cycle_session_thinking") {
		const level = typeof snapshot?.thinkingLevel === "string" ? snapshot.thinkingLevel : undefined;
		if (level) return `当前级别：${THINKING_LEVEL_LABELS[level] ?? level}`;
	}
	if (operation.type === "set_session_model" || operation.type === "cycle_session_model") {
		const model = record(snapshot?.model);
		if (typeof model?.provider === "string" && typeof model.id === "string") return `当前模型：${model.provider}/${model.id}`;
	}
	if (operation.type === "share_session") {
		const previewUrl = typeof result?.previewUrl === "string" ? result.previewUrl : undefined;
		if (previewUrl) return `已生成分享地址：${previewUrl}`;
	}
	return undefined;
}

export function operationTaskDisplay(operation: WebOperation): { title: string; detail: string; icon: ReactNode } {
	const title = OPERATION_TITLES[operation.type] ?? "执行系统操作";
	const detail =
		operationProgressDetail(operation) ??
		({
			prompt: "向 Agent 发送一条新任务并等待回复",
			steer: "向正在运行的 Agent 追加引导",
			follow_up: "向当前会话追加后续消息",
			clear_queue: "清除尚未处理的引导和后续消息",
			compact: "压缩历史上下文，保留当前任务所需信息",
			share_session: "生成当前会话的分享内容",
			run_bash: "执行工作区命令并收集输出",
			set_session_thinking: "修改当前会话的思考强度",
			cycle_session_thinking: "切换到下一个可用思考强度",
			set_session_model: "修改当前会话使用的模型",
			cycle_session_model: "切换到下一个可用模型",
			reload_resources: "重新加载项目资源、技能和扩展",
			fork_session: "从当前会话记录创建新的上下文分支",
		}[operation.type] ?? `操作类型：${operation.type}`);
	return { title, detail, icon: operationIcon(operation.type) };
}

function operationStatusLabel(status: WebOperation["status"]): string {
	return status === "accepted"
		? "已接收"
		: status === "running"
			? "执行中"
			: status === "waiting_for_input"
				? "等待输入"
				: status === "completed"
					? "已完成"
					: status === "failed"
						? "失败"
						: status === "aborted"
							? "已取消"
							: "已停止";
}

function operationEqual(previous: WebOperation, next: WebOperation): boolean {
	return (
		previous.operationId === next.operationId &&
		previous.updatedAt === next.updatedAt &&
		previous.status === next.status &&
		previous.error === next.error &&
		previous.progress === next.progress &&
		previous.result === next.result
	);
}

type OperationDetail = {
	label: string;
	value: string;
	multiline?: boolean;
};

function operationTime(timestamp: number, withDate = false): string {
	return new Intl.DateTimeFormat("zh-CN", withDate
		? { dateStyle: "medium", timeStyle: "medium" }
		: { hour: "2-digit", minute: "2-digit" }).format(timestamp);
}

function readableFieldLabel(key: string): string {
	return (
		{
			changed: "是否发生变化",
			supported: "是否支持",
			isScoped: "是否使用会话模型",
			cancelled: "是否取消",
			exitCode: "退出状态",
			truncated: "输出是否截断",
			fullOutputPath: "完整输出文件",
			path: "文件位置",
			previewUrl: "预览地址",
			gistUrl: "分享地址",
		} as Record<string, string>
	)[key] ?? key;
}

function readableValue(value: unknown): string | undefined {
	if (typeof value === "string") return value;
	if (typeof value === "number") return String(value);
	if (typeof value === "boolean") return value ? "是" : "否";
	if (Array.isArray(value)) return `共 ${value.length} 项`;
	const object = record(value);
	if (object && typeof object.provider === "string" && typeof object.id === "string")
		return `${object.provider}/${object.id}`;
	return undefined;
}

function appendRecordDetails(details: OperationDetail[], value: unknown, excludedKeys: string[] = []): void {
	const object = record(value);
	if (!object) return;
	for (const [key, item] of Object.entries(object)) {
		if (excludedKeys.includes(key)) continue;
		const text = readableValue(item);
		if (text !== undefined) details.push({ label: readableFieldLabel(key), value: text });
	}
}

export function operationDetails(operation: WebOperation): OperationDetail[] {
	const details: OperationDetail[] = [];
	const progress = record(operation.progress);
	const result = record(operation.result);
	const snapshot = record(result?.snapshot) ?? result;
	const add = (label: string, value: unknown, multiline = false) => {
		const text = readableValue(value);
		if (text !== undefined && text !== "") details.push({ label, value: text, multiline });
	};

	switch (operation.type) {
		case "run_bash": {
			add("执行命令", progress?.command ?? result?.command);
			add("退出状态", result?.exitCode);
			add("执行是否取消", result?.cancelled);
			const output = typeof result?.output === "string" ? result.output : progress?.output;
			if (typeof output === "string") details.push({ label: "命令输出", value: output || "无输出", multiline: true });
			if (progress?.truncated === true || result?.truncated === true)
				details.push({ label: "输出说明", value: "输出过长，界面只保留了末尾内容。" });
			break;
		}
		case "set_session_model":
		case "cycle_session_model": {
			const model = record(snapshot?.model);
			if (model && typeof model.provider === "string" && typeof model.id === "string")
				details.push({ label: "当前模型", value: `${model.provider}/${model.id}` });
			if (operation.type === "cycle_session_model") add("是否切换成功", result?.changed);
			break;
		}
		case "set_session_thinking":
		case "cycle_session_thinking": {
			if (typeof snapshot?.thinkingLevel === "string")
				details.push({
					label: "当前思考强度",
					value: THINKING_LEVEL_LABELS[snapshot.thinkingLevel] ?? snapshot.thinkingLevel,
				});
			if (operation.type === "cycle_session_thinking") {
				add("是否切换成功", result?.changed);
				add("是否支持思考强度", result?.supported);
			}
			break;
		}
		case "share_session":
			add("预览地址", result?.previewUrl);
			add("分享地址", result?.gistUrl);
			break;
		case "export_session":
			add("导出文件", result?.path);
			break;
		case "import_session":
			details.push({ label: "导入结果", value: result?.cancelled === true ? "已取消导入。" : "会话已导入。" });
			break;
		case "compact":
			details.push({ label: "处理结果", value: "当前会话的上下文已完成整理。" });
			break;
		case "prompt":
		case "steer":
		case "follow_up": {
			const message = progress?.type === "message" && typeof progress.text === "string" ? progress.text : undefined;
			if (message) {
				details.push({
					label: operation.type === "prompt" ? "提交内容" : operation.type === "steer" ? "引导内容" : "追加内容",
					value: message,
					multiline: true,
				});
			}
			if (typeof progress?.imageCount === "number" && progress.imageCount > 0)
				details.push({ label: "图片附件", value: `${progress.imageCount} 张` });
			if (progress?.truncated === true) details.push({ label: "内容说明", value: "内容过长，界面只保留了前面的部分。" });
			details.push({
				label: "处理结果",
				value:
					operation.type === "prompt"
						? "任务已提交给 Agent。"
						: operation.type === "steer"
							? "引导内容已提交给正在运行的 Agent。"
							: "后续任务已加入当前会话。",
			});
			break;
		}
		case "add_model_provider":
		case "add_provider_model":
		case "sync_model_provider":
			details.push({
				label: "处理结果",
				value: Array.isArray(operation.result)
					? `模型目录已更新，共 ${operation.result.length} 个模型。`
					: "Provider 配置已更新。",
			});
			break;
		case "login_model_provider":
			details.push({ label: "处理结果", value: "Provider 登录流程已完成。" });
			break;
		case "logout_model_provider":
			details.push({ label: "处理结果", value: "Provider 已退出登录。" });
			break;
		case "reload_resources":
			details.push({ label: "处理结果", value: "项目资源、技能和扩展已重新加载。" });
			break;
		default:
			appendRecordDetails(details, operation.progress, ["type"]);
			appendRecordDetails(details, operation.result, ["snapshot", "operationId", "sessionPath"]);
			break;
	}

	if (details.length === 0)
		details.push({
			label: "处理结果",
			value: operation.status === "completed" ? "任务已完成，没有更多可展示的明细。" : "暂无可展示的执行明细。",
		});
	return details;
}

function OperationDetailSection({ detail }: { detail: OperationDetail }) {
	return (
		<section className="space-y-1.5">
			<h3 className="text-xs font-medium text-muted-foreground">{detail.label}</h3>
			{detail.multiline ? (
				<pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md border bg-muted/30 p-3 font-mono text-xs leading-5">
					{detail.value}
				</pre>
			) : (
				<div className="break-words rounded-md border bg-muted/20 px-3 py-2 text-sm">{detail.value}</div>
			)}
		</section>
	);
}

function OperationRow({ operation, onClick }: { operation: WebOperation; onClick: () => void }) {
	const display = operationTaskDisplay(operation);
	const active = ACTIVE_OPERATION_STATUSES.has(operation.status);
	return (
		<button
			type="button"
			onClick={onClick}
			className="flex w-full min-w-0 max-w-full items-center gap-1.5 overflow-hidden rounded-md border border-border/60 bg-background px-2 py-2 text-left transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
			aria-label={`查看任务详情：${display.title}`}
		>
			<span className="shrink-0 text-muted-foreground">{display.icon}</span>
			<span className="min-w-0 flex-1 truncate text-[13px] font-medium" title={display.title}>
				{display.title}
			</span>
			<Badge
				className="h-5 shrink-0 px-1.5 text-[11px]"
				variant={operation.status === "failed" ? "destructive" : active ? "secondary" : "outline"}
			>
				{operationStatusLabel(operation.status)}
			</Badge>
			<span className="hidden shrink-0 text-[11px] text-muted-foreground sm:inline">
				{operationTime(operation.updatedAt)}
			</span>
			<ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
		</button>
	);
}

function OperationDetailDialog({ operation, onClose }: { operation?: WebOperation; onClose: () => void }) {
	if (!operation) return null;
	const display = operationTaskDisplay(operation);
	return (
		<Dialog open onOpenChange={(open) => !open && onClose()}>
			<DialogContent className="max-h-[calc(100vh-2rem)] overflow-hidden p-0 sm:max-w-2xl">
				<div className="max-h-[calc(100vh-2rem)] overflow-y-auto p-6">
					<DialogHeader className="pr-8">
						<div className="flex min-w-0 items-center gap-2">
							<span className="shrink-0 text-muted-foreground">{display.icon}</span>
							<DialogTitle className="min-w-0 truncate">{display.title}</DialogTitle>
							<Badge
								className="ml-auto shrink-0"
								variant={operation.status === "failed" ? "destructive" : "outline"}
							>
								{operationStatusLabel(operation.status)}
							</Badge>
						</div>
						<DialogDescription>查看这项任务的执行过程和结果。</DialogDescription>
					</DialogHeader>
					<div className="mt-5 space-y-5">
						<div className="grid gap-3 rounded-md border bg-muted/20 p-3 text-xs sm:grid-cols-3">
							<div className="space-y-1">
								<div className="text-muted-foreground">操作类型</div>
								<code className="break-all text-foreground">{operation.type}</code>
							</div>
							<div className="space-y-1">
								<div className="text-muted-foreground">开始时间</div>
								<div>{operationTime(operation.acceptedAt, true)}</div>
							</div>
							<div className="space-y-1">
								<div className="text-muted-foreground">更新时间</div>
								<div>{operationTime(operation.updatedAt, true)}</div>
							</div>
						</div>
						{operation.error ? (
							<OperationDetailSection detail={{ label: "失败原因", value: operation.error }} />
						) : null}
						{operationDetails(operation).map((detail, index) => (
							<OperationDetailSection key={`${detail.label}-${index}`} detail={detail} />
						))}
					</div>
				</div>
			</DialogContent>
		</Dialog>
	);
}

function OperationCard({ operation }: { operation: WebOperation }) {
	const display = operationTaskDisplay(operation);
	const status = operationStatusLabel(operation.status);
	const updatedAt = operationTime(operation.updatedAt);
	const active = ACTIVE_OPERATION_STATUSES.has(operation.status);
	return (
		<div className="min-w-0 max-w-full overflow-hidden rounded-md border border-border/60 bg-background px-2 py-1.5 shadow-none">
			<div className="flex min-w-0 items-center gap-1.5">
				<span className="text-muted-foreground">{display.icon}</span>
				<span className="min-w-0 flex-1 truncate text-[13px] font-medium" title={display.title}>
					{display.title}
				</span>
				<Badge
					className="h-5 shrink-0 px-1.5 text-[11px]"
					variant={operation.status === "failed" ? "destructive" : active ? "secondary" : "outline"}
				>
					{active ? <LoaderCircle className="mr-1 size-3 animate-spin" /> : null}
					{status}
				</Badge>
				<span className="shrink-0 text-[11px] text-muted-foreground">{updatedAt}</span>
			</div>
			<div className="mt-0.5 truncate pl-5 text-xs text-muted-foreground" title={display.detail}>
				{display.detail}
			</div>
			{operation.error ? (
				<div className="mt-0.5 line-clamp-2 pl-5 text-xs text-destructive" title={operation.error}>
					失败原因：{operation.error}
				</div>
			) : null}
		</div>
	);
}

export const RunPanel = memo(function RunPanel({ state, actions, scrollRef }: RunPanelProps) {
	const [selectedOperationId, setSelectedOperationId] = useState<string>();
	const currentOperation =
		state.sessionId &&
		state.currentOperation?.sessionId === state.sessionId &&
		ACTIVE_OPERATION_STATUSES.has(state.currentOperation.status)
			? state.currentOperation
			: undefined;
	const operations = useMemo(
		() =>
			state.operations
				.filter(
					(operation) =>
						operation.sessionId === state.sessionId && operation.operationId !== currentOperation?.operationId,
				)
				.sort((a, b) => b.updatedAt - a.updatedAt),
		[currentOperation?.operationId, state.operations, state.sessionId],
	);
	const selectedOperation = operations.find((operation) => operation.operationId === selectedOperationId);
	const renderOperation = useCallback(
		(operation: WebOperation) => (
			<OperationRow operation={operation} onClick={() => setSelectedOperationId(operation.operationId)} />
		),
		[],
	);
	return (
		<div className="grid min-w-0 max-w-full gap-4 overflow-x-hidden p-4">
			<Task defaultOpen className="min-w-0 max-w-full">
				<TaskTrigger title="实时运行" />
				<TaskContent contentClassName="border-l-0 pl-0">
					{currentOperation ? (
						<OperationCard operation={currentOperation} />
					) : (
						<TaskItem>当前没有运行中的任务</TaskItem>
					)}
				</TaskContent>
			</Task>
			<div className="flex items-center justify-between text-xs font-medium text-muted-foreground">
				<span>任务记录</span>
				<span>{operations.length}</span>
			</div>
			{operations.length ? (
				<div className="min-w-0 max-w-full overflow-hidden">
					<VirtualizedTranscript
						items={operations}
						getKey={operationKey}
						estimateHeight={estimateOperationHeight}
						gap={4}
						isItemEqual={operationEqual}
						renderItem={renderOperation}
						scrollRef={scrollRef}
					/>
				</div>
			) : (
				<Card>
					<CardContent className="py-4 text-center text-sm text-muted-foreground">还没有任务记录</CardContent>
				</Card>
			)}
			<div className="grid grid-cols-2 gap-2">
				<Button
					variant="outline"
					onClick={() => void actions.compact()}
					disabled={
						state.readOnly ||
						Boolean(currentOperation && ACTIVE_OPERATION_STATUSES.has(currentOperation.status))
					}
				>
					<ArrowDownToLine className="size-4" />
					整理上下文
				</Button>
				<Button variant="outline" onClick={() => void actions.exportSession()} disabled={state.readOnly}>
					<Download className="size-4" />
					导出会话
				</Button>
			</div>
			<OperationDetailDialog operation={selectedOperation} onClose={() => setSelectedOperationId(undefined)} />
		</div>
	);
}, runPanelPropsEqual);
