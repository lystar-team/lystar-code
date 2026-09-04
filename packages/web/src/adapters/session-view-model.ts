import type { TranscriptItem } from "@lystar/code-gui-protocol";

export type ToolVisualState = "input-available" | "output-available" | "output-error";

export interface TranscriptAttachmentViewModel {
	id: string;
	filename: string;
	mediaType: string;
	url: string;
}

export interface TranscriptToolViewModel {
	id: string;
	name: string;
	summary: string;
	state: ToolVisualState;
	detail?: string;
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
			timestamp: string;
			attachments: TranscriptAttachmentViewModel[];
			sources: string[];
	  }
	| { kind: "reasoning"; text: string; timestamp: string }
	| { kind: "tools"; tools: TranscriptToolViewModel[]; timestamp: string }
	| { kind: "code"; code: string; language: string; timestamp: string }
	| { kind: "summary"; title: string; text: string; timestamp: string };

export function toSessionItemViewModel(
	item: TranscriptItem,
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

	if (view.type === "user" || view.type === "assistant") {
		return {
			kind: "message",
			role: view.type,
			text: view.text,
			timestamp: item.timestamp,
			attachments: (view.images ?? []).map((image, index) => ({
				id: image.contentRef,
				filename: image.alt || `图片 ${index + 1}`,
				mediaType: image.mimeType,
				url: "",
			})),
			sources: view.type === "assistant" ? extractSources(view.text) : [],
		};
	}

	if (view.type === "thinking") {
		return { kind: "reasoning", text: view.text, timestamp: item.timestamp };
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
					diff: view.diff,
				},
			],
		};
	}

	if (view.type === "bash") {
		return { kind: "code", code: view.text, language: "bash", timestamp: item.timestamp };
	}

	if (view.type === "summary") {
		return { kind: "summary", title: view.title, text: view.text, timestamp: item.timestamp };
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

function toToolState(status?: "success" | "error"): ToolVisualState {
	if (status === "success") return "output-available";
	if (status === "error") return "output-error";
	return "input-available";
}

function extractSources(text: string): string[] {
	return [...new Set(text.match(/https?:[^\s)]+/gu) ?? [])].slice(0, 8);
}
