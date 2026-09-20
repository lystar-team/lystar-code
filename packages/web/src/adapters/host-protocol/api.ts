import { createUuid } from "@lystar/code-web-protocol";
import type {
	BootstrapResponse,
	DirectoryListing,
	FileMetadataResponse,
	FileResponse,
	GatewayEvent,
	GitBranchesResponse,
	GitCommitResponse,
	GitDiffResponse,
	GitHistoryResponse,
	GitMutation,
	GitMutationResponse,
	GitStatsResponse,
	GitStatusResponse,
	HarnessImportResultResponse,
	HarnessImportsResponse,
	HostInstructionsResponse,
	FileUploadResponse,
	ModelOptionsResponse,
	ModelsResponse,
	ProjectGroup,
	ProjectSkillsResponse,
	ProjectTreeResponse,
	ProjectTrustResponse,
	PromptAttachment,
	ProductBranding,
	ProductUpdateCheckResponse,
	ProductUpdateStatusResponse,
	SaveSecuritySettingsResponse,
	SecuritySettingsResponse,
	SystemPermissionsResponse,
	SessionTreeResponse,
	SubagentConfig,
	SubagentConfigsResponse,
	SubagentDetailsResponse,
	SubagentsResponse,
	SettingsResponse,
	TranscriptResponse,
	WebCompletionResult,
	WebLease,
	WebOperation,
	WebProject,
	WebSessionSnapshot,
	WebThinkingLevel,
	WebSessionSummary,
} from "../../types.ts";

const TOKEN_KEY = "lystar.web.token";
const CLIENT_ID_KEY = "lystar.web.client-id";

export class UnauthorizedError extends Error {
	constructor() {
		super("需要输入 Web 密码");
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
	private readonly pendingSessionSubscriptions = new WeakMap<WebSocket, Map<string, number | undefined>>();
	private readonly pendingProjectSubscriptions = new WeakMap<WebSocket, Set<string>>();
	private readonly pendingSubscriptionListeners = new WeakMap<
		WebSocket,
		{ onOpen: () => void; onClose: () => void }
	>();

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

	async projectGroups(): Promise<{ groups: ProjectGroup[] }> {
		return this.request<{ groups: ProjectGroup[] }>("/api/project-groups");
	}

	async reorderProjectGroups(groupIds: string[]): Promise<{ groups: ProjectGroup[] }> {
		return this.request<{ groups: ProjectGroup[] }>("/api/project-groups", {
			method: "PATCH",
			body: JSON.stringify({ groupIds }),
		});
	}

	async addProjectGroup(name: string): Promise<{ group: ProjectGroup; groups: ProjectGroup[] }> {
		return this.request<{ group: ProjectGroup; groups: ProjectGroup[] }>("/api/project-groups", {
			method: "POST",
			body: JSON.stringify({ name }),
		});
	}

	async updateProjectGroup(id: string, name: string): Promise<{ group: ProjectGroup; groups: ProjectGroup[] }> {
		return this.request<{ group: ProjectGroup; groups: ProjectGroup[] }>(
			`/api/project-groups/${encodeURIComponent(id)}`,
			{ method: "PATCH", body: JSON.stringify({ name }) },
		);
	}

	async removeProjectGroup(id: string): Promise<{ groups: ProjectGroup[] }> {
		return this.request<{ groups: ProjectGroup[] }>(`/api/project-groups/${encodeURIComponent(id)}`, {
			method: "DELETE",
		});
	}

	async setProjectGroup(projectId: string, groupId?: string): Promise<{ groups: ProjectGroup[] }> {
		return this.request<{ groups: ProjectGroup[] }>(`/api/projects/${encodeURIComponent(projectId)}/group`, {
			method: "PATCH",
			body: JSON.stringify({ groupId }),
		});
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

	async setSessionPinned(projectId: string, sessionId: string, pinned: boolean): Promise<{ project: WebProject }> {
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

	async downloadProjectFile(projectId: string, path: string): Promise<Blob> {
		const response = await fetch(
			`/api/projects/${encodeURIComponent(projectId)}/file?path=${encodeURIComponent(path)}&download=true`,
			{ headers: { ...jsonHeaders(), Accept: "application/octet-stream" } },
		);
		if (!response.ok) await parseResponse<never>(response);
		return response.blob();
	}

	async renameProjectEntry(projectId: string, path: string, name: string): Promise<{ path: string }> {
		return this.request<{ path: string }>(`/api/projects/${encodeURIComponent(projectId)}/file`, {
			method: "PATCH",
			body: JSON.stringify({ path, name }),
		});
	}

	async deleteProjectEntries(projectId: string, paths: string[]): Promise<{ paths: string[] }> {
		return this.request<{ paths: string[] }>(`/api/projects/${encodeURIComponent(projectId)}/file`, {
			method: "DELETE",
			body: JSON.stringify({ paths }),
		});
	}

	async uploadProjectFile(
		projectId: string,
		directory: string,
		file: File,
	): Promise<{ path: string; byteLength: number }> {
		const query = new URLSearchParams({ path: directory, name: file.name });
		return this.request<{ path: string; byteLength: number }>(
			`/api/projects/${encodeURIComponent(projectId)}/upload?${query.toString()}`,
			{
				method: "POST",
				headers: { "Content-Type": file.type || "application/octet-stream" },
				body: file,
			},
		);
	}

	async createProjectArchive(
		projectId: string,
		paths: string[],
		name: string,
	): Promise<{ path: string; entryCount: number }> {
		return this.request<{ path: string; entryCount: number }>(
			`/api/projects/${encodeURIComponent(projectId)}/archive`,
			{
				method: "POST",
				body: JSON.stringify({ paths, name }),
			},
		);
	}

	async projectFileMetadata(projectId: string, path: string): Promise<FileMetadataResponse> {
		return this.request<FileMetadataResponse>(
			`/api/projects/${encodeURIComponent(projectId)}/file?path=${encodeURIComponent(path)}&metadata=true`,
		);
	}

	async saveProjectFile(
		projectId: string,
		path: string,
		content: string,
		expectedHash: string,
		sessionId?: string,
	): Promise<FileResponse> {
		return this.request<FileResponse>(`/api/projects/${encodeURIComponent(projectId)}/file`, {
			method: "POST",
			body: JSON.stringify({
				path,
				content,
				expectedHash,
				...(sessionId ? { sessionId } : {}),
				clientRequestId: createUuid(),
			}),
		});
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

	async gitStatus(projectId: string, discover = false): Promise<GitStatusResponse> {
		const params = discover ? "?discover=true" : "";
		return this.request<GitStatusResponse>(`/api/projects/${encodeURIComponent(projectId)}/git/status${params}`);
	}

	async gitDiff(projectId: string, path?: string, staged = false, repositoryPath?: string): Promise<GitDiffResponse> {
		const params = new URLSearchParams({ staged: String(staged) });
		if (path) params.set("path", path);
		if (repositoryPath) params.set("repositoryPath", repositoryPath);
		return this.request<GitDiffResponse>(`/api/projects/${encodeURIComponent(projectId)}/git/diff?${params}`);
	}

	async gitStats(projectId: string, repositoryPath?: string): Promise<GitStatsResponse> {
		const params = new URLSearchParams();
		if (repositoryPath) params.set("repositoryPath", repositoryPath);
		return this.request<GitStatsResponse>(`/api/projects/${encodeURIComponent(projectId)}/git/stats?${params}`);
	}

	async gitBranches(projectId: string, repositoryPath?: string): Promise<GitBranchesResponse> {
		const params = new URLSearchParams();
		if (repositoryPath) params.set("repositoryPath", repositoryPath);
		return this.request<GitBranchesResponse>(`/api/projects/${encodeURIComponent(projectId)}/git/branches?${params}`);
	}

	async gitHistory(
		projectId: string,
		offset = 0,
		limit = 50,
		repositoryPath?: string,
	): Promise<GitHistoryResponse> {
		const params = new URLSearchParams({ offset: String(offset), limit: String(limit) });
		if (repositoryPath) params.set("repositoryPath", repositoryPath);
		return this.request<GitHistoryResponse>(`/api/projects/${encodeURIComponent(projectId)}/git/history?${params}`);
	}

	async gitCommit(
		projectId: string,
		revision: string,
		repositoryPath?: string,
		path?: string,
	): Promise<GitCommitResponse> {
		const params = new URLSearchParams({ revision });
		if (repositoryPath) params.set("repositoryPath", repositoryPath);
		if (path) params.set("path", path);
		return this.request<GitCommitResponse>(`/api/projects/${encodeURIComponent(projectId)}/git/commit?${params}`);
	}

	async mutateGit(projectId: string, mutation: GitMutation, repositoryPath?: string): Promise<GitMutationResponse> {
		return this.request<GitMutationResponse>(`/api/projects/${encodeURIComponent(projectId)}/git/mutate`, {
			method: "POST",
			body: JSON.stringify({ mutation, clientRequestId: createUuid(), ...(repositoryPath ? { repositoryPath } : {}) }),
		});
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

	async subagents(sessionId: string): Promise<SubagentsResponse> {
		return this.request<SubagentsResponse>(`/api/sessions/${encodeURIComponent(sessionId)}/subagents`);
	}

	async subagent(sessionId: string, agentId: string): Promise<SubagentDetailsResponse> {
		return this.request<SubagentDetailsResponse>(
			`/api/sessions/${encodeURIComponent(sessionId)}/subagents/${encodeURIComponent(agentId)}`,
		);
	}

	async subagentTranscript(
		sessionId: string,
		agentId: string,
		options: { cursor?: string; limit?: number } = {},
	): Promise<TranscriptResponse> {
		const params = new URLSearchParams();
		if (options.cursor) params.set("cursor", options.cursor);
		if (options.limit) params.set("limit", String(options.limit));
		const query = params.toString() ? `?${params}` : "";
		return this.request<TranscriptResponse>(
			`/api/sessions/${encodeURIComponent(sessionId)}/subagents/${encodeURIComponent(agentId)}/transcript${query}`,
		);
	}

	async abortSubagent(sessionId: string, agentId: string): Promise<void> {
		await this.request(
			`/api/sessions/${encodeURIComponent(sessionId)}/subagents/${encodeURIComponent(agentId)}/abort`,
			{ method: "POST", body: JSON.stringify({ clientRequestId: createUuid() }) },
		);
	}

	async continueSubagent(sessionId: string, agentId: string, text: string): Promise<void> {
		await this.request(
			`/api/sessions/${encodeURIComponent(sessionId)}/subagents/${encodeURIComponent(agentId)}/continue`,
			{ method: "POST", body: JSON.stringify({ text, clientRequestId: createUuid() }) },
		);
	}

	async uploadFile(file: File): Promise<FileUploadResponse> {
		return this.request<FileUploadResponse>("/api/uploads/file", {
			method: "POST",
			headers: {
				"Content-Type": file.type || "application/octet-stream",
				"X-LYStar-File-Name": encodeURIComponent(file.name),
			},
			body: file,
		});
	}

	async prompt(
		sessionId: string,
		text: string,
		kind: "prompt" | "steer" | "follow-up" = "prompt",
		attachments?: PromptAttachment[],
		queueId?: string,
	): Promise<{ operation?: WebOperation; accepted?: boolean }> {
		const clientRequestId = kind === "prompt" && queueId ? queueId : createUuid();
		const result = await this.request<{ operation?: WebOperation; accepted?: boolean }>(
			`/api/sessions/${encodeURIComponent(sessionId)}/${kind}`,
			{
				method: "POST",
				body: JSON.stringify({
					text,
					...(attachments?.length ? { attachments } : {}),
					...(kind !== "prompt" && queueId ? { queueId } : {}),
					clientRequestId,
				}),
			},
		);
		if (result.operation?.status === "failed") throw new Error(result.operation.error ?? "排队消息发送失败");
		return result;
	}

	async queueAction(sessionId: string, queueId: string, action: "remove" | "steer"): Promise<void> {
		const result = await this.request<{ operation?: WebOperation }>(
			`/api/sessions/${encodeURIComponent(sessionId)}/queue-action`,
			{
				method: "POST",
				body: JSON.stringify({ queueId, action, clientRequestId: createUuid() }),
			},
		);
		if (result.operation?.status === "failed") throw new Error(result.operation.error ?? "排队消息操作失败");
	}

	async abort(sessionId: string, operationId?: string): Promise<void> {
		await this.request(`/api/sessions/${encodeURIComponent(sessionId)}/abort`, {
			method: "POST",
			body: JSON.stringify({ operationId }),
		});
	}

	async reloadResources(sessionId: string): Promise<{ session: WebSessionSnapshot }> {
		return this.request<{ session: WebSessionSnapshot }>(`/api/sessions/${encodeURIComponent(sessionId)}/reload`, {
			method: "POST",
			body: JSON.stringify({ clientRequestId: createUuid() }),
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

	async deleteSessions(sessionIds: string[]): Promise<{
		deletedIds: string[];
		failures: Array<{ sessionId: string; code: string; message: string }>;
	}> {
		return this.request("/api/sessions", {
			method: "DELETE",
			body: JSON.stringify({ sessionIds }),
		});
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

	async modelOptions(includeProviders: readonly string[] = []): Promise<ModelOptionsResponse> {
		const params = new URLSearchParams();
		for (const provider of includeProviders) params.append("includeProvider", provider);
		const query = params.size > 0 ? `?${params}` : "";
		return this.request<ModelOptionsResponse>(`/api/model-options${query}`);
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

	async removeModelProvider(provider: string): Promise<{ providers: ModelsResponse["providers"] }> {
		return this.request<{ providers: ModelsResponse["providers"] }>(
			`/api/model-providers/${encodeURIComponent(provider)}`,
			{ method: "DELETE" },
		);
	}

	async setProviderModelEnabled(
		provider: string,
		modelId: string,
		enabled: boolean,
	): Promise<{ models: ModelsResponse["models"] }> {
		return this.request<{ models: ModelsResponse["models"] }>(
			`/api/model-providers/${encodeURIComponent(provider)}/models/enabled`,
			{
				method: "POST",
				body: JSON.stringify({ id: modelId, enabled, clientRequestId: createUuid() }),
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

	async harnessImports(projectId: string): Promise<HarnessImportsResponse> {
		return this.request<HarnessImportsResponse>(
			`/api/settings/imports?projectId=${encodeURIComponent(projectId)}`,
		);
	}

	async importHarnessResources(projectId: string, itemIds: string[]): Promise<HarnessImportResultResponse> {
		return this.request<HarnessImportResultResponse>(
			`/api/settings/imports?projectId=${encodeURIComponent(projectId)}`,
			{
				method: "POST",
				body: JSON.stringify({ itemIds, clientRequestId: createUuid() }),
			},
		);
	}

	async subagentConfigs(projectId: string): Promise<SubagentConfigsResponse> {
		return this.request<SubagentConfigsResponse>(
			`/api/settings/subagents?projectId=${encodeURIComponent(projectId)}`,
		);
	}

	async saveSubagentConfig(
		projectId: string,
		input: {
			scope: "user" | "project";
			originalName?: string;
			name: string;
			description: string;
			provider?: string;
			model?: string;
			thinkingLevel?: WebThinkingLevel;
			tools?: string[];
			content: string;
			expectedHash?: string;
		},
	): Promise<SubagentConfigsResponse> {
		return this.request<SubagentConfigsResponse>(
			`/api/settings/subagents?projectId=${encodeURIComponent(projectId)}`,
			{
				method: "POST",
				body: JSON.stringify({ ...input, clientRequestId: createUuid() }),
			},
		);
	}

	async deleteSubagentConfig(
		projectId: string,
		input: Pick<SubagentConfig, "name" | "contentHash"> & { scope: "user" | "project" },
	): Promise<SubagentConfigsResponse> {
		return this.request<SubagentConfigsResponse>(
			`/api/settings/subagents?projectId=${encodeURIComponent(projectId)}`,
			{
				method: "DELETE",
				body: JSON.stringify({
					scope: input.scope,
					name: input.name,
					expectedHash: input.contentHash,
					clientRequestId: createUuid(),
				}),
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

	async branding(): Promise<ProductBranding> {
		return this.request<ProductBranding>("/api/branding");
	}

	async saveBranding(input: { name: string; logo?: string | null }): Promise<ProductBranding> {
		return this.request<ProductBranding>("/api/branding", {
			method: "POST",
			body: JSON.stringify(input),
		});
	}

	async securitySettings(): Promise<SecuritySettingsResponse> {
		return this.request<SecuritySettingsResponse>("/api/security-settings");
	}

	async saveSecuritySettings(input: {
		host: string;
		allowedHosts: string[];
		port: number;
		runtimePort: number;
		password?: string;
	}): Promise<SaveSecuritySettingsResponse> {
		return this.request<SaveSecuritySettingsResponse>("/api/security-settings", {
			method: "POST",
			body: JSON.stringify(input),
		});
	}

	async systemPermissions(): Promise<SystemPermissionsResponse> {
		return this.request<SystemPermissionsResponse>("/api/system-permissions");
	}

	async requestSystemPermission(
		permission: "keychain" | "accessibility" | "automation" | "screen-recording",
	): Promise<SystemPermissionsResponse> {
		return this.request<SystemPermissionsResponse>("/api/system-permissions", {
			method: "POST",
			body: JSON.stringify({ permission }),
		});
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

	async productUpdateStatus(): Promise<ProductUpdateStatusResponse> {
		return this.request<ProductUpdateStatusResponse>("/api/product-update");
	}

	async checkProductUpdate(): Promise<ProductUpdateCheckResponse> {
		return this.request<ProductUpdateCheckResponse>("/api/product-update/check");
	}

	async startProductUpdate(targetVersion: string): Promise<ProductUpdateStatusResponse> {
		return this.request<ProductUpdateStatusResponse>("/api/product-update", {
			method: "POST",
			body: JSON.stringify({ targetVersion }),
		});
	}

	async diagnostics(projectId?: string): Promise<unknown> {
		const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
		return this.request(`/api/diagnostics${query}`);
	}

	async restartDiagnosticService(service: "gateway" | "runtime"): Promise<{ accepted: boolean; service: string }> {
		return this.request<{ accepted: boolean; service: string }>("/api/diagnostics/actions", {
			method: "POST",
			body: JSON.stringify({ action: `restart-${service}` }),
		});
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

	private sendSessionSubscription(socket: WebSocket, sessionId: string, lastSeq?: number): void {
		socket.send(
			JSON.stringify({ type: "subscribe_session", sessionId, ...(lastSeq === undefined ? {} : { lastSeq }) }),
		);
	}

	private flushPendingSessionSubscriptions(socket: WebSocket): void {
		if (socket.readyState !== WebSocket.OPEN) return;
		const pendingSessions = this.pendingSessionSubscriptions.get(socket);
		for (const [sessionId, lastSeq] of pendingSessions ?? []) {
			this.sendSessionSubscription(socket, sessionId, lastSeq);
		}
		const pendingProjects = this.pendingProjectSubscriptions.get(socket);
		for (const projectId of pendingProjects ?? []) {
			socket.send(JSON.stringify({ type: "subscribe_project", projectId }));
		}
		const listeners = this.pendingSubscriptionListeners.get(socket);
		if (listeners) {
			socket.removeEventListener("open", listeners.onOpen);
			socket.removeEventListener("close", listeners.onClose);
			this.pendingSubscriptionListeners.delete(socket);
		}
		this.pendingSessionSubscriptions.delete(socket);
		this.pendingProjectSubscriptions.delete(socket);
	}

	private ensurePendingSubscriptionListeners(socket: WebSocket): void {
		if (this.pendingSubscriptionListeners.has(socket)) return;
		const onOpen = () => this.flushPendingSessionSubscriptions(socket);
		const onClose = () => {
			this.pendingSessionSubscriptions.delete(socket);
			this.pendingProjectSubscriptions.delete(socket);
			this.pendingSubscriptionListeners.delete(socket);
		};
		this.pendingSubscriptionListeners.set(socket, { onOpen, onClose });
		socket.addEventListener("open", onOpen, { once: true });
		socket.addEventListener("close", onClose, { once: true });
	}

	subscribeSession(socket: WebSocket, sessionId: string, lastSeq?: number): void {
		if (!sessionId) return;
		if (socket.readyState === WebSocket.OPEN) {
			this.sendSessionSubscription(socket, sessionId, lastSeq);
			return;
		}
		if (socket.readyState !== WebSocket.CONNECTING) return;
		const pending = this.pendingSessionSubscriptions.get(socket) ?? new Map<string, number | undefined>();
		pending.set(sessionId, lastSeq);
		this.pendingSessionSubscriptions.set(socket, pending);
		this.ensurePendingSubscriptionListeners(socket);
	}

	unsubscribeSession(socket: WebSocket, sessionId: string): void {
		this.pendingSessionSubscriptions.get(socket)?.delete(sessionId);
		if (socket.readyState !== WebSocket.OPEN || !sessionId) return;
		socket.send(JSON.stringify({ type: "unsubscribe_session", sessionId }));
	}

	subscribeProject(socket: WebSocket, projectId: string): void {
		if (!projectId) return;
		if (socket.readyState === WebSocket.OPEN) {
			socket.send(JSON.stringify({ type: "subscribe_project", projectId }));
			return;
		}
		if (socket.readyState !== WebSocket.CONNECTING) return;
		const pending = this.pendingProjectSubscriptions.get(socket) ?? new Set<string>();
		pending.add(projectId);
		this.pendingProjectSubscriptions.set(socket, pending);
		this.ensurePendingSubscriptionListeners(socket);
	}

	unsubscribeProject(socket: WebSocket, projectId: string): void {
		this.pendingProjectSubscriptions.get(socket)?.delete(projectId);
		if (socket.readyState !== WebSocket.OPEN || !projectId) return;
		socket.send(JSON.stringify({ type: "unsubscribe_project", projectId }));
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
			} catch (error) {
				console.error("Web 实时消息处理失败，需要重新同步", error);
				socket.close(4001, "实时消息处理失败");
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
