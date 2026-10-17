import type { SessionCollaborationResult, SessionHeader, SessionOutcome } from "@earendil-works/pi-coding-agent/core";
import type {
	ContentChunk,
	ReadImageContentResult,
	SubagentSnapshot,
	TranscriptItem,
	TranscriptPage,
} from "@lystar/code-web-protocol";

export interface SessionIndexMetadata {
	header: SessionHeader;
	leafId: string | null;
	name?: string;
	nameResolved?: boolean;
	model?: { provider: string; id: string };
	thinkingLevel?: string;
	messageCount: number;
	firstMessage: string;
	lastOutcome?: SessionOutcome;
	modifiedMs: number;
	collaborationResult?: SessionCollaborationResult;
	snapshot: { generation: string; revision: number; updatedAt: number };
}

export interface SessionTranscriptOptions {
	cursor?: string;
	limit: number;
	emptyGeneration?: string;
	byteBudget?: number;
	leafId?: string | null;
	compact?: boolean;
}

export type SessionIndexTranscriptPage = Omit<TranscriptPage, "agentSteps"> & {
	contextCalls?: TranscriptItem[];
	stepItems: TranscriptItem[];
};

export interface SessionIndexRequest {
	id: number;
	command: "metadata" | "subagents" | "remove" | "history" | "history_content" | "history_image" | "history_join";
	path: string;
	writerLocked: boolean;
	transcript?: SessionTranscriptOptions & { maxJsonlLineBytes: number };
	contentRef?: string;
	offset?: number;
	limit?: number;
	joins?: string[];
}

export interface SessionIndexResponse {
	id: number;
	transcriptPart?: "items" | "stepItems" | "contextCalls";
	item?: TranscriptItem;
	result?:
		| SessionIndexMetadata
		| SessionIndexTranscriptPage
		| SubagentSnapshot[]
		| ContentChunk
		| ReadImageContentResult
		| Record<string, string>
		| null;
	error?: { message: string; code?: string; retryable?: boolean };
}
