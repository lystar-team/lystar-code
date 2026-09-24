import type {
	AgentStep,
	GitBranches,
	GitCommit,
	GitDiff,
	GitHistory,
	GitMutation,
	GitStatus,
	ToolActivityState,
	ToolDiff,
	WebSearchProgress,
} from "@lystar/code-web-protocol";
import type {
	FileResponse,
	HarnessImportResultResponse,
	HarnessImportsResponse,
	ProjectGroup,
	ProjectInstruction,
	ProjectSkillsResponse,
	ProjectTreeResponse,
	ProductBranding,
	PromptAttachmentPreview,
	QueuedUserPrompt,
	SecuritySettingsResponse,
	SubagentConfig,
	SubagentSnapshot,
	UiRequestEvent,
	WebOperation,
	WebProject,
	WebSessionSnapshot,
	WebThinkingLevel,
} from "../types.ts";
import type { PendingUserPrompt } from "./chat-lifecycle.ts";
import type { LiveCompactionState } from "./compaction-state.ts";
import type { WorkbenchTranscriptItem } from "./transcript-state.ts";

export type InspectorMode = "runs" | "files" | "tree" | "git" | "subagent";
export type ComposerMode = "prompt" | "steer" | "follow-up";
export type ThemeMode = "system" | "light" | "dark";
export type SettingsTab =
	| "appearance"
	| "system"
	| "instructions"
	| "skills"
	| "models"
	| "subagents"
	| "imports"
	| "diagnostics"
	| "permissions"
	| "security"
	| "about";

export interface LiveTool {
	id: string;
	name: string;
	batchId: string;
	summary: string;
	state: ToolActivityState;
	result?: string;
	status: "running" | "success" | "error";
	stepId?: string;
	inputPreview?: boolean;
	webSearch?: WebSearchProgress;
	diff?: ToolDiff;
}

export type LiveTurnItem =
	| { id: string; kind: "text"; parts: readonly string[]; turnId: number; stepId?: string }
	| { id: string; kind: "thinking"; parts: readonly string[]; turnId: number; stepId?: string }
	| { id: string; kind: "tools"; turnId: number; batchId: string; toolIds: string[] }
	| { id: string; kind: "compaction"; turnId: number; stepId?: string }
	| {
			id: string;
			kind: "user";
			turnId: number;
			queueId: string;
			text: string;
			displayText: string;
			attachments: PromptAttachmentPreview[];
			afterEntryId?: string;
			stepId?: string;
			sentAt?: number;
			status: "queued" | "processing";
	  };


export interface GitFileDiffStats {
	additions: number;
	deletions: number;
}

export interface WorkbenchState {
	loading: boolean;
	networkOnline: boolean;
	connected: boolean;
	reconnecting: boolean;
	connectionError: string;
	authRequired: boolean;
	projects: WebProject[];
	projectGroups: ProjectGroup[];
	currentProjectId?: string;
	sessionId?: string;
	session?: WebSessionSnapshot;
	sessionError?: string;
	transcript: WorkbenchTranscriptItem[];
	/** 当前会话 Transcript 已知的最新步骤索引；工具归属只来自这份索引或实时 stepId。 */
	agentSteps: Record<string, AgentStep>;
	transcriptPageLoaded: boolean;
	transcriptLoading: boolean;
	transcriptError?: string;
	transcriptGeneration?: string;
	transcriptRevision?: number;
	transcriptLeafId?: string | null;
	previousCursor?: string;
	toolActivityEpoch?: string;
	toolActivityRevision?: number;
	hasMorePrevious: boolean;
	loadingEarlier: boolean;
	lease?: { leaseId: string; leaseGeneration: number; createdAt: number; updatedAt: number };
	readOnly: boolean;
	sessionReady: boolean;
	pendingUserPrompts: PendingUserPrompt[];
	/** 已落盘用户消息 entryId → 客户端按下发送的时刻，使「已处理」和「本次耗时」同一起点。 */
	promptSendTimes: Record<string, number>;
	queuedUserPrompts: QueuedUserPrompt[];
	currentOperation?: WebOperation;
	operations: WebOperation[];
	liveTools: Record<string, LiveTool>;
	liveSteps: Record<string, AgentStep>;
	liveTurnItems: LiveTurnItem[];
	liveTurnId: number;
	liveTurnStartRevision?: number;
	liveTurnActive?: boolean;
	liveCompaction?: LiveCompactionState;
	promptScrollRequest?: number;
	unreadSessionIds: Record<string, true>;
	statusText: string;
	pendingUiRequests: UiRequestEvent[];
	inspectorOpen: boolean;
	inspectorMode: InspectorMode;
	gitStatus?: GitStatus;
	gitBranches?: GitBranches;
	gitHistory?: GitHistory;
	gitCommit?: GitCommit;
	gitFileStats: Record<string, GitFileDiffStats>;
	gitDiff?: GitDiff;
	gitLoading: boolean;
	gitBranchesLoading: boolean;
	gitHistoryLoading: boolean;
	gitCommitLoading: boolean;
	gitDiffLoading: boolean;
	gitOperation?: GitMutation["type"];
	gitCredentialAuthorizationMessage?: string;
	fileTree?: ProjectTreeResponse;
	fileTreeRootPath?: string;
	fileTreeCache: Record<string, ProjectTreeResponse>;
	fileTreeLoading: boolean;
	filePath?: string;
	fileContent?: FileResponse;
	fileError?: string;
	fileLoading: boolean;
	sessionTree: Array<{
		id: string;
		parentId: string | null;
		kind: string;
		label?: string;
		timestamp: string;
		preview: string;
		isLeaf: boolean;
		depth: number;
	}>;
	sessionTreeLoading: boolean;
	directoryListing?: {
		path: string;
		parent?: string;
		home: string;
		entries: Array<{ name: string; path: string; hidden: boolean; kind?: "directory" | "file" }>;
	};
	directoryLoading: boolean;
	settingsOpen: boolean;
	settingsTab: SettingsTab;
	branding: ProductBranding;
	brandingSaving: boolean;
	brandingError?: string;
	securitySettings?: SecuritySettingsResponse;
	securitySettingsLoading: boolean;
	securitySettingsSaving: boolean;
	securitySettingsError?: string;
	skills: ProjectSkillsResponse["skills"];
	skillDiagnostics: unknown;
	skillsLoading: boolean;
	skillsError?: string;
	skillUpdatingPath?: string;
	hostInstructions: ProjectInstruction[];
	hostInstructionsLoading: boolean;
	hostInstructionsError?: string;
	hostInstructionSaving: boolean;
	harnessImports?: HarnessImportsResponse;
	harnessImportsLoading: boolean;
	harnessImportsError?: string;
	harnessImporting: boolean;
	harnessImportResult?: HarnessImportResultResponse;
	subagentConfigs: SubagentConfig[];
	subagentConfigsLoading: boolean;
	subagentConfigsSaving: boolean;
	subagentConfigsError?: string;
	modelOptions: Array<{
		provider: string;
		id: string;
		name: string;
		reasoning: boolean;
		contextWindow: number;
		supportedThinkingLevels: string[];
	}>;
	modelOptionProviders: Array<{
		id: string;
		name: string;
		builtIn: boolean;
	}>;
	modelCatalogRevision: number;
	models: Array<{
		provider: string;
		id: string;
		name: string;
		api: string;
		reasoning: boolean;
		input: ("text" | "image")[];
		contextWindow: number;
		maxTokens: number;
		thinkingLevelMap?: Partial<
			Record<"off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra", string | null>
		>;
		capabilitiesPending?: boolean;
		hasOverrides?: boolean;
		supportedThinkingLevels: string[];
		authenticated: boolean;
		authMethods: string[];
		authSource?: string;
	}>;
	providers: Array<{
		id: string;
		name: string;
		api?: string;
		baseUrl?: string;
		authenticated: boolean;
		authMethods: string[];
		authSource?: string;
		modelCount: number;
		builtIn: boolean;
		custom: boolean;
		hasCustomConfig: boolean;
		disabledModels: string[];
		catalogProvider?: string;
	}>;
	hiddenModelProviders: string[];
	modelSettingsLoading: boolean;
	modelSettingsError?: string;
	sessionNameSettings?: { model?: string; thinkingLevel: WebThinkingLevel };
	sessionNameSettingsLoading: boolean;
	sessionNameSettingsSaving: boolean;
	sessionNameSettingsError?: string;
	about?: Record<string, unknown>;
	diagnostics?: Record<string, unknown>;
	projectTrust?: { cwd: string; trusted: boolean | null; reason: string; resourceRisk: boolean };
	toast?: string;
	theme: ThemeMode;
	composerMode: ComposerMode;
	subagents: SubagentSnapshot[];
	subagentsLoading: boolean;
	subagentsError?: string;
	selectedSubagentId?: string;
	subagentViews: Record<string, SubagentConversationState>;
}

export interface SubagentConversationState {
	snapshot: SubagentSnapshot;
	transcript: WorkbenchTranscriptItem[];
	agentSteps: Record<string, AgentStep>;
	transcriptPageLoaded: boolean;
	transcriptLoading: boolean;
	transcriptError?: string;
	transcriptGeneration?: string;
	transcriptRevision?: number;
	transcriptLeafId?: string | null;
	previousCursor?: string;
	hasMorePrevious: boolean;
	loadingEarlier: boolean;
	toolActivityEpoch?: string;
	toolActivityRevision?: number;
	liveTools: Record<string, LiveTool>;
	liveSteps: Record<string, AgentStep>;
	liveTurnItems: LiveTurnItem[];
	liveTurnId: number;
	liveTurnStartRevision?: number;
	liveTurnActive?: boolean;
	liveCompaction?: LiveCompactionState;
	statusText: string;
}
