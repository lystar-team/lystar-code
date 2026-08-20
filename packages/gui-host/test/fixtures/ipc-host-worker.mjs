import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { serveIpcHost } from "../../src/ipc.ts";
import { GuiHostService } from "../../src/service.ts";

const [agentDir, endpoint] = process.argv.slice(2);

class Runtime {
	listeners = new Set();
	sessionPath = join(agentDir, "session.jsonl");

	constructor() {
		writeFileSync(
			this.sessionPath,
			`${JSON.stringify({ type: "session", version: 3, id: "session", timestamp: new Date().toISOString(), cwd: agentDir })}\n`,
		);
	}

	getSnapshot(writeAccess) {
		return {
			id: "session",
			path: this.sessionPath,
			cwd: agentDir,
			createdAt: 1,
			updatedAt: 1,
			phase: "idle",
			activity: "idle",
			thinkingLevel: "off",
			attached: true,
			writeAccess,
			revision: 0,
			leafId: null,
			queuedSteerCount: 0,
			queuedFollowUpCount: 0,
			transcriptGeneration: "session",
			transcriptRevision: 0,
		};
	}

	async prompt(text) {
		appendFileSync(join(agentDir, "prompt-calls.txt"), `${text}\n`);
		await new Promise((resolve) => setTimeout(resolve, 400));
	}
	async runBash() {
		return { exitCode: 0 };
	}
	async rename() {}
	async setModel() {}
	async setThinkingLevel() {}
	async fork() {
		return { sessionPath: this.sessionPath };
	}
	async abort() {}
	async dispose() {}
	onEvent(listener) {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
}

const runtime = new Runtime();
const adapter = {
	async createSession() {
		return runtime;
	},
	async openSession() {
		return runtime;
	},
	async deleteSession() {},
	async listSessions() {
		return [];
	},
	async listModels() {
		return [];
	},
	async listSkills() {
		return { skills: [], diagnostics: [] };
	},
	async setSkillEnabled() {
		return { skills: [], diagnostics: [] };
	},
	getAbout() {
		return { productVersion: "test-ipc" };
	},
	async getDiagnostics() {
		return { checks: [] };
	},
};

const service = new GuiHostService(adapter, {
	agentDir,
	journalPath: join(agentDir, "operations.jsonl"),
	persistent: true,
});
const server = await serveIpcHost(service, endpoint);
process.stderr.write("ready\n");

const shutdown = async () => {
	await new Promise((resolve) => server.close(resolve));
	await service.dispose();
	process.exit(0);
};
process.once("SIGTERM", () => void shutdown());
process.once("SIGINT", () => void shutdown());
