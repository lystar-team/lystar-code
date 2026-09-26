import type {
	AgentCapabilityLease,
	AgentInputOrigin,
	AgentTurnContext,
	AgentTurnResult,
	SessionCollaborationResult,
	SessionCollaborationTask,
	SessionCoordinator,
	SessionWorkspaceSnapshot,
} from "@earendil-works/pi-coding-agent/core";
import type {
	AuthType,
	ChangelogResult,
	ClipboardImageReadResult,
	CompletionItem,
	CompletionResult,
	ContentChunk,
	GitBranches,
	GitCommit,
	GitDiff,
	GitHistory,
	GitMutation,
	GitMutationResult,
	GitStats,
	GitStatus,
	HarnessImportPreview,
	HarnessImportResult,
	HostDirectoryListing,
	JsonValue,
	ModelOptions,
	ModelRef,
	PackageSummary,
	ProjectFileSaveResult,
	ProjectInstruction,
	ProjectResource,
	ProjectTrust,
	ReadProjectImageResult,
	RenderRichTextResult,
	RichTextMessageType,
	SessionActivity,
	SessionInfoResult,
	SessionPhase,
	SessionProgress,
	SessionStateSnapshot,
	SessionTreeNode,
	SettingSummary,
	SubagentConfig,
	SubagentSnapshot,
	ThinkingLevel,
} from "@lystar/code-web-protocol";

export type QueueAction = "remove" | "steer";

export interface RuntimeEvent {
	type:
		| "progress"
		| "entry_committed"
		| "state_changed"
		| "subagent_updated"
		| "turn_settled"
		| "ui_request"
		| "disconnected";
	payload: JsonValue | SessionProgress;
}

export interface ToolRecoveryRuntimeDiagnostics {
	mode: "off" | "observe" | "assist" | "auto";
	toolFailureTotal: Array<{ tool: string; code: string; count: number }>;
	toolRecoveryAttemptTotal: Array<{ tool: string; action: string; count: number }>;
	toolRecoverySuccessTotal: Array<{ tool: string; action: string; count: number }>;
	toolRepeatBlockedTotal: Array<{ tool: string; code: string; count: number }>;
	toolUnsafeRetryBlockedTotal: Array<{ tool: string; count: number }>;
	lessonMatchTotal: Array<{ lesson: string; count: number }>;
	lessonRecoverySuccessTotal: Array<{ lesson: string; count: number }>;
	lessonSuspendedTotal: Array<{ lesson: string; count: number }>;
	duration: { count: number; totalMs: number; maxMs: number };
	activeCircuits: number;
}

export interface RichTextRenderRequest {
	text: string;
	width: number;
	messageType: RichTextMessageType;
	isStreaming: boolean;
}

export interface RuntimeSessionAsyncControls {
	isConnected?(): boolean;
	ownsSessionWriter?(): boolean;
	hasExternalClients?(): boolean;
	getLiveMessage?(): { text: string; thinking: string; stepId?: string } | undefined;
	readLiveMessage?(): Promise<{ text: string; thinking: string; stepId?: string } | undefined>;
	getCapabilities?(): readonly string[];
	listSettingsAsync?(): Promise<SettingSummary[]>;
	getSessionTreeAsync?(): Promise<SessionTreeNode[]>;
	getSessionInfoAsync?(): Promise<SessionInfoResult>;
	listForkMessagesAsync?(): Promise<Array<{ entryId: string; text: string }>>;
	listSubagentsAsync?(): Promise<SubagentSnapshot[]>;
	readSubagentAsync?(agentId: string): Promise<{ transcript?: SubagentSnapshot; live?: SubagentSnapshot }>;
	getLastAssistantTextAsync?(): Promise<string | undefined>;
	getTurnResultAsync?(turnId: string): Promise<AgentTurnResult | undefined>;
	activateExtensionLifecycle?(): Promise<void>;
	reservePromptWithOrigin?(options: {
		inputId: string;
		origin: AgentInputOrigin;
		activeToolNames?: readonly string[];
		capabilities?: AgentCapabilityLease;
	}): RuntimePromptReservation;
	recordCollaborationResult?(result: SessionCollaborationResult): Promise<void>;
}

export interface RuntimePromptReservation {
	submit(text: string, images?: Array<{ data: string; mimeType: string }>): Promise<AgentTurnContext | undefined>;
	cancel(): void;
}

export interface RuntimeSession extends RuntimeSessionAsyncControls {
	readonly sessionPath: string;
	getSnapshot(writeAccess: SessionStateSnapshot["writeAccess"]): SessionStateSnapshot;
	listSettings(): SettingSummary[];
	setSetting(
		id: string,
		value: boolean | number | string,
	): Promise<{ setting: SettingSummary; requiresRestart: boolean }>;
	getSessionTree(): SessionTreeNode[];
	getSessionInfo(): SessionInfoResult;
	listForkMessages(): Array<{ entryId: string; text: string }>;
	setEntryLabel(entryId: string, label?: string): Promise<void>;
	navigateSessionTree(
		entryId: string,
		summarize: boolean,
	): Promise<{ editorText?: string; cancelled: boolean; newLeafId?: string }>;
	listSubagents(): SubagentSnapshot[];
	readSubagent(agentId: string): { transcript?: SubagentSnapshot; live?: SubagentSnapshot };
	abortSubagent(agentId: string): Promise<void>;
	continueSubagent(agentId: string, text: string): Promise<void>;
	prompt(text: string, images?: Array<{ data: string; mimeType: string }>, queueId?: string): Promise<void>;
	promptWithOrigin?(
		text: string,
		images: Array<{ data: string; mimeType: string }> | undefined,
		options: {
			inputId: string;
			origin: AgentInputOrigin;
			activeToolNames?: readonly string[];
			capabilities?: AgentCapabilityLease;
		},
	): Promise<AgentTurnContext | undefined>;
	steer(text: string, images?: Array<{ data: string; mimeType: string }>, queueId?: string): Promise<void>;
	followUp(text: string, images?: Array<{ data: string; mimeType: string }>, queueId?: string): Promise<void>;
	queueAction(queueId: string, action: QueueAction): Promise<void>;
	clearQueue(): Promise<{ steering: string[]; followUp: string[] }>;
	compact(customInstructions?: string): Promise<void>;
	exportSession(outputPath?: string): Promise<{ path: string }>;
	importSession(inputPath: string, cwdOverride?: string): Promise<{ cancelled: boolean; sessionPath?: string }>;
	shareSession(signal?: AbortSignal): Promise<{ previewUrl: string; gistUrl: string }>;
	getLastAssistantText(): string | undefined;
	runBash(command: string, excludeFromContext: boolean, onChunk: (chunk: string) => void): Promise<JsonValue>;
	rename(name: string): Promise<void>;
	setModel(model: ModelRef): Promise<void>;
	setThinkingLevel(level: ThinkingLevel): Promise<void>;
	cycleModel(direction: "forward" | "backward"): Promise<{ changed: boolean; isScoped: boolean }>;
	cycleThinkingLevel(): Promise<{ changed: boolean; supported: boolean }>;
	fork(entryId: string, position?: "before" | "at"): Promise<{ sessionPath: string; selectedText?: string }>;
	abort(): Promise<void>;
	reloadResources(): Promise<void>;
	getCompletions(text: string, cursor: number): CompletionResult | Promise<CompletionResult | undefined> | undefined;
	renderRichText?(request: RichTextRenderRequest): RenderRichTextResult;
	getToolRecoveryDiagnostics(): ToolRecoveryRuntimeDiagnostics | undefined;
	dispose(): Promise<void>;
	onEvent(listener: (event: RuntimeEvent) => void): () => void;
}

export interface SessionSummaryBase {
	path: string;
	id: string;
	cwd: string;
	name?: string;
	parentId?: string;
	relation?: "collaboration" | "fork";
	profileId?: string;
	profileName?: string;
	profileIcon?: string;
	createdAt: number;
	updatedAt: number;
	messageCount: number;
	firstMessage: string;
	activity: SessionActivity;
	workspace?: SessionWorkspaceSnapshot;
	taskId?: string;
	taskDescription?: string;
	collaborationResult?: SessionCollaborationResult;
}

export interface ModelSummary {
	provider: string;
	id: string;
	name: string;
	api: string;
	reasoning: boolean;
	input: ("text" | "image")[];
	contextWindow: number;
	maxTokens: number;
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>>;
	capabilitiesPending?: boolean;
	hasOverrides?: boolean;
	supportedThinkingLevels: ThinkingLevel[];
	authenticated: boolean;
	authMethods: AuthType[];
	authSource?: string;
}

export interface ModelProviderSummary {
	id: string;
	name: string;
	api?: string;
	baseUrl?: string;
	authenticated: boolean;
	authMethods: AuthType[];
	authSource?: string;
	modelCount: number;
	builtIn: boolean;
	custom: boolean;
	hasCustomConfig: boolean;
	disabledModels: string[];
	catalogProvider?: string;
}

export interface ModelProviderInput {
	provider: string;
	name?: string;
	baseUrl: string;
	api: string;
	apiKey?: string;
	catalogProvider?: string;
	clearCatalogProvider?: boolean;
}

export interface ProviderModelInput {
	provider: string;
	id: string;
	name?: string;
	api?: string;
	baseUrl?: string;
	reasoning: boolean;
	input: ("text" | "image")[];
	thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>>;
	resetOverride?: boolean;
	contextWindow?: number;
	maxTokens?: number;
}

export interface SkillSummary {
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
}

export interface RuntimeAdapter {
	createSession(
		cwd: string,
		onUiRequest: UiRequestHandler,
		options?: {
			parentSession?: string;
			profileId?: string;
			roomAgent?: boolean;
			collaborationTask?: SessionCollaborationTask;
			collaborationWorkspace?: SessionWorkspaceSnapshot;
			sessionDir?: string;
			readOnly?: boolean;
		},
	): Promise<RuntimeSession>;
	setSessionCoordinator?(coordinator: SessionCoordinator): void;
	openSession(
		sessionPath: string,
		onUiRequest: UiRequestHandler,
		options?: { deferExtensionLifecycle?: boolean },
	): Promise<RuntimeSession>;
	inspectSession(sessionPath: string): SessionStateSnapshot;
	inspectSessionActivity?(sessionPath: string): Promise<SessionActivity | undefined>;
	isSessionWriterLocked(sessionPath: string): boolean;
	deleteSession(sessionPath: string): Promise<void>;
	getSessionDirectory?(cwd: string): string;
	listSessions(cwd: string, options?: { metadataOnly?: boolean }): Promise<SessionSummaryBase[]>;
	listModels(): Promise<ModelSummary[]>;
	listModelProviders(): Promise<ModelProviderSummary[]>;
	listModelOptions(options?: { includeProviders?: readonly string[] }): Promise<ModelOptions>;
	addModelProvider(input: ModelProviderInput): Promise<ModelProviderSummary[]>;
	removeModelProvider(provider: string): Promise<ModelProviderSummary[]>;
	addProviderModel(input: ProviderModelInput): Promise<ModelSummary[]>;
	setProviderModelEnabled(provider: string, modelId: string, enabled: boolean): Promise<ModelSummary[]>;
	syncModelProvider(provider: string): Promise<ModelSummary[]>;
	loginModelProvider(
		provider: string,
		authType: AuthType,
		onUiRequest: UiRequestHandler,
		signal?: AbortSignal,
	): Promise<ModelSummary[]>;
	logoutModelProvider(provider: string): Promise<ModelSummary[]>;
	listSkills(cwd: string, onUiRequest: UiRequestHandler): Promise<{ skills: SkillSummary[]; diagnostics: JsonValue }>;
	listHarnessImports(cwd: string): HarnessImportPreview;
	listSubagentConfigs(cwd: string): SubagentConfig[];
	saveSubagentConfig(
		cwd: string,
		input: {
			scope: "user" | "project";
			originalName?: string;
			name: string;
			description: string;
			icon?: string;
			provider?: string;
			model?: string;
			thinkingLevel?: ThinkingLevel;
			tools?: string[];
			skills?: string[];
			tags?: string[];
			content: string;
			expectedHash?: string;
		},
		onUiRequest: UiRequestHandler,
	): Promise<SubagentConfig[]>;
	deleteSubagentConfig(
		cwd: string,
		input: { scope: "user" | "project"; name: string; expectedHash: string },
		onUiRequest: UiRequestHandler,
	): Promise<SubagentConfig[]>;
	importHarnessResources(cwd: string, itemIds: string[], onUiRequest: UiRequestHandler): Promise<HarnessImportResult>;
	setSkillEnabled(
		cwd: string,
		path: string,
		scope: "user" | "project",
		enabled: boolean,
		onUiRequest: UiRequestHandler,
	): Promise<{ skills: SkillSummary[]; diagnostics: JsonValue }>;
	listProjectInstructions(cwd: string): ProjectInstruction[];
	saveProjectInstruction(
		cwd: string,
		fileName: "AGENTS.md" | "AGENTS.override.md",
		content: string,
		expectedHash?: string,
	): ProjectInstruction[];
	listHostInstructions(): ProjectInstruction[];
	saveHostInstruction(
		fileName: "AGENTS.md" | "AGENTS.override.md",
		content: string,
		expectedHash?: string,
	): ProjectInstruction[];
	listDirectories(path?: string): HostDirectoryListing;
	completeProjectFiles(cwd: string, query: string, limit: number): CompletionItem[];
	resolveProjectResource(cwd: string, target: string, line?: number, column?: number): ProjectResource;
	readProjectResource(cwd: string, path: string, offset: number, limit: number): ContentChunk;
	saveProjectFile(cwd: string, path: string, content: string, expectedHash: string): ProjectFileSaveResult;
	resolveExternalResource(target: string, line?: number, column?: number): ProjectResource;
	readExternalResource(path: string, accessToken: string, offset: number, limit: number): ContentChunk;
	getAbout(): JsonValue;
	getChangelog(sessionPath: string, width: number, cwd?: string): ChangelogResult;
	getDiagnostics(cwd?: string, runtimeDiagnostics?: ToolRecoveryRuntimeDiagnostics): Promise<JsonValue>;
	getGitStatus(cwd: string, options?: { refreshRepositories?: boolean }): Promise<GitStatus>;
	getGitDiff(cwd: string, path: string | undefined, staged: boolean, repositoryPath?: string): Promise<GitDiff>;
	getGitStats(cwd: string, repositoryPath?: string): Promise<GitStats>;
	getGitBranches(cwd: string, repositoryPath?: string): Promise<GitBranches>;
	getGitHistory(cwd: string, offset: number, limit: number, repositoryPath?: string): Promise<GitHistory>;
	getGitCommit(cwd: string, revision: string, repositoryPath?: string, path?: string): Promise<GitCommit>;
	mutateGit(
		cwd: string,
		repositoryPath: string | undefined,
		mutation: GitMutation,
		signal?: AbortSignal,
	): Promise<GitMutationResult>;
	checkForUpdates(): Promise<JsonValue>;
	listSettings(sessionPath: string): SettingSummary[];
	getSessionTree(sessionPath: string): SessionTreeNode[];
	listSubagents(sessionPath: string): SubagentSnapshot[];
	readSubagent(sessionPath: string, agentId: string): { transcript?: SubagentSnapshot };
	getProjectTrust(cwd: string): ProjectTrust;
	getProjectTrustDecision(cwd: string): boolean | null;
	setProjectTrust(cwd: string, trusted: boolean | null): Promise<ProjectTrust>;
	listPackages(cwd: string): PackageSummary[];
	installPackage(
		cwd: string,
		source: string,
		scope: "user" | "project",
	): Promise<{ changed: boolean; message: string }>;
	removePackage(
		cwd: string,
		source: string,
		scope: "user" | "project",
	): Promise<{ changed: boolean; message: string }>;
	updatePackages(cwd: string, source?: string): Promise<{ changed: boolean; message: string }>;
	readProjectImage(cwd: string, path: string): ReadProjectImageResult;
	readClipboardImage(): Promise<ClipboardImageReadResult>;
	readClipboardText(): Promise<{ capability: boolean; text?: string }>;
	writeClipboardText(text: string): Promise<{ capability: boolean; changed: boolean }>;
	renderRichText?(sessionPath: string, request: RichTextRenderRequest): RenderRichTextResult;
}

export interface UiRequest {
	id: string;
	kind: "select" | "confirm" | "input" | "secret" | "editor" | "notify";
	title: string;
	payload: JsonValue;
	timeoutMs?: number;
	signal?: AbortSignal;
}

export type UiRequestHandler = (request: UiRequest) => Promise<{
	value?: JsonValue;
	confirmed?: boolean;
	cancelled?: boolean;
}>;

export interface RuntimeStateInput {
	id: string;
	path: string;
	name?: string;
	cwd: string;
	createdAt: number;
	updatedAt: number;
	phase: SessionPhase;
	activity: SessionActivity;
	model?: ModelRef;
	thinkingLevel: ThinkingLevel;
	leafId: string | null;
	queuedSteerCount: number;
	queuedFollowUpCount: number;
	transcriptGeneration: string;
	transcriptRevision: number;
}
