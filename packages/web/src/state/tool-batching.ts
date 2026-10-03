import { webSearchProgressSummary } from "@lystar/code-web-protocol";
import type { WebSearchProgress } from "@lystar/code-web-protocol";

export interface ToolBatchDescriptor {
	name: string;
	summary: string;
}

function parseToolSummary(summary: string): Record<string, unknown> | undefined {
	try {
		const parsed: unknown = JSON.parse(summary);
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: undefined;
	} catch {
		return undefined;
	}
}

export type SessionToolPhase = "running" | "queued" | "completed" | "error" | "cancelled" | "interrupted";

/** 每个协作工具的动作短语；阶段文案由短语拼出。 */
const sessionToolActions: Record<string, string> = {
	session_create: "派发任务给智能体",
	session_send: "向智能体发送消息",
	session_wait: "等待智能体返回",
	session_list: "查看智能体会话",
	session_profiles: "查看智能体配置",
	session_stop: "停止智能体",
	room_create: "创建协作空间",
	room_join: "加入协作空间",
	room_leave: "退出协作空间",
	room_list: "查看协作空间",
	room_send: "发送协作消息",
	room_read: "读取协作消息",
	room_claim: "领取协作任务",
	room_task_list: "查看协作任务",
	room_task_create: "创建协作任务",
	room_task_update: "更新协作任务",
};

export function isSessionTool(name: string): boolean {
	return Object.hasOwn(sessionToolActions, name);
}

export function sessionToolAction(name: string): string | undefined {
	return sessionToolActions[name];
}

export function sessionToolLabel(name: string, phase: SessionToolPhase): string | undefined {
	const action = sessionToolActions[name];
	if (!action) return undefined;
	switch (phase) {
		case "running":
			return `正在${action}`;
		case "queued":
			return `准备${action}`;
		case "completed":
			return `已${action}`;
		case "error":
			return `${action}失败`;
		case "cancelled":
			return `${action}已取消`;
		case "interrupted":
			return `${action}已中断`;
	}
}

export function sessionToolTask(summary: string): string | undefined {
	const parsed = parseToolSummary(summary);
	const task = [parsed?.task, parsed?.title].find(
		(value): value is string => typeof value === "string" && value.trim().length > 0,
	);
	return task?.trim();
}

export interface SessionToolAgentIdentity {
	nickname?: string;
}

function parseJson(value: string | undefined): unknown {
	if (!value) return undefined;
	try {
		return JSON.parse(value);
	} catch {
		return undefined;
	}
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function sessionResultObject(detail: string | undefined): Record<string, unknown> | undefined {
	let current: unknown = parseJson(detail);
	for (let depth = 0; depth < 3; depth++) {
		if (typeof current === "string") {
			current = parseJson(current);
			continue;
		}
		const object = objectValue(current);
		if (!object) return undefined;
		const session = objectValue(object.session);
		if (session) return session;
		if (typeof object.id === "string" || typeof object.sessionId === "string" || typeof object.agentId === "string") return object;
		const content = Array.isArray(object.content) ? object.content : [];
		const text = content.find((item) => objectValue(item)?.type === "text");
		current = objectValue(text)?.text;
	}
	return undefined;
}

export function sessionToolAgent(summary: string, detail?: string): SessionToolAgentIdentity | undefined {
	const input = parseToolSummary(summary);
	const result = sessionResultObject(detail);
	const profileNames = new Set(
		[input?.profileId, result?.profileId, result?.profileName].filter(
			(value): value is string => typeof value === "string" && value.trim().length > 0,
		),
	);
	const nickname = [result?.nickname, result?.name].find(
		(value): value is string =>
			typeof value === "string" && value.trim().length > 0 && !profileNames.has(value.trim()),
	);
	return nickname ? { nickname: nickname.trim() } : undefined;
}

function skillNameFromPath(path: string): string | undefined {
	let normalizedPath = path.split(/[?#]/u, 1)[0] ?? path;
	try {
		normalizedPath = decodeURIComponent(normalizedPath);
	} catch {
		// 路径不是 URL 编码时继续使用原始值。
	}
	normalizedPath = normalizedPath.replaceAll("\\", "/");
	const segments = normalizedPath.split("/").filter(Boolean);
	const skillDirectoryIndex = segments.findIndex((segment) => segment.toLowerCase() === "skills");
	if (skillDirectoryIndex < 0 || skillDirectoryIndex !== segments.length - 3) return undefined;
	if (segments.at(-1)?.toLowerCase() !== "skill.md") return undefined;
	return segments.at(-2);
}

export function skillNameFromTool(tool: ToolBatchDescriptor): string | undefined {
	if (tool.name !== "read") return undefined;
	const parsed = parseToolSummary(tool.summary);
	for (const key of ["path", "file_path", "filename", "url"]) {
		if (typeof parsed?.[key] === "string") return skillNameFromPath(parsed[key]);
	}
	return skillNameFromPath(tool.summary);
}

export function mergeWebSearchSummary(previous: string | undefined, next: string | undefined): string {
	const nextSummary = next?.trim();
	if (nextSummary && nextSummary !== "网页搜索") return nextSummary;
	return previous?.trim() || nextSummary || "网页搜索";
}

export function mergeWebSearchToolSummary(
	previous: string | undefined,
	next: string | undefined,
	progress: WebSearchProgress | undefined,
): string {
	const structured = webSearchProgressSummary(progress);
	return mergeWebSearchSummary(previous, structured === "网页搜索" ? next : structured);
}

export function mergeImageGenerationSummary(previous: string | undefined, next: string | undefined): string {
	const incomingPrompt = parseToolSummary(next ?? "")?.prompt;
	if (typeof incomingPrompt === "string" && incomingPrompt.trim()) return next ?? "";
	const previousPrompt = parseToolSummary(previous ?? "")?.prompt;
	if (typeof previousPrompt === "string" && previousPrompt.trim()) return previous ?? "";
	return next || previous || "image_gen";
}

export function shouldJoinToolBatch(
	previousTool: ToolBatchDescriptor | undefined,
	nextTool: ToolBatchDescriptor,
): boolean {
	if (!previousTool || skillNameFromTool(previousTool) || skillNameFromTool(nextTool)) return false;
	return (
		(previousTool.name === "bash" && nextTool.name === "bash") ||
		(previousTool.name === "read" && nextTool.name === "read") ||
		(previousTool.name === "web_search" && nextTool.name === "web_search")
	);
}

export function shouldJoinLiveToolBatch(
	previousTool: ToolBatchDescriptor | undefined,
	nextTool: ToolBatchDescriptor,
	previousTurnId: number | undefined,
	currentTurnId: number,
): boolean {
	return previousTurnId === currentTurnId && shouldJoinToolBatch(previousTool, nextTool);
}
