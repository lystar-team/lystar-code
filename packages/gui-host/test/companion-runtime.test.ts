import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getGuiCompanionEndpoint } from "../../coding-agent/src/core/gui-companion-contract.ts";
import { GuiCompanionProtocolError, GuiCompanionRuntime } from "../src/companion-runtime.ts";

const cleanup: Array<() => Promise<void> | void> = [];

afterEach(async () => {
	while (cleanup.length > 0) await cleanup.pop()?.();
});

async function serveSnapshot(
	createSnapshot: (sessionPath: string, cwd: string) => Record<string, unknown>,
): Promise<{ agentDir: string; sessionPath: string }> {
	const agentDir = mkdtempSync(join(tmpdir(), "gcr-"));
	const sessionPath = join(agentDir, "s.jsonl");
	const endpoint = getGuiCompanionEndpoint(agentDir, sessionPath);
	mkdirSync(join(agentDir, "host", "companions"), { recursive: true });
	const snapshot = createSnapshot(sessionPath, agentDir);
	const server: Server = createServer((socket) => {
		let buffer = "";
		socket.on("data", (chunk) => {
			buffer += chunk.toString();
			if (!buffer.includes("\n")) return;
			socket.write(`${JSON.stringify({ type: "ready", snapshot })}\n`);
		});
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(endpoint, resolve);
	});
	cleanup.push(async () => {
		await new Promise<void>((resolve) => server.close(() => resolve()));
		rmSync(agentDir, { recursive: true, force: true });
	});
	return { agentDir, sessionPath };
}

function baseSnapshot(sessionPath: string, cwd: string): Record<string, unknown> {
	return {
		id: "test-session",
		path: sessionPath,
		cwd,
		createdAt: 1,
		updatedAt: 1,
		phase: "idle",
		activity: "idle",
		thinkingLevel: "off",
		leafId: null,
		queuedSteerCount: 0,
		queuedFollowUpCount: 0,
		transcriptGeneration: "generation",
		transcriptRevision: 0,
		toolActivityEpoch: "epoch",
		toolActivityRevision: 0,
		toolActivities: [],
	};
}

describe("GuiCompanionRuntime 协议协商", () => {
	it("兼容旧 v1 握手，并只声明旧版基础能力", async () => {
		const server = await serveSnapshot((sessionPath, cwd) => baseSnapshot(sessionPath, cwd));
		const runtime = await GuiCompanionRuntime.open(server.agentDir, server.sessionPath);

		expect(runtime.getCapabilities()).toEqual([
			"prompt",
			"steer",
			"follow_up",
			"clear_queue",
			"abort",
			"model",
			"thinking",
			"completion",
		]);
		expect(runtime.getSnapshot("owned").writeAccess).toBe("owned");
		await runtime.dispose();
	});

	it("拒绝缺少 v2 能力清单的握手", async () => {
		const server = await serveSnapshot((sessionPath, cwd) => ({
			...baseSnapshot(sessionPath, cwd),
			protocolVersion: 2,
		}));

		await expect(GuiCompanionRuntime.open(server.agentDir, server.sessionPath)).rejects.toMatchObject({
			code: "gui_companion_protocol_incompatible",
		});
	});

	it("拒绝未知 Companion 协议版本", async () => {
		const server = await serveSnapshot((sessionPath, cwd) => ({
			...baseSnapshot(sessionPath, cwd),
			protocolVersion: 99,
			capabilities: [],
		}));

		await expect(GuiCompanionRuntime.open(server.agentDir, server.sessionPath)).rejects.toBeInstanceOf(
			GuiCompanionProtocolError,
		);
	});
});
