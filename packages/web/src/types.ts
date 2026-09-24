import type {
	AgentStep,
	CompletionResult,
	GitBranches,
	GitCommit,
	GitDiff,
	GitHistory,
	GitMutation,
	GitMutationResult,
	GitStats,
	GitStatus,
	HarnessId,
	HarnessImportItem,
	HarnessImportPreview,
	HarnessImportResult,
	HarnessImportSource,
	HostDirectoryEntry,
	ModelOption,
	ModelOptionProvider,
	ModelProviderSummary,
	ModelSummary,
	OperationSnapshot,
	ProjectInstruction,
	ProjectTrust,
	SessionProgress,
	SessionStateSnapshot,
	SessionSummary,
	SessionTreeNode,
	SettingSummary,
	SubagentConfig,
	SubagentSnapshot,
	TranscriptItem,
	TranscriptPage,
} from "@lystar/code-web-protocol";

export type {
	HarnessId,
	HarnessImportItem,
	HarnessImportPreview,
	HarnessImportResult,
	HarnessImportSource,
	GitMutation,
	ProjectInstruction,
	SubagentConfig,
	SubagentSnapshot,
};

export type WebSessionSummary = Omit<SessionSummary, "path" | "cwd"> & { pinned?: boolean; roomMember?: boolean };
export type WebSessionSnapshot = Omit<SessionStateSnapshot, "path" | "cwd">;
export type WebTranscriptItem = Omit<TranscriptItem, "payload">;
export type WebOperation = Omit<
	OperationSnapshot,
	"sessionPath" | "clientInstanceId" | "clientRequestId" | "payloadHash"
> & { sessionId?: string };

export type WebCompletionResult = CompletionResult;

export interface ProjectGroup {
	id: string;
	name: string;
	projectIds: string[];
}

export interface WebProject {
	id: string;
	name: string;
	path: string;
	pinned?: boolean;
	color?: "red" | "orange" | "green" | "blue" | "purple" | "gray";
	archived?: boolean;
	sessions: WebSessionSummary[];
}

export type WebRoomMode = "direct" | "group";
export type WebRoomRoute = "direct" | "broadcast" | "one_of_us";
export type WebRoomSenderType = "agent" | "user";
export type WebRoomMessageKind = "task" | "message" | "question" | "answer" | "status" | "result" | "system";

export interface WebRoomCapabilityLease {
	allowedTools: string[];
	readRoots?: string[];
	writeRoots?: string[];
	shell?: "disabled" | "sandboxed";
}

export interface WebRoom {
	id: string;
	cwd: string;
	title: string;
	ownerSessionId: string;
	mode: WebRoomMode;
	createdAt: string;
	updatedAt: string;
}

export interface WebRoomMember {
	roomId: string;
	sessionId: string;
	role: "owner" | "member";
	joinedAt: string;
	leftAt?: string;
	lastReadSeq: number;
	nickname?: string;
	profileId?: string;
	profileName?: string;
	profileIcon?: string;
}

export interface WebRoomMessage {
	id: string;
	roomId: string;
	seq: number;
	senderSessionId: string;
	senderType: WebRoomSenderType;
	targetSessionIds: string[];
	route: WebRoomRoute;
	kind: WebRoomMessageKind;
	body: string;
	attachments?: Array<{ path: string; filename: string; mimeType: string }>;
	taskId?: string;
	capabilities?: WebRoomCapabilityLease;
	replyToMessageId?: string;
	basedOnSeq?: number;
	idempotencyKey: string;
	createdAt: string;
}

export interface WebRoomSummary {
	room: WebRoom;
	members: WebRoomMember[];
	latestSeq: number;
}

export interface WebRoomCursor {
	roomId: string;
	sessionId: string;
	lastReadSeq: number;
}

export interface WebRoomReadResponse {
	summary: WebRoomSummary;
	messages: WebRoomMessage[];
	cursor: WebRoomCursor;
	nextSeq?: number;
}

export interface WebRoomSendResponse {
	message: WebRoomMessage;
	deduplicated: boolean;
	deliveredTo: string[];
	errors: Array<{ sessionId: string; message: string }>;
}

export interface WebLease {
	leaseId: string;
	leaseGeneration: number;
	createdAt: number;
	updatedAt: number;
}

export interface ProductBranding {
	name: string;
	logo?: string;
}

export interface ProductUpdateJob {
	id: string;
	status: "running" | "completed" | "failed";
	stage: "starting" | "downloading" | "verifying" | "installing" | "restarting" | "completed" | "failed";
	progress: number;
	currentVersion: string;
	targetVersion: string;
	message: string;
	startedAt: number;
	updatedAt: number;
}

export interface ProductUpdateStatusResponse {
	currentVersion: string;
	job?: ProductUpdateJob;
}

export interface ProductUpdateCheckResponse extends ProductUpdateStatusResponse {
	checkedAt: number;
	repository: string | null;
	installEnabled: boolean;
	installBlockedReason: string;
	status: "available" | "current" | "unavailable" | "offline";
	latestVersion: string | null;
	packageName?: string | null;
	note?: string | null;
	url?: string | null;
}

export interface DirectoryListing {
	path: string;
	parent?: string;
	home: string;
	entries: HostDirectoryEntry[];
}

export interface FileResponse {
	kind: "text" | "image" | "binary";
	path: string;
	mimeType: string;
	byteLength: number;
	previewByteLength?: number;
	truncated?: boolean;
	content?: string;
	data?: string;
	contentHash?: string;
	contentVersion?: string;
}

export type FileMetadataResponse = Pick<
	FileResponse,
	"kind" | "path" | "mimeType" | "byteLength" | "contentVersion"
>;

export interface FileUploadResponse {
	path: string;
	mimeType: string;
	byteLength: number;
}

export interface PromptAttachment {
	path: string;
	mimeType: string;
}

export interface PromptAttachmentPreview {
	id: string;
	filename: string;
	mediaType: string;
	url: string;
}

export interface QueuedUserPrompt {
	id: string;
	text: string;
	displayText: string;
	delivery: "steer" | "follow-up";
	attachments: PromptAttachmentPreview[];
}

export interface BootstrapResponse {
	projects: WebProject[];
	projectGroups: ProjectGroup[];
	capabilities: readonly string[];
	connection: { connected: boolean; host: string; productVersion?: string };
	pendingUiRequests: UiRequestEvent[];
	operations: WebOperation[];
	leases: Array<{ sessionId: string; lease: WebLease }>;
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
	| { type: "session_stream"; sessionId: string; text: string; thinking: string; stepId?: string; seq?: number }
	| { type: "bootstrap"; data: BootstrapResponse }
	| { type: "connection_state"; connected: boolean; message?: string }
	| { type: "session_lease"; sessionId: string; lease: WebLease }
	| { type: "model_catalog_changed"; revision: number }
	| { type: "project_files_changed"; projectId: string; paths: string[] }
	| { type: "sessions_changed"; projectId?: string }
	| {
			type: "session_summary";
			sessionId: string;
			activity: WebSessionSummary["activity"];
			name?: string;
			operationUpdatedAt?: number;
	  }
	| {
			type: "session_subscription";
			sessionId: string;
			seq: number;
			gap: boolean;
	  }
	| { type: "session_snapshot"; sessionId: string; snapshot: WebSessionSnapshot; seq?: number }
	| { type: "session_removed"; sessionId: string }
	| { type: "transcript_changed"; sessionId: string; seq?: number }
	| {
			type: "transcript_committed";
			sessionId: string;
			transcriptGeneration: string;
			fromRevision: number;
			toRevision: number;
			items: WebTranscriptItem[];
			agentSteps?: AgentStep[];
			seq?: number;
	  }
	| { type: "session_progress"; sessionId: string; progress: SessionProgress; seq?: number }
	| {
			type: "subagent_updated";
			sessionId: string;
			snapshot: SubagentSnapshot;
			progress?: SessionProgress[];
			seq?: number;
	  }
	| { type: "operation_updated"; operation: WebOperation; seq?: number }
	| UiRequestEvent;

export interface ModelsResponse {
	revision: number;
	models: ModelSummary[];
	providers: (ModelProviderSummary & { catalogProvider?: string })[];
}

export interface ModelOptionsResponse {
	revision: number;
	models: ModelOption[];
	providers: ModelOptionProvider[];
}

export type WebThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";

export interface WebModelProviderInput {
	provider: string;
	name?: string;
	baseUrl: string;
	api: string;
	apiKey?: string;
	catalogProvider?: string;
	clearCatalogProvider?: boolean;
}

export interface WebProviderModelInput {
	id: string;
	name?: string;
	api?: string;
	baseUrl?: string;
	reasoning: boolean;
	thinkingLevelMap?: Partial<Record<WebThinkingLevel, string | null>>;
	input: ("text" | "image")[];
	resetOverride?: boolean;
	contextWindow?: number;
	maxTokens?: number;
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

export interface SystemPermissionStatus {
	id: "administrator" | "keychain" | "accessibility" | "automation" | "screen-recording";
	name: string;
	state: "granted" | "required" | "unknown" | "unsupported";
	message: string;
	canRequest: boolean;
}

export interface SystemPermissionsResponse {
	platform: string;
	supported: boolean;
	permissions: SystemPermissionStatus[];
}

export interface SecuritySettingsResponse {
	host: string;
	allowedHosts: string[];
	port: number;
	runtimePort: number;
	passwordConfigured: boolean;
	editable: {
		host: boolean;
		allowedHosts: boolean;
		port: boolean;
		runtimePort: boolean;
		password: boolean;
	};
}

export interface SaveSecuritySettingsResponse extends SecuritySettingsResponse {
	accepted: true;
	passwordChanged: boolean;
	restartPending: true;
	runtimePreserved: true;
}

export type HarnessImportsResponse = HarnessImportPreview;
export type HarnessImportResultResponse = HarnessImportResult;

export interface HostInstructionsResponse {
	instructions: ProjectInstruction[];
}

export interface SubagentConfigsResponse {
	subagents: SubagentConfig[];
}

export interface SubagentsResponse {
	subagents: SubagentSnapshot[];
}

export interface SubagentDetailsResponse {
	transcript?: SubagentSnapshot;
	live?: SubagentSnapshot;
}

export interface SessionTreeResponse {
	tree: SessionTreeNode[];
}

export interface GitStatusResponse extends GitStatus {}
export interface GitDiffResponse extends GitDiff {}
export interface GitStatsResponse extends GitStats {}
export interface GitBranchesResponse extends GitBranches {}
export interface GitHistoryResponse extends GitHistory {}
export interface GitCommitResponse extends GitCommit {}
export interface GitMutationResponse extends GitMutationResult {}
export interface ProjectTrustResponse extends ProjectTrust {}
export type TranscriptResponse = Omit<TranscriptPage, "items"> & { items: WebTranscriptItem[] };
