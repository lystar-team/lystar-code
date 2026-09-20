import type { GitStatus, SessionProgress } from "@lystar/code-web-protocol";
import { webApi } from "../adapters/host-protocol/api.ts";
import type {
	ProjectTreeResponse,
	SystemPermissionsResponse,
	WebOperation,
	WebProject,
	WebSessionSnapshot,
	WebSessionSummary,
	WebTranscriptItem,
} from "../types.ts";
import { hasActiveSessionSnapshot } from "./chat-lifecycle.ts";
import type { ThemeMode, WorkbenchState } from "./workbench-types.ts";

export function browserNetworkOnline(): boolean {
	return typeof navigator === "undefined" || navigator.onLine !== false;
}

export function gitFileStatsKey(repositoryPath: string, path: string): string {
	return `${repositoryPath}\0${path}`;
}

export type SessionDetailCache = Pick<
	WorkbenchState,
	| "session"
	| "transcript"
	| "agentSteps"
	| "transcriptPageLoaded"
	| "transcriptGeneration"
	| "transcriptRevision"
	| "transcriptLeafId"
	| "previousCursor"
	| "toolActivityEpoch"
	| "toolActivityRevision"
	| "hasMorePrevious"
	| "loadingEarlier"
	| "liveTools"
	| "liveSteps"
	| "liveTurnItems"
	| "liveTurnId"
	| "liveTurnStartRevision"
	| "liveTurnActive"
	| "liveCompaction"
	| "pendingUserPrompts"
	| "promptSendTimes"
	| "queuedUserPrompts"
	| "statusText"
>;

export function sessionDetailCacheFromState(state: WorkbenchState): SessionDetailCache {
	return {
		session: state.session,
		transcript: state.transcript,
		agentSteps: state.agentSteps,
		transcriptPageLoaded: state.transcriptPageLoaded,
		transcriptGeneration: state.transcriptGeneration,
		transcriptRevision: state.transcriptRevision,
		transcriptLeafId: state.transcriptLeafId,
		previousCursor: state.previousCursor,
		toolActivityEpoch: state.toolActivityEpoch,
		toolActivityRevision: state.toolActivityRevision,
		hasMorePrevious: state.hasMorePrevious,
		loadingEarlier: state.loadingEarlier,
		liveTools: state.liveTools,
		liveSteps: state.liveSteps,
		liveTurnItems: state.liveTurnItems,
		liveTurnId: state.liveTurnId,
		liveTurnStartRevision: state.liveTurnStartRevision,
		liveTurnActive: state.liveTurnActive,
		liveCompaction: state.liveCompaction,
		pendingUserPrompts: state.pendingUserPrompts,
		promptSendTimes: state.promptSendTimes,
		queuedUserPrompts: state.queuedUserPrompts,
		statusText: state.statusText,
	};
}

export const SESSION_DETAIL_CACHE_LIMIT = 8;
export const SESSION_DETAIL_CACHE_BYTES_LIMIT = 24 * 1024 * 1024;

export type CachedSessionDetail = {
	detail: SessionDetailCache;
	bytes: number;
};

export function approximateValueBytes(value: unknown, seen = new WeakSet<object>(), depth = 0): number {
	if (typeof value === "string") return value.length * 2;
	if (typeof value === "number" || typeof value === "bigint") return 8;
	if (typeof value === "boolean") return 4;
	if (!value || typeof value !== "object") return 0;
	if (seen.has(value) || depth > 12) return 0;
	seen.add(value);
	if (Array.isArray(value)) {
		return 24 + value.reduce((total, item) => total + approximateValueBytes(item, seen, depth + 1), 0);
	}
	let bytes = 48;
	for (const [key, item] of Object.entries(value)) {
		bytes += key.length * 2 + approximateValueBytes(item, seen, depth + 1);
	}
	return bytes;
}

export function cacheSessionDetail(
	cache: Map<string, CachedSessionDetail>,
	sessionId: string,
	detail: SessionDetailCache,
): void {
	cache.delete(sessionId);
	const entry = { detail, bytes: approximateValueBytes(detail) };
	cache.set(sessionId, entry);
	let totalBytes = [...cache.values()].reduce((total, current) => total + current.bytes, 0);
	while (cache.size > SESSION_DETAIL_CACHE_LIMIT || totalBytes > SESSION_DETAIL_CACHE_BYTES_LIMIT) {
		const oldest = cache.keys().next().value;
		if (oldest === undefined) break;
		const removed = cache.get(oldest);
		cache.delete(oldest);
		totalBytes -= removed?.bytes ?? 0;
	}
}

export function readCachedSessionDetail(
	cache: Map<string, CachedSessionDetail>,
	sessionId: string,
): SessionDetailCache | undefined {
	const entry = cache.get(sessionId);
	if (!entry) return undefined;
	cache.delete(sessionId);
	cache.set(sessionId, entry);
	return entry.detail;
}

export const THEME_KEY = "lystar.web.theme";
export const MODEL_PROVIDER_VISIBILITY_KEY = "lystar.web.model-provider-visibility.v2";
export const ACTIVE_OPERATION_STATUSES = new Set(["accepted", "running", "waiting_for_input"]);
export const TERMINAL_OPERATION_STATUSES = new Set(["completed", "failed", "aborted", "interrupted"]);

export function savedTheme(): ThemeMode {
	if (typeof window === "undefined") return "system";
	const value = window.localStorage.getItem(THEME_KEY);
	return value === "light" || value === "dark" ? value : "system";
}

type ModelProviderVisibilityOverrides = Record<string, boolean>;
type ModelProviderVisibilityProvider = Pick<WorkbenchState["providers"][number], "id" | "authenticated">;

export function savedModelProviderVisibilityOverrides(): ModelProviderVisibilityOverrides {
	if (typeof window === "undefined") return {};
	try {
		const value: unknown = JSON.parse(window.localStorage.getItem(MODEL_PROVIDER_VISIBILITY_KEY) ?? "{}");
		if (Array.isArray(value)) {
			const overrides: ModelProviderVisibilityOverrides = {};
			for (const providerId of value) {
				if (typeof providerId === "string") overrides[providerId] = false;
			}
			return overrides;
		}
		if (!value || typeof value !== "object") return {};
		const overrides: ModelProviderVisibilityOverrides = {};
		for (const [providerId, visible] of Object.entries(value)) {
			if (typeof visible === "boolean") overrides[providerId] = visible;
		}
		return overrides;
	} catch {
		return {};
	}
}

export function savedHiddenModelProviders(): string[] {
	return Object.entries(savedModelProviderVisibilityOverrides())
		.filter(([, visible]) => !visible)
		.map(([providerId]) => providerId);
}

export function resolveHiddenModelProviders(
	providers: readonly ModelProviderVisibilityProvider[],
	overrides: Readonly<ModelProviderVisibilityOverrides>,
): string[] {
	return providers
		.filter(({ id, authenticated }) => overrides[id] === false || (overrides[id] === undefined && !authenticated))
		.map(({ id }) => id);
}

export function applyTheme(theme: ThemeMode): void {
	if (typeof document === "undefined") return;
	document.documentElement.dataset.theme = theme === "system" ? "" : theme;
	window.localStorage.setItem(THEME_KEY, theme);
}

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export const GIT_KEYCHAIN_AUTHORIZATION_MARKER = "LYSTAR_GIT_KEYCHAIN_AUTHORIZATION_REQUIRED";
export const GIT_KEYCHAIN_AUTHORIZATION_MESSAGE =
	"Git 需要访问这台 Mac 的登录钥匙串，本次后台操作已停止。请在运行 LYStar Code Web 的 Mac 本机终端执行 lc web permissions setup，在终端隐藏输入一次登录钥匙串密码完成批量授权，完成后回到 Web 重试。";

export function gitCredentialAuthorizationMessageFromSystemPermissions(
	permissions: SystemPermissionsResponse,
): string | undefined {
	if (!permissions.supported) return undefined;
	const keychain = permissions.permissions.find((permission) => permission.id === "keychain");
	if (keychain?.state !== "required") return undefined;
	return keychain.message || GIT_KEYCHAIN_AUTHORIZATION_MESSAGE;
}

export function gitCredentialAuthorizationMessage(value: unknown): string | undefined {
	const candidate = value && typeof value === "object" ? (value as { code?: unknown; message?: unknown }) : undefined;
	const code = typeof candidate?.code === "string" ? candidate.code : undefined;
	const message =
		typeof candidate?.message === "string"
			? candidate.message
			: typeof value === "string"
				? value
				: value instanceof Error
					? value.message
					: "";
	if (
		code !== "git_credentials_required" &&
		!message.includes(GIT_KEYCHAIN_AUTHORIZATION_MARKER) &&
		!(/Git|git/u.test(message) && /钥匙串|keychain/iu.test(message) && message.includes("lc web permissions setup"))
	)
		return undefined;
	return code === "git_credentials_required" && message.trim() ? message.trim() : GIT_KEYCHAIN_AUTHORIZATION_MESSAGE;
}

export function hasMeaningfulSessionFirstMessage(value: string): boolean {
	const normalized = value.trim();
	return normalized.length > 0 && normalized !== "未命名会话";
}

export function sessionTitle(session: WebSessionSummary | WebSessionSnapshot | undefined): string {
	if (!session) return "未命名会话";
	return (
		("name" in session && session.name?.trim()) ||
		("firstMessage" in session && session.firstMessage.trim()) ||
		"未命名会话"
	);
}

export function eventIsObject(value: unknown): value is Record<string, unknown> {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function operationForSession(operations: WebOperation[], sessionId: string | undefined): WebOperation | undefined {
	if (!sessionId) return undefined;
	let latest: WebOperation | undefined;
	for (const operation of operations) {
		if (operation.sessionId !== sessionId || !ACTIVE_OPERATION_STATUSES.has(operation.status)) continue;
		if (!latest || operation.updatedAt > latest.updatedAt) latest = operation;
	}
	return latest;
}

export function operationForSessionSnapshot(
	operations: WebOperation[],
	snapshot: WebSessionSnapshot | undefined,
): WebOperation | undefined {
	return snapshot && hasActiveSessionSnapshot(snapshot) ? operationForSession(operations, snapshot.id) : undefined;
}

export function mergeSessionSummaries(
	current: readonly WebSessionSummary[],
	incoming: readonly WebSessionSummary[],
): WebSessionSummary[] {
	const currentById = new Map(current.map((session) => [session.id, session]));
	return incoming.map((next) => {
		const previous = currentById.get(next.id);
		const preservedName = !Object.hasOwn(next, "name") && previous?.name?.trim() ? { name: previous.name } : {};
		const preservedFirstMessage =
			previous &&
			hasMeaningfulSessionFirstMessage(previous.firstMessage) &&
			!hasMeaningfulSessionFirstMessage(next.firstMessage)
				? { firstMessage: previous.firstMessage }
				: {};
		return { ...next, ...preservedName, ...preservedFirstMessage };
	});
}

export function updateSessionSummaryName(projects: WebProject[], sessionId: string, name: string | undefined): WebProject[] {
	const normalizedName = name?.trim();
	for (let projectIndex = 0; projectIndex < projects.length; projectIndex++) {
		const project = projects[projectIndex];
		const sessionIndex = project.sessions.findIndex((session) => session.id === sessionId);
		if (sessionIndex < 0) continue;
		const session = project.sessions[sessionIndex];
		const currentName = session.name?.trim();
		if (currentName === normalizedName && (normalizedName !== undefined || !Object.hasOwn(session, "name"))) {
			return projects;
		}
		const { name: _name, ...withoutName } = session;
		const nextSession = normalizedName ? { ...withoutName, name: normalizedName } : withoutName;
		const sessions = [...project.sessions];
		sessions[sessionIndex] = nextSession;
		const next = [...projects];
		next[projectIndex] = { ...project, sessions };
		return next;
	}
	return projects;
}

export function updateSessionSummaryFirstMessage(
	projects: WebProject[],
	sessionId: string,
	firstMessage: string,
): WebProject[] {
	const normalizedMessage = firstMessage.trim();
	if (!normalizedMessage) return projects;
	for (let projectIndex = 0; projectIndex < projects.length; projectIndex++) {
		const project = projects[projectIndex];
		const sessionIndex = project.sessions.findIndex((session) => session.id === sessionId);
		if (sessionIndex < 0) continue;
		const session = project.sessions[sessionIndex];
		if (hasMeaningfulSessionFirstMessage(session.firstMessage)) return projects;
		const sessions = [...project.sessions];
		sessions[sessionIndex] = {
			...session,
			firstMessage: normalizedMessage,
			messageCount: Math.max(session.messageCount, 1),
		};
		const next = [...projects];
		next[projectIndex] = { ...project, sessions };
		return next;
	}
	return projects;
}

export function mergeProjectSessions(current: readonly WebProject[], incoming: readonly WebProject[]): WebProject[] {
	const currentById = new Map(current.map((project) => [project.id, project]));
	return incoming.map((project) => {
		const previous = currentById.get(project.id);
		return previous ? { ...project, sessions: mergeSessionSummaries(previous.sessions, project.sessions) } : project;
	});
}

export function updateSessionActivity(
	projects: WebProject[],
	sessionId: string,
	activity: WebSessionSummary["activity"],
	operationUpdatedAt?: number,
): WebProject[] {
	for (let projectIndex = 0; projectIndex < projects.length; projectIndex++) {
		const project = projects[projectIndex];
		const sessionIndex = project.sessions.findIndex((session) => session.id === sessionId);
		if (sessionIndex < 0) continue;
		const session = project.sessions[sessionIndex];
		if (
			session.activity === activity &&
			(operationUpdatedAt === undefined || session.operationUpdatedAt === operationUpdatedAt)
		) {
			return projects;
		}
		const sessions = [...project.sessions];
		sessions[sessionIndex] = {
			...session,
			activity,
			...(operationUpdatedAt === undefined ? {} : { operationUpdatedAt }),
		};
		const next = [...projects];
		next[projectIndex] = { ...project, sessions };
		return next;
	}
	return projects;
}

export function sessionActivityFromProgress(progress: SessionProgress): "running" | "waiting_for_input" | "idle" | undefined {
	switch (progress.type) {
		case "phase":
			return progress.phase === "waiting_for_input"
				? "waiting_for_input"
				: progress.phase === "idle"
					? "idle"
					: "running";
		case "compaction":
			return progress.status === "running" || progress.status === "waiting_retry" ? "running" : undefined;
		case "retry":
			return progress.status === "running" || progress.status === "waiting" ? "running" : undefined;
		case "assistant_delta":
		case "thinking_delta":
		case "agent_step":
		case "tool_start":
		case "tool_update":
		case "tool_end":
		case "user_message":
		case "bash":
			return "running";
		case "tool_state":
			return progress.activity.state === "success" ||
				progress.activity.state === "error" ||
				progress.activity.state === "cancelled" ||
				progress.activity.state === "interrupted"
				? undefined
				: "running";
		case "queue_update":
		case "status":
		case "usage":
			return undefined;
	}
}

export function gitCredentialAuthorizationMessageFromProgress(progress: SessionProgress): string | undefined {
	if (progress.type === "tool_state" && progress.activity.state === "error") {
		return gitCredentialAuthorizationMessage(progress.activity.error);
	}
	if (progress.type === "tool_end" && progress.status === "error") {
		return gitCredentialAuthorizationMessage(progress.summary);
	}
	return undefined;
}

export function transcriptText(item: WebTranscriptItem): string {
	return item.view && "text" in item.view ? item.view.text : "";
}

export function changedFilePaths(progress: SessionProgress): string[] {
	if (progress.type === "tool_end" && progress.status === "success") {
		return progress.diff?.files.flatMap((file) => (file.path ? [file.path] : [])) ?? [];
	}
	if (progress.type === "tool_state" && progress.activity.state === "success") {
		return progress.activity.diff?.files.flatMap((file) => (file.path ? [file.path] : [])) ?? [];
	}
	return [];
}

export function normalizedProjectFilePath(projectPath: string, input: string): string | undefined {
	const normalizedRoot = projectPath.replaceAll("\\", "/").replace(/\/$/u, "");
	let normalized = input.replaceAll("\\", "/").replace(/^\.\//u, "");
	if (normalized === normalizedRoot) return undefined;
	if (normalized.startsWith(`${normalizedRoot}/`)) normalized = normalized.slice(normalizedRoot.length + 1);
	if (!normalized || normalized.startsWith("../") || normalized.includes("/../")) return undefined;
	return normalized;
}

export function parentProjectPath(path: string): string {
	const separator = path.lastIndexOf("/");
	return separator < 0 ? "" : path.slice(0, separator);
}

export function sameGitStatus(left: GitStatus | undefined, right: GitStatus): boolean {
	return left !== undefined && JSON.stringify(left) === JSON.stringify(right);
}

export function sameProjectTree(left: ProjectTreeResponse | undefined, right: ProjectTreeResponse): boolean {
	return left !== undefined && JSON.stringify(left) === JSON.stringify(right);
}

export function hasLiveTurnContent(state: Pick<WorkbenchState, "liveTools" | "liveSteps" | "liveTurnItems">): boolean {
	return Boolean(Object.keys(state.liveTools).length || Object.keys(state.liveSteps).length || state.liveTurnItems.length);
}

export function shouldClearLiveTurn(state: WorkbenchState): boolean {
	return state.liveTurnActive === false && hasLiveTurnContent(state);
}

export function shouldRefreshCompletedTurn(state: WorkbenchState): boolean {
	return !state.transcriptPageLoaded || Boolean(state.liveTurnItems.length);
}

export function projectInspectorStateForSelection(
	currentProjectId: string | undefined,
	nextProjectId: string | undefined,
): Partial<
	Pick<
		WorkbenchState,
		| "fileTree"
		| "fileTreeRootPath"
		| "fileTreeCache"
		| "fileTreeLoading"
		| "gitStatus"
		| "gitBranches"
		| "gitHistory"
		| "gitCommit"
		| "gitFileStats"
		| "gitDiff"
		| "gitLoading"
		| "gitBranchesLoading"
		| "gitHistoryLoading"
		| "gitCommitLoading"
		| "gitDiffLoading"
		| "gitOperation"
		| "filePath"
		| "fileContent"
		| "fileError"
		| "fileLoading"
	>
> {
	if (!nextProjectId || currentProjectId === nextProjectId) return {};
	return {
		fileTree: undefined,
		fileTreeRootPath: undefined,
		fileTreeCache: {},
		fileTreeLoading: false,
		gitStatus: undefined,
		gitBranches: undefined,
		gitHistory: undefined,
		gitCommit: undefined,
		gitFileStats: {},
		gitDiff: undefined,
		gitLoading: false,
		gitBranchesLoading: false,
		gitHistoryLoading: false,
		gitCommitLoading: false,
		gitDiffLoading: false,
		gitOperation: undefined,
		fileContent: undefined,
		fileError: undefined,
		fileLoading: false,
	};
}

export function initialState(): WorkbenchState {
	return {
		loading: false,
		networkOnline: browserNetworkOnline(),
		connected: false,
		reconnecting: false,
		connectionError: "",
		authRequired: !webApi.hasToken(),
		projects: [],
		projectGroups: [],
		sessionError: undefined,
		transcript: [],
		agentSteps: {},
		transcriptPageLoaded: false,
		transcriptLoading: false,
		transcriptError: undefined,
		transcriptGeneration: undefined,
		transcriptRevision: undefined,
		transcriptLeafId: undefined,
		hasMorePrevious: false,
		loadingEarlier: false,
		readOnly: false,
		sessionReady: false,
		pendingUserPrompts: [],
		promptSendTimes: {},
		queuedUserPrompts: [],
		operations: [],
		liveTools: {},
		liveSteps: {},
		liveTurnItems: [],
		liveCompaction: undefined,
		liveTurnId: 0,
		unreadSessionIds: {},
		gitFileStats: {},
		statusText: "",
		pendingUiRequests: [],
		inspectorOpen: typeof window !== "undefined" && window.matchMedia("(min-width: 1280px)").matches,
		inspectorMode: "files",
		gitLoading: false,
		gitBranchesLoading: false,
		gitHistoryLoading: false,
		gitCommitLoading: false,
		gitDiffLoading: false,
		gitCredentialAuthorizationMessage: undefined,
		fileTreeLoading: false,
		fileTreeRootPath: undefined,
		fileTreeCache: {},
		fileError: undefined,
		fileLoading: false,
		sessionTree: [],
		sessionTreeLoading: false,
		directoryLoading: false,
		settingsOpen: false,
		settingsTab: "appearance",
		branding: { name: "LYStar Code" },
		brandingSaving: false,
		brandingError: undefined,
		securitySettings: undefined,
		securitySettingsLoading: false,
		securitySettingsSaving: false,
		securitySettingsError: undefined,
		skills: [],
		skillDiagnostics: undefined,
		skillsLoading: false,
		hostInstructions: [],
		hostInstructionsLoading: false,
		hostInstructionSaving: false,
		harnessImportsLoading: false,
		harnessImporting: false,
		subagentConfigs: [],
		subagentConfigsLoading: false,
		subagentConfigsSaving: false,
		subagents: [],
		subagentsLoading: false,
		subagentViews: {},
		modelOptions: [],
		modelOptionProviders: [],
		modelCatalogRevision: 0,
		models: [],
		providers: [],
		hiddenModelProviders: savedHiddenModelProviders(),
		modelSettingsLoading: false,
		theme: savedTheme(),
		composerMode: "prompt",
	};
}
