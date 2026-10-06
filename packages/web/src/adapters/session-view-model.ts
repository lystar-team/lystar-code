import type { TranscriptCodemodeDetails, TranscriptSubagentRef, WebSearchProgress } from "@lystar/code-web-protocol";
import type { WebTranscriptItem } from "../types.ts";

export type ToolVisualState = "input-available" | "output-available" | "output-error";

export const ASSISTANT_TEXT_DISPLAY_LIMIT = 16_384;

export function splitAssistantDisplayText(text: string): { text: string; fullText?: string; truncated?: boolean } {
	if (text.length <= ASSISTANT_TEXT_DISPLAY_LIMIT) return { text };
	return { text: `${text.slice(0, ASSISTANT_TEXT_DISPLAY_LIMIT - 1)}…`, fullText: text, truncated: true };
}

export interface TranscriptAttachmentViewModel {
	id: string;
	filename: string;
	mediaType: string;
	url: string;
}

export interface TranscriptImageViewModel {
	contentRef: string;
	mimeType: string;
	byteLength: number;
	alt?: string;
}

export interface TranscriptSourceViewModel {
	url: string;
	title?: string;
}

export interface TranscriptToolViewModel {
	id: string;
	name: string;
	summary: string;
	state: ToolVisualState;
	detail?: string;
	sources?: TranscriptSourceViewModel[];
	webSearch?: WebSearchProgress;
	images?: TranscriptImageViewModel[];
	codemode?: TranscriptCodemodeDetails;
	subagents?: TranscriptSubagentRef[];
	diff?: {
		files: Array<{
			path?: string;
			operation?: string;
			additions?: number;
			deletions?: number;
			diff?: string;
		}>;
	};
}

export type SessionItemViewModel =
	| {
			kind: "message";
			role: "user" | "assistant" | "system";
			text: string;
			fullText?: string;
			contentRef?: string;
			truncated?: boolean;
			timestamp: string;
			attachments: TranscriptAttachmentViewModel[];
			sources: string[];
	  }
	| { kind: "reasoning"; text: string; timestamp: string }
	| { kind: "tools"; tools: TranscriptToolViewModel[]; timestamp: string }
	| { kind: "code"; code: string; language: string; timestamp: string }
	| { kind: "extension_entry"; customType: string; details?: string; timestamp: string }
	| {
			kind: "extension_activity";
			activityId: string;
			extensionPath: string;
			hook: string;
			status: "running" | "completed" | "failed" | "interrupted";
			durationMs?: number;
			error?: string;
			details?: string;
			timestamp: string;
	  }
	| {
			kind: "summary";
			variant?: "compaction" | "branch_summary";
			title: string;
			text: string;
			tokensBefore?: number;
			timestamp: string;
	  };

export function toSessionItemViewModel(
	item: WebTranscriptItem,
	toolStatuses: ReadonlyMap<string, "success" | "error"> = new Map(),
): SessionItemViewModel {
	const view = item.view;
	if (!view) {
		return {
			kind: "message",
			role: "system",
			text: "这条记录暂时无法显示",
			timestamp: item.timestamp,
			attachments: [],
			sources: [],
		};
	}

	if (view.type === "user" || view.type === "assistant" || view.type === "custom_message") {
		// 长回复默认显示截断，消息内展开读全文：复制走全文，不走截断摘要。
		const assistantText = view.type === "assistant" ? splitAssistantDisplayText(view.text) : { text: view.text };
		return {
			kind: "message",
			role: view.type === "custom_message" ? "system" : view.type,
			text: assistantText.text,
			...(assistantText.fullText ? { fullText: assistantText.fullText, truncated: true } : {}),
			...(view.type === "assistant" && view.contentRef ? { contentRef: view.contentRef, truncated: true } : {}),
			timestamp: item.timestamp,
			attachments: [
				...(view.images ?? []).map((image, index) => ({
					id: image.contentRef,
					filename: image.alt || `图片 ${index + 1}`,
					mediaType: image.mimeType,
					url: "",
				})),
				...(view.files ?? []).map((file, index) => ({
					id: `${item.entryId}:file:${index}`,
					filename: file.filename,
					mediaType: file.mimeType,
					url: "",
				})),
			],
			sources: view.type === "assistant" ? extractSources(view.text) : [],
		};
	}

	if (view.type === "thinking") {
		return { kind: "reasoning", text: view.text, timestamp: item.timestamp };
	}

	if (view.type === "agent_step") {
		return {
			kind: "summary",
			title: view.step.title,
			text: view.step.summary ?? "",
			timestamp: item.timestamp,
		};
	}

	if (view.type === "extension_entry") {
		return {
			kind: "extension_entry",
			customType: view.customType,
			...(view.details === undefined ? {} : { details: view.details }),
			timestamp: item.timestamp,
		};
	}

	if (view.type === "extension_activity") {
		return {
			kind: "extension_activity",
			activityId: view.activityId,
			extensionPath: view.extensionPath,
			hook: view.hook,
			status: view.status,
			...(view.durationMs === undefined ? {} : { durationMs: view.durationMs }),
			...(view.error === undefined ? {} : { error: view.error }),
			...(view.details === undefined ? {} : { details: view.details }),
			timestamp: item.timestamp,
		};
	}

	if (view.type === "web_search") {
		return {
			kind: "tools",
			timestamp: item.timestamp,
			tools: [
				{
					id: view.id,
					name: "web_search",
					summary: view.query || "网页搜索",
					state: toWebSearchState(view.status),
					sources: view.sources,
					...(view.webSearch ? { webSearch: view.webSearch } : {}),
				},
			],
		};
	}

	if (view.type === "tool_call") {
		return {
			kind: "tools",
			timestamp: item.timestamp,
			tools: view.calls.map((call) => ({
				id: call.id,
				name: call.name,
				summary: call.summary,
				state: toToolState(toolStatuses.get(call.id)),
			})),
		};
	}

	if (view.type === "tool_result") {
		return {
			kind: "tools",
			timestamp: item.timestamp,
			tools: [
				{
					id: view.callId,
					name: view.name,
					summary: view.summary,
					state: toToolState(view.status),
					detail: view.detail,
					images: view.images,
					codemode: view.codemode,
					subagents: view.subagents,
					diff: view.diff,
				},
			],
		};
	}

	if (view.type === "bash") {
		return { kind: "code", code: view.text, language: "bash", timestamp: item.timestamp };
	}

	if (view.type === "summary") {
		return {
			kind: "summary",
			...(view.variant === undefined ? {} : { variant: view.variant }),
			title: view.title,
			text: view.text,
			...(view.tokensBefore === undefined ? {} : { tokensBefore: view.tokensBefore }),
			timestamp: item.timestamp,
		};
	}

	return {
		kind: "message",
		role: "system",
		text: view.text,
		timestamp: item.timestamp,
		attachments: [],
		sources: [],
	};
}

function toWebSearchState(status: "in_progress" | "searching" | "completed" | "failed"): ToolVisualState {
	if (status === "completed") return "output-available";
	if (status === "failed") return "output-error";
	return "input-available";
}

function toToolState(status?: "success" | "error"): ToolVisualState {
	if (status === "success") return "output-available";
	if (status === "error") return "output-error";
	return "input-available";
}

function extractSources(text: string): string[] {
	return [...new Set(text.match(/https?:[^\s)]+/gu) ?? [])].slice(0, 8);
}
