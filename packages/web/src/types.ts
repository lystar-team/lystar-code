import type {
	GitDiff,
	GitStatus,
	HostDirectoryEntry,
	ModelProviderSummary,
	ModelSummary,
	OperationSnapshot,
	ProjectTrust,
	SessionProgress,
	SessionStateSnapshot,
	SessionSummary,
	SessionTreeNode,
	SettingSummary,
	TranscriptItem,
	TranscriptPage,
} from "@lystar/code-gui-protocol";

export type WebSessionSummary = Omit<SessionSummary, "path" | "cwd">;
export type WebSessionSnapshot = Omit<SessionStateSnapshot, "path" | "cwd">;
export type WebOperation = Omit<
	OperationSnapshot,
	"sessionPath" | "clientInstanceId" | "clientRequestId" | "payloadHash"
> & { sessionId?: string };

export interface WebProject {
	id: string;
	name: string;
	pinned?: boolean;
	color?: "red" | "orange" | "green" | "blue" | "purple" | "gray";
	archived?: boolean;
	sessions: WebSessionSummary[];
}

export interface WebLease {
	leaseId: string;
	leaseGeneration: number;
	createdAt: number;
	updatedAt: number;
}

export interface DirectoryListing {
	path: string;
	parent?: string;
	home: string;
	entries: HostDirectoryEntry[];
}

export interface FileResponse {
	kind: "text" | "image";
	path: string;
	mimeType: string;
	byteLength: number;
	content?: string;
	data?: string;
}

export interface BootstrapResponse {
	projects: WebProject[];
	capabilities: readonly string[];
	connection: { connected: boolean; host: string; productVersion?: string };
	pendingUiRequests: UiRequestEvent[];
	operations: WebOperation[];
}

export interface UiRequestEvent {
	type: "ui_request";
	id: string;
	operationId: string;
	kind: string;
	title: string;
	payload: unknown;
	timeoutMs?: number;
}

export type GatewayEvent =
	| { type: "bootstrap"; data: BootstrapResponse }
	| { type: "connection_state"; connected: boolean; message?: string }
	| { type: "sessions_changed"; projectId?: string }
	| { type: "session_snapshot"; sessionId: string; snapshot: WebSessionSnapshot }
	| { type: "session_removed"; sessionId: string }
	| { type: "transcript_changed"; sessionId: string }
	| {
			type: "transcript_committed";
			sessionId: string;
			transcriptGeneration: string;
			fromRevision: number;
			toRevision: number;
			items: TranscriptItem[];
	  }
	| { type: "session_progress"; sessionId: string; progress: SessionProgress }
	| { type: "operation_updated"; operation: WebOperation }
	| UiRequestEvent;

export interface ModelsResponse {
	models: ModelSummary[];
	providers: ModelProviderSummary[];
}

export interface ProjectTreeEntry extends HostDirectoryEntry {
	kind: "directory" | "file";
}

export interface ProjectTreeResponse {
	path: string;
	parent?: string;
	home: string;
	entries: ProjectTreeEntry[];
}

export interface ProjectSkillsResponse {
	skills: Array<{
		name: string;
		description: string;
		path: string;
		baseDir: string;
		source: string;
		scope: "user" | "project" | "temporary";
		origin: "package" | "top-level";
		enabled: boolean;
		disableModelInvocation: boolean;
		eligible: boolean;
	}>;
	diagnostics: unknown;
}

export interface SettingsResponse {
	settings: SettingSummary[];
}

export interface SessionTreeResponse {
	tree: SessionTreeNode[];
}

export interface GitStatusResponse extends GitStatus {}
export interface GitDiffResponse extends GitDiff {}
export interface ProjectTrustResponse extends ProjectTrust {}
export interface TranscriptResponse extends TranscriptPage {}
