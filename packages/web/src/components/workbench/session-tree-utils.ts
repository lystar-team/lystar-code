import { promptDisplayText } from "../../state/chat-lifecycle";
import type { WorkbenchState } from "../../state/use-workbench";

export type SessionTreeNode = WorkbenchState["sessionTree"][number];

const NODE_KIND_LABELS: Record<string, string> = {
	compaction: "上下文压缩",
	branch_summary: "分支摘要",
	custom: "扩展记录",
	custom_message: "扩展消息",
	label: "节点标记",
	model_change: "模型切换",
	session: "会话开始",
	session_info: "会话信息",
	thinking_level_change: "思考级别",
};

export interface SessionTurn {
	id: string;
	forkEntryId: string;
	timestamp: string;
	userNode?: SessionTreeNode;
	responseNodes: SessionTreeNode[];
	toolNodes: SessionTreeNode[];
	supportingNodes: SessionTreeNode[];
	isLeaf: boolean;
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function clip(value: string, maxLength = 180): string {
	const normalized = value.replace(/\s+/g, " ").trim();
	return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}…` : normalized;
}

function contentText(value: unknown): string | undefined {
	if (typeof value === "string") {
		const text = promptDisplayText(value);
		return text || undefined;
	}
	if (!Array.isArray(value)) return undefined;
	const parts = value.flatMap((part) => {
		const item = record(part);
		if (!item) return [];
		if (item.type === "text" && typeof item.text === "string") {
			const text = promptDisplayText(item.text);
			return text ? [text] : [];
		}
		if (item.type === "image") return ["图片附件"];
		if (item.type === "file") return ["文件附件"];
		if (item.type === "toolCall" && typeof item.name === "string") return [`调用工具：${item.name}`];
		return [];
	});
	return parts.length ? parts.join(" · ") : undefined;
}

function parsePreview(preview: string): Record<string, unknown> | undefined {
	try {
		return record(JSON.parse(preview));
	} catch {
		return undefined;
	}
}

export function sessionTreeNodeRole(node: SessionTreeNode): string | undefined {
	const role = parsePreview(node.preview)?.role;
	if (typeof role === "string") return role;
	return /"role"\s*:\s*"([^"\\]+)"/.exec(node.preview)?.[1];
}

function messageHasToolCall(node: SessionTreeNode): boolean {
	const value = parsePreview(node.preview);
	return Array.isArray(value?.content) && value.content.some((part) => record(part)?.type === "toolCall");
}

function messageLabel(value: Record<string, unknown>): string | undefined {
	const role = typeof value.role === "string" ? value.role : undefined;
	const content = contentText(value.content);
	if (role === "user") return content ? `用户提交：${content}` : "用户提交";
	if (role === "assistant") return content ? `Agent：${content}` : "Agent 回复";
	if (role === "toolResult") {
		const toolName = typeof value.toolName === "string" ? value.toolName : "工具";
		return content ? `${toolName}：${content}` : `工具结果：${toolName}`;
	}
	if (role) return content ? `${role}：${content}` : `${role} 消息`;
	return undefined;
}

export function sessionTreeNodeLabel(node: SessionTreeNode): string {
	if (node.label?.trim()) return clip(node.label);
	const value = parsePreview(node.preview);
	if (value) {
		const message = messageLabel(value);
		if (message) return clip(message);
		if (node.kind === "compaction" && typeof value.summary === "string") return clip(`上下文压缩：${value.summary}`);
		if (node.kind === "branch_summary" && typeof value.summary === "string") return clip(`分支摘要：${value.summary}`);
		if (node.kind === "model_change") {
			const provider = typeof value.provider === "string" ? value.provider : "";
			const modelId = typeof value.modelId === "string" ? value.modelId : "";
			if (provider || modelId) return clip(`切换模型：${provider}/${modelId}`.replace(/\/$/, ""));
		}
		if (node.kind === "thinking_level_change" && typeof value.thinkingLevel === "string") {
			return `调整思考级别：${value.thinkingLevel}`;
		}
		if (node.kind === "custom_message" && typeof value.content === "string") return clip(`扩展消息：${value.content}`);
	}
	if (node.kind === "message") {
		const role = sessionTreeNodeRole(node);
		if (role === "user") return "用户消息";
		if (role === "assistant") return "Agent 回复";
		if (role === "toolResult") return "工具结果";
	}
	return NODE_KIND_LABELS[node.kind] ?? "会话记录";
}

export function sessionTreeNodeKindLabel(node: SessionTreeNode): string {
	const role = sessionTreeNodeRole(node);
	if (node.kind === "message") {
		if (role === "user") return "用户消息";
		if (role === "assistant") return "Agent 回复";
		if (role === "toolResult") return "工具结果";
	}
	return NODE_KIND_LABELS[node.kind] ?? "会话记录";
}

function timestampValue(timestamp: string): number {
	const value = Date.parse(timestamp);
	return Number.isNaN(value) ? 0 : value;
}

function isUserMessage(node: SessionTreeNode): boolean {
	return node.kind === "message" && sessionTreeNodeRole(node) === "user";
}

function isToolNode(node: SessionTreeNode): boolean {
	if (node.kind !== "message") return false;
	const role = sessionTreeNodeRole(node);
	return role === "toolResult" || (role === "assistant" && messageHasToolCall(node));
}

function createTurn(node: SessionTreeNode): SessionTurn {
	return {
		id: node.id,
		forkEntryId: node.id,
		timestamp: node.timestamp,
		userNode: isUserMessage(node) ? node : undefined,
		responseNodes: [],
		toolNodes: [],
		supportingNodes: [],
		isLeaf: node.isLeaf,
	};
}

export function buildSessionTurns(nodes: readonly SessionTreeNode[]): SessionTurn[] {
	const ordered = [...nodes]
		.filter((node) => node.kind !== "session")
		.sort((left, right) => timestampValue(left.timestamp) - timestampValue(right.timestamp));
	const turns: SessionTurn[] = [];
	let current: SessionTurn | undefined;

	for (const node of ordered) {
		if (isUserMessage(node)) {
			current = createTurn(node);
			turns.push(current);
			continue;
		}
		if (!current) {
			current = createTurn(node);
			turns.push(current);
		} else {
			current.timestamp = timestampValue(node.timestamp) >= timestampValue(current.timestamp) ? node.timestamp : current.timestamp;
			current.isLeaf = current.isLeaf || node.isLeaf;
		}
		if (isToolNode(node)) current.toolNodes.push(node);
		else if (node.kind === "message" && sessionTreeNodeRole(node) === "assistant") current.responseNodes.push(node);
		else current.supportingNodes.push(node);
	}

	return turns.sort((left, right) => timestampValue(right.timestamp) - timestampValue(left.timestamp) || right.id.localeCompare(left.id));
}

export function sessionTurnLabel(turn: SessionTurn): string {
	return turn.userNode ? sessionTreeNodeLabel(turn.userNode) : turn.responseNodes[0] ? sessionTreeNodeLabel(turn.responseNodes[0]) : "会话记录";
}

export function formatSessionTreeTimestamp(timestamp: string): string {
	const date = new Date(timestamp);
	if (Number.isNaN(date.getTime())) return "时间未知";
	return new Intl.DateTimeFormat("zh-CN", {
		month: "numeric",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
	}).format(date);
}
