import type {
	AuthType,
	ClipboardImageReadResult,
	CompletionItem,
	CompletionResult,
	ContentChunk,
	ExtensionTerminalInputResult,
	ExtensionUiState,
	GitDiff,
	GitStatus,
	HostDirectoryListing,
	JsonValue,
	ModelRef,
	PackageSummary,
	ProjectInstruction,
	ProjectResource,
	ProjectTrust,
	ReadProjectImageResult,
	RenderRichTextResult,
	RichTextMessageType,
	SessionActivity,
	SessionPhase,
	SessionProgress,
	SessionStateSnapshot,
	SessionTreeNode,
	SettingSummary,
	SubagentSnapshot,
	ThinkingLevel,
} from "@lystar/code-gui-protocol";

export interface RuntimeEvent {
	type: "progress" | "entry_committed" | "state_changed" | "ui_request" | "extension_ui";
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

export interface RuntimeSession {
	readonly sessionPath: string;
	getSnapshot(writeAccess: SessionStateSnapshot["writeAccess"]): SessionStateSnapshot;
	listSettings(): SettingSummary[];
	setSetting(
		id: string,
		value: boolean | number | string,
	): Promise<{ setting: SettingSummary; requiresRestart: boolean }>;
	getSessionTree(): SessionTreeNode[];
	setEntryLabel(entryId: string, label?: string): Promise<void>;
	navigateSessionTree(
		entryId: string,
		summarize: boolean,
	): Promise<{ editorText?: string; cancelled: boolean; newLeafId?: string }>;
	listSubagents(): SubagentSnapshot[];
	readSubagent(agentId: string): { transcript?: SubagentSnapshot; live?: SubagentSnapshot };
	abortSubagent(agentId: string): Promise<void>;
	continueSubagent(agentId: string, text: string): Promise<void>;
	prompt(text: string, images?: Array<{ data: string; mimeType: string }>): Promise<void>;
	steer(text: string, images?: Array<{ data: string; mimeType: string }>): Promise<void>;
	followUp(text: string, images?: Array<{ data: string; mimeType: string }>): Promise<void>;
	clearQueue(): Promise<{ steering: string[]; followUp: string[] }>;
	compact(customInstructions?: string): Promise<void>;
	exportSession(outputPath?: string): Promise<{ path: string }>;
	importSession(inputPath: string, cwdOverride?: string): Promise<{ cancelled: boolean }>;
	shareSession(signal?: AbortSignal): Promise<{ previewUrl: string; gistUrl: string }>;
	runBash(command: string, onChunk: (chunk: string) => void): Promise<JsonValue>;
	rename(name: string): Promise<void>;
	setModel(model: ModelRef): Promise<void>;
	setThinkingLevel(level: ThinkingLevel): Promise<void>;
	fork(entryId: string, position?: "before" | "at"): Promise<{ sessionPath: string; selectedText?: string }>;
	abort(): Promise<void>;
	reloadResources(): Promise<void>;
	getCompletions(text: string, cursor: number): CompletionResult | undefined;
	renderRichText?(request: RichTextRenderRequest): RenderRichTextResult;
	getExtensionUiSnapshot?(): ExtensionUiState;
	getExtensionComponentDiagnostics?(): JsonValue;
	updateExtensionEditorState?(text: string, generation: number): number;
	dispatchExtensionTerminalInput?(data: string): Promise<ExtensionTerminalInputResult>;
	dispatchExtensionComponentInput?(
		componentId: string,
		generation: number,
		data: string,
	): { accepted: boolean; appAction?: string };
	resizeExtensionComponents?(width: number, height: number): boolean;
	disposeExtensionComponent?(componentId: string, generation: number): boolean;
	completeExtensionCustom?(
		componentId: string,
		generation: number,
		value: JsonValue | undefined,
		cancelled: boolean,
	): boolean;
	publishExtensionComponents?(): void;
	getToolRecoveryDiagnostics(): ToolRecoveryRuntimeDiagnostics;
	dispose(): Promise<void>;
	onEvent(listener: (event: RuntimeEvent) => void): () => void;
}

export interface SessionSummaryBase {
	path: string;
	id: string;
	cwd: string;
	name?: string;
	createdAt: number;
	updatedAt: number;
	messageCount: number;
	firstMessage: string;
	activity: SessionActivity;
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
	supportedThinkingLevels: ThinkingLevel[];
	authenticated: boolean;
	authMethods: AuthType[];
	authSource?: string;
}

export interface ModelProviderSummary {
	id: string;
	name: string;
	authenticated: boolean;
	authMethods: AuthType[];
	authSource?: string;
	modelCount: number;
	builtIn: boolean;
	custom: boolean;
}

export interface ModelProviderInput {
	provider: string;
	name?: string;
	baseUrl: string;
	api: string;
}

export interface ProviderModelInput {
	provider: string;
	id: string;
	name?: string;
	api?: string;
	baseUrl?: string;
	reasoning: boolean;
	input: ("text" | "image")[];
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
	createSession(cwd: string, onUiRequest: UiRequestHandler): Promise<RuntimeSession>;
	openSession(sessionPath: string, onUiRequest: UiRequestHandler): Promise<RuntimeSession>;
	inspectSession(sessionPath: string): SessionStateSnapshot;
	isSessionWriterLocked(sessionPath: string): boolean;
	deleteSession(sessionPath: string): Promise<void>;
	listSessions(cwd: string): Promise<SessionSummaryBase[]>;
	listModels(): Promise<ModelSummary[]>;
	listModelProviders(): Promise<ModelProviderSummary[]>;
	addModelProvider(input: ModelProviderInput): Promise<ModelProviderSummary[]>;
	addProviderModel(input: ProviderModelInput): Promise<ModelSummary[]>;
	loginModelProvider(provider: string, authType: AuthType, onUiRequest: UiRequestHandler): Promise<ModelSummary[]>;
	logoutModelProvider(provider: string): Promise<ModelSummary[]>;
	listSkills(cwd: string, onUiRequest: UiRequestHandler): Promise<{ skills: SkillSummary[]; diagnostics: JsonValue }>;
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
	resolveExternalResource(target: string, line?: number, column?: number): ProjectResource;
	readExternalResource(path: string, accessToken: string, offset: number, limit: number): ContentChunk;
	getAbout(): JsonValue;
	getDiagnostics(cwd?: string, runtimeDiagnostics?: ToolRecoveryRuntimeDiagnostics): Promise<JsonValue>;
	getGitStatus(cwd: string): Promise<GitStatus>;
	getGitDiff(cwd: string, path: string | undefined, staged: boolean): Promise<GitDiff>;
	checkForUpdates(): Promise<JsonValue>;
	listSettings(sessionPath: string): SettingSummary[];
	getSessionTree(sessionPath: string): SessionTreeNode[];
	listSubagents(sessionPath: string): SubagentSnapshot[];
	readSubagent(sessionPath: string, agentId: string): { transcript?: SubagentSnapshot };
	getProjectTrust(cwd: string): ProjectTrust;
	setProjectTrust(cwd: string, trusted: boolean): Promise<ProjectTrust>;
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
