import { join } from "node:path";
import { GuiHostService } from "../../src/service.ts";
import { runStdioHost } from "../../src/stdio.ts";

const agentDir = process.argv[2];
const loggedInModels = [
	{
		provider: "test",
		id: "test-model",
		name: "Test Model",
		api: "openai-completions",
		reasoning: false,
		input: ["text"],
		contextWindow: 128000,
		maxTokens: 4096,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		supportedThinkingLevels: ["off"],
		authenticated: true,
		authMethods: ["api_key", "oauth"],
		authSource: "test",
	},
];

const adapter = {
	async createSession() {
		throw new Error("not used");
	},
	async openSession() {
		throw new Error("not used");
	},
	async deleteSession() {
		throw new Error("not used");
	},
	async listSessions() {
		return [];
	},
	async listModels() {
		return [];
	},
	async loginModelProvider(_provider, authType, onUiRequest) {
		if (authType === "oauth") {
			await onUiRequest({
				id: "stdio-oauth-notify",
				kind: "notify",
				title: "模型认证",
				payload: { method: "auth_url", url: "https://example.test/oauth" },
			});
			return loggedInModels;
		}
		const method = await onUiRequest({
			id: "stdio-auth-method",
			kind: "select",
			title: "模型认证",
			payload: {
				message: "选择认证方式",
				options: [{ id: "bearer-token", label: "Bearer token" }],
			},
		});
		await onUiRequest({
			id: "stdio-auth-secret",
			kind: "secret",
			title: "模型认证",
			payload: { message: "输入令牌" },
		});
		if (method.cancelled) throw new Error("认证已取消");
		return loggedInModels;
	},
	async logoutModelProvider() {
		return [];
	},
	async listSkills() {
		return { skills: [], diagnostics: [] };
	},
	async setSkillEnabled() {
		return { skills: [], diagnostics: [] };
	},
	getAbout() {
		return { productVersion: "test-process", agentDir };
	},
	async getDiagnostics() {
		return { checks: [] };
	},
};

const service = new GuiHostService(adapter, { agentDir, journalPath: join(agentDir, "operations.jsonl") });
process.stderr.write("ready\n");
try {
	await runStdioHost(service);
} finally {
	await service.dispose();
}