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

const sessionToolLabels: Record<string, Record<SessionToolPhase, string>> = {
	create: {
		running: "正在派发智能体",
		queued: "准备派发智能体",
		completed: "已派发智能体",
		error: "派发智能体失败",
		cancelled: "派发智能体已取消",
		interrupted: "派发智能体已中断",
	},
	send: {
		running: "正在联系智能体",
		queued: "准备联系智能体",
		completed: "已联系智能体",
		error: "联系智能体失败",
		cancelled: "联系智能体已取消",
		interrupted: "联系智能体已中断",
	},
	wait: {
		running: "正在等待智能体返回",
		queued: "准备等待智能体返回",
		completed: "已完成等待智能体",
		error: "等待智能体失败",
		cancelled: "等待智能体已取消",
		interrupted: "等待智能体已中断",
	},
	list: {
		running: "正在查看智能体会话",
		queued: "准备查看智能体会话",
		completed: "已查看智能体会话",
		error: "查看智能体会话失败",
		cancelled: "查看智能体会话已取消",
		interrupted: "查看智能体会话已中断",
	},
	profiles: {
		running: "正在查看智能体配置",
		queued: "准备查看智能体配置",
		completed: "已查看智能体配置",
		error: "查看智能体配置失败",
		cancelled: "查看智能体配置已取消",
		interrupted: "查看智能体配置已中断",
	},
	stop: {
		running: "正在停止智能体",
		queued: "准备停止智能体",
		completed: "已停止智能体",
		error: "停止智能体失败",
		cancelled: "停止智能体已取消",
		interrupted: "停止智能体已中断",
	},
	room_create: {
		running: "正在创建协作空间",
		queued: "准备创建协作空间",
		completed: "已创建协作空间",
		error: "创建协作空间失败",
		cancelled: "创建协作空间已取消",
		interrupted: "创建协作空间已中断",
	},
	room_join: {
		running: "正在加入协作空间",
		queued: "准备加入协作空间",
		completed: "已加入协作空间",
		error: "加入协作空间失败",
		cancelled: "加入协作空间已取消",
		interrupted: "加入协作空间已中断",
	},
	room_leave: {
		running: "正在退出协作空间",
		queued: "准备退出协作空间",
		completed: "已退出协作空间",
		error: "退出协作空间失败",
		cancelled: "退出协作空间已取消",
		interrupted: "退出协作空间已中断",
	},
	room_list: {
		running: "正在查看协作空间",
		queued: "准备查看协作空间",
		completed: "已查看协作空间",
		error: "查看协作空间失败",
		cancelled: "查看协作空间已取消",
		interrupted: "查看协作空间已中断",
	},
	room_send: {
		running: "正在发送协作消息",
		queued: "准备发送协作消息",
		completed: "已发送协作消息",
		error: "发送协作消息失败",
		cancelled: "发送协作消息已取消",
		interrupted: "发送协作消息已中断",
	},
	room_read: {
		running: "正在读取协作消息",
		queued: "准备读取协作消息",
		completed: "已读取协作消息",
		error: "读取协作消息失败",
		cancelled: "读取协作消息已取消",
		interrupted: "读取协作消息已中断",
	},
};

export function sessionToolLabel(summary: string, phase: SessionToolPhase): string | undefined {
	const action = parseToolSummary(summary)?.action;
	return typeof action === "string" ? sessionToolLabels[action]?.[phase] : undefined;
}

export function sessionToolTask(summary: string): string | undefined {
	const task = parseToolSummary(summary)?.task;
	return typeof task === "string" && task.trim() ? task.trim() : undefined;
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
