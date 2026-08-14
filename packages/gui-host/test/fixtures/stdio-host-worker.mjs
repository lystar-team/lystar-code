import { join } from "node:path";
import { GuiHostService } from "../../src/service.ts";
import { runStdioHost } from "../../src/stdio.ts";

const agentDir = process.argv[2];

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
	async loginModelProvider(_provider, _authType, onUiRequest) {
		const method = await onUiRequest({
			id: "stdio-auth-method",
			kind: "select",
			title: "模型认证",
			payload: {
				message: "选择认证方式",
				options: [{ id: "bearer-token", label: "Bearer token" }],
			},
		});
		const secret = await onUiRequest({
			id: "stdio-auth-secret",
			kind: "secret",
			title: "模型认证",
			payload: { message: "输入令牌" },
		});
		return [{ method: method.value, secret: secret.value }];
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