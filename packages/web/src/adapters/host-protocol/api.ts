import { createUuid } from "@lystar/code-gui-protocol";
import type {
	BootstrapResponse,
	WebCompletionResult,
	DirectoryListing,
	FileResponse,
	GatewayEvent,
	GitDiffResponse,
	GitStatusResponse,
	HostInstructionsResponse,
	ModelsResponse,
	ProjectSkillsResponse,
	ProjectTreeResponse,
	ProjectTrustResponse,
	SessionTreeResponse,
	SettingsResponse,
	TranscriptResponse,
	WebLease,
	WebOperation,
	WebProject,
	WebSessionSnapshot,
	WebSessionSummary,
} from "../../types.ts";

const TOKEN_KEY = "lystar.web.token";
const CLIENT_ID_KEY = "lystar.web.client-id";

export class UnauthorizedError extends Error {
	constructor() {
		super("需要输入 Web Token");
		this.name = "UnauthorizedError";
	}
}

function clientId(): string {
	const current = localStorage.getItem(CLIENT_ID_KEY);
	if (current && /^[A-Za-z0-9._:-]{8,128}$/u.test(current)) return current;
	const next = createUuid();
	localStorage.setItem(CLIENT_ID_KEY, next);
	return next;
}

function jsonHeaders(): HeadersInit {
	const token = localStorage.getItem(TOKEN_KEY)?.trim();
	return {
		Accept: "application/json",
		"Content-Type": "application/json",
		"X-LYStar-Client-Id": clientId(),
		...(token ? { Authorization: `Bearer ${token}` } : {}),
	};
}

async function parseResponse<T>(response: Response): Promise<T> {
	if (response.status === 401) throw new UnauthorizedError();
	const value = (await response.json().catch(() => ({}))) as { error?: { code?: string; message?: string } };
	if (!response.ok) {
		const error = new Error(value.error?.message || `请求失败（${response.status}）`) as Error & { code?: string };
		error.code = value.error?.code;
		throw error;
	}
	return value as T;
}

export class WebApi {
	hasToken(): boolean {
		return Boolean(localStorage.getItem(TOKEN_KEY)?.trim());
	}

	setToken(token: string): void {
		const value = token.trim();
		if (value) localStorage.setItem(TOKEN_KEY, value);
		else localStorage.removeItem(TOKEN_KEY);
	}

	clearToken(): void {
		localStorage.removeItem(TOKEN_KEY);
	}

	async request<T>(path: string, init: RequestInit = {}): Promise<T> {
		const response = await fetch(path, {
			...init,
			headers: { ...jsonHeaders(), ...(init.headers ?? {}) },
		});
		return parseResponse<T>(response);
	}

	async bootstrap(): Promise<BootstrapResponse> {
		return this.request<BootstrapResponse>("/api/bootstrap");
	}

	async directories(path?: string): Promise<DirectoryListing> {
		const query = path ? `?path=${encodeURIComponent(path)}` : "";
		return this.request<DirectoryListing>(`/api/directories${query}`);
	}

	async addProject(cwd: string, name?: string): Promise<{ project: WebProject }> {
		return this.request<{ project: WebProject }>("/api/projects", {
			method: "POST",
			body: JSON.stringify({ cwd, name }),
		});
	}

	async updateProject(
		id: string,
		update: Partial<Pick<WebProject, "name" | "pinned" | "color" | "archived">>,
	): Promise<{ project: WebProject }> {
		return this.request<{ project: WebProject }>(`/api/projects/${encodeURIComponent(id)}`, {
			method: "PATCH",
			body: JSON.stringify(update),
		});
	}

	async removeProject(id: string): Promise<void> {
		await this.request(`/api/projects/${encodeURIComponent(id)}`, { method: "DELETE" });
	}

	async setSessionPinned(
		projectId: string,
		sessionId: string,
		pinned: boolean,
	): Promise<{ project: WebProject }> {
		return this.request<{ project: WebProject }>(
			`/api/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}/pin`,
			{
				method: "PATCH",
				body: JSON.stringify({ pinned }),
			},
		);
	}

	async reorderProjects(projectIds: string[]): Promise<void> {
		await this.request("/api/projects/order", {
			method: "PATCH",
			body: JSON.stringify({ projectIds }),
		});
	}

	async projectSessions(projectId: string): Promise<{ sessions: WebSessionSummary[] }> {
		return this.request<{ sessions: WebSessionSummary[] }>(`/api/projects/${encodeURIComponent(projectId)}/sessions`);
	}

	async reorderSessions(projectId: string, sessionIds: string[]): Promise<{ sessions: WebSessionSummary[] }> {
		return this.request<{ sessions: WebSessionSummary[] }>(
			`/api/projects/${encodeURIComponent(projectId)}/sessions/order`,
			{
				method: "PATCH",
				body: JSON.stringify({ sessionIds }),
			},
		);
	}

	async completions(
		projectId: string,
		text: string,
		cursor: number,
		sessionId?: string,
	): Promise<WebCompletionResult> {
		return this.request<WebCompletionResult>(`/api/projects/${encodeURIComponent(projectId)}/completions`, {
			method: "POST",
			body: JSON.stringify({ text, cursor, ...(sessionId ? { sessionId } : {}) }),
		});
	}

	async projectTree(projectId: string, path = ""): Promise<ProjectTreeResponse> {
		const query = path ? `?path=${encodeURIComponent(path)}` : "";
		return this.request<ProjectTreeResponse>(`/api/projects/${encodeURIComponent(projectId)}/tree${query}`);
	}

	async projectFile(projectId: string, path: string): Promise<FileResponse> {
		return this.request<FileResponse>(
			`/api/projects/${encodeURIComponent(projectId)}/file?path=${encodeURIComponent(path)}`,
		);
	}

	async externalFile(path: string): Promise<FileResponse> {
		return this.request<FileResponse>(`/api/resources/external?path=${encodeURIComponent(path)}`);
	}

	async projectSkills(projectId: string): Promise<ProjectSkillsResponse> {
		return this.request<ProjectSkillsResponse>(`/api/projects/${encodeURIComponent(projectId)}/skills`);
	}

	async setProjectSkillEnabled(
		projectId: string,
		path: string,
		scope: "user" | "project",
		enabled: boolean,
	): Promise<ProjectSkillsResponse> {
		return this.request<ProjectSkillsResponse>(`/api/projects/${encodeURIComponent(projectId)}/skills`, {
			method: "POST",
			body: JSON.stringify({ path, scope, enabled, clientRequestId: createUuid() }),
		});
	}

	async readImageContent(
		sessionId: string,
		contentRef: string,
	): Promise<{ contentRef: string; mimeType: string; byteLength: number; data: string }> {
		return this.request<{ contentRef: string; mimeType: string; byteLength: number; data: string }>(
			`/api/sessions/${encodeURIComponent(sessionId)}/content/${encodeURIComponent(contentRef)}/image`,
		);
	}

	async gitStatus(projectId: string): Promise<GitStatusResponse> {
		return this.request<GitStatusResponse>(`/api/projects/${encodeURIComponent(projectId)}/git/status`);
	}

	async gitDiff(projectId: string, path?: string, staged = false): Promise<GitDiffResponse> {
		const params = new URLSearchParams({ staged: String(staged) });
		if (path) params.set("path", path);
		return this.request<GitDiffResponse>(`/api/projects/${encodeURIComponent(projectId)}/git/diff?${params}`);
	}

	async projectTrust(projectId: string): Promise<ProjectTrustResponse> {
		return this.request<ProjectTrustResponse>(`/api/projects/${encodeURIComponent(projectId)}/trust`);
	}

	async setProjectTrust(projectId: string, sessionId: string, trusted: boolean): Promise<ProjectTrustResponse> {
		return this.request<ProjectTrustResponse>(`/api/projects/${encodeURIComponent(projectId)}/trust`, {
			method: "POST",
			body: JSON.stringify({ sessionId, trusted }),
		});
	}

	async createSession(projectId: string): Promise<{ session: WebSessionSnapshot; lease: WebLease }> {
		return this.request<{ session: WebSessionSnapshot; lease: WebLease }>("/api/sessions", {
			method: "POST",
			body: JSON.stringify({ projectId }),
		});
	}

	async session(sessionId: string): Promise<{ session: WebSessionSnapshot }> {
		return this.request<{ session: WebSessionSnapshot }>(`/api/sessions/${encodeURIComponent(sessionId)}`);
	}

	async control(sessionId: string): Promise<{ owned: boolean; lease: WebLease; snapshot: WebSessionSnapshot }> {
		return this.request<{ owned: boolean; lease: WebLease; snapshot: WebSessionSnapshot }>(
			`/api/sessions/${encodeURIComponent(sessionId)}/control`,
			{ method: "POST" },
		);
	}

	async release(sessionId: string): Promise<void> {
		await this.request(`/api/sessions/${encodeURIComponent(sessionId)}/control`, { method: "DELETE" });
	}

	async transcript(
		sessionId: string,
		options: { cursor?: string; limit?: number; search?: string } = {},
	): Promise<TranscriptResponse> {
		const params = new URLSearchParams();
		if (options.cursor) params.set("cursor", options.cursor);
		if (options.limit) params.set("limit", String(options.limit));
		if (options.search) params.set("search", options.search);
		const query = params.toString() ? `?${params}` : "";
		return this.request<TranscriptResponse>(`/api/sessions/${encodeURIComponent(sessionId)}/transcript${query}`);
	}

	async prompt(
		sessionId: string,
		text: string,
		kind: "prompt" | "steer" | "follow-up" = "prompt",
		images?: Array<{ data: string; mimeType: string }>,
	): Promise<{ operation?: WebOperation; accepted?: boolean }> {
		return this.request<{ operation?: WebOperation; accepted?: boolean }>(
			`/api/sessions/${encodeURIComponent(sessionId)}/${kind}`,
			{
				method: "POST",
				body: JSON.stringify({ text, ...(images?.length ? { images } : {}), clientRequestId: createUuid() }),
			},
		);
	}

	async abort(sessionId: string, operationId?: string): Promise<void> {
		await this.request(`/api/sessions/${encodeURIComponent(sessionId)}/abort`, {
			method: "POST",
			body: JSON.stringify({ operationId }),
		});
	}

	async compact(sessionId: string, customInstructions?: string): Promise<{ operation: WebOperation }> {
		return this.request<{ operation: WebOperation }>(`/api/sessions/${encodeURIComponent(sessionId)}/compact`, {
			method: "POST",
			body: JSON.stringify({ customInstructions, clientRequestId: createUuid() }),
		});
	}

	async fork(
		sessionId: string,
		entryId: string,
	): Promise<{ session: WebSessionSnapshot; lease: WebLease; selectedText?: string }> {
		return this.request<{ session: WebSessionSnapshot; lease: WebLease; selectedText?: string }>(
			`/api/sessions/${encodeURIComponent(sessionId)}/fork`,
			{ method: "POST", body: JSON.stringify({ entryId, clientRequestId: createUuid() }) },
		);
	}

	async deleteSession(sessionId: string): Promise<void> {
		await this.request(`/api/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE" });
	}

	async renameSession(sessionId: string, name: string): Promise<{ session: WebSessionSnapshot }> {
		return this.request<{ session: WebSessionSnapshot }>(`/api/sessions/${encodeURIComponent(sessionId)}/rename`, {
			method: "POST",
			body: JSON.stringify({ name, clientRequestId: createUuid() }),
		});
	}

	async exportSession(sessionId: string): Promise<{ path: string }> {
		return this.request<{ path: string }>(`/api/sessions/${encodeURIComponent(sessionId)}/export`, {
			method: "POST",
			body: JSON.stringify({ clientRequestId: createUuid() }),
		});
	}

	async model(sessionId: string, provider: string, id: string): Promise<{ session: WebSessionSnapshot }> {
		return this.request<{ session: WebSessionSnapshot }>(`/api/sessions/${encodeURIComponent(sessionId)}/model`, {
			method: "POST",
			body: JSON.stringify({ model: { provider, id }, clientRequestId: createUuid() }),
		});
	}

	async thinking(sessionId: string, level: string): Promise<{ session: WebSessionSnapshot }> {
		return this.request<{ session: WebSessionSnapshot }>(`/api/sessions/${encodeURIComponent(sessionId)}/thinking`, {
			method: "POST",
			body: JSON.stringify({ level, clientRequestId: createUuid() }),
		});
	}

	async operations(sessionId: string): Promise<{ operations: WebOperation[] }> {
		return this.request<{ operations: WebOperation[] }>(`/api/sessions/${encodeURIComponent(sessionId)}/operations`);
	}

	async operation(operationId: string): Promise<{ operation: WebOperation }> {
		return this.request<{ operation: WebOperation }>(`/api/operations/${encodeURIComponent(operationId)}`);
	}

	async abortOperation(operationId: string): Promise<void> {
		await this.request(`/api/operations/${encodeURIComponent(operationId)}/abort`, { method: "POST", body: "{}" });
	}

	async tree(sessionId: string): Promise<SessionTreeResponse> {
		return this.request<SessionTreeResponse>(`/api/sessions/${encodeURIComponent(sessionId)}/tree`);
	}

	async navigateTree(sessionId: string, entryId: string, summarize = false): Promise<unknown> {
		return this.request(`/api/sessions/${encodeURIComponent(sessionId)}/tree/navigate`, {
			method: "POST",
			body: JSON.stringify({ entryId, summarize, clientRequestId: createUuid() }),
		});
	}

	async models(): Promise<ModelsResponse> {
		return this.request<ModelsResponse>("/api/models");
	}

	async modelProvider(input: {
		provider: string;
		name?: string;
		baseUrl: string;
		api: string;
		apiKey?: string;
		catalogProvider?: string;
		clearCatalogProvider?: boolean;
	}): Promise<{ providers: ModelsResponse["providers"] }> {
		return this.request<{ providers: ModelsResponse["providers"] }>("/api/model-providers", {
			method: "POST",
			body: JSON.stringify(input),
		});
	}

	async providerModel(
		provider: string,
		input: {
			id: string;
			name?: string;
			api?: string;
			baseUrl?: string;
			reasoning: boolean;
			thinkingLevelMap?: Partial<
				Record<"off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra", string | null>
			>;
			resetOverride?: boolean;
			input: ("text" | "image")[];
			contextWindow?: number;
			maxTokens?: number;
		},
	): Promise<{ models: ModelsResponse["models"] }> {
		return this.request<{ models: ModelsResponse["models"] }>(
			`/api/model-providers/${encodeURIComponent(provider)}/models`,
			{
				method: "POST",
				body: JSON.stringify(input),
			},
		);
	}

	async syncModelProvider(provider: string): Promise<{ models: ModelsResponse["models"] }> {
		return this.request<{ models: ModelsResponse["models"] }>(
			`/api/model-providers/${encodeURIComponent(provider)}/sync`,
			{
				method: "POST",
				body: JSON.stringify({}),
			},
		);
	}

	async hostInstructions(): Promise<HostInstructionsResponse> {
		return this.request<HostInstructionsResponse>("/api/settings/host-instructions");
	}

	async saveHostInstruction(content: string, expectedHash?: string): Promise<HostInstructionsResponse> {
		return this.request<HostInstructionsResponse>("/api/settings/host-instructions", {
			method: "POST",
			body: JSON.stringify({
				fileName: "AGENTS.md",
				content,
				...(expectedHash ? { expectedHash } : {}),
				clientRequestId: createUuid(),
			}),
		});
	}

	async settings(sessionId: string): Promise<SettingsResponse> {
		return this.request<SettingsResponse>(`/api/settings?sessionId=${encodeURIComponent(sessionId)}`);
	}


	async setSetting(sessionId: string, id: string, value: boolean | number | string): Promise<unknown> {
		return this.request("/api/settings", {
			method: "POST",
			body: JSON.stringify({ sessionId, id, value, clientRequestId: createUuid() }),
		});
	}

	async about(): Promise<unknown> {
		return this.request("/api/about");
	}

	async diagnostics(projectId?: string): Promise<unknown> {
		const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
		return this.request(`/api/diagnostics${query}`);
	}

	async uiResponse(
		requestId: string,
		response: { value?: unknown; confirmed?: boolean; cancelled?: boolean },
	): Promise<void> {
		await this.request(`/api/ui-requests/${encodeURIComponent(requestId)}`, {
			method: "POST",
			body: JSON.stringify(response),
		});
	}

	connect(onEvent: (event: GatewayEvent) => void, onClose: () => void): WebSocket {
		const protocol = location.protocol === "https:" ? "wss:" : "ws:";
		const token = encodeURIComponent(localStorage.getItem(TOKEN_KEY)?.trim() ?? "");
		const socket = new WebSocket(
			`${protocol}//${location.host}/ws?token=${token}&clientId=${encodeURIComponent(clientId())}`,
		);
		let closed = false;
		const notifyClose = () => {
			if (closed) return;
			closed = true;
			onClose();
		};
		socket.addEventListener("message", (message) => {
			try {
				onEvent(JSON.parse(String(message.data)) as GatewayEvent);
			} catch {
				// 网关只发送 JSON；无效消息忽略，下一次快照会重新校准状态。
			}
		});
		socket.addEventListener("close", notifyClose, { once: true });
		socket.addEventListener("error", () => {
			// close 事件负责触发唯一一次重连，避免 error+close 导致重复创建 WebSocket。
		});
		return socket;
	}
}

export const webApi = new WebApi();
