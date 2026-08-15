import type { SessionActivity, SessionStateSnapshot } from "@lystar/code-gui-protocol";
import { invoke, isTauri } from "@tauri-apps/api/core";

const BROWSER_STATE_KEY = "lystar.gui.desktop-state";

export interface SshConnectionProfile {
	id: string;
	name: string;
	target: string;
	mode?: "alias" | "direct";
	user?: string;
	port?: number;
	authMethod?: "agent" | "key" | "password";
	identityFile?: string;
	credentialId?: string;
	rememberPassword?: boolean;
	platform?: "auto" | "linux" | "darwin" | "windows";
	defaultCwd?: string;
	hostCommand?: string;
}

export interface CachedSessionSummary {
	path: string;
	id: string;
	cwd: string;
	name?: string;
	createdAt: number;
	updatedAt: number;
	messageCount: number;
	firstMessage: string;
	activity: SessionActivity;
	writeAccess: SessionStateSnapshot["writeAccess"];
	operationUpdatedAt?: number;
}

export interface DesktopLayout {
	inspectorWidth: number;
	inspectorSplit: number;
	sidebarCollapsed?: boolean;
}

export interface DesktopProject {
	id: string;
	name: string;
	cwd: string;
	connectionId: "local" | string;
	pinned?: boolean;
	color?: "red" | "orange" | "green" | "blue" | "purple" | "gray";
	archived?: boolean;
	recentSessions?: CachedSessionSummary[];
}

export interface DesktopState {
	version: 1;
	connections: SshConnectionProfile[];
	projects: DesktopProject[];
	selectedProjectId?: string;
	layout?: DesktopLayout;
}

export interface SshProbeResult {
	target: string;
	connected: boolean;
	platform?: string;
	arch?: string;
	hostInstalled: boolean;
	hostStatus?: Record<string, unknown>;
	message?: string;
}

export interface SshHostKeyStatus {
	host: string;
	port: number;
	known: boolean;
	fingerprints: string[];
	trustToken?: string;
}

function string(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeConnection(value: unknown): SshConnectionProfile | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const source = value as Record<string, unknown>;
	const id = string(source.id);
	const name = string(source.name);
	const target = string(source.target);
	if (!id || !name || !target) return undefined;
	const platform =
		source.platform === "linux" || source.platform === "darwin" || source.platform === "windows"
			? source.platform
			: "auto";
	const port =
		typeof source.port === "number" && Number.isInteger(source.port) && source.port >= 1 && source.port <= 65535
			? source.port
			: undefined;
	const authMethod = source.authMethod === "key" || source.authMethod === "password" ? source.authMethod : "agent";
	return {
		id,
		name,
		target,
		mode: source.mode === "direct" ? "direct" : "alias",
		...(string(source.user) ? { user: string(source.user) } : {}),
		...(port ? { port } : {}),
		authMethod,
		...(string(source.identityFile) ? { identityFile: string(source.identityFile) } : {}),
		...(string(source.credentialId) ? { credentialId: string(source.credentialId) } : {}),
		...(source.rememberPassword === true ? { rememberPassword: true } : {}),
		platform,
		...(string(source.defaultCwd) ? { defaultCwd: string(source.defaultCwd) } : {}),
		...(string(source.hostCommand) ? { hostCommand: string(source.hostCommand) } : {}),
	};
}

function normalizeProject(value: unknown): DesktopProject | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const source = value as Record<string, unknown>;
	const id = string(source.id);
	const name = string(source.name);
	const cwd = string(source.cwd);
	const connectionId = string(source.connectionId);
	if (!id || !name || !cwd || !connectionId) return undefined;
	const recentSessions = Array.isArray(source.recentSessions)
		? source.recentSessions.flatMap((item) => normalizeSession(item) ?? [])
		: [];
	const color = ["red", "orange", "green", "blue", "purple", "gray"].includes(String(source.color))
		? (source.color as DesktopProject["color"])
		: undefined;
	return {
		id,
		name,
		cwd,
		connectionId,
		...(source.pinned === true ? { pinned: true } : {}),
		...(color ? { color } : {}),
		...(source.archived === true ? { archived: true } : {}),
		...(recentSessions.length > 0 ? { recentSessions } : {}),
	};
}

function normalizeSession(value: unknown): CachedSessionSummary | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const source = value as Record<string, unknown>;
	const path = string(source.path);
	const id = string(source.id);
	const cwd = string(source.cwd);
	if (!path || !id || !cwd || typeof source.createdAt !== "number" || typeof source.updatedAt !== "number") {
		return undefined;
	}
	return {
		path,
		id,
		cwd,
		...(string(source.name) ? { name: string(source.name) } : {}),
		createdAt: source.createdAt,
		updatedAt: source.updatedAt,
		messageCount: typeof source.messageCount === "number" ? source.messageCount : 0,
		firstMessage: string(source.firstMessage) ?? "未命名会话",
		activity:
			source.activity === "running" ||
			source.activity === "waiting_for_input" ||
			source.activity === "completed" ||
			source.activity === "failed" ||
			source.activity === "aborted" ||
			source.activity === "interrupted"
				? source.activity
				: "idle",
		writeAccess:
			source.writeAccess === "owned" ||
			source.writeAccess === "controlled_elsewhere" ||
			source.writeAccess === "locked_externally"
				? source.writeAccess
				: "available",
		...(typeof source.operationUpdatedAt === "number" ? { operationUpdatedAt: source.operationUpdatedAt } : {}),
	};
}

function normalizeState(value: unknown): DesktopState {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return { version: 1, connections: [], projects: [] };
	}
	const source = value as Record<string, unknown>;
	const layoutSource =
		source.layout && typeof source.layout === "object" && !Array.isArray(source.layout)
			? (source.layout as Record<string, unknown>)
			: undefined;
	const inspectorWidth = typeof layoutSource?.inspectorWidth === "number" ? layoutSource.inspectorWidth : undefined;
	const inspectorSplit = typeof layoutSource?.inspectorSplit === "number" ? layoutSource.inspectorSplit : undefined;
	return {
		version: 1,
		connections: Array.isArray(source.connections)
			? source.connections.flatMap((item) => normalizeConnection(item) ?? [])
			: [],
		projects: Array.isArray(source.projects) ? source.projects.flatMap((item) => normalizeProject(item) ?? []) : [],
		...(string(source.selectedProjectId) ? { selectedProjectId: string(source.selectedProjectId) } : {}),
		...(inspectorWidth !== undefined && inspectorSplit !== undefined
			? {
					layout: {
						inspectorWidth: Math.min(900, Math.max(320, inspectorWidth)),
						inspectorSplit: Math.min(0.8, Math.max(0.2, inspectorSplit)),
						...(layoutSource?.sidebarCollapsed === true ? { sidebarCollapsed: true } : {}),
					},
				}
			: {}),
	};
}

export async function loadDesktopState(): Promise<DesktopState> {
	if (isTauri()) return normalizeState(await invoke<unknown>("load_desktop_state"));
	try {
		return normalizeState(JSON.parse(localStorage.getItem(BROWSER_STATE_KEY) ?? "null"));
	} catch {
		return { version: 1, connections: [], projects: [] };
	}
}

export async function saveDesktopState(state: DesktopState): Promise<void> {
	const normalized = normalizeState(state);
	if (isTauri()) await invoke("save_desktop_state", { state: normalized });
	else localStorage.setItem(BROWSER_STATE_KEY, JSON.stringify(normalized));
}

function profileInput(profile: SshConnectionProfile): {
	target: string;
	platform: string;
	user?: string;
	port?: number;
	authMethod: string;
	identityFile?: string;
	credentialId?: string;
	hostCommand?: string;
} {
	return {
		target: profile.target,
		platform: profile.platform ?? "auto",
		...(profile.user ? { user: profile.user } : {}),
		...(profile.port ? { port: profile.port } : {}),
		authMethod: profile.authMethod ?? "agent",
		...(profile.identityFile ? { identityFile: profile.identityFile } : {}),
		...(profile.credentialId ? { credentialId: profile.credentialId } : {}),
		...(profile.hostCommand ? { hostCommand: profile.hostCommand } : {}),
	};
}

export async function storeSshPassword(profileId: string, password: string, remember: boolean): Promise<string> {
	if (!isTauri()) throw new Error("SSH 密码只在桌面应用中可用");
	return invoke<string>("store_ssh_password", { profileId, password, remember });
}

export async function deleteSshPassword(credentialId: string): Promise<void> {
	if (!isTauri()) return;
	await invoke("delete_ssh_password", { credentialId });
}

export async function inspectSshHostKey(profile: SshConnectionProfile): Promise<SshHostKeyStatus> {
	if (!isTauri()) throw new Error("SSH Host key 检查只在桌面应用中可用");
	return invoke<SshHostKeyStatus>("inspect_ssh_host_key", { profile: profileInput(profile) });
}

export async function trustSshHostKey(trustToken: string): Promise<void> {
	if (!isTauri()) throw new Error("SSH Host key 确认只在桌面应用中可用");
	await invoke("trust_ssh_host_key", { trustToken });
}

export async function probeSshConnection(profile: SshConnectionProfile): Promise<SshProbeResult> {
	if (!isTauri()) throw new Error("SSH 连接只在桌面应用中可用");
	return invoke<SshProbeResult>("probe_ssh_connection", { profile: profileInput(profile) });
}

export async function installSshHost(profile: SshConnectionProfile, sourcePath?: string): Promise<SshProbeResult> {
	if (!isTauri()) throw new Error("远端后台安装只在桌面应用中可用");
	return invoke<SshProbeResult>("install_ssh_host", {
		profile: profileInput(profile),
		sourcePath: sourcePath || null,
	});
}
