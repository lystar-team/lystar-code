import { ArrowDownToLine, Download } from "lucide-react";
import type { WebOperation } from "../../types";
import type { WorkbenchState } from "../../state/use-workbench";
import { Task, TaskContent, TaskItem, TaskTrigger } from "../ai-elements/task";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../ui/card";
import { ACTIVE_OPERATION_STATUSES } from "./constants";
import type { WorkbenchActions } from "./types";

export function RunPanel({ state, actions }: { state: WorkbenchState; actions: WorkbenchActions }) {
	const operations = state.operations
		.filter((operation) => !operation.sessionId || operation.sessionId === state.sessionId)
		.sort((a, b) => b.updatedAt - a.updatedAt);
	return (
		<div className="grid gap-4 p-4">
			<Task defaultOpen>
				<TaskTrigger title="实时运行" />
				<TaskContent>
					{state.currentOperation ? (
						<OperationCard operation={state.currentOperation} />
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
				<div className="grid gap-2">
					{operations.slice(0, 20).map((operation) => (
						<OperationCard key={operation.operationId} operation={operation} />
					))}
				</div>
			) : (
				<Card>
					<CardContent className="py-6 text-center text-sm text-muted-foreground">还没有任务记录</CardContent>
				</Card>
			)}
			<div className="grid grid-cols-2 gap-2">
				<Button
					variant="outline"
					onClick={() => void actions.compact()}
					disabled={
						state.readOnly ||
						Boolean(state.currentOperation && ACTIVE_OPERATION_STATUSES.has(state.currentOperation.status))
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
		</div>
	);
}

function OperationCard({ operation }: { operation: WebOperation }) {
	const labels: Record<string, string> = {
		prompt: "对话",
		steer: "引导",
		follow_up: "后续消息",
		compact: "整理上下文",
		run_bash: "运行命令",
		login_model_provider: "Provider 登录",
	};
	const status = operationStatusLabel(operation.status);
	const updatedAt = new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" }).format(
		operation.updatedAt,
	);
	return (
		<Card className="py-0 shadow-none">
			<CardHeader className="gap-1.5 p-3">
				<div className="flex min-w-0 items-center justify-between gap-2">
					<CardTitle className="min-w-0 truncate text-sm">{labels[operation.type] ?? "其他任务"}</CardTitle>
					<Badge
						className="h-6 shrink-0 px-2 text-xs"
						variant={operation.status === "failed" ? "destructive" : "secondary"}
					>
						{status}
					</Badge>
				</div>
				<CardDescription className="text-xs">{updatedAt}</CardDescription>
				{operation.error ? (
					<CardDescription className="truncate text-xs text-destructive" title={operation.error}>
						{operation.error}
					</CardDescription>
				) : null}
			</CardHeader>
		</Card>
	);
}

function operationStatusLabel(status: string): string {
	return status === "running"
		? "执行中"
		: status === "accepted"
			? "已接收"
			: status === "completed"
				? "已完成"
				: status === "failed"
					? "失败"
					: status === "aborted"
						? "已停止"
						: status;
}
