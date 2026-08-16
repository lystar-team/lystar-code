import {
	type AuthType,
	type Command,
	type CompletionResult,
	type ContentChunk,
	createClientRequestId,
	type GitDiff,
	type GitStatus,
	type GuiClientSnapshot,
	GuiProtocolClient,
	GuiProtocolError,
	type HostDirectoryListing,
	type JsonValue,
	type ModelRef,
	type OperationSnapshot,
	type ProjectInstruction,
	type ProjectResource,
	type SessionSummary as ProtocolSessionSummary,
	type ServerEvent,
	type SessionStateSnapshot,
	type ThinkingLevel,
	type TranscriptItem,
	type TranscriptPage,
} from "@lystar/code-gui-protocol";
import { isTauri } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
	type DesktopProject,
	deleteSshPassword,
	inspectSshHostKey,
	installSshHost,
	loadDesktopState,
	probeSshConnection,
	type SshConnectionProfile,
	type SshHostKeyStatus,
	type SshProbeResult,
	saveDesktopState,
	storeSshPassword,
	trustSshHostKey,
} from "./desktop-state.ts";
import { createByteTransport } from "./transport.ts";

declare const __LYSTAR_GUI_DEFAULT_CWD__: string;

export type ThemeMode = "system" | "light" | "dark";
export type SettingsPage =
	| "general"
	| "appearance"
	| "connections"
	| "models"
	| "skills"
	| "update"
	| "diagnostics"
	| "about";
export type SettingsHostId = "all" | "local" | string;

export type ProjectSummary = DesktopProject;
export type { SshConnectionProfile, SshProbeResult };

export type SessionSummary = ProtocolSessionSummary;

export interface ControlLease {
	leaseId: string;
	leaseGeneration: number;
	sessionPath: string;
	clientInstanceId: string;
	createdAt: number;
	updatedAt: number;
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

export interface ConnectionStatus {
	connected: boolean;
	transport: "local" | "ssh";
	persistent: boolean;
	hostInstanceId: string;
	serverInstanceId: string;
	hostStartedAt: number;
	platform: string;
	arch: string;
	remoteProfilesSupported: boolean;
	remoteBlockedReason: string;
}

export interface UpdateStatus {
	status: "offline" | "available" | "current" | "unavailable";
	currentVersion: string;
	latestVersion: string | null;
	packageName?: string | null;
	note?: string | null;
	checkedAt: number;
	repository: string | null;
	installEnabled: false;
	installBlockedReason: string;
}

export interface SessionAction {
	kind: "create" | "switch" | "project";
	sessionPath?: string;
}

export interface ResourceViewer {
	resource: ProjectResource;
	text?: string;
	url?: string;
}

export interface ProjectOpenFailure {
	stage: "connect" | "sessions" | "session" | "transcript";
	message: string;
}

export interface PendingHostKeyConfirmation {
	profileId: string;
	profileName: string;
	status: SshHostKeyStatus;
}

export interface RemoteDirectoryBrowser {
	connectionId: string;
	listing?: HostDirectoryListing;
	loading: boolean;
	error?: string;
	showHidden: boolean;
}

export interface PendingExternalResource {
	target: string;
	line?: number;
	column?: number;
	matchingProjectId?: string;
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
}

export interface PendingUiRequest extends Extract<ServerEvent, { type: "ui_request" }> {}

export interface AppSnapshot {
	connected: boolean;
	connectionError?: string;
	capabilities: readonly string[];
	projects: readonly ProjectSummary[];
	projectOpenFailures: Readonly<Record<string, ProjectOpenFailure>>;
	pendingHostKey?: PendingHostKeyConfirmation;
	remoteDirectoryBrowser?: RemoteDirectoryBrowser;
	pendingExternalResource?: PendingExternalResource;
	connections: readonly SshConnectionProfile[];
	connectionProbes: Readonly<Record<string, SshProbeResult>>;
	activeConnectionId: "local" | string;
	currentProjectId?: string;
	currentCwd?: string;
	sessions: readonly SessionSummary[];
	selectedSessionPath?: string;
	selectedSession?: SessionStateSnapshot;
	lease?: ControlLease;
	transcript: readonly TranscriptItem[];
	transcriptGeneration?: string;
	previousCursor?: string;
	hasMorePrevious: boolean;
	hasMoreRecent: boolean;
	loadingEarlier: boolean;
	models: readonly ModelSummary[];
	modelProviders: readonly ModelProviderSummary[];
	skills: readonly SkillSummary[];
	skillDiagnostics: JsonValue;
	projectInstructions: readonly ProjectInstruction[];
	diagnostics?: JsonValue;
	about?: JsonValue;
	connectionStatus?: ConnectionStatus;
	updateStatus?: UpdateStatus;
	gitStatus?: GitStatus;
	gitDiff?: GitDiff;
	gitInspectorOpen: boolean;
	sidebarCollapsed: boolean;
	inspectorWidth: number;
	inspectorSplit: number;
	resourceViewer?: ResourceViewer;
	currentOperation?: OperationSnapshot;
	liveText: string;
	pendingUi: readonly PendingUiRequest[];
	statusText?: string;
	toast?: string;
	theme: ThemeMode;
	settingsPage?: SettingsPage;
	settingsHostId: SettingsHostId;
	settingsHostConnected: boolean;
	settingsHostLoading: boolean;
	settingsHostError?: string;
	settingsProjectId?: string;
	hostInstructions: readonly ProjectInstruction[];
	sessionAction?: SessionAction;
	pendingActions: readonly string[];
	modelAuthProvider?: string;
	modelAuthStatus?: string;
	busy: boolean;
}

const ACTIVE_OPERATION_STATUSES = new Set(["accepted", "running", "waiting_for_input"]);
const TRANSCRIPT_WINDOW_MAX_ITEMS = 600;
const TRANSCRIPT_WINDOW_ESTIMATED_BYTES = 8 * 1024 * 1024;
const HOST_REQUEST_TIMEOUT_MS = 20_000;
const PROJECTS_KEY = "lystar.gui.projects";
const CLIENT_ID_KEY = "lystar.gui.client-id";
const THEME_KEY = "lystar.gui.theme";
const GUI_COMMANDS: CompletionResult["items"] = [
	{ value: "/new ", label: "new", description: "新建会话", kind: "command" },
	{ value: "/settings ", label: "settings", description: "打开设置", kind: "command" },
	{ value: "/models ", label: "models", description: "打开模型与认证", kind: "command" },
	{ value: "/changes ", label: "changes", description: "打开工作区变更", kind: "command" },
];

interface HostConnection {
	connectionId: "local" | string;
	client: GuiProtocolClient;
	initial: {
		sessions: SessionStateSnapshot[];
		operations: OperationSnapshot[];
		pendingUiRequests: PendingUiRequest[];
	};
}

interface PreparedSession {
	lease?: ControlLease;
	snapshot: SessionStateSnapshot;
	page: TranscriptPage;
	readOnlyError?: unknown;
}

async function waitForClient(client: GuiProtocolClient): Promise<void> {
	if (client.getSnapshot().connected) return;
	await new Promise<void>((resolve, reject) => {
		let unsubscribe = () => {};
		const timeout = window.setTimeout(() => {
			unsubscribe();
			reject(new Error(client.getSnapshot().lastError ?? "GUI 后台服务连接超时"));
		}, 10_000);
		unsubscribe = client.subscribe(() => {
			const snapshot = client.getSnapshot();
			if (!snapshot.connected && !snapshot.lastError) return;
			window.clearTimeout(timeout);
			unsubscribe();
			if (snapshot.connected) resolve();
			else reject(new Error(snapshot.lastError ?? "GUI 后台服务连接失败"));
		});
	});
}

function requestHost<T>(client: GuiProtocolClient, request: Command, timeoutMessage: string): Promise<T> {
	return client.request<T>(request, { timeoutMs: HOST_REQUEST_TIMEOUT_MS, timeoutMessage });
}

function readJson<T>(key: string, fallback: T): T {
	try {
		const value = localStorage.getItem(key);
		return value ? (JSON.parse(value) as T) : fallback;
	} catch {
		return fallback;
	}
}

function estimateTranscriptItemBytes(item: TranscriptItem): number {
	return JSON.stringify(item).length * 2;
}

function prependTranscriptPage(
	pageItems: readonly TranscriptItem[],
	currentItems: readonly TranscriptItem[],
): { items: TranscriptItem[]; truncated: boolean } {
	const combined = [...pageItems, ...currentItems];
	const requiredItems = Math.min(pageItems.length, TRANSCRIPT_WINDOW_MAX_ITEMS);
	let estimatedBytes = 0;
	let end = 0;
	while (end < combined.length && end < TRANSCRIPT_WINDOW_MAX_ITEMS) {
		const nextBytes = estimateTranscriptItemBytes(combined[end]);
		if (end >= requiredItems && estimatedBytes + nextBytes > TRANSCRIPT_WINDOW_ESTIMATED_BYTES) break;
		estimatedBytes += nextBytes;
		end++;
	}
	return { items: combined.slice(0, end), truncated: end < combined.length };
}

function projectName(cwd: string): string {
	const normalized = cwd.replace(/[\\/]+$/, "");
	return normalized.split(/[\\/]/).at(-1) || cwd;
}

function asRecord(value: JsonValue | undefined): Record<string, JsonValue> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}

function extractAssistantText(progress: JsonValue): string | undefined {
	const event = asRecord(progress);
	if (event?.type !== "message_update") return undefined;
	const message = asRecord(event.message);
	if (message?.role !== "assistant" || !Array.isArray(message.content)) return undefined;
	return message.content
		.map((content) => asRecord(content))
		.filter((content) => content?.type === "text" && typeof content.text === "string")
		.map((content) => content?.text as string)
		.join("");
}

function themeFromStorage(): ThemeMode {
	const theme = localStorage.getItem(THEME_KEY);
	return theme === "light" || theme === "dark" ? theme : "system";
}

function userErrorMessage(error: unknown): string {
	if (error instanceof GuiProtocolError) {
		switch (error.code) {
			case "session_locked":
			case "session_control_locked":
				return "该会话正在其他进程中使用";
			case "invalid_session_lease":
				return "会话写入权限已失效，请重新打开会话";
			case "session_lock_compromised":
				return "会话写入锁已失效，为保护数据已切换为只读";
			case "operation_journal_corrupt":
				return "任务记录损坏，当前后台服务已切换为只读";
			case "transcript_cursor_invalid":
				return "会话内容已更新，请回到最新内容后重试";
			case "git_not_repository":
				return "当前项目不是 Git 仓库";
		}
	}
	return error instanceof Error ? error.message : String(error);
}

function isReadOnlySessionError(error: unknown): boolean {
	return (
		error instanceof GuiProtocolError &&
		["session_locked", "session_control_locked", "session_lock_compromised"].includes(error.code)
	);
}

async function openExternalUrl(url: string): Promise<void> {
	if (isTauri()) await openUrl(url);
	else window.open(url, "_blank", "noopener,noreferrer");
}

export class GuiAppStore {
	private client?: GuiProtocolClient;
	private clientSnapshot?: GuiClientSnapshot;
	private unsubscribeClient?: () => void;
	private unsubscribeEvents?: () => void;
	private readonly listeners = new Set<() => void>();
	private projects: ProjectSummary[] = [];
	private projectOpenFailures: Record<string, ProjectOpenFailure> = {};
	private connections: SshConnectionProfile[] = [];
	private readonly sessionCredentialIds = new Map<string, string>();
	private connectionProbes: Record<string, SshProbeResult> = {};
	private pendingHostKey?: PendingHostKeyConfirmation;
	private pendingHostKeyResolver?: { resolve(): void; reject(error: Error): void };
	private directoryConnection?: HostConnection;
	private remoteDirectoryBrowser?: RemoteDirectoryBrowser;
	private activeConnectionId: "local" | string = "local";
	private currentProjectId?: string;
	private lastProjectId?: string;
	private registryLoaded = false;
	private sessions: SessionSummary[] = [];
	private transcript: TranscriptItem[] = [];
	private models: ModelSummary[] = [];
	private modelProviders: ModelProviderSummary[] = [];
	private skills: SkillSummary[] = [];
	private projectInstructions: ProjectInstruction[] = [];
	private pendingUi: PendingUiRequest[] = [];
	private readonly pendingUiClients = new Map<string, GuiProtocolClient>();
	private lease?: ControlLease;
	private selectedSessionPath?: string;
	private selectedSession?: SessionStateSnapshot;
	private currentCwd?: string;
	private previousCursor?: string;
	private transcriptGeneration?: string;
	private hasMorePrevious = false;
	private hasMoreRecent = false;
	private browsingHistory = false;
	private loadingEarlier = false;
	private currentOperation?: OperationSnapshot;
	private liveText = "";
	private skillDiagnostics: JsonValue = [];
	private diagnostics?: JsonValue;
	private about?: JsonValue;
	private connectionStatus?: ConnectionStatus;
	private updateStatus?: UpdateStatus;
	private gitStatus?: GitStatus;
	private gitDiff?: GitDiff;
	private gitInspectorOpen = false;
	private sidebarCollapsed = false;
	private inspectorWidth = 480;
	private inspectorSplit = 0.34;
	private resourceViewer?: ResourceViewer;
	private pendingExternalResource?: PendingExternalResource;
	private statusText?: string;
	private toast?: string;
	private startupConnectionError?: string;
	private settingsPage?: SettingsPage;
	private settingsHostId: SettingsHostId = "all";
	private settingsHostLoading = false;
	private settingsHostError?: string;
	private settingsProjectId?: string;
	private hostInstructions: ProjectInstruction[] = [];
	private settingsConnection?: HostConnection;
	private settingsConnectionOwned = false;
	private unsubscribeSettingsEvents?: () => void;
	private settingsHostRequest = 0;
	private settingsHostLoad?: { hostId: SettingsHostId; page: SettingsPage; promise: Promise<void> };
	private sessionAction?: SessionAction;
	private readonly pendingActions = new Set<string>();
	private modelAuthProvider?: string;
	private modelAuthStatus?: string;
	private theme = themeFromStorage();
	private busy = false;
	private snapshot: AppSnapshot = this.buildSnapshot();
	private transcriptRequest = 0;
	private connectionPromise?: Promise<void>;
	private projectOpen?: { projectId: string; promise: Promise<void> };

	getSnapshot = (): AppSnapshot => this.snapshot;

	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};

	connect(): Promise<void> {
		this.connectionPromise ??= this.openConnection().catch((error) => {
			this.connectionPromise = undefined;
			throw error;
		});
		return this.connectionPromise;
	}

	private async openConnection(): Promise<void> {
		await this.loadRegistry();
		const defaultCwd = import.meta.env.DEV ? __LYSTAR_GUI_DEFAULT_CWD__ : "";
		if (defaultCwd && this.projects.length === 0) {
			const project = await this.addProject(defaultCwd, "local");
			await this.selectProject(project.id);
			return;
		}

		const initialProject = this.projects.find((project) => project.id === this.lastProjectId) ?? this.projects[0];
		if (initialProject) {
			try {
				await this.selectProject(initialProject.id);
				return;
			} catch {}
		}

		const localFallback = this.projects.find(
			(project) => project.connectionId === "local" && project.id !== initialProject?.id,
		);
		if (localFallback) {
			try {
				await this.selectProject(localFallback.id);
				return;
			} catch {}
		}

		try {
			const connection = await this.createHostConnection("local");
			this.activateHostConnection(connection);
			this.startupConnectionError = undefined;
			void this.loadHostMetadata();
		} catch (error) {
			this.startupConnectionError = userErrorMessage(error);
			this.publish();
		}
	}

	private async loadRegistry(): Promise<void> {
		if (this.registryLoaded) return;
		const state = await loadDesktopState();
		this.connections = state.connections;
		this.projects = state.projects;
		this.lastProjectId = state.selectedProjectId;
		this.inspectorWidth = state.layout?.inspectorWidth ?? 480;
		this.inspectorSplit = state.layout?.inspectorSplit ?? 0.34;
		this.sidebarCollapsed = state.layout?.sidebarCollapsed === true;
		if (this.projects.length === 0) {
			const legacy = readJson<Array<{ cwd: string; name: string }>>(PROJECTS_KEY, []);
			this.projects = legacy.flatMap((project) =>
				project.cwd
					? [
							{
								id: crypto.randomUUID(),
								cwd: project.cwd,
								name: project.name || projectName(project.cwd),
								connectionId: "local" as const,
							},
						]
					: [],
			);
			if (this.projects.length > 0) await this.persistRegistry();
		}
		this.registryLoaded = true;
	}

	private async persistRegistry(selectedProjectId = this.lastProjectId, projects = this.projects): Promise<void> {
		await saveDesktopState({
			version: 1,
			connections: this.connections,
			projects,
			...(selectedProjectId ? { selectedProjectId } : {}),
			layout: {
				inspectorWidth: this.inspectorWidth,
				inspectorSplit: this.inspectorSplit,
				...(this.sidebarCollapsed ? { sidebarCollapsed: true } : {}),
			},
		});
	}

	private usableSshProfile(profile: SshConnectionProfile): SshConnectionProfile {
		const credentialId =
			this.sessionCredentialIds.get(profile.id) ?? (profile.rememberPassword ? profile.credentialId : undefined);
		if ((profile.authMethod ?? "agent") === "password" && !credentialId) {
			throw new Error(`SSH 连接“${profile.name}”需要输入密码`);
		}
		return { ...profile, ...(credentialId ? { credentialId } : {}) };
	}

	private async ensureSshHostKey(profile: SshConnectionProfile): Promise<void> {
		if (!isTauri()) return;
		const status = await inspectSshHostKey(profile);
		if (status.known) return;
		if (!status.trustToken || status.fingerprints.length === 0) {
			throw new Error("远端未返回可确认的 SSH Host key 指纹");
		}
		await new Promise<void>((resolve, reject) => {
			this.pendingHostKey = { profileId: profile.id, profileName: profile.name, status };
			this.pendingHostKeyResolver = { resolve, reject };
			this.publish();
		});
	}

	async respondToHostKeyConfirmation(confirmed: boolean): Promise<void> {
		const pending = this.pendingHostKey;
		const resolver = this.pendingHostKeyResolver;
		if (!pending || !resolver) return;
		this.pendingHostKey = undefined;
		this.pendingHostKeyResolver = undefined;
		try {
			if (!confirmed || !pending.status.trustToken) throw new Error("已取消 SSH Host key 确认");
			await trustSshHostKey(pending.status.trustToken);
			resolver.resolve();
		} catch (error) {
			resolver.reject(error instanceof Error ? error : new Error(String(error)));
		} finally {
			this.publish();
		}
	}

	private async createHostConnection(connectionId: "local" | string): Promise<HostConnection> {
		const storedProfile =
			connectionId === "local" ? undefined : this.connections.find((connection) => connection.id === connectionId);
		if (connectionId !== "local" && !storedProfile) throw new Error("未找到 SSH 连接配置");
		const profile = storedProfile ? this.usableSshProfile(storedProfile) : undefined;
		if (profile) await this.ensureSshHostKey(profile);
		const transport = await createByteTransport(profile ? { kind: "ssh", profile } : { kind: "local" });
		const clientKey = `${CLIENT_ID_KEY}:${connectionId}`;
		const clientInstanceId = localStorage.getItem(clientKey) || crypto.randomUUID();
		localStorage.setItem(clientKey, clientInstanceId);
		const client = new GuiProtocolClient(transport, clientInstanceId);
		try {
			await client.connect();
			await waitForClient(client);
			const initial = await requestHost<HostConnection["initial"]>(
				client,
				{ command: "get_snapshot" },
				"GUI 后台初始化超时",
			);
			return { connectionId, client, initial };
		} catch (error) {
			await client.close().catch(() => {});
			throw error;
		}
	}

	private activateHostConnection(connection: HostConnection): void {
		this.unsubscribeClient?.();
		this.unsubscribeEvents?.();
		this.activeConnectionId = connection.connectionId;
		this.client = connection.client;
		this.clientSnapshot = connection.client.getSnapshot();
		this.pendingUi = connection.initial.pendingUiRequests;
		this.unsubscribeClient = connection.client.subscribe(() => {
			if (this.client !== connection.client) return;
			this.clientSnapshot = connection.client.getSnapshot();
			if (this.selectedSessionPath)
				this.selectedSession = this.clientSnapshot.sessions.get(this.selectedSessionPath) ?? this.selectedSession;
			this.publish();
		});
		this.unsubscribeEvents = connection.client.onEvent((event) => void this.handleEvent(event));
	}

	private async loadHostMetadata(): Promise<void> {
		const results = await Promise.allSettled([
			this.loadModelData(),
			this.loadAbout(),
			this.loadDiagnostics(),
			this.loadConnectionStatus(),
		]);
		const failed = results.find((result) => result.status === "rejected");
		if (failed?.status === "rejected") this.statusText = `部分 Host 信息加载失败：${userErrorMessage(failed.reason)}`;
		this.publish();
	}

	private async disconnectCurrentHost(detachRemoteOperation = false): Promise<void> {
		const active = this.currentOperation && ACTIVE_OPERATION_STATUSES.has(this.currentOperation.status);
		if (active && this.activeConnectionId === "local") {
			throw new Error("本机任务仍在运行，停止后再切换连接");
		}
		if (!active && !detachRemoteOperation) await this.releaseCurrentSession();
		this.unsubscribeClient?.();
		this.unsubscribeEvents?.();
		this.unsubscribeClient = undefined;
		this.unsubscribeEvents = undefined;
		const client = this.client;
		this.client = undefined;
		this.clientSnapshot = undefined;
		await client?.close();
	}

	async disconnect(): Promise<void> {
		await this.disconnectCurrentHost(this.activeConnectionId !== "local");
		this.connectionPromise = undefined;
	}

	setTheme(theme: ThemeMode): void {
		this.theme = theme;
		localStorage.setItem(THEME_KEY, theme);
		document.documentElement.dataset.theme = theme === "system" ? "" : theme;
		this.publish();
	}

	toggleSidebar(): void {
		this.sidebarCollapsed = !this.sidebarCollapsed;
		this.publish();
		void this.persistRegistry();
	}

	openSettings(page: SettingsPage = "general"): void {
		this.settingsPage = page;
		const hostScoped = ["general", "models", "skills", "diagnostics", "about"].includes(page);
		const target = hostScoped && this.settingsHostId === "all" ? this.activeConnectionId : this.settingsHostId;
		if (target !== "all") void this.selectSettingsHost(target).catch((error) => this.showError(error));
		else this.publish();
	}

	selectSettingsHost(hostId: SettingsHostId): Promise<void> {
		const page = this.settingsPage ?? "general";
		if (this.settingsHostLoad?.hostId === hostId && this.settingsHostLoad.page === page)
			return this.settingsHostLoad.promise;
		const requestId = ++this.settingsHostRequest;
		const promise = this.loadSettingsHost(hostId, page, requestId).finally(() => {
			if (this.settingsHostLoad?.promise === promise) this.settingsHostLoad = undefined;
		});
		this.settingsHostLoad = { hostId, page, promise };
		return promise;
	}

	private async loadSettingsHost(hostId: SettingsHostId, page: SettingsPage, requestId: number): Promise<void> {
		this.settingsHostId = hostId;
		this.settingsHostLoading = hostId !== "all";
		this.settingsHostError = undefined;
		this.settingsProjectId = undefined;
		if (page === "general") {
			this.hostInstructions = [];
			this.projectInstructions = [];
		}
		if (page === "models") {
			this.models = [];
			this.modelProviders = [];
		}
		if (page === "skills") {
			this.skills = [];
			this.skillDiagnostics = [];
		}
		if (page === "diagnostics") this.diagnostics = undefined;
		if (page === "about") this.about = undefined;
		this.publish();
		if (hostId === "all") {
			await this.disposeSettingsConnection();
			if (requestId === this.settingsHostRequest) {
				this.settingsHostLoading = false;
				this.publish();
			}
			return;
		}

		let connection: HostConnection | undefined;
		let newOwnedConnection = false;
		let committed = false;
		try {
			const existing =
				this.settingsConnection?.connectionId === hostId && this.settingsConnection.client.getSnapshot().connected
					? this.settingsConnection
					: undefined;
			connection =
				existing ??
				(hostId === this.activeConnectionId && this.client?.getSnapshot().connected
					? {
							connectionId: hostId,
							client: this.client,
							initial: await requestHost<HostConnection["initial"]>(
								this.client,
								{ command: "get_snapshot" },
								"读取当前 Host 状态超时",
							),
						}
					: await this.createHostConnection(hostId));
			newOwnedConnection = connection !== existing && connection.client !== this.client;
			if (requestId !== this.settingsHostRequest) {
				if (newOwnedConnection) await connection.client.close().catch(() => {});
				return;
			}
			const capabilities = connection.client.getSnapshot().hello?.capabilities ?? [];
			const project =
				this.projects.find(
					(candidate) => candidate.connectionId === hostId && candidate.id === this.currentProjectId,
				) ?? this.projects.find((candidate) => candidate.connectionId === hostId);

			const previousConnection = this.settingsConnection;
			const previousOwned = this.settingsConnectionOwned;
			if (previousConnection !== connection) {
				this.unsubscribeSettingsEvents?.();
				this.unsubscribeSettingsEvents = undefined;
				this.settingsConnection = connection;
				this.settingsConnectionOwned = connection.client !== this.client;
				if (this.settingsConnectionOwned) {
					this.unsubscribeSettingsEvents = connection.client.onEvent(
						(event) => void this.handleEvent(event, connection!.client),
					);
				}
				if (previousOwned) await previousConnection?.client.close().catch(() => {});
			}
			committed = true;
			this.settingsProjectId = project?.id;
			this.publish();

			let failure: PromiseRejectedResult | undefined;
			if (page === "general") {
				const [instructions, projectInstructions] = await Promise.allSettled([
					capabilities.includes("host-instructions")
						? requestHost<ProjectInstruction[]>(
								connection.client,
								{ command: "list_host_instructions" },
								"读取 Host AGENTS.md 超时",
							)
						: Promise.resolve([]),
					project && capabilities.includes("project-instructions")
						? requestHost<ProjectInstruction[]>(
								connection.client,
								{ command: "list_project_instructions", cwd: project.cwd },
								"读取项目 AGENTS.md 超时",
							)
						: Promise.resolve([]),
				]);
				if (requestId !== this.settingsHostRequest) return;
				if (instructions.status === "fulfilled") this.hostInstructions = instructions.value;
				if (projectInstructions.status === "fulfilled") this.projectInstructions = projectInstructions.value;
				failure = [instructions, projectInstructions].find((result) => result.status === "rejected");
			} else if (page === "models") {
				const [models, providers] = await Promise.allSettled([
					capabilities.includes("models")
						? requestHost<ModelSummary[]>(connection.client, { command: "list_models" }, "读取模型列表超时")
						: Promise.resolve([]),
					capabilities.includes("models")
						? requestHost<ModelProviderSummary[]>(
								connection.client,
								{ command: "list_model_providers" },
								"读取模型供应商超时",
							)
						: Promise.resolve([]),
				]);
				if (requestId !== this.settingsHostRequest) return;
				if (models.status === "fulfilled") this.models = models.value;
				if (providers.status === "fulfilled") this.modelProviders = providers.value;
				failure = [models, providers].find((result) => result.status === "rejected");
			} else if (page === "skills") {
				const skills = await Promise.allSettled([
					project && capabilities.includes("skills")
						? requestHost<{ skills: SkillSummary[]; diagnostics: JsonValue }>(
								connection.client,
								{ command: "list_skills", cwd: project.cwd },
								"读取技能列表超时",
							)
						: Promise.resolve({ skills: [], diagnostics: [] }),
				]);
				if (requestId !== this.settingsHostRequest) return;
				if (skills[0].status === "fulfilled") {
					this.skills = skills[0].value.skills;
					this.skillDiagnostics = skills[0].value.diagnostics;
				} else failure = skills[0];
			} else if (page === "diagnostics" && capabilities.includes("diagnostics")) {
				const diagnostics = await Promise.allSettled([
					requestHost<JsonValue>(
						connection.client,
						{ command: "get_diagnostics", ...(project ? { cwd: project.cwd } : {}) },
						"读取诊断信息超时",
					),
				]);
				if (requestId !== this.settingsHostRequest) return;
				if (diagnostics[0].status === "fulfilled") this.diagnostics = diagnostics[0].value;
				else failure = diagnostics[0];
			} else if (page === "about" && capabilities.includes("about")) {
				const about = await Promise.allSettled([
					requestHost<JsonValue>(connection.client, { command: "get_about" }, "读取版本信息超时"),
				]);
				if (requestId !== this.settingsHostRequest) return;
				if (about[0].status === "fulfilled") this.about = about[0].value;
				else failure = about[0];
			}
			if (failure?.status === "rejected") this.settingsHostError = userErrorMessage(failure.reason);
		} catch (error) {
			if (!committed && newOwnedConnection) await connection?.client.close().catch(() => {});
			if (requestId !== this.settingsHostRequest) return;
			this.settingsHostError = userErrorMessage(error);
			throw error;
		} finally {
			if (requestId === this.settingsHostRequest) {
				this.settingsHostLoading = false;
				this.publish();
			}
		}
	}

	private async disposeSettingsConnection(): Promise<void> {
		this.unsubscribeSettingsEvents?.();
		this.unsubscribeSettingsEvents = undefined;
		const connection = this.settingsConnection;
		const owned = this.settingsConnectionOwned;
		this.settingsConnection = undefined;
		this.settingsConnectionOwned = false;
		if (owned) await connection?.client.close().catch(() => {});
	}

	closeSettings(): void {
		this.settingsPage = undefined;
		this.settingsHostRequest++;
		this.settingsHostId = "all";
		this.settingsHostLoading = false;
		this.hostInstructions = [];
		this.settingsHostError = undefined;
		this.settingsProjectId = undefined;
		void this.disposeSettingsConnection();
		void Promise.allSettled([this.loadHostMetadata(), this.loadSkills(), this.loadProjectInstructions()]);
		this.publish();
	}

	async chooseProject(): Promise<void> {
		let cwd: string | null = null;
		if (isTauri()) {
			const selected = await open({ directory: true, multiple: false, title: "打开本机项目" });
			cwd = typeof selected === "string" ? selected : null;
		} else {
			cwd = window.prompt("输入项目绝对路径", this.currentCwd ?? __LYSTAR_GUI_DEFAULT_CWD__)?.trim() || null;
		}
		if (!cwd) return;
		const project = await this.addProject(cwd, "local");
		await this.selectProject(project.id);
	}

	private async prepareSession(client: GuiProtocolClient, sessionPath: string): Promise<PreparedSession> {
		if (client === this.client && this.selectedSessionPath === sessionPath && this.lease && this.selectedSession) {
			return {
				lease: this.lease,
				snapshot: this.selectedSession,
				page: await requestHost<TranscriptPage>(
					client,
					{ command: "read_transcript", sessionPath, limit: 120 },
					"读取会话内容超时",
				),
			};
		}
		try {
			const result = await requestHost<{ lease: ControlLease; snapshot: SessionStateSnapshot }>(
				client,
				{ command: "acquire_session", sessionPath, clientInstanceId: client.clientInstanceId },
				"取得会话写入权限超时",
			);
			try {
				return {
					...result,
					page: await requestHost<TranscriptPage>(
						client,
						{ command: "read_transcript", sessionPath, limit: 120 },
						"读取会话内容超时",
					),
				};
			} catch (error) {
				await requestHost<void>(
					client,
					{
						command: "release_session",
						sessionPath: result.snapshot.path,
						leaseId: result.lease.leaseId,
					},
					"释放候选会话写入权限超时",
				).catch(() => {});
				throw error;
			}
		} catch (error) {
			if (!isReadOnlySessionError(error)) throw error;
			const snapshot = await requestHost<SessionStateSnapshot>(
				client,
				{ command: "inspect_session", sessionPath },
				"读取只读会话状态超时",
			);
			return {
				snapshot,
				page: await requestHost<TranscriptPage>(
					client,
					{ command: "read_transcript", sessionPath, limit: 120 },
					"读取会话内容超时",
				),
				readOnlyError: error,
			};
		}
	}

	selectProject(projectId: string): Promise<void> {
		if (this.projectOpen) {
			if (this.projectOpen.projectId === projectId) return this.projectOpen.promise;
			return Promise.reject(new Error("另一个项目正在打开，请等待当前操作结束"));
		}
		const promise = this.openProject(projectId).finally(() => {
			if (this.projectOpen?.promise === promise) this.projectOpen = undefined;
		});
		this.projectOpen = { projectId, promise };
		return promise;
	}

	private async openProject(projectId: string): Promise<void> {
		const project = this.projects.find((candidate) => candidate.id === projectId);
		if (!project) throw new Error("未找到项目");
		if (project.id === this.currentProjectId && this.clientSnapshot?.connected && this.selectedSessionPath) return;

		const oldClient = this.client;
		const oldConnectionId = this.activeConnectionId;
		const oldSessionPath = this.selectedSessionPath;
		const oldLease = this.lease;
		const oldOperation = this.currentOperation;
		const sameHost =
			oldClient !== undefined && this.clientSnapshot?.connected === true && project.connectionId === oldConnectionId;
		const oldOperationActive = oldOperation && ACTIVE_OPERATION_STATUSES.has(oldOperation.status);
		if (oldOperationActive && (sameHost || oldConnectionId === "local")) {
			throw new Error("当前任务仍在运行，停止后再切换项目");
		}

		this.sessionAction = { kind: "project" };
		this.setBusy(true);
		let stage: ProjectOpenFailure["stage"] = "connect";
		let candidate: HostConnection | undefined;
		let prepared: PreparedSession | undefined;
		let preparedOwnsLease = false;
		try {
			candidate = sameHost
				? {
						connectionId: oldConnectionId,
						client: oldClient,
						initial: await requestHost<HostConnection["initial"]>(
							oldClient,
							{ command: "get_snapshot" },
							"读取当前 Host 状态超时",
						),
					}
				: await this.createHostConnection(project.connectionId);

			stage = "sessions";
			const sessions = await requestHost<SessionSummary[]>(
				candidate.client,
				{ command: "list_sessions", cwd: project.cwd },
				"读取项目会话列表超时",
			);
			sessions.sort((left, right) => right.updatedAt - left.updatedAt);
			const activeOperation = candidate.initial.operations.find(
				(operation) =>
					ACTIVE_OPERATION_STATUSES.has(operation.status) &&
					sessions.some((session) => session.path === operation.sessionPath),
			);
			const initialSession =
				(activeOperation && sessions.find((session) => session.path === activeOperation.sessionPath)) ??
				sessions[0];
			if (initialSession) {
				stage = "session";
				prepared = await this.prepareSession(candidate.client, initialSession.path);
				preparedOwnsLease = prepared.lease !== undefined && prepared.lease !== oldLease;
				stage = "transcript";
			}

			const switchingSession = oldSessionPath && oldSessionPath !== prepared?.snapshot.path;
			const updatedProjects = this.projects.map((candidateProject) =>
				candidateProject.id === project.id
					? { ...candidateProject, recentSessions: sessions.slice(0, 100) }
					: candidateProject,
			);
			await this.persistRegistry(project.id, updatedProjects);

			if (!sameHost) this.activateHostConnection(candidate);
			else {
				this.clientSnapshot = candidate.client.getSnapshot();
				this.pendingUi = candidate.initial.pendingUiRequests;
			}
			this.activeConnectionId = project.connectionId;
			this.currentProjectId = project.id;
			this.currentCwd = project.cwd;
			this.sessions = sessions;
			this.currentOperation = activeOperation;
			this.skills = [];
			this.skillDiagnostics = [];
			this.projectInstructions = [];
			this.gitStatus = undefined;
			this.gitDiff = undefined;
			this.gitInspectorOpen = false;
			if (prepared) {
				this.transcriptRequest++;
				this.lease = prepared.lease;
				this.selectedSessionPath = prepared.snapshot.path;
				this.selectedSession = prepared.snapshot;
				this.applyTranscriptPage(prepared.page);
			} else {
				this.resetSessionView();
			}
			this.lastProjectId = project.id;
			delete this.projectOpenFailures[project.id];
			this.projects = updatedProjects;
			this.startupConnectionError = undefined;
			this.publish();
			preparedOwnsLease = false;

			if (oldClient && oldLease && switchingSession && !oldOperationActive) {
				await requestHost<void>(
					oldClient,
					{
						command: "release_session",
						sessionPath: oldSessionPath,
						leaseId: oldLease.leaseId,
					},
					"释放旧会话写入权限超时",
				).catch((error) => {
					this.statusText = `旧会话写入权限释放失败：${userErrorMessage(error)}`;
					this.publish();
				});
			}

			if (!sameHost && oldClient) await oldClient.close().catch(() => {});
			void Promise.allSettled([this.loadSkills(), this.loadProjectInstructions(), this.loadHostMetadata()]);
			if (prepared?.readOnlyError) this.showError(prepared.readOnlyError);
		} catch (error) {
			if (preparedOwnsLease && candidate && prepared?.lease) {
				await requestHost<void>(
					candidate.client,
					{
						command: "release_session",
						sessionPath: prepared.snapshot.path,
						leaseId: prepared.lease.leaseId,
					},
					"释放候选会话写入权限超时",
				).catch(() => {});
			}
			if (candidate && !sameHost) await candidate.client.close().catch(() => {});
			this.projectOpenFailures = {
				...this.projectOpenFailures,
				[project.id]: { stage, message: userErrorMessage(error) },
			};
			this.startupConnectionError = this.currentProjectId ? undefined : userErrorMessage(error);
			this.publish();
			throw error;
		} finally {
			this.sessionAction = undefined;
			this.setBusy(false);
		}
	}

	async createSession(): Promise<void> {
		if (!this.client || !this.currentCwd) return;
		if (this.currentOperation && ACTIVE_OPERATION_STATUSES.has(this.currentOperation.status)) {
			throw new Error("当前任务仍在运行，停止后再创建会话");
		}
		this.sessionAction = { kind: "create" };
		this.setBusy(true);
		try {
			const previousSessionPath = this.selectedSessionPath;
			const previousLease = this.lease;
			const result = await this.client.request<{ lease: ControlLease; snapshot: SessionStateSnapshot }>({
				command: "create_session",
				cwd: this.currentCwd,
				clientInstanceId: this.client.clientInstanceId,
				clientRequestId: createClientRequestId(),
			});
			try {
				await this.releaseLease(previousSessionPath, previousLease);
			} catch (error) {
				await this.releaseLease(result.snapshot.path, result.lease).catch(() => {});
				throw error;
			}
			this.lease = result.lease;
			this.selectedSessionPath = result.snapshot.path;
			this.selectedSession = result.snapshot;
			this.transcript = [];
			this.previousCursor = undefined;
			this.transcriptGeneration = undefined;
			this.hasMorePrevious = false;
			this.hasMoreRecent = false;
			this.browsingHistory = false;
			this.liveText = "";
			await this.refreshSessions();
		} catch (error) {
			this.showError(error);
		} finally {
			this.sessionAction = undefined;
			this.setBusy(false);
		}
	}

	async acquireSession(sessionPath: string): Promise<void> {
		if (!this.client || (this.selectedSessionPath === sessionPath && this.lease)) return;
		const activeOperation =
			this.currentOperation && ACTIVE_OPERATION_STATUSES.has(this.currentOperation.status)
				? this.currentOperation
				: undefined;
		if (activeOperation && activeOperation.sessionPath !== sessionPath) {
			throw new Error("当前任务仍在运行，停止后再切换会话");
		}
		this.sessionAction = { kind: "switch", sessionPath };
		this.setBusy(true);
		let result: { lease: ControlLease; snapshot: SessionStateSnapshot } | undefined;
		let inspected: SessionStateSnapshot | undefined;
		try {
			const previousSessionPath = this.selectedSessionPath;
			const previousLease = this.lease;
			let acquireError: unknown;
			try {
				result = await this.client.request<{ lease: ControlLease; snapshot: SessionStateSnapshot }>({
					command: "acquire_session",
					sessionPath,
					clientInstanceId: this.client.clientInstanceId,
				});
			} catch (error) {
				if (!isReadOnlySessionError(error)) throw error;
				acquireError = error;
				inspected = await this.client.request<SessionStateSnapshot>({ command: "inspect_session", sessionPath });
			}
			const targetPath = result?.snapshot.path ?? inspected?.path ?? sessionPath;
			const page = await this.fetchTranscript(targetPath);
			try {
				await this.releaseLease(previousSessionPath, previousLease);
			} catch (error) {
				if (result) await this.releaseLease(result.snapshot.path, result.lease).catch(() => {});
				result = undefined;
				throw error;
			}
			this.transcriptRequest++;
			this.lease = result?.lease;
			this.selectedSessionPath = targetPath;
			this.selectedSession = result?.snapshot ?? inspected ?? this.clientSnapshot?.sessions.get(targetPath);
			this.currentOperation = activeOperation?.sessionPath === targetPath ? activeOperation : undefined;
			this.applyTranscriptPage(page);
			this.publish();
			if (acquireError) this.showError(acquireError);
			result = undefined;
		} catch (error) {
			if (result) await this.releaseLease(result.snapshot.path, result.lease).catch(() => {});
			throw error;
		} finally {
			this.sessionAction = undefined;
			this.setBusy(false);
		}
	}

	async loadEarlier(): Promise<void> {
		if (!this.client || !this.selectedSessionPath || !this.previousCursor || this.loadingEarlier) return;
		const sessionPath = this.selectedSessionPath;
		const cursor = this.previousCursor;
		this.loadingEarlier = true;
		this.publish();
		try {
			const page = await this.client.request<TranscriptPage>({
				command: "read_transcript",
				sessionPath,
				cursor,
				limit: 120,
			});
			if (this.selectedSessionPath !== sessionPath || this.previousCursor !== cursor) return;
			const bounded = prependTranscriptPage(page.items, this.transcript);
			this.transcriptGeneration ??= page.transcriptGeneration;
			this.browsingHistory = true;
			this.hasMoreRecent ||= bounded.truncated;
			this.transcript = bounded.items;
			this.previousCursor = page.previousCursor;
			this.hasMorePrevious = page.hasMorePrevious;
		} finally {
			this.loadingEarlier = false;
			this.publish();
		}
	}

	async jumpToLatest(): Promise<void> {
		await this.refreshTranscript();
	}

	async submit(text: string, images?: Array<{ data: string; mimeType: string }>): Promise<void> {
		const value = text.trim();
		if (!value) return;
		if (value === "/new") return this.createSession();
		if (value === "/settings") {
			this.openSettings();
			return;
		}
		if (value === "/models") {
			this.openSettings("models");
			return;
		}
		if (value === "/changes") {
			await this.openGitInspector();
			return;
		}
		if (!this.client || !this.selectedSessionPath || !this.lease) return;
		const commandText = value.startsWith("!") ? value.slice(1).trim() : undefined;
		if (commandText !== undefined && !commandText) return;
		if (commandText !== undefined && images?.length) throw new Error("Bash 命令不能包含图片附件");
		const clientRequestId = createClientRequestId();
		const result =
			commandText !== undefined
				? await this.client.request<{ operation: OperationSnapshot }>({
						command: "run_bash",
						sessionPath: this.selectedSessionPath,
						leaseId: this.lease.leaseId,
						clientInstanceId: this.client.clientInstanceId,
						clientRequestId,
						commandText,
					})
				: await this.client.request<{ operation: OperationSnapshot }>({
						command: "prompt",
						sessionPath: this.selectedSessionPath,
						leaseId: this.lease.leaseId,
						clientInstanceId: this.client.clientInstanceId,
						clientRequestId,
						text: value,
						images,
					});
		this.currentOperation = result.operation;
		this.sessions = this.sessions.map((session) =>
			session.path === result.operation.sessionPath
				? { ...session, activity: "running", operationUpdatedAt: result.operation.updatedAt }
				: session,
		);
		this.liveText = "";
		if (this.browsingHistory) this.hasMoreRecent = true;
		this.publish();
	}

	async abort(): Promise<void> {
		if (!this.client || !this.currentOperation || !this.lease) return;
		await this.client.request({
			command: "abort_operation",
			operationId: this.currentOperation.operationId,
			leaseId: this.lease.leaseId,
		});
	}

	async renameSession(name: string): Promise<void> {
		if (!this.client || !this.selectedSession || !this.lease) return;
		this.selectedSession = await this.client.request<SessionStateSnapshot>({
			command: "rename_session",
			sessionPath: this.selectedSession.path,
			leaseId: this.lease.leaseId,
			name: name.trim(),
			clientInstanceId: this.client.clientInstanceId,
			clientRequestId: createClientRequestId(),
		});
		await this.refreshSessions();
		this.publish();
	}

	async deleteSession(sessionPath: string): Promise<void> {
		if (!this.client) return;
		if (this.selectedSessionPath === sessionPath) await this.releaseCurrentSession();
		await this.client.request({
			command: "delete_session",
			cwd: this.currentCwd ?? this.selectedSession?.cwd ?? ".",
			sessionPath,
			clientInstanceId: this.client.clientInstanceId,
			clientRequestId: createClientRequestId(),
		});
		await this.refreshSessions();
		if (this.sessions[0]) await this.acquireSession(this.sessions[0].path);
		this.publish();
	}

	async forkSession(entryId: string): Promise<void> {
		if (!this.client || !this.selectedSession || !this.lease) return;
		const result = await this.client.request<{
			lease: ControlLease;
			snapshot: SessionStateSnapshot;
			selectedText?: string;
		}>({
			command: "fork_session",
			sessionPath: this.selectedSession.path,
			leaseId: this.lease.leaseId,
			entryId,
			clientInstanceId: this.client.clientInstanceId,
			clientRequestId: createClientRequestId(),
		});
		this.lease = result.lease;
		this.selectedSessionPath = result.snapshot.path;
		this.selectedSession = result.snapshot;
		await Promise.all([this.refreshTranscript(), this.refreshSessions()]);
	}

	async setModel(model: ModelRef): Promise<void> {
		if (!this.client || !this.selectedSession || !this.lease) return;
		this.selectedSession = await this.client.request<SessionStateSnapshot>({
			command: "set_session_model",
			sessionPath: this.selectedSession.path,
			leaseId: this.lease.leaseId,
			model,
			clientInstanceId: this.client.clientInstanceId,
			clientRequestId: createClientRequestId(),
		});
		this.publish();
	}

	async setThinkingLevel(level: ThinkingLevel): Promise<void> {
		if (!this.client || !this.selectedSession || !this.lease) return;
		this.selectedSession = await this.client.request<SessionStateSnapshot>({
			command: "set_session_thinking",
			sessionPath: this.selectedSession.path,
			leaseId: this.lease.leaseId,
			level,
			clientInstanceId: this.client.clientInstanceId,
			clientRequestId: createClientRequestId(),
		});
		this.publish();
	}

	private settingsRuntime(): { client?: GuiProtocolClient; cwd?: string } {
		if (
			this.settingsPage &&
			this.settingsConnection?.connectionId === this.settingsHostId &&
			this.settingsHostId !== "all"
		) {
			const project = this.projects.find((candidate) => candidate.id === this.settingsProjectId);
			return { client: this.settingsConnection.client, cwd: project?.cwd };
		}
		return { client: this.client, cwd: this.currentCwd };
	}

	private clientHasCapability(client: GuiProtocolClient | undefined, capability: string): boolean {
		return client?.getSnapshot().hello?.capabilities.includes(capability as never) === true;
	}

	async toggleSkill(skill: SkillSummary): Promise<void> {
		const { client, cwd } = this.settingsRuntime();
		if (!client || !cwd || skill.scope === "temporary") return;
		const scope = skill.scope;
		await this.withAction(`skill:${skill.path}`, async () => {
			const result = await client.request<{ skills: SkillSummary[]; diagnostics: JsonValue }>({
				command: "set_skill_enabled",
				cwd,
				path: skill.path,
				scope,
				enabled: !skill.enabled,
				clientInstanceId: client.clientInstanceId,
				clientRequestId: createClientRequestId(),
			});
			this.skills = result.skills;
			this.skillDiagnostics = result.diagnostics;
		});
	}

	async refreshSkills(): Promise<void> {
		const { client, cwd } = this.settingsRuntime();
		if (!this.settingsPage || !client || !cwd || !this.clientHasCapability(client, "skills")) {
			await this.loadSkills();
			return;
		}
		const result = await requestHost<{ skills: SkillSummary[]; diagnostics: JsonValue }>(
			client,
			{ command: "list_skills", cwd },
			"重新加载技能超时",
		);
		this.skills = result.skills;
		this.skillDiagnostics = result.diagnostics;
		this.publish();
	}

	async refreshModels(): Promise<void> {
		const { client } = this.settingsRuntime();
		if (!this.settingsPage || !client || !this.clientHasCapability(client, "models")) {
			await this.loadModelData();
			return;
		}
		[this.models, this.modelProviders] = await Promise.all([
			requestHost<ModelSummary[]>(client, { command: "list_models" }, "重新加载模型超时"),
			requestHost<ModelProviderSummary[]>(client, { command: "list_model_providers" }, "重新加载模型供应商超时"),
		]);
		this.publish();
	}

	async addModelProvider(provider: ModelProviderInput, model: ProviderModelInput): Promise<void> {
		const { client } = this.settingsRuntime();
		if (!client || !this.clientHasCapability(client, "models-auth")) return;
		await this.withAction("models", async () => {
			this.modelProviders = await client.request<ModelProviderSummary[]>({
				command: "add_model_provider",
				...provider,
				clientInstanceId: client.clientInstanceId,
				clientRequestId: createClientRequestId(),
			});
			this.models = await client.request<ModelSummary[]>({
				command: "add_provider_model",
				...model,
				clientInstanceId: client.clientInstanceId,
				clientRequestId: createClientRequestId(),
			});
		});
		await this.loginModelProvider(provider.provider, "api_key");
	}

	async addProviderModel(model: ProviderModelInput): Promise<void> {
		const { client } = this.settingsRuntime();
		if (!client || !this.clientHasCapability(client, "models")) return;
		this.models = await this.withAction("models", () =>
			client.request<ModelSummary[]>({
				command: "add_provider_model",
				...model,
				clientInstanceId: client.clientInstanceId,
				clientRequestId: createClientRequestId(),
			}),
		);
		this.publish();
	}

	async loginModelProvider(provider: string, authType: AuthType): Promise<void> {
		const { client } = this.settingsRuntime();
		if (!client || !this.clientHasCapability(client, "models-auth")) return;
		this.modelAuthProvider = provider;
		this.modelAuthStatus = authType === "oauth" ? "正在打开认证页面" : "等待输入认证信息";
		this.publish();
		try {
			this.models = await this.withAction(`model-auth:${provider}`, () =>
				client.request<ModelSummary[]>({
					command: "login_model_provider",
					provider,
					authType,
					clientInstanceId: client.clientInstanceId,
					clientRequestId: createClientRequestId(),
				}),
			);
			this.modelProviders = await client.request<ModelProviderSummary[]>({ command: "list_model_providers" });
			this.modelAuthStatus = "认证已完成";
		} finally {
			this.modelAuthProvider = undefined;
			this.publish();
		}
	}

	async logoutModelProvider(provider: string): Promise<void> {
		const { client } = this.settingsRuntime();
		if (!client || !this.clientHasCapability(client, "models-auth")) return;
		this.modelAuthProvider = provider;
		this.modelAuthStatus = "正在移除已保存的认证";
		this.publish();
		try {
			this.models = await this.withAction(`model-auth:${provider}`, () =>
				client.request<ModelSummary[]>({
					command: "logout_model_provider",
					provider,
					clientInstanceId: client.clientInstanceId,
					clientRequestId: createClientRequestId(),
				}),
			);
			this.modelProviders = await client.request<ModelProviderSummary[]>({ command: "list_model_providers" });
			this.modelAuthStatus = "已移除保存的认证";
		} finally {
			this.modelAuthProvider = undefined;
			this.publish();
		}
	}

	async refreshConnectionStatus(): Promise<void> {
		await this.loadConnectionStatus();
	}

	async refreshDiagnostics(): Promise<void> {
		const { client, cwd } = this.settingsRuntime();
		if (client && this.clientHasCapability(client, "diagnostics")) {
			this.diagnostics = await client.request<JsonValue>({ command: "get_diagnostics", ...(cwd ? { cwd } : {}) });
			this.publish();
		} else await this.loadDiagnostics();
	}

	async openGitInspector(): Promise<void> {
		if (!this.hasCapability("git-inspector")) return;
		this.gitInspectorOpen = true;
		this.publish();
		await this.refreshGitStatus();
	}

	closeGitInspector(): void {
		this.gitInspectorOpen = false;
		this.publish();
	}

	async refreshGitStatus(): Promise<void> {
		if (!this.client || !this.currentCwd || !this.hasCapability("git-inspector")) return;
		this.gitStatus = await this.withAction("git-status", () =>
			this.client!.request<GitStatus>({ command: "get_git_status", cwd: this.currentCwd! }),
		);
		if (this.gitDiff?.path && !this.gitStatus.files.some((file) => file.path === this.gitDiff?.path)) {
			this.gitDiff = undefined;
		}
		this.publish();
	}

	async loadGitDiff(path: string, staged: boolean): Promise<void> {
		if (!this.client || !this.currentCwd || !this.hasCapability("git-inspector")) return;
		this.gitDiff = await this.withAction("git-diff", () =>
			this.client!.request<GitDiff>({ command: "get_git_diff", cwd: this.currentCwd!, path, staged }),
		);
		this.publish();
	}

	async checkForUpdates(): Promise<void> {
		if (!this.client || !this.hasCapability("updates")) return;
		this.updateStatus = await this.withAction("updates", () =>
			this.client!.request<UpdateStatus>({ command: "check_for_updates" }),
		);
		this.publish();
	}

	async getCompletions(text: string, cursor: number): Promise<CompletionResult> {
		const empty: CompletionResult = { prefixStart: cursor, prefixEnd: cursor, items: [] };
		let result = empty;
		if (this.client && this.currentCwd && this.hasCapability("completion")) {
			result = await this.client.request<CompletionResult>({
				command: "get_completions",
				cwd: this.currentCwd,
				sessionPath: this.selectedSessionPath,
				text,
				cursor,
			});
		}
		if (!text.slice(0, cursor).startsWith("/")) return result;
		const query = text.slice(1, cursor).toLowerCase();
		const local = GUI_COMMANDS.filter((item) =>
			`${item.label} ${item.description ?? ""}`.toLowerCase().includes(query),
		);
		const seen = new Set<string>();
		return {
			prefixStart: 0,
			prefixEnd: cursor,
			items: [...local, ...(result.prefixStart === 0 ? result.items : [])].filter((item) => {
				if (seen.has(item.value)) return false;
				seen.add(item.value);
				return true;
			}),
		};
	}

	async refreshProjectInstructions(): Promise<void> {
		const { client, cwd } = this.settingsRuntime();
		if (this.settingsPage && client && cwd && this.clientHasCapability(client, "project-instructions")) {
			this.projectInstructions = await requestHost<ProjectInstruction[]>(
				client,
				{ command: "list_project_instructions", cwd },
				"重新加载项目 AGENTS.md 超时",
			);
			this.publish();
			return;
		}
		await this.loadProjectInstructions();
	}

	async selectSettingsProject(projectId: string): Promise<void> {
		const project = this.projects.find(
			(candidate) => candidate.id === projectId && candidate.connectionId === this.settingsHostId,
		);
		if (!project || !this.settingsConnection) return;
		this.settingsProjectId = project.id;
		if (this.clientHasCapability(this.settingsConnection.client, "project-instructions")) {
			this.projectInstructions = await requestHost<ProjectInstruction[]>(
				this.settingsConnection.client,
				{ command: "list_project_instructions", cwd: project.cwd },
				"读取项目 AGENTS.md 超时",
			);
		}
		this.publish();
	}

	async refreshHostInstructions(): Promise<void> {
		const client = this.settingsConnection?.client;
		if (!client || !this.clientHasCapability(client, "host-instructions")) return;
		this.hostInstructions = await requestHost<ProjectInstruction[]>(
			client,
			{ command: "list_host_instructions" },
			"重新加载 Host AGENTS.md 超时",
		);
		this.publish();
	}

	async saveHostInstruction(
		fileName: "AGENTS.md" | "AGENTS.override.md",
		content: string,
		expectedHash?: string,
	): Promise<void> {
		const client = this.settingsConnection?.client;
		if (!client || !this.clientHasCapability(client, "host-instructions")) return;
		try {
			this.hostInstructions = await client.request<ProjectInstruction[]>({
				command: "save_host_instruction",
				fileName,
				content,
				expectedHash,
				clientInstanceId: client.clientInstanceId,
				clientRequestId: createClientRequestId(),
			});
			this.toast = `${fileName} 已保存到当前 Host`;
		} catch (error) {
			if (error instanceof GuiProtocolError && error.code === "instruction_conflict") {
				await this.refreshHostInstructions();
			}
			throw error;
		} finally {
			this.publish();
		}
	}

	async saveProjectInstruction(
		fileName: "AGENTS.md" | "AGENTS.override.md",
		content: string,
		expectedHash?: string,
	): Promise<void> {
		const { client, cwd } = this.settingsRuntime();
		if (!client || !cwd || !this.clientHasCapability(client, "project-instructions")) return;
		try {
			this.projectInstructions = await client.request<ProjectInstruction[]>({
				command: "save_project_instruction",
				cwd,
				fileName,
				content,
				expectedHash,
				clientInstanceId: client.clientInstanceId,
				clientRequestId: createClientRequestId(),
			});
			this.toast = `${fileName} 已保存并重新加载`;
		} catch (error) {
			if (error instanceof GuiProtocolError && error.code === "instruction_conflict") {
				await this.refreshProjectInstructions();
			}
			throw error;
		} finally {
			this.publish();
		}
	}

	setInspectorLayout(width: number, split: number): void {
		this.inspectorWidth = Math.min(900, Math.max(320, Math.round(width)));
		this.inspectorSplit = Math.min(0.8, Math.max(0.2, split));
		this.publish();
	}

	async persistInspectorLayout(): Promise<void> {
		await this.persistRegistry();
	}

	async resetInspectorLayout(): Promise<void> {
		this.setInspectorLayout(480, 0.34);
		await this.persistRegistry();
	}

	async openResource(target: string, line?: number, column?: number): Promise<void> {
		if (/^(?:https?:|mailto:)/i.test(target)) {
			await openExternalUrl(target);
			return;
		}
		if (!this.client || !this.currentCwd || !this.hasCapability("project-resources")) {
			throw new Error("当前后台不支持打开项目文件");
		}
		try {
			const resource = await this.client.request<ProjectResource>({
				command: "resolve_project_resource",
				cwd: this.currentCwd,
				target,
				line,
				column,
			});
			await this.showResource(resource);
		} catch (error) {
			if (!(error instanceof GuiProtocolError) || error.code !== "resource_outside_project") throw error;
			const normalized = target.replaceAll("\\", "/");
			const matchingProject = this.projects.find(
				(project) =>
					project.connectionId === this.activeConnectionId &&
					(normalized === project.cwd.replaceAll("\\", "/") ||
						normalized.startsWith(`${project.cwd.replaceAll("\\", "/").replace(/\/$/, "")}/`)),
			);
			this.pendingExternalResource = {
				target,
				...(line ? { line } : {}),
				...(column ? { column } : {}),
				...(matchingProject ? { matchingProjectId: matchingProject.id } : {}),
			};
			this.publish();
		}
	}

	async resolveExternalResource(action: "view" | "switch" | "cancel"): Promise<void> {
		const pending = this.pendingExternalResource;
		this.pendingExternalResource = undefined;
		this.publish();
		if (!pending || action === "cancel") return;
		if (action === "switch") {
			if (!pending.matchingProjectId) return;
			await this.selectProject(pending.matchingProjectId);
			await this.openResource(pending.target, pending.line, pending.column);
			return;
		}
		if (!this.client || !this.hasCapability("external-resources")) {
			throw new Error("当前后台不支持一次性查看项目外文件");
		}
		const resource = await this.client.request<ProjectResource>({
			command: "resolve_external_resource",
			target: pending.target,
			line: pending.line,
			column: pending.column,
		});
		await this.showResource(resource);
	}

	private async showResource(resource: ProjectResource): Promise<void> {
		const bytes = await this.readResourceBytes(resource);
		if (resource.kind === "image") {
			const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
			const url = URL.createObjectURL(new Blob([buffer], { type: resource.mimeType }));
			this.resourceViewer = { resource, url };
		} else {
			this.resourceViewer = { resource, text: new TextDecoder().decode(bytes) };
		}
		this.publish();
	}

	closeResource(): void {
		if (this.resourceViewer?.url) URL.revokeObjectURL(this.resourceViewer.url);
		this.resourceViewer = undefined;
		this.publish();
	}

	async readContentBytes(sessionPath: string, contentRef: string): Promise<Uint8Array> {
		if (!this.client) throw new Error("GUI 后台服务尚未连接");
		const parts: Uint8Array[] = [];
		let offset = 0;
		let total = 0;
		while (true) {
			const chunk = await this.client.request<ContentChunk>({
				command: "read_content",
				sessionPath,
				contentRef,
				offset,
				limit: 1024 * 1024,
			});
			if (chunk.nextOffset <= offset && !chunk.done) throw new Error("后台服务返回了无效的大内容分块");
			const binary = atob(chunk.data);
			const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
			parts.push(bytes);
			total += bytes.byteLength;
			offset = chunk.nextOffset;
			if (chunk.done) {
				const result = new Uint8Array(total);
				let position = 0;
				for (const part of parts) {
					result.set(part, position);
					position += part.byteLength;
				}
				return result;
			}
		}
	}

	private async readResourceBytes(resource: ProjectResource): Promise<Uint8Array> {
		if (!this.client || (!resource.accessToken && !this.currentCwd)) throw new Error("GUI 后台服务尚未连接");
		const parts: Uint8Array[] = [];
		let offset = 0;
		let total = 0;
		while (true) {
			const chunk = resource.accessToken
				? await this.client.request<ContentChunk>({
						command: "read_external_resource",
						path: resource.path,
						accessToken: resource.accessToken,
						offset,
						limit: 1024 * 1024,
					})
				: await this.client.request<ContentChunk>({
						command: "read_project_resource",
						cwd: this.currentCwd!,
						path: resource.path,
						offset,
						limit: 1024 * 1024,
					});
			if (chunk.nextOffset <= offset && !chunk.done) throw new Error("后台服务返回了无效的文件分块");
			const bytes = Uint8Array.from(atob(chunk.data), (character) => character.charCodeAt(0));
			parts.push(bytes);
			total += bytes.byteLength;
			offset = chunk.nextOffset;
			if (chunk.done) {
				const result = new Uint8Array(total);
				let position = 0;
				for (const part of parts) {
					result.set(part, position);
					position += part.byteLength;
				}
				return result;
			}
		}
	}

	async readContent(sessionPath: string, contentRef: string): Promise<string> {
		return new TextDecoder().decode(await this.readContentBytes(sessionPath, contentRef));
	}

	async respondToUi(
		request: PendingUiRequest,
		response: { value?: JsonValue; confirmed?: boolean; cancelled?: boolean },
	): Promise<void> {
		await (this.pendingUiClients.get(request.id) ?? this.client)?.respondToUi(request.id, response);
		this.pendingUiClients.delete(request.id);
		this.pendingUi = this.pendingUi.filter((candidate) => candidate.id !== request.id);
		this.publish();
	}

	async saveSshConnection(input: Omit<SshConnectionProfile, "id"> & { id?: string }): Promise<SshConnectionProfile> {
		const existing = input.id ? this.connections.find((connection) => connection.id === input.id) : undefined;
		const connection: SshConnectionProfile = {
			id: input.id ?? crypto.randomUUID(),
			name: input.name.trim(),
			target: input.target.trim(),
			mode: input.mode ?? "alias",
			...(input.user?.trim() ? { user: input.user.trim() } : {}),
			...(input.port ? { port: input.port } : {}),
			authMethod: input.authMethod ?? "agent",
			...(input.identityFile?.trim() ? { identityFile: input.identityFile.trim() } : {}),
			...((input.authMethod ?? "agent") === "password" && existing?.credentialId
				? { credentialId: existing.credentialId, ...(existing.rememberPassword ? { rememberPassword: true } : {}) }
				: {}),
			platform: input.platform ?? "auto",
			...(input.defaultCwd?.trim() ? { defaultCwd: input.defaultCwd.trim() } : {}),
			...(input.hostCommand?.trim() ? { hostCommand: input.hostCommand.trim() } : {}),
		};
		if (!connection.name || !connection.target) throw new Error("连接名称和 SSH 主机不能为空");
		if (
			connection.port !== undefined &&
			(!Number.isInteger(connection.port) || connection.port < 1 || connection.port > 65535)
		) {
			throw new Error("SSH 端口必须在 1 到 65535 之间");
		}
		if (connection.authMethod === "key" && !connection.identityFile) throw new Error("密钥认证需要选择私钥文件");
		const duplicate = this.connections.find(
			(candidate) =>
				candidate.target === connection.target &&
				(candidate.user ?? "") === (connection.user ?? "") &&
				(candidate.port ?? 22) === (connection.port ?? 22) &&
				candidate.id !== connection.id,
		);
		if (duplicate) throw new Error(`SSH 目标已由“${duplicate.name}”使用`);
		if (existing?.credentialId && connection.authMethod !== "password") {
			await deleteSshPassword(existing.credentialId).catch(() => {});
			this.sessionCredentialIds.delete(connection.id);
		}
		this.connections = [connection, ...this.connections.filter((candidate) => candidate.id !== connection.id)];
		await this.persistRegistry();
		this.publish();
		return connection;
	}

	async setSshPassword(connectionId: string, password: string, remember: boolean): Promise<void> {
		const connection = this.connections.find((candidate) => candidate.id === connectionId);
		if (!connection) throw new Error("未找到 SSH 连接配置");
		const previousCredentialId = connection.credentialId;
		const credentialId = await storeSshPassword(connectionId, password, remember);
		if (previousCredentialId && previousCredentialId !== credentialId) {
			await deleteSshPassword(previousCredentialId).catch(() => {});
		}
		if (remember) {
			this.sessionCredentialIds.delete(connectionId);
			this.connections = this.connections.map((candidate) =>
				candidate.id === connectionId
					? { ...candidate, credentialId, rememberPassword: true, authMethod: "password" }
					: candidate,
			);
			await this.persistRegistry();
		} else {
			this.sessionCredentialIds.set(connectionId, credentialId);
			this.connections = this.connections.map((candidate) =>
				candidate.id === connectionId
					? { ...candidate, authMethod: "password", credentialId: undefined, rememberPassword: undefined }
					: candidate,
			);
		}
		this.publish();
	}

	async removeSshConnection(connectionId: string): Promise<void> {
		if (this.activeConnectionId === connectionId) throw new Error("当前正在使用该 SSH 连接");
		if (this.projects.some((project) => project.connectionId === connectionId)) {
			throw new Error("该 SSH 连接仍有关联项目，请先移除这些项目");
		}
		const connection = this.connections.find((candidate) => candidate.id === connectionId);
		const credentialId = this.sessionCredentialIds.get(connectionId) ?? connection?.credentialId;
		if (credentialId) await deleteSshPassword(credentialId).catch(() => {});
		this.sessionCredentialIds.delete(connectionId);
		this.connections = this.connections.filter((candidate) => candidate.id !== connectionId);
		delete this.connectionProbes[connectionId];
		await this.persistRegistry();
		this.publish();
	}

	async probeSshProfile(connectionId: string): Promise<SshProbeResult> {
		const storedProfile = this.connections.find((connection) => connection.id === connectionId);
		if (!storedProfile) throw new Error("未找到 SSH 连接配置");
		const profile = this.usableSshProfile(storedProfile);
		await this.ensureSshHostKey(profile);
		const result = await this.withAction(`ssh-probe:${connectionId}`, () => probeSshConnection(profile));
		this.connectionProbes = { ...this.connectionProbes, [connectionId]: result };
		if (result.platform === "linux" || result.platform === "darwin" || result.platform === "windows") {
			this.connections = this.connections.map((connection) =>
				connection.id === connectionId && connection.platform === "auto"
					? { ...connection, platform: result.platform as "linux" | "darwin" | "windows" }
					: connection,
			);
			await this.persistRegistry();
		}
		this.publish();
		return result;
	}

	async installSshProfile(connectionId: string, sourcePath?: string): Promise<SshProbeResult> {
		const storedProfile = this.connections.find((connection) => connection.id === connectionId);
		if (!storedProfile) throw new Error("未找到 SSH 连接配置");
		const profile = this.usableSshProfile(storedProfile);
		await this.ensureSshHostKey(profile);
		const result = await this.withAction(`ssh-install:${connectionId}`, () => installSshHost(profile, sourcePath));
		this.connectionProbes = { ...this.connectionProbes, [connectionId]: result };
		this.publish();
		return result;
	}

	async chooseAndInstallSshProfile(connectionId: string): Promise<void> {
		if (!isTauri()) throw new Error("远端后台安装只在桌面应用中可用");
		const selected = await open({
			directory: false,
			multiple: false,
			title: "选择与远端系统匹配的 LYStar GUI Host",
		});
		if (typeof selected === "string") await this.installSshProfile(connectionId, selected);
	}

	async openRemoteDirectoryBrowser(connectionId: string, path?: string): Promise<void> {
		await this.closeRemoteDirectoryBrowser();
		this.remoteDirectoryBrowser = { connectionId, loading: true, showHidden: false };
		this.publish();
		try {
			const connection = await this.createHostConnection(connectionId);
			const listing = await connection.client.request<HostDirectoryListing>({
				command: "list_directories",
				...(path ? { path } : {}),
			});
			this.directoryConnection = connection;
			this.remoteDirectoryBrowser = { connectionId, listing, loading: false, showHidden: false };
		} catch (error) {
			this.remoteDirectoryBrowser = {
				connectionId,
				loading: false,
				showHidden: false,
				error: userErrorMessage(error),
			};
		}
		this.publish();
	}

	async navigateRemoteDirectory(path: string): Promise<void> {
		if (!this.directoryConnection || !this.remoteDirectoryBrowser) return;
		this.remoteDirectoryBrowser = { ...this.remoteDirectoryBrowser, loading: true, error: undefined };
		this.publish();
		try {
			const listing = await this.directoryConnection.client.request<HostDirectoryListing>({
				command: "list_directories",
				path,
			});
			this.remoteDirectoryBrowser = { ...this.remoteDirectoryBrowser, listing, loading: false };
		} catch (error) {
			this.remoteDirectoryBrowser = {
				...this.remoteDirectoryBrowser,
				loading: false,
				error: userErrorMessage(error),
			};
		}
		this.publish();
	}

	toggleRemoteHiddenDirectories(): void {
		if (!this.remoteDirectoryBrowser) return;
		this.remoteDirectoryBrowser = {
			...this.remoteDirectoryBrowser,
			showHidden: !this.remoteDirectoryBrowser.showHidden,
		};
		this.publish();
	}

	async closeRemoteDirectoryBrowser(): Promise<void> {
		const connection = this.directoryConnection;
		this.directoryConnection = undefined;
		this.remoteDirectoryBrowser = undefined;
		this.publish();
		await connection?.client.close().catch(() => {});
	}

	async addRemoteProject(connectionId: string, cwd: string, name?: string): Promise<void> {
		if (!this.connections.some((connection) => connection.id === connectionId))
			throw new Error("未找到 SSH 连接配置");
		await this.closeRemoteDirectoryBrowser();
		const project = await this.addProject(cwd.trim(), connectionId, name?.trim());
		await this.selectProject(project.id);
	}

	async updateProject(
		projectId: string,
		update: Pick<ProjectSummary, "name" | "pinned" | "color" | "archived">,
	): Promise<void> {
		const project = this.projects.find((candidate) => candidate.id === projectId);
		if (!project) throw new Error("未找到项目");
		if (update.archived && projectId === this.currentProjectId) throw new Error("当前项目不能归档，请先切换项目");
		const name = update.name.trim();
		if (!name) throw new Error("项目名称不能为空");
		this.projects = this.projects.map((candidate) =>
			candidate.id === projectId
				? {
						...candidate,
						name,
						pinned: update.pinned || undefined,
						color: update.color,
						archived: update.archived || undefined,
					}
				: candidate,
		);
		await this.persistRegistry();
		this.publish();
	}

	async removeProject(projectId: string): Promise<void> {
		if (projectId === this.currentProjectId) throw new Error("当前项目不能直接移除，请先切换到其他项目");
		this.projects = this.projects.filter((project) => project.id !== projectId);
		if (this.lastProjectId === projectId) this.lastProjectId = this.projects[0]?.id;
		await this.persistRegistry();
		this.publish();
	}

	clearToast(): void {
		this.toast = undefined;
		this.publish();
	}

	private async addProject(cwd: string, connectionId: "local" | string, name?: string): Promise<ProjectSummary> {
		if (!cwd) throw new Error("项目路径不能为空");
		const existing = this.projects.find((project) => project.connectionId === connectionId && project.cwd === cwd);
		const project: ProjectSummary = {
			id: existing?.id ?? crypto.randomUUID(),
			cwd,
			name: name || existing?.name || projectName(cwd),
			connectionId,
			...(existing?.pinned ? { pinned: true } : {}),
			...(existing?.color ? { color: existing.color } : {}),
			...(existing?.archived ? { archived: true } : {}),
			...(existing?.recentSessions ? { recentSessions: existing.recentSessions } : {}),
		};
		this.projects = [project, ...this.projects.filter((candidate) => candidate.id !== project.id)];
		await this.persistRegistry();
		this.publish();
		return project;
	}

	private resetSessionView(): void {
		this.transcriptRequest++;
		this.lease = undefined;
		this.selectedSessionPath = undefined;
		this.selectedSession = undefined;
		this.transcript = [];
		this.previousCursor = undefined;
		this.transcriptGeneration = undefined;
		this.hasMorePrevious = false;
		this.hasMoreRecent = false;
		this.browsingHistory = false;
		this.liveText = "";
	}

	private async refreshSessions(): Promise<void> {
		if (!this.client || !this.currentCwd) return;
		this.sessions = await this.client.request<SessionSummary[]>({ command: "list_sessions", cwd: this.currentCwd });
		this.sessions.sort((left, right) => right.updatedAt - left.updatedAt);
		if (this.currentProjectId) {
			this.projects = this.projects.map((project) =>
				project.id === this.currentProjectId
					? { ...project, recentSessions: this.sessions.slice(0, 100) }
					: project,
			);
			await this.persistRegistry();
		}
		this.publish();
	}

	private async refreshTranscript(): Promise<void> {
		if (!this.selectedSessionPath) return;
		await this.readTranscript(this.selectedSessionPath);
	}

	private async readTranscript(sessionPath: string): Promise<void> {
		const request = ++this.transcriptRequest;
		const page = await this.fetchTranscript(sessionPath);
		if (request !== this.transcriptRequest || this.selectedSessionPath !== sessionPath) return;
		this.applyTranscriptPage(page);
		this.publish();
	}

	private async fetchTranscript(sessionPath: string): Promise<TranscriptPage> {
		if (!this.client) throw new Error("GUI 后台服务尚未连接");
		return this.client.request<TranscriptPage>({
			command: "read_transcript",
			sessionPath,
			limit: 120,
		});
	}

	private applyTranscriptPage(page: TranscriptPage): void {
		this.transcript = page.items;
		this.previousCursor = page.previousCursor;
		this.transcriptGeneration = page.transcriptGeneration;
		this.hasMorePrevious = page.hasMorePrevious;
		this.hasMoreRecent = false;
		this.browsingHistory = false;
		this.liveText = "";
	}

	private async releaseLease(sessionPath?: string, lease?: ControlLease): Promise<void> {
		if (!this.client || !sessionPath || !lease) return;
		await this.client.request({ command: "release_session", sessionPath, leaseId: lease.leaseId });
	}

	private async releaseCurrentSession(): Promise<void> {
		const sessionPath = this.selectedSessionPath;
		if (!this.client || !sessionPath || !this.lease) {
			this.resetSessionView();
			return;
		}
		if (this.currentOperation && ACTIVE_OPERATION_STATUSES.has(this.currentOperation.status)) {
			throw new Error("当前任务仍在运行，停止后再切换会话");
		}
		await this.releaseLease(sessionPath, this.lease);
		this.resetSessionView();
	}

	private async loadModelData(): Promise<void> {
		await Promise.all([this.loadModels(), this.loadModelProviders()]);
	}

	private async loadModels(): Promise<void> {
		if (!this.client || !this.hasCapability("models")) return;
		this.models = await this.withAction("models", () =>
			this.client!.request<ModelSummary[]>({ command: "list_models" }),
		);
		this.publish();
	}

	private async loadModelProviders(): Promise<void> {
		if (!this.client || !this.hasCapability("models")) return;
		this.modelProviders = await this.withAction("model-providers", () =>
			this.client!.request<ModelProviderSummary[]>({ command: "list_model_providers" }),
		);
		this.publish();
	}

	private async loadSkills(): Promise<void> {
		if (!this.client || !this.currentCwd || !this.hasCapability("skills")) return;
		const result = await this.withAction("skills", () =>
			this.client!.request<{ skills: SkillSummary[]; diagnostics: JsonValue }>({
				command: "list_skills",
				cwd: this.currentCwd!,
			}),
		);
		this.skills = result.skills;
		this.skillDiagnostics = result.diagnostics;
		this.publish();
	}

	private async loadProjectInstructions(): Promise<void> {
		if (!this.client || !this.currentCwd || !this.hasCapability("project-instructions")) {
			this.projectInstructions = [];
			this.publish();
			return;
		}
		this.projectInstructions = await this.withAction("project-instructions", () =>
			this.client!.request<ProjectInstruction[]>({
				command: "list_project_instructions",
				cwd: this.currentCwd!,
			}),
		);
		this.publish();
	}

	private async loadAbout(): Promise<void> {
		if (!this.client) return;
		this.about = await this.withAction("about", () => this.client!.request<JsonValue>({ command: "get_about" }));
		this.publish();
	}

	private async loadDiagnostics(): Promise<void> {
		if (!this.client || !this.hasCapability("diagnostics")) return;
		this.diagnostics = await this.withAction("diagnostics", () =>
			this.client!.request<JsonValue>({
				command: "get_diagnostics",
				cwd: this.currentCwd,
			}),
		);
		this.publish();
	}

	private async loadConnectionStatus(): Promise<void> {
		if (!this.client || !this.hasCapability("connections")) return;
		const status = await this.withAction("connections", () =>
			this.client!.request<ConnectionStatus>({ command: "get_connection_status" }),
		);
		this.connectionStatus = {
			...status,
			transport: this.activeConnectionId === "local" ? "local" : "ssh",
			remoteProfilesSupported: isTauri(),
			remoteBlockedReason: isTauri() ? "" : "SSH 连接只在桌面应用中可用。",
		};
		this.publish();
	}

	private async handleEvent(event: ServerEvent, sourceClient = this.client): Promise<void> {
		if (event.type === "sessions_changed" && event.cwd === this.currentCwd) {
			await this.refreshSessions();
			if (this.selectedSessionPath && !this.lease) {
				const summary = this.sessions.find((session) => session.path === this.selectedSessionPath);
				if (summary?.writeAccess === "available" && !this.sessionAction) {
					await this.acquireSession(this.selectedSessionPath);
				} else if (this.client) {
					this.selectedSession = await this.client.request<SessionStateSnapshot>({
						command: "inspect_session",
						sessionPath: this.selectedSessionPath,
					});
				}
			}
		}
		if (event.type === "transcript_changed" && event.sessionPath === this.selectedSessionPath) {
			if (this.browsingHistory) this.hasMoreRecent = true;
			else await this.refreshTranscript();
		}
		if (event.type === "session_snapshot" && event.snapshot.path === this.selectedSessionPath) {
			this.selectedSession = event.snapshot;
		}
		if (event.type === "session_removed") {
			if (event.sessionPath === this.selectedSessionPath) {
				this.selectedSessionPath = undefined;
				this.selectedSession = undefined;
				this.lease = undefined;
				this.transcript = [];
				this.previousCursor = undefined;
				this.transcriptGeneration = undefined;
				this.hasMorePrevious = false;
				this.hasMoreRecent = false;
				this.browsingHistory = false;
			}
			await this.refreshSessions();
		}
		if (event.type === "operation_updated") {
			const activity = event.operation.status === "accepted" ? "running" : event.operation.status;
			this.sessions = this.sessions.map((session) =>
				session.path === event.operation.sessionPath
					? { ...session, activity, operationUpdatedAt: event.operation.updatedAt }
					: session,
			);
		}
		if (event.type === "operation_updated" && event.operation.sessionPath === this.selectedSessionPath) {
			this.currentOperation = event.operation;
			if (!ACTIVE_OPERATION_STATUSES.has(event.operation.status)) {
				this.statusText = event.operation.status === "completed" ? "已完成" : event.operation.error;
				this.liveText = "";
				if (this.browsingHistory) this.hasMoreRecent = true;
				else await this.refreshTranscript();
				if (this.gitInspectorOpen) await this.refreshGitStatus().catch(() => {});
			}
		}
		if (event.type === "transcript_committed" && event.sessionPath === this.selectedSessionPath) {
			if (event.transcriptGeneration !== this.transcriptGeneration) await this.refreshTranscript();
			else if (this.browsingHistory) this.hasMoreRecent = true;
			else await this.refreshTranscript();
		}
		if (
			event.type === "session_progress" &&
			event.sessionPath === this.selectedSessionPath &&
			!this.browsingHistory
		) {
			const liveText = extractAssistantText(event.progress);
			if (liveText !== undefined) this.liveText = liveText;
		}
		if (event.type === "ui_request") {
			const payload = asRecord(event.payload);
			if (event.kind === "notify") {
				if (payload?.method === "setStatus")
					this.statusText = typeof payload.text === "string" ? payload.text : undefined;
				else if (payload?.method === "setTitle" && typeof payload.title === "string")
					document.title = payload.title;
				else if (payload?.method === "notify") this.toast = event.title;
				else if (payload?.method === "auth_progress" && typeof payload.message === "string")
					this.modelAuthStatus = payload.message;
				else if (payload?.method === "auth_info" && typeof payload.message === "string")
					this.modelAuthStatus = payload.message;
				else if (payload?.method === "auth_auth_url" && typeof payload.url === "string") {
					this.modelAuthStatus =
						typeof payload.instructions === "string" ? payload.instructions : "请在浏览器完成认证";
					await openExternalUrl(payload.url);
				} else if (
					payload?.method === "auth_device_code" &&
					typeof payload.verificationUri === "string" &&
					typeof payload.userCode === "string"
				) {
					this.modelAuthStatus = `设备码：${payload.userCode}`;
					await openExternalUrl(payload.verificationUri);
				}
				await sourceClient?.respondToUi(event.id, { confirmed: true });
			} else {
				if (sourceClient) this.pendingUiClients.set(event.id, sourceClient);
				this.pendingUi = [...this.pendingUi.filter((candidate) => candidate.id !== event.id), event];
			}
		}
		this.publish();
	}

	private async withAction<T>(key: string, action: () => Promise<T>): Promise<T> {
		this.pendingActions.add(key);
		this.publish();
		try {
			return await action();
		} finally {
			this.pendingActions.delete(key);
			this.publish();
		}
	}

	private hasCapability(capability: string): boolean {
		return this.clientSnapshot?.hello?.capabilities.includes(capability as never) === true;
	}

	showError(error: unknown): void {
		this.toast = userErrorMessage(error);
		this.publish();
	}

	private setBusy(busy: boolean): void {
		this.busy = busy;
		this.publish();
	}

	private buildSnapshot(): AppSnapshot {
		return {
			connected: this.clientSnapshot?.connected ?? false,
			connectionError: this.clientSnapshot?.lastError ?? this.startupConnectionError,
			capabilities: this.clientSnapshot?.hello?.capabilities ?? [],
			projects: this.projects,
			projectOpenFailures: this.projectOpenFailures,
			pendingHostKey: this.pendingHostKey,
			remoteDirectoryBrowser: this.remoteDirectoryBrowser,
			pendingExternalResource: this.pendingExternalResource,
			connections: this.connections,
			connectionProbes: this.connectionProbes,
			activeConnectionId: this.activeConnectionId,
			currentProjectId: this.currentProjectId,
			currentCwd: this.currentCwd,
			sessions: this.sessions,
			selectedSessionPath: this.selectedSessionPath,
			selectedSession: this.selectedSession,
			lease: this.lease,
			transcript: this.transcript,
			transcriptGeneration: this.transcriptGeneration,
			previousCursor: this.previousCursor,
			hasMorePrevious: this.hasMorePrevious,
			hasMoreRecent: this.hasMoreRecent,
			loadingEarlier: this.loadingEarlier,
			models: this.models,
			modelProviders: this.modelProviders,
			skills: this.skills,
			skillDiagnostics: this.skillDiagnostics,
			projectInstructions: this.projectInstructions,
			diagnostics: this.diagnostics,
			about: this.about,
			connectionStatus: this.connectionStatus,
			updateStatus: this.updateStatus,
			gitStatus: this.gitStatus,
			gitDiff: this.gitDiff,
			gitInspectorOpen: this.gitInspectorOpen,
			sidebarCollapsed: this.sidebarCollapsed,
			inspectorWidth: this.inspectorWidth,
			inspectorSplit: this.inspectorSplit,
			resourceViewer: this.resourceViewer,
			currentOperation: this.currentOperation,
			liveText: this.liveText,
			pendingUi: this.pendingUi,
			statusText: this.statusText,
			toast: this.toast,
			theme: this.theme,
			settingsPage: this.settingsPage,
			settingsHostId: this.settingsHostId,
			settingsHostConnected:
				this.settingsConnection?.connectionId === this.settingsHostId &&
				this.settingsConnection.client.getSnapshot().connected,
			settingsHostLoading: this.settingsHostLoading,
			settingsHostError: this.settingsHostError,
			settingsProjectId: this.settingsProjectId,
			hostInstructions: this.hostInstructions,
			sessionAction: this.sessionAction,
			pendingActions: [...this.pendingActions],
			modelAuthProvider: this.modelAuthProvider,
			modelAuthStatus: this.modelAuthStatus,
			busy: this.busy,
		};
	}

	private publish(): void {
		this.snapshot = this.buildSnapshot();
		for (const listener of this.listeners) listener();
	}
}

export const guiStore = new GuiAppStore();
