import type {
	SessionCollaborationResult,
	SessionWorkspace,
	SessionWorkspacesResult,
} from "@lystar/code-web-protocol";
import { assertWorkspaceCommandResult } from "@lystar/code-web-protocol/schemas";
import { parseSessionToolInput, parseSessionToolPayload, sessionToolStatusLabel } from "../../state/tool-batching.ts";
import type { ToolBatchTool } from "../../types.ts";
import { Button } from "../ui/button";
import { formatWorkspaceSize, workspaceModeLabel, workspaceStatusLabel } from "../workbench/session-workspaces";
import { CodeBlock } from "./code-block";

function Field({ label, value }: { label: string; value?: string }) {
	return value ? (
		<div className="grid min-w-0 gap-0.5 text-xs leading-5 sm:grid-cols-[5.5rem_minmax(0,1fr)] sm:gap-2">
			<span className="text-muted-foreground">{label}</span>
			<span className="min-w-0 whitespace-pre-wrap break-all text-foreground">{value}</span>
		</div>
	) : null;
}

function WorkspaceDetail({ workspace, reason, canRelease }: { workspace: SessionWorkspace; reason?: string; canRelease?: boolean }) {
	const reasons = [...new Set([workspace.retainedReason, reason].filter((value): value is string => Boolean(value)))];
	return (
		<div className="grid min-w-0 gap-1">
			<Field label="工作区模式" value={workspaceModeLabel(workspace.mode)} />
			<Field label="工作区状态" value={workspaceStatusLabel(workspace.status)} />
			<Field label="工作目录" value={workspace.worktreePath ?? workspace.cwd} />
			<Field label="占用大小" value={formatWorkspaceSize(workspace.sizeBytes)} />
			{workspace.branch ? <Field label="分支" value={workspace.branch} /> : null}
			{workspace.mode === "direct" || workspace.mode === "shared" || workspace.status === "released" ? (
				<Field label="回收状态" value={workspace.status === "released" ? "已回收，会话记录仍保留" : "使用原项目目录，无需回收"} />
			) : typeof canRelease === "boolean" ? <Field label="回收状态" value={canRelease ? "可回收" : "暂不可回收"} /> : null}
			{reasons.length ? <Field label="保留原因" value={reasons.join("；")} /> : null}
		</div>
	);
}

function DeliveryDetail({ result, onOpenPath }: { result: SessionCollaborationResult; onOpenPath?: (path: string) => void }) {
	return (
		<div className="grid min-w-0 gap-1.5">
			<Field label="任务结果" value={sessionToolStatusLabel(result.outcome)} />
			{result.resultText ? <p className="whitespace-pre-wrap break-words text-xs leading-5 text-foreground">{result.resultText}</p> : null}
			{result.error ? <p className="whitespace-pre-wrap break-words text-xs leading-5 text-destructive" role="alert">{result.error}</p> : null}
			{result.changedFiles ? (
				<div className="grid min-w-0 gap-1">
					<span className="text-xs text-muted-foreground">变更文件（{result.changedFiles.length}）</span>
					{result.changedFiles.length ? <ul className="grid min-w-0 gap-1">
						{result.changedFiles.map((path, index) => <li className="min-w-0 break-all font-mono text-xs" key={`${index}:${path}`}>
							{onOpenPath ? <Button className="h-auto min-h-7 max-w-full whitespace-normal break-all px-1 text-left font-mono text-xs" onClick={() => onOpenPath(path)} type="button" variant="ghost">{path}</Button> : path}
						</li>)}
					</ul> : <span className="text-xs text-muted-foreground">没有文件变更</span>}
				</div>
			) : null}
			<Field label="交付提交" value={result.deliveryCommit} />
			{result.patchPath ? <div className="grid min-w-0 gap-1">
				<Field label="补丁文件" value={result.patchPath} />
				{onOpenPath ? <Button className="h-7 w-fit px-1 text-xs" onClick={() => onOpenPath(result.patchPath!)} type="button" variant="ghost">查看补丁</Button> : null}
			</div> : null}
		</div>
	);
}

export function SessionWorkspaceToolDetail({ tool, onOpenSession, onOpenPath }: {
	tool: ToolBatchTool & { name: "session_accept_result" | "session_workspaces" };
	onOpenSession?: (sessionId: string) => void;
	onOpenPath?: (path: string) => void;
}) {
	const input = parseSessionToolInput(tool.summary);
	const payload = parseSessionToolPayload(tool.detail);
	const active = tool.state === "input-available" || tool.state === "input-queued";
	let value: SessionCollaborationResult | SessionWorkspacesResult | undefined;
	try {
		assertWorkspaceCommandResult(tool.name, payload?.value);
		value = payload?.value as SessionCollaborationResult | SessionWorkspacesResult;
	} catch {
		// 结果预览可能不完整，保留原文，不把缺失字段当作成功或空列表。
	}
	const sessionId = typeof input?.sessionId === "string" ? input.sessionId : undefined;
	const content = value && "workspaces" in value ? (
		<>
			{input?.action === "cleanup" && value.released ? <Field label="本次回收" value={`${value.released.length} 个工作区`} /> : null}
			{value.workspaces.length ? <ul aria-label="协作工作区" className="grid min-w-0 gap-3">
				{value.workspaces.map((entry) => <li className="grid min-w-0 gap-2 border-l border-border pl-2.5" key={entry.sessionId}>
					<WorkspaceDetail workspace={entry.workspace} reason={entry.reason} canRelease={entry.canRelease} />
					{entry.result ? <DeliveryDetail result={entry.result} onOpenPath={onOpenPath} /> : null}
					{onOpenSession ? <Button className="h-7 w-fit px-1 text-xs" aria-label={`查看 ${entry.workspace.cwd} 的会话`} onClick={() => onOpenSession(entry.sessionId)} type="button" variant="ghost">查看会话</Button> : null}
				</li>)}
			</ul> : <p className="text-xs text-muted-foreground">本次查询没有匹配的工作区。</p>}
		</>
	) : value && "outcome" in value ? (
		<>
			<Field label="接收状态" value={value.workspace
				? value.workspace.status === "accepted" || value.workspace.status === "released" ? "成果已接收" : "未确认接收"
				: tool.state === "output-available" && value.outcome === "completed" && !value.error ? "接收操作已完成" : "未确认接收"} />
			<DeliveryDetail result={value} onOpenPath={onOpenPath} />
			{value.workspace ? <WorkspaceDetail workspace={value.workspace} /> : <Field label="工作区状态" value="结果未提供工作区信息" />}
		</>
	) : (
		<div className="grid min-w-0 gap-1.5">
			<p className="text-xs text-muted-foreground">{active ? tool.state === "input-queued" ? "已排队，等待处理" : "等待工具返回结果" : tool.state === "output-cancelled" ? "操作已取消" : tool.state === "output-interrupted" ? "操作已中断" : tool.state === "output-error" ? "操作失败" : "结果预览不完整"}</p>
			{tool.detail && tool.detail !== tool.summary ? <CodeBlock className="my-0 border-border/60 bg-muted/25" code={typeof payload?.value === "string" ? payload.value : tool.detail} language="json" plainText wrap /> : null}
		</div>
	);
	return (
		<div className="grid min-w-0 gap-2">
			{content}
			{tool.name === "session_accept_result" && sessionId && onOpenSession ? <Button className="h-7 w-fit px-1 text-xs" onClick={() => onOpenSession(sessionId)} type="button" variant="ghost">查看子会话</Button> : null}
		</div>
	);
}
