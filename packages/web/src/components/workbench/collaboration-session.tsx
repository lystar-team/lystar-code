import {
	Braces,
	CheckCircle2,
	FileText,
	MessageSquare,
	SearchCode,
	TerminalSquare,
	type LucideIcon,
} from "lucide-react";
import type { WebSessionSummary } from "../../types";

const AGENT_ALIASES = [
	"霜叶",
	"海盐",
	"纸鸢",
	"星野",
	"青岚",
	"松墨",
	"云砚",
	"川柏",
	"月白",
	"南枝",
	"远山",
	"清和",
] as const;

export type CollaborationAgentKind = "main" | "code" | "test" | "document" | "research" | "general";

export const AGENT_ICON_OPTIONS = [
	{ value: "main", label: "对话", icon: MessageSquare },
	{ value: "code", label: "代码", icon: Braces },
	{ value: "test", label: "测试", icon: CheckCircle2 },
	{ value: "document", label: "文档", icon: FileText },
	{ value: "research", label: "调研", icon: SearchCode },
	{ value: "general", label: "终端", icon: TerminalSquare },
] as const;

export type AgentIconKey = (typeof AGENT_ICON_OPTIONS)[number]["value"];

export function isCollaborationSession(session: WebSessionSummary | undefined): boolean {
	return session?.relation === "collaboration" && Boolean(session.parentId);
}

export function collaborationAlias(sessionId: string): string {
	let hash = 2166136261;
	for (const character of sessionId) {
		hash ^= character.codePointAt(0) ?? 0;
		hash = Math.imul(hash, 16777619);
	}
	return AGENT_ALIASES[Math.abs(hash) % AGENT_ALIASES.length]!;
}

export function collaborationAgentKind(session: WebSessionSummary | undefined): CollaborationAgentKind {
	if (!session) return "main";
	const value = `${session.profileId ?? ""} ${session.profileName ?? ""} ${session.profileIcon ?? ""}`.toLowerCase();
	if (/test|qa|verify|验证|测试/u.test(value)) return "test";
	if (/doc|writer|文档|整理/u.test(value)) return "document";
	if (/research|search|调研|检索/u.test(value)) return "research";
	if (/code|review|develop|代码|审阅|开发/u.test(value)) return "code";
	return "general";
}

export function collaborationAgentIcon(kind: CollaborationAgentKind): LucideIcon {
	switch (kind) {
		case "main":
			return MessageSquare;
		case "code":
			return Braces;
		case "test":
			return CheckCircle2;
		case "document":
			return FileText;
		case "research":
			return SearchCode;
		case "general":
			return TerminalSquare;
	}
}

export function collaborationAgentIconForSession(session: WebSessionSummary | undefined): LucideIcon {
	const configured = session?.profileIcon?.trim().toLowerCase();
	const option = AGENT_ICON_OPTIONS.find((candidate) => candidate.value === configured);
	return option?.icon ?? collaborationAgentIcon(collaborationAgentKind(session));
}

export function collaborationAgentType(session: WebSessionSummary | undefined): string {
	if (!session) return "主智能体";
	return session.profileName?.trim() || "协作智能体";
}

export function collaborationSessionsForSession(
	sessions: readonly WebSessionSummary[],
	sessionId: string | undefined,
): WebSessionSummary[] {
	if (!sessionId) return [];
	const current = sessions.find((session) => session.id === sessionId);
	if (!current) return [];
	const rootId = current.relation === "collaboration" && current.parentId ? current.parentId : current.id;
	const root = sessions.find((session) => session.id === rootId);
	const children = sessions.filter(
		(session) => session.relation === "collaboration" && session.parentId === rootId,
	);
	return root && children.length ? [root, ...children] : [];
}

export function collaborationStatus(session: WebSessionSummary | undefined, current = false): string {
	if (current) return "当前";
	switch (session?.activity) {
		case "running":
			return "进行中";
		case "waiting_for_input":
			return "等待回复";
		case "completed":
			return "已完成";
		case "failed":
			return "失败";
		case "aborted":
			return "已停止";
		case "interrupted":
			return "已中断";
		case "idle":
		default:
			return "空闲";
	}
}
