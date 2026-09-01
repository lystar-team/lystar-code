import { type ChildProcessByStdio, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import { GuiCompanionServer, getGuiCompanionEndpoint } from "../src/core/gui-companion.ts";

const tempDirs = new Set<string>();
type SpawnedChild = ChildProcessByStdio<null, Readable, null>;
const children = new Set<SpawnedChild>();

function createSession(sessionPath: string): AgentSession {
	return {
		sessionFile: sessionPath,
		sessionManager: {
			getEntries: () => [],
		},
		subscribe: () => () => {},
	} as unknown as AgentSession;
}

function waitForExit(child: SpawnedChild): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
	return new Promise((resolve) => child.once("exit", () => resolve()));
}

async function startStaleListener(endpoint: string): Promise<void> {
	const child = spawn(
		process.execPath,
		[
			"-e",
			"const net = require('node:net'); const server = net.createServer(); server.listen(process.argv[1], () => process.stdout.write('ready\\n')); setInterval(() => {}, 1000);",
			endpoint,
		],
		{ stdio: ["ignore", "pipe", "ignore"] },
	);
	children.add(child);
	await new Promise<void>((resolve, reject) => {
		let output = "";
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			output += chunk;
			if (output.includes("ready")) resolve();
		});
		child.once("error", reject);
		child.once("exit", (code) => reject(new Error(`stale listener exited early: ${code}`)));
	});
	child.kill("SIGKILL");
	await waitForExit(child);
}

afterEach(async () => {
	for (const child of children) {
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
	}
	await Promise.all([...children].map(waitForExit));
	children.clear();
	for (const directory of tempDirs) rmSync(directory, { recursive: true, force: true });
	tempDirs.clear();
});

describe("GuiCompanionServer", () => {
	it("does not replace an active companion endpoint", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "lystar-gui-companion-"));
		tempDirs.add(agentDir);
		const sessionPath = join(agentDir, "session.jsonl");
		writeFileSync(sessionPath, "{}\n");
		const endpoint = getGuiCompanionEndpoint(agentDir, sessionPath);
		const first = new GuiCompanionServer(createSession(sessionPath), agentDir);
		const second = new GuiCompanionServer(createSession(sessionPath), agentDir);

		await first.start();
		await expect(second.start()).rejects.toThrow(`GUI companion is already running at ${endpoint}`);
		expect(existsSync(endpoint)).toBe(true);

		await second.dispose();
		await first.dispose();
		expect(existsSync(endpoint)).toBe(false);
	});

	it.runIf(process.platform !== "win32")("recovers from a stale Unix socket", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "lystar-gui-companion-"));
		tempDirs.add(agentDir);
		const sessionPath = join(agentDir, "session.jsonl");
		writeFileSync(sessionPath, "{}\n");
		const endpoint = getGuiCompanionEndpoint(agentDir, sessionPath);
		mkdirSync(join(agentDir, "host", "companions"), { recursive: true });
		await startStaleListener(endpoint);
		expect(existsSync(endpoint)).toBe(true);

		const server = new GuiCompanionServer(createSession(sessionPath), agentDir);
		await server.start();
		expect(existsSync(endpoint)).toBe(true);
		await server.dispose();
		expect(existsSync(endpoint)).toBe(false);
	});
});
