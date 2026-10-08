import type { ReactNode } from "react";
import type { ToolBatchState } from "../../types.ts";
import {
	parseSessionToolInput,
	parseSessionToolPayload,
	sessionToolAgent,
	sessionToolStatusLabel as statusLabel,
} from "../../state/tool-batching.ts";
import { Button } from "../ui/button";

interface SessionCollaborationToolDetailProps {
	name: string;
	summary: string;
	detail?: string;
	progress?: string;
	result?: string;
	state?: ToolBatchState;
	onOpenSession?: (sessionId: string) => void;
}

type DataRecord = Record<string, unknown>;

function record(value: unknown): DataRecord | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? value as DataRecord : undefined;
}

function text(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function firstText(source: DataRecord | undefined, keys: string[]): string | undefined {
	for (const key of keys) {
		const value = text(source?.[key]);
		if (value) return value;
	}
	return undefined;
}

function list(source: unknown, keys: string[]): unknown[] {
	if (Array.isArray(source)) return source;
	const object = record(source);
	for (const key of keys) {
		if (Array.isArray(object?.[key])) return object[key] as unknown[];
	}
	return [];
}

function displayName(source: DataRecord, memberIds = new Map<string, string>()): string {
	const task = firstText(source, ["taskDescription", "taskTitle", "title"]);
	const candidates = [
		firstText(source, ["nickname", "memberName", "senderName", "agentName"]),
		firstText(source, ["profileName"]),
		firstText(source, ["name"]),
	];
	for (const candidate of candidates) {
		if (candidate && candidate !== task) return candidate;
	}
	const senderId = firstText(source, ["senderSessionId", "sessionId"]);
	return (senderId && memberIds.get(senderId)) || "协作成员";
}


function stopReasonLabel(value: unknown): string | undefined {
	if (value === "user_requested") return "用户请求停止";
	if (value === "task_cancelled") return "任务已取消";
	return text(value);
}

function TextBlock({ label, children, destructive = false }: { label: string; children: string; destructive?: boolean }) {
	return (
		<div className="grid min-w-0 gap-0.5">
			<span className="text-xs text-muted-foreground">{label}</span>
			<p className={destructive ? "whitespace-pre-wrap break-words text-xs leading-5 text-destructive" : "whitespace-pre-wrap break-words text-xs leading-5 text-foreground"}>
				{children}
			</p>
		</div>
	);
}

function Field({ label, value }: { label: string; value?: string }) {
	return value ? (
		<div className="grid min-w-0 grid-cols-[5.5rem_minmax(0,1fr)] gap-2 text-xs leading-5 max-sm:grid-cols-1 max-sm:gap-0.5">
			<span className="text-muted-foreground">{label}</span>
			<span className="min-w-0 whitespace-pre-wrap break-words text-foreground">{value}</span>
		</div>
	) : null;
}

function sessionRows(value: unknown): DataRecord[] {
	return list(value, ["sessions", "summaries", "items"]).flatMap((item) => {
		const entry = record(item);
		return entry ? [entry] : [];
	});
}

function hasSessionSummary(value: DataRecord | undefined): value is DataRecord {
	return Boolean(value && ["id", "sessionId", "nickname", "memberName", "profileName", "activity", "taskDescription", "result", "outcome", "status"].some((key) => value[key] !== undefined));
}

function sessionRowTitle(item: DataRecord): string | undefined {
	const nickname = firstText(item, ["nickname", "memberName"]);
	const profileName = firstText(item, ["profileName"]);
	const name = firstText(item, ["name"]);
	return nickname ?? profileName ?? name;
}

function SessionRows({ rows, onOpenSession }: { rows: DataRecord[]; onOpenSession?: (sessionId: string) => void }) {
	if (!rows.length) return null;
	return (
		<div className="grid min-w-0 gap-0.5">
			{rows.map((item, index) => {
				const id = firstText(item, ["id", "sessionId"]);
				const title = sessionRowTitle(item) ?? "智能体";
				const activity = statusLabel(item.activity ?? item.state ?? item.status);
				const content = (
					<>
						<span className="min-w-0 truncate text-xs text-foreground">{title}</span>
						{activity ? <span className="shrink-0 text-xs text-muted-foreground">{activity}</span> : null}
					</>
				);
				return id && onOpenSession ? (
					<Button aria-label={`切换到 ${title} 会话`} className="h-7 min-w-0 justify-start gap-2 px-1 text-left" key={id} onClick={() => onOpenSession(id)} type="button" variant="ghost">
						{content}
					</Button>
				) : (
					<div className="flex min-h-7 min-w-0 items-center gap-2 px-1" key={`${title}-${index}`}>
						{content}
					</div>
				);
			})}
		</div>
	);
}

function errorText(value: unknown): string | undefined {
	if (typeof value === "string") return text(value);
	const object = record(value);
	if (!object) return undefined;
	return firstText(object, ["message", "text", "error"]);
}

function ProfileRows({ value }: { value: unknown }) {
	const rows = list(value, ["profiles", "configs", "items"]).flatMap((item) => {
		const profile = record(item);
		return profile ? [profile] : [];
	});
	if (!rows.length) return null;
	return (
		<div className="grid min-w-0 gap-1.5">
			{rows.map((profile, index) => (
				<div className="grid min-w-0 gap-0.5 rounded-md border border-border/60 px-2.5 py-2" key={`${firstText(profile, ["name", "profileName"]) ?? "profile"}-${index}`}>
					<span className="text-xs font-medium text-foreground">{firstText(profile, ["name", "profileName"]) ?? "智能体配置"}</span>
					{firstText(profile, ["description", "profileDescription"]) ? <span className="whitespace-pre-wrap break-words text-xs leading-5 text-muted-foreground">{firstText(profile, ["description", "profileDescription"])}</span> : null}
				</div>
			))}
		</div>
	);
}

function RoomRows({ rooms }: { rooms: DataRecord[] }) {
	if (!rooms.length) return null;
	return (
		<div className="grid min-w-0 gap-1.5">
			{rooms.map((entry, index) => {
				const room = record(entry.room) ?? entry;
				const members = list(entry, ["members"]).flatMap((item) => {
					const member = record(item);
					return member ? [displayName(member)] : [];
				});
				return (
					<div className="grid min-w-0 gap-0.5 rounded-md border border-border/60 px-2.5 py-2" key={`${firstText(room, ["title"]) ?? "room"}-${index}`}>
						<span className="text-xs font-medium text-foreground">{firstText(room, ["title"]) ?? "协作空间"}</span>
						{members.length ? <span className="whitespace-pre-wrap break-words text-xs leading-5 text-muted-foreground">成员：{members.join("、")}</span> : null}
					</div>
				);
			})}
		</div>
	);
}

function MemberRows({ members }: { members: DataRecord[] }) {
	if (!members.length) return null;
	return (
		<div className="grid min-w-0 gap-1.5">
			{members.map((member, index) => (
				<div className="flex min-w-0 items-center justify-between gap-2 rounded-md border border-border/60 px-2.5 py-1.5" key={`${firstText(member, ["nickname", "name", "profileName"]) ?? "member"}-${index}`}>
					<span className="min-w-0 truncate text-xs text-foreground">{displayName(member)}</span>
					<span className="shrink-0 text-xs text-muted-foreground">{member.role === "owner" ? "负责人" : statusLabel(member.activity)}</span>
				</div>
			))}
		</div>
	);
}

function TaskRows({ tasks, members }: { tasks: DataRecord[]; members: DataRecord[] }) {
	if (!tasks.length) return null;
	const memberNames = new Map<string, string>();
	for (const member of members) {
		const id = firstText(member, ["sessionId", "id"]);
		if (id) memberNames.set(id, displayName(member));
	}
	return (
		<div className="grid min-w-0 gap-1.5">
			{tasks.map((task, index) => {
				const assigneeId = firstText(task, ["assigneeSessionId", "assigneeId"]);
				const assignee = firstText(task, ["assigneeName", "assigneeNickname"]) ?? (assigneeId ? memberNames.get(assigneeId) : undefined);
				return (
					<div className="grid min-w-0 gap-1 rounded-md border border-border/60 px-2.5 py-2" key={`${firstText(task, ["title"]) ?? "task"}-${index}`}>
						<div className="flex min-w-0 items-center justify-between gap-2">
							<span className="min-w-0 truncate text-xs font-medium text-foreground">{firstText(task, ["title"]) ?? "协作任务"}</span>
							<span className="shrink-0 text-xs text-muted-foreground">{statusLabel(task.status)}</span>
						</div>
						{firstText(task, ["description", "taskDescription"]) ? <span className="whitespace-pre-wrap break-words text-xs leading-5 text-muted-foreground">{firstText(task, ["description", "taskDescription"])}</span> : null}
						{assignee ? <span className="text-xs text-muted-foreground">负责人：{assignee}</span> : null}
						{firstText(task, ["resultText"]) ? <TextBlock label="结果" children={firstText(task, ["resultText"]) ?? ""} /> : null}
						{errorText(task.error) ? <TextBlock label="错误" destructive children={errorText(task.error) ?? ""} /> : null}
					</div>
				);
			})}
		</div>
	);
}

function messageKindLabel(value: unknown): string | undefined {
	const labels: Record<string, string> = {
		task: "任务",
		message: "消息",
		question: "问题",
		answer: "答复",
		status: "状态",
		result: "结果",
		system: "系统",
	};
	const kind = text(value);
	return kind ? labels[kind] ?? kind : undefined;
}

function MessageRows({ messages, members }: { messages: DataRecord[]; members: DataRecord[] }) {
	if (!messages.length) return null;
	const memberNames = new Map<string, string>();
	for (const member of members) {
		const id = firstText(member, ["sessionId", "id"]);
		if (id) memberNames.set(id, displayName(member));
	}
	return (
		<div className="grid min-w-0 gap-2">
			{messages.map((message, index) => (
				<div className="grid min-w-0 gap-0.5 border-l border-border pl-2.5" key={`${firstText(message, ["seq"]) ?? index}`}>
					<div className="flex min-w-0 items-center gap-2 text-xs">
						<span className="min-w-0 truncate font-medium text-foreground">{displayName(message, memberNames)}</span>
						{messageKindLabel(message.kind) ? <span className="shrink-0 text-muted-foreground">{messageKindLabel(message.kind)}</span> : null}
					</div>
					{firstText(message, ["body", "text"]) ? <p className="whitespace-pre-wrap break-words text-xs leading-5 text-foreground">{firstText(message, ["body", "text"])}</p> : null}
				</div>
			))}
		</div>
	);
}

function CapabilityDetails({ value }: { value: unknown }) {
	const capabilities = record(value);
	if (!capabilities) return null;
	const allowedTools = Array.isArray(capabilities.allowedTools) ? capabilities.allowedTools.filter((item): item is string => typeof item === "string") : [];
	const readRoots = Array.isArray(capabilities.readRoots) ? capabilities.readRoots.filter((item): item is string => typeof item === "string") : [];
	const writeRoots = Array.isArray(capabilities.writeRoots) ? capabilities.writeRoots.filter((item): item is string => typeof item === "string") : [];
	return (
		<div className="grid min-w-0 gap-1">
			{allowedTools.length ? <Field label="可用工具" value={allowedTools.join("、")} /> : null}
			{readRoots.length ? <Field label="可读目录" value={readRoots.join("、")} /> : null}
			{writeRoots.length ? <Field label="可写目录" value={writeRoots.join("、")} /> : null}
			{capabilities.shell === "disabled" || capabilities.shell === "sandboxed" ? <Field label="命令执行" value={capabilities.shell === "disabled" ? "禁用" : "沙箱"} /> : null}
		</div>
	);
}

function resultError(value: unknown): string | undefined {
	const object = record(value);
	if (!object) return undefined;
	const direct = errorText(object.error);
	if (direct) return direct;
	const errors = list(object, ["errors"]);
	const messages = errors.flatMap((item) => {
		const message = errorText(item);
		return message ? [message] : [];
	});
	return messages.length ? messages.join("\n") : undefined;
}

function resultText(value: unknown): string | undefined {
	if (typeof value === "string") return text(value);
	const object = record(value);
	if (!object) return undefined;
	return firstText(object, ["resultText", "message", "text", "body", "note"]) ?? statusLabel(object.outcome);
}

function elapsedLabel(value: unknown): string | undefined {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
	return value < 1000 ? `${Math.round(value)} 毫秒` : `${(value / 1000).toFixed(1)} 秒`;
}

function progressStateLabel(value: unknown): string | undefined {
	const state = text(value);
	if (state === "waiting") return "等待中";
	if (state === "completed") return "已返回";
	if (state === "needs_input") return "需要输入";
	return statusLabel(state);
}

function SessionCollaborationToolDetail({
	name,
	summary,
	detail,
	progress,
	result,
	state,
	onOpenSession,
}: SessionCollaborationToolDetailProps) {
	const input = parseSessionToolInput(summary);
	const detailPayload = parseSessionToolPayload(detail);
	const progressPayload = parseSessionToolPayload(progress) ?? (record(detailPayload?.value)?.sessions ? detailPayload : undefined);
	const resultPayload = parseSessionToolPayload(result) ?? (!progressPayload ? detailPayload : undefined);
	const progressValue = progressPayload?.value;
	const resultValue = resultPayload?.value;
	const incomplete = resultPayload?.incomplete ?? progressPayload?.incomplete ?? detailPayload?.incomplete;
	const progressObject = record(progressValue);
	const resultObject = record(resultValue);
	const metadata = resultPayload?.details ?? progressPayload?.details ?? record(progressObject?.details);
	const isWaiting = name === "session_wait";
	const isSessionAction = name === "session_send" || name === "session_stop";
	const progressSessions = sessionRows(progressValue);
	const resultSessions = sessionRows(resultValue);
	const progressSummaryRows = isSessionAction && state === "input-available" && hasSessionSummary(progressObject) ? [progressObject] : [];
	const resultSummaryRows = isSessionAction && !resultObject?.session && hasSessionSummary(resultObject) ? [resultObject] : [];
	const finalSessions = resultSessions.length ? resultSessions : resultSummaryRows;
	const progressRows = progressSessions.length ? progressSessions : progressSummaryRows;
	const displaySessions = finalSessions.length ? finalSessions : progressRows;
	const showingProgress = isWaiting && resultSessions.length === 0 && progressSessions.length > 0;
	const hasVisibleSessionStatus = displaySessions.some((session) => session.activity !== undefined || session.state !== undefined || session.status !== undefined);
	const profileResults = name === "session_profiles" ? resultValue : undefined;
	const roomRecords = list(resultValue, ["rooms"]).flatMap((item) => {
		const entry = record(item);
		return entry ? [entry] : [];
	});
	const rooms = name === "room_list" && Array.isArray(resultValue)
		? resultValue.flatMap((item) => {
			const entry = record(item);
			return entry ? [entry] : [];
		})
		: roomRecords;
	const room = record(resultObject?.room) ?? record(resultValue);
	const members = list(resultValue, ["members"]).flatMap((item) => {
		const entry = record(item);
		return entry ? [entry] : [];
	});
	const nestedMembers = list(resultObject?.summary, ["members"]).flatMap((item) => {
		const entry = record(item);
		return entry ? [entry] : [];
	});
	const directMember = record(resultObject?.member);
	const allMembers = members.length ? members : nestedMembers.length ? nestedMembers : directMember ? [directMember] : [];
	const taskRecords = list(resultValue, ["tasks"]).flatMap((item) => {
		const entry = record(item);
		return entry ? [entry] : [];
	});
	const singleTask = record(resultObject?.task) ?? (firstText(resultObject, ["title"]) ? resultObject : undefined);
	const tasks = taskRecords.length ? taskRecords : singleTask ? [singleTask] : [];
	const directMessage = record(resultObject?.message);
	const messages = list(resultValue, ["messages"]).flatMap((item) => {
		const entry = record(item);
		return entry ? [entry] : [];
	});
	if (directMessage && !messages.length && name === "room_send") messages.push(directMessage);

	const identity = sessionToolAgent(summary, result ?? progress ?? detail)?.nickname;
	const task = firstText(input, ["task", "description"]);
	const taskTitle = name === "room_task_create" ? firstText(input, ["title"]) : undefined;
	const message = firstText(input, ["text", "body"]);
	const error = resultError(resultValue) ?? (state === "output-error" ? resultError(detailPayload?.value) ?? errorText(detailPayload?.value) : undefined);
	const stopReason = stopReasonLabel(resultObject?.stopReason ?? metadata?.stopReason ?? input?.reason);
	const stopNote = firstText(resultObject, ["stopNote"]) ?? firstText(metadata, ["stopNote"]) ?? (name === "session_stop" ? firstText(input, ["note"]) : undefined);
	const textResult = resultText(resultValue);
	const elapsed = elapsedLabel(metadata?.elapsedMs ?? progressObject?.elapsedMs ?? resultObject?.elapsedMs);
	const progressStateValue = isWaiting && resultSessions.length > 0 && state === "output-available" && metadata?.state === undefined && progressObject?.state === "waiting"
		? "completed"
		: metadata?.state ?? progressObject?.state ?? resultObject?.state;
	const progressState = state === "output-cancelled" ? "已取消" : state === "output-interrupted" ? "已中断" : progressStateLabel(progressStateValue);
	const progressData = isWaiting && (showingProgress || progressState || elapsed);
	const operationSource = state === "input-available" || state === "input-queued" ? progressObject : resultObject;
	const operationStatus = statusLabel(operationSource?.activity ?? operationSource?.outcome ?? operationSource?.state ?? operationSource?.status) ??
		(state === "output-available" ? "已返回" : state === "output-error" ? "失败" : state === "output-cancelled" ? "已停止" : state === "output-interrupted" ? "已中断" : state === "input-available" ? "运行中" : state === "input-queued" ? "已排队" : undefined);
	const agentId = firstText(resultObject?.session ? record(resultObject.session) : resultObject, ["id", "sessionId"]) ?? firstText(input, ["sessionId"]);
	const sessionRecord = record(resultObject?.session) ?? (name === "session_create" ? resultObject : undefined);
	const roomTitle = firstText(room, ["title"]);
	const roomName = name === "room_create" ? firstText(input, ["title"]) : undefined;
	const roomKind = messageKindLabel(input?.kind);
	const routeLabels: Record<string, string> = { direct: "定向发送", broadcast: "广播", one_of_us: "成员认领" };
	const modeLabels: Record<string, string> = { auto: "自动", steer: "调整当前任务", follow_up: "追加任务" };

	const details: ReactNode[] = [];
	const sessionAction = name.startsWith("session_");
	if (identity && !displaySessions.length && !sessionRecord) details.push(<Field key="identity" label="智能体" value={identity} />);
	if (task && !sessionAction) details.push(<TextBlock key="task" label={taskTitle ? `任务：${taskTitle}` : "任务"}>{task}</TextBlock>);
	if (taskTitle && !task) details.push(<Field key="task-title" label="任务" value={taskTitle} />);
	if (message) details.push(<TextBlock key="message" label={name === "session_send" ? "消息" : "消息正文"}>{message}</TextBlock>);
	if (name === "session_send" && text(input?.mode)) details.push(<Field key="mode" label="发送方式" value={modeLabels[String(input?.mode)] ?? String(input?.mode)} />);
	if (name === "session_create" && text(input?.workspaceMode)) {
		const workspaceModes: Record<string, string> = { shared: "共享工作区", worktree: "独立工作区", patch: "补丁交付" };
		details.push(<Field key="workspace" label="工作区" value={workspaceModes[String(input?.workspaceMode)] ?? "工作区"} />);
	}
	if (name === "room_create" && text(input?.mode)) details.push(<Field key="room-mode" label="空间类型" value={input?.mode === "group" ? "群组" : "单聊"} />);
	if ((name === "room_create" || name === "room_join" || name === "room_leave") && (roomTitle || roomName)) details.push(<Field key="room-title" label="协作空间" value={roomTitle ?? roomName} />);
	if (name === "room_join" && text(input?.nickname)) details.push(<Field key="nickname" label="成员名" value={String(input?.nickname)} />);
	if (name === "room_join" && text(input?.profileName)) details.push(<Field key="profile" label="智能体配置" value={String(input?.profileName)} />);
	if (name === "room_send") {
		if (text(input?.route)) details.push(<Field key="route" label="发送范围" value={routeLabels[String(input?.route)] ?? String(input?.route)} />);
		if (roomKind) details.push(<Field key="kind" label="消息类型" value={roomKind} />);
		if (record(input?.capabilities)) details.push(<CapabilityDetails key="capabilities" value={input?.capabilities} />);
	}
	if (name === "room_task_update" && text(input?.status)) details.push(<Field key="task-status" label="任务状态" value={statusLabel(input?.status)} />);
	if (name === "session_stop") {
		if (stopReason) details.push(<Field key="stop-reason" label="停止原因" value={stopReason} />);
		if (stopNote) details.push(<TextBlock key="stop-note" label="说明">{stopNote}</TextBlock>);
	}
	if (progressData) {
		if (progressState) details.push(<Field key="wait-state" label="等待状态" value={progressState} />);
		if (elapsed) details.push(<Field key="elapsed" label="已等待" value={elapsed} />);
	}
	if (name === "room_send" && Array.isArray(resultObject?.deliveredTo) && resultObject.deliveredTo.length) {
		details.push(<Field key="delivered" label="送达成员" value={`${resultObject.deliveredTo.length} 位`} />);
	}
	if ((name === "session_stop" || name === "session_send") && operationStatus && !hasVisibleSessionStatus) {
		const running = state === "input-available" || state === "input-queued";
		details.push(<Field key="operation-status" label={running ? "当前状态" : name === "session_stop" ? "处理结果" : "发送状态"} value={operationStatus} />);
	}
	if (incomplete) details.push(<Field key="incomplete" label="协作详情" value="结果预览不完整。" />);
	if (error) details.push(<TextBlock key="error" label="错误" destructive>{error}</TextBlock>);
	if (textResult && textResult !== error && !displaySessions.length && !sessionRecord && !messages.length && !tasks.length) {
		details.push(<TextBlock key="result-text" label="结果">{textResult}</TextBlock>);
	}
	if (!displaySessions.length && !sessionRecord && resultObject?.result && record(resultObject.result)) {
		const nestedResult = record(resultObject.result);
		const nestedText = resultText(nestedResult);
		const nestedError = resultError(nestedResult);
		if (nestedText) details.push(<TextBlock key="nested-result" label="执行结果">{nestedText}</TextBlock>);
		if (nestedError) details.push(<TextBlock key="nested-error" label="执行错误" destructive>{nestedError}</TextBlock>);
	}

	return (
		<div className="grid min-w-0 gap-2">
			{details.length ? <div className="grid min-w-0 gap-1.5">{details}</div> : null}
			{displaySessions.length ? <SessionRows rows={displaySessions} onOpenSession={onOpenSession} /> : null}
			{profileResults ? <ProfileRows value={profileResults} /> : null}
			{rooms.length ? <RoomRows rooms={rooms} /> : null}
			{allMembers.length ? <MemberRows members={allMembers} /> : null}
			{tasks.length ? <TaskRows tasks={tasks} members={allMembers} /> : null}
			{messages.length ? <MessageRows messages={messages} members={allMembers} /> : null}
			{sessionRecord ? <SessionRows rows={[sessionRecord]} onOpenSession={onOpenSession} /> : null}
			{agentId && !sessionRecord && !displaySessions.length && onOpenSession ? <Button className="h-7 w-fit px-1 text-xs" onClick={() => onOpenSession(agentId)} type="button" variant="ghost">切换到子会话</Button> : null}
			{name === "room_list" && !rooms.length && roomTitle ? <Field label="协作空间" value={roomTitle} /> : null}
			{name === "room_task_update" && firstText(input, ["note"]) ? <TextBlock label="更新说明">{firstText(input, ["note"]) ?? ""}</TextBlock> : null}
			{!details.length && !displaySessions.length && !profileResults && !rooms.length && !allMembers.length && !tasks.length && !messages.length && !sessionRecord && !room && state !== "input-available" && state !== "input-queued" ? (
				<span className="text-xs text-muted-foreground">没有可展示的协作详情</span>
			) : null}
		</div>
	);
}

export { SessionCollaborationToolDetail };
