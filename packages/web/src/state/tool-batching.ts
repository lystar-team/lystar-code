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

function recordValue(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function parseSessionToolInput(summary: string): Record<string, unknown> | undefined {
	return recordValue(parseToolSummary(summary));
}

interface SessionToolPayload {
	value: unknown;
	details?: Record<string, unknown>;
	incomplete?: boolean;
}

function parsedSessionToolValue(value: unknown, depth = 0): unknown {
	if (depth < 5 && typeof value === "string") {
		try {
			return parsedSessionToolValue(JSON.parse(value), depth + 1);
		} catch {
			return value;
		}
	}
	if (Array.isArray(value)) return value.map((item) => parsedSessionToolValue(item, depth + 1));
	return value;
}

export function parseSessionToolPayload(detail: string | undefined): SessionToolPayload | undefined {
	if (!detail?.trim()) return undefined;
	let decoded: unknown = detail;
	for (let depth = 0; depth < 5 && typeof decoded === "string"; depth++) {
		const encoded = decoded;
		try {
			decoded = JSON.parse(encoded);
		} catch {
			// 传输预览可能截断 JSON；保留缺口标记，不把它作为正文或真实错误展示。
			return /^\s*[\[{]/u.test(encoded) ? { value: undefined, incomplete: true } : { value: encoded };
		}
	}
	const wrapper = recordValue(decoded);
	if (!wrapper) return { value: parsedSessionToolValue(decoded) };
	const detailsValue = parsedSessionToolValue(wrapper.details);
	const details = recordValue(detailsValue);
	if (Array.isArray(wrapper.content)) {
		const texts = wrapper.content.flatMap((item) => {
			const block = recordValue(item);
			return block?.type === "text" && typeof block.text === "string" ? [parsedSessionToolValue(block.text)] : [];
		});
		if (texts.length) return { value: texts.length === 1 ? texts[0] : texts, ...(details ? { details } : {}) };
	}
	if (wrapper.structuredContent !== undefined) {
		return { value: parsedSessionToolValue(wrapper.structuredContent), ...(details ? { details } : {}) };
	}
	return { value: parsedSessionToolValue(decoded), ...(details ? { details } : {}) };
}

export function parseSessionToolResult(detail: string | undefined): unknown {
	return parseSessionToolPayload(detail)?.value;
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
	const parsed = parseSessionToolInput(summary);
	const task = [parsed?.task, parsed?.title].find(
		(value): value is string => typeof value === "string" && value.trim().length > 0,
	);
	return task?.trim();
}

export interface SessionToolAgentIdentity {
	nickname?: string;
}

function sessionResultObject(detail: string | undefined): Record<string, unknown> | undefined {
	const current = parseSessionToolResult(detail);
	if (Array.isArray(current)) return recordValue(current[0]);
	const object = recordValue(current);
	if (!object) return undefined;
	const sessions = Array.isArray(object.sessions) ? object.sessions : undefined;
	return recordValue(object.session) ?? recordValue(sessions?.[0]) ?? object;
}

export function sessionToolStatusLabel(value: unknown): string | undefined {
	const status = typeof value === "string" ? value.trim() : undefined;
	if (!status) return undefined;
	const labels: Record<string, string> = {
		todo: "待认领",
		doing: "进行中",
		blocked: "阻塞",
		done: "已完成",
		queued: "已排队",
		idle: "尚未开始",
		running: "运行中",
		waiting: "等待中",
		waiting_for_input: "需要输入",
		needs_input: "需要输入",
		interrupted: "已中断",
		succeeded: "已完成",
		completed: "已完成",
		failed: "失败",
		cancelled: "已停止",
		aborted: "已停止",
	};
	return labels[status] ?? status;
}

export function sessionToolActivityLabel(detail: string | undefined): string | undefined {
	return sessionToolStatusLabel(sessionResultObject(detail)?.activity);
}

export function sessionToolSessionId(name: string, summary: string, detail?: string): string | undefined {
	const input = parseSessionToolInput(summary);
	if (name === "session_send" || name === "session_stop") {
		return typeof input?.sessionId === "string" ? input.sessionId : undefined;
	}
	if (name === "session_wait") {
		return Array.isArray(input?.sessionIds) && input.sessionIds.length === 1 && typeof input.sessionIds[0] === "string"
			? input.sessionIds[0]
			: undefined;
	}
	if (name !== "session_create") return undefined;
	const result = sessionResultObject(detail);
	return typeof result?.id === "string" ? result.id : undefined;
}

export function sessionToolAgent(summary: string, detail?: string): SessionToolAgentIdentity | undefined {
	const input = parseSessionToolInput(summary);
	const result = sessionResultObject(detail);
	const taskNames = new Set(
		[input?.task, input?.title, result?.taskDescription, result?.taskTitle, result?.title].filter(
			(value): value is string => typeof value === "string" && value.trim().length > 0,
		).map((value) => value.trim()),
	);
	const displayName = typeof result?.name === "string" && result.name !== result.profileId && result.name !== input?.profileId
		? result.name
		: undefined;
	const candidates = [result?.nickname, result?.memberName, input?.nickname, result?.profileName, input?.profileName, displayName];
	const nickname = candidates.find(
		(value): value is string =>
			typeof value === "string" && value.trim().length > 0 && !taskNames.has(value.trim()),
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
