import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	getWebCompanionEndpoint,
	getWebSessionHandoffEndpoint,
} from "../../coding-agent/src/core/web-companion-contract.ts";
import type { RuntimeEvent } from "../src/types.ts";
import { WebCompanionProtocolError, WebCompanionRuntime } from "../src/web-companion-runtime.ts";

const cleanup: Array<() => Promise<void> | void> = [];

afterEach(async () => {
	while (cleanup.length > 0) await cleanup.pop()?.();
});

async function serveSnapshot(
	createSnapshot: (sessionPath: string, cwd: string) => Record<string, unknown>,
	tail = "",
	closeBeforeReady = false,
	fragment = false,
): Promise<{ agentDir: string; sessionPath: string }> {
	const agentDir = mkdtempSync(join(tmpdir(), "gcr-"));
	const sessionPath = join(agentDir, "s.jsonl");
	const endpoint = getWebCompanionEndpoint(agentDir, sessionPath);
	mkdirSync(join(agentDir, "host", "companions"), { recursive: true });
	const snapshot = createSnapshot(sessionPath, agentDir);
	const server: Server = createServer((socket) => {
		let buffer = "";
		socket.on("data", (chunk) => {
			buffer += chunk.toString();
			if (!buffer.includes("\n")) return;
			if (closeBeforeReady) {
				socket.destroy();
				return;
			}
			const bytes = Buffer.from(`${JSON.stringify({ type: "ready", snapshot })}\n${tail}`);
			if (fragment) {
				const split = bytes.indexOf(Buffer.from("中文")) + 1;
				socket.write(bytes.subarray(0, split));
				setTimeout(() => socket.write(bytes.subarray(split)), 5);
			} else socket.write(bytes);
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

describe("WebCompanionRuntime 协议协商", () => {
	it("长 Agent 目录使用受限长度的 Unix Socket 路径", () => {
		if (process.platform === "win32") return;
		const agentDir = join(tmpdir(), "a".repeat(160));
		const sessionPath = join(agentDir, "sessions", "session.jsonl");
		for (const endpoint of [
			getWebCompanionEndpoint(agentDir, sessionPath),
			getWebSessionHandoffEndpoint(agentDir, sessionPath),
		]) {
			expect(Buffer.byteLength(endpoint)).toBeLessThanOrEqual(100);
			expect(endpoint.startsWith(agentDir)).toBe(false);
		}
	});

	it("握手粘包保留实时事件直到订阅接管", async () => {
		const tail = `${JSON.stringify({ type: "agent_event", event: { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "保留消息" } } })}\n`;
		const server = await serveSnapshot(baseSnapshot, tail);
		const runtime = await WebCompanionRuntime.open(server.agentDir, server.sessionPath);
		try {
			const events: RuntimeEvent[] = [];
			runtime.onEvent((event) => {
				events.push(event);
			});
			expect(events).toEqual([{ type: "progress", payload: { type: "assistant_delta", text: "保留消息" } }]);
			expect(runtime.getToolRecoveryDiagnostics()).toBeUndefined();
		} finally {
			await runtime.dispose();
		}
	});
	it("提交事件同步更新 Transcript 快照版本", async () => {
		const tail = `${JSON.stringify({
			type: "entry_committed",
			items: [],
			transcriptGeneration: "generation-2",
			fromRevision: 0,
			transcriptRevision: 128,
		})}\n`;
		const server = await serveSnapshot(baseSnapshot, tail);
		const runtime = await WebCompanionRuntime.open(server.agentDir, server.sessionPath);
		try {
			const events: RuntimeEvent[] = [];
			runtime.onEvent((event) => {
				events.push(event);
			});
			expect(runtime.getSnapshot("available")).toMatchObject({
				transcriptGeneration: "generation-2",
				transcriptRevision: 128,
			});
			expect(events).toEqual([
				expect.objectContaining({
					type: "entry_committed",
					payload: expect.objectContaining({ transcriptRevision: 128 }),
				}),
			]);
		} finally {
			await runtime.dispose();
		}
	});
	it("握手中文跨 UTF-8 字节分片仍完整", async () => {
		const server = await serveSnapshot(
			(path, cwd) => ({ ...baseSnapshot(path, cwd), name: "中文会话" }),
			"",
			false,
			true,
		);
		const runtime = await WebCompanionRuntime.open(server.agentDir, server.sessionPath);
		try {
			expect(runtime.getSnapshot("available").name).toBe("中文会话");
		} finally {
			await runtime.dispose();
		}
	});
	it("握手前关闭不会留下等待", async () => {
		const server = await serveSnapshot(baseSnapshot, "", true);
		await expect(WebCompanionRuntime.open(server.agentDir, server.sessionPath)).rejects.toThrow("关闭");
	});
	it("兼容旧 v1 握手，并只声明旧版基础能力", async () => {
		const server = await serveSnapshot((sessionPath, cwd) => baseSnapshot(sessionPath, cwd));
		const runtime = await WebCompanionRuntime.open(server.agentDir, server.sessionPath);

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

		await expect(WebCompanionRuntime.open(server.agentDir, server.sessionPath)).rejects.toMatchObject({
			code: "web_companion_protocol_incompatible",
		});
	});

	it("拒绝未知 Companion 协议版本", async () => {
		const server = await serveSnapshot((sessionPath, cwd) => ({
			...baseSnapshot(sessionPath, cwd),
			protocolVersion: 99,
			capabilities: [],
		}));

		await expect(WebCompanionRuntime.open(server.agentDir, server.sessionPath)).rejects.toBeInstanceOf(
			WebCompanionProtocolError,
		);
	});

	it("投影压缩、摘要重试和完成事件的完整顺序", async () => {
		const tail = `${[
			{ type: "agent_event", event: { type: "compaction_start", reason: "manual" } },
			{
				type: "agent_event",
				event: {
					type: "compaction_end",
					reason: "manual",
					result: {},
					aborted: false,
					willRetry: false,
				},
			},
			{
				type: "agent_event",
				event: {
					type: "summarization_retry_scheduled",
					attempt: 1,
					maxAttempts: 2,
					delayMs: 250,
					errorMessage: "temporary",
				},
			},
			{
				type: "agent_event",
				event: { type: "summarization_retry_attempt_start", source: "compaction", reason: "manual" },
			},
			{ type: "agent_event", event: { type: "summarization_retry_finished" } },
		]
			.map((message) => JSON.stringify(message))
			.join("\n")}\n`;
		const server = await serveSnapshot(baseSnapshot, tail);
		const runtime = await WebCompanionRuntime.open(server.agentDir, server.sessionPath);
		try {
			const events: RuntimeEvent[] = [];
			runtime.onEvent((event) => events.push(event));
			expect(events.flatMap((event) => (event.type === "progress" ? [event.payload] : []))).toEqual([
				{ type: "phase", phase: "compaction" },
				{ type: "compaction", status: "running", reason: "manual" },
				{ type: "compaction", status: "completed", reason: "manual" },
				{ type: "phase", phase: "retry" },
				{
					type: "retry",
					status: "waiting",
					kind: "summarization",
					attempt: 1,
					maxAttempts: 2,
					delayMs: 250,
					error: "temporary",
				},
				{ type: "phase", phase: "compaction" },
				{ type: "compaction", status: "running", reason: "manual" },
				{ type: "retry", status: "running", kind: "compaction" },
				{ type: "retry", status: "completed", kind: "summarization" },
			]);
		} finally {
			await runtime.dispose();
		}
	});
});
