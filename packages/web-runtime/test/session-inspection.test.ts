import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RUNTIME_PROTOCOL_VERSION, type ServerMessage } from "@lystar/code-web-protocol";
import { describe, expect, it } from "vitest";
import { CodingAgentRuntimeAdapter } from "../src/runtime-adapter.ts";
import { WebRuntimeService } from "../src/service.ts";

describe("Web Runtime session inspection", () => {
	it("keeps bootstrap and inspection responsive for large tool results", async () => {
		const root = mkdtempSync(join(tmpdir(), "web-session-inspection-"));
		const agentDir = join(root, "agent");
		const cwd = join(root, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });
		const sessionPath = join(root, "session.jsonl");
		writeFileSync(
			sessionPath,
			`${[
				{ type: "session", version: 3, id: "session-id", cwd, timestamp: "2026-09-27T00:00:00Z" },
				{ type: "session_info", id: "name", parentId: null, timestamp: "2026-09-27T00:01:00Z", name: "inspected" },
				{
					type: "message",
					id: "last",
					parentId: "name",
					timestamp: "2026-09-27T00:02:00Z",
					message: {
						role: "toolResult",
						toolName: "read",
						content: [{ type: "text", text: "x".repeat(5 * 1024 * 1024) }],
					},
				},
			]
				.map((entry) => JSON.stringify(entry))
				.join("\n")}\n`,
		);
		const adapter = new CodingAgentRuntimeAdapter({ agentDir });
		const service = new WebRuntimeService(adapter, { agentDir, startupSessionPath: sessionPath });
		const responses: ServerMessage[] = [];
		const connection = service.createConnection(async (message) => {
			responses.push(message);
		});
		try {
			await connection.handle({ type: "hello", version: RUNTIME_PROTOCOL_VERSION, clientInstanceId: "browser" });
			await connection.handle({ type: "request", id: "bootstrap", request: { command: "get_snapshot" } });
			await connection.handle({
				type: "request",
				id: "inspection",
				request: { command: "inspect_session", sessionPath },
			});
			expect(responses).toContainEqual(
				expect.objectContaining({
					type: "response",
					id: "bootstrap",
					ok: true,
					result: expect.objectContaining({ startupSessionPath: sessionPath, startupCwd: cwd }),
				}),
			);
			expect(responses).toContainEqual(
				expect.objectContaining({
					type: "response",
					id: "inspection",
					ok: true,
					result: expect.objectContaining({ id: "session-id", name: "inspected", leafId: "last", cwd }),
				}),
			);
			await connection.handle({
				type: "request",
				id: "tree",
				request: { command: "get_session_tree", sessionPath },
			});
			await connection.handle({
				type: "request",
				id: "subagents",
				request: { command: "list_subagents", sessionPath },
			});
			await connection.handle({
				type: "request",
				id: "subagent",
				request: { command: "read_subagent", sessionPath, agentId: "missing" },
			});
			expect(responses).toContainEqual(
				expect.objectContaining({ type: "response", id: "subagents", ok: true, result: [] }),
			);
			expect(responses).toContainEqual(
				expect.objectContaining({ type: "response", id: "subagent", ok: true, result: {} }),
			);
			const tree = responses.find((message) => message.type === "response" && message.id === "tree");
			expect(tree).toMatchObject({
				type: "response",
				ok: true,
				result: [
					expect.objectContaining({ id: "name", depth: 0 }),
					expect.objectContaining({
						id: "last",
						depth: 1,
						isLeaf: true,
						preview: expect.stringContaining('"role":"toolResult"'),
					}),
				],
			});
			expect(adapter.listSettings(sessionPath).length).toBeGreaterThan(0);
		} finally {
			await connection.close();
			await service.dispose();
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("keeps the Runtime connection alive when a cold session tree exceeds the transport frame", async () => {
		const root = mkdtempSync(join(tmpdir(), "web-session-tree-limit-"));
		const agentDir = join(root, "agent");
		mkdirSync(agentDir, { recursive: true });
		const sessionPath = join(root, "session.jsonl");
		const entries: string[] = [
			JSON.stringify({
				type: "session",
				version: 3,
				id: "session-id",
				cwd: root,
				timestamp: "2026-09-27T00:00:00Z",
			}),
		];
		let parentId: string | null = null;
		for (let index = 0; index < 4300; index++) {
			const id = `entry-${index}`;
			entries.push(
				JSON.stringify({
					type: "message",
					id,
					parentId,
					timestamp: "2026-09-27T00:01:00Z",
					message: { role: "user", content: "x".repeat(4096) },
				}),
			);
			parentId = id;
		}
		writeFileSync(sessionPath, `${entries.join("\n")}\n`);
		const service = new WebRuntimeService(new CodingAgentRuntimeAdapter({ agentDir }), { agentDir });
		const responses: ServerMessage[] = [];
		const connection = service.createConnection(async (message) => {
			responses.push(message);
		});
		try {
			await connection.handle({ type: "hello", version: RUNTIME_PROTOCOL_VERSION, clientInstanceId: "browser" });
			await connection.handle({
				type: "request",
				id: "tree",
				request: { command: "get_session_tree", sessionPath },
			});
			expect(responses).toContainEqual(
				expect.objectContaining({
					type: "response",
					id: "tree",
					ok: false,
					error: expect.objectContaining({ code: "session_tree_too_large" }),
				}),
			);
			await connection.handle({
				type: "request",
				id: "inspection",
				request: { command: "inspect_session", sessionPath },
			});
			expect(responses).toContainEqual(
				expect.objectContaining({
					type: "response",
					id: "inspection",
					ok: true,
					result: expect.objectContaining({ leafId: parentId }),
				}),
			);
		} finally {
			await connection.close();
			await service.dispose();
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("returns committed subagent results from an unloaded session", async () => {
		const root = mkdtempSync(join(tmpdir(), "web-subagent-inspection-"));
		const agentDir = join(root, "agent");
		const cwd = join(root, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });
		const sessionPath = join(root, "session.jsonl");
		writeFileSync(
			sessionPath,
			`${[
				{ type: "session", version: 3, id: "session-id", cwd, timestamp: "2026-09-27T00:00:00Z" },
				{
					type: "message",
					id: "read",
					parentId: null,
					timestamp: "2026-09-27T00:01:00Z",
					message: {
						role: "toolResult",
						toolCallId: "call-1",
						toolName: "read",
						content: "x".repeat(5 * 1024 * 1024),
					},
				},
				{
					type: "message",
					id: "agent",
					parentId: "read",
					timestamp: "2026-09-27T00:02:00Z",
					message: {
						role: "toolResult",
						toolCallId: "call-2",
						toolName: "subagent",
						details: {
							results: [
								{ runId: "run-1", agentId: "agent-1", agent: "explore", task: "inspect", state: "succeeded" },
							],
						},
					},
				},
			]
				.map((entry) => JSON.stringify(entry))
				.join("\n")}\n`,
		);
		try {
			const adapter = new CodingAgentRuntimeAdapter({ agentDir });
			const subagents = await adapter.listSubagents(sessionPath);
			expect(subagents).toEqual([
				expect.objectContaining({ runId: "run-1", agentId: "agent-1", agent: "explore", task: "inspect" }),
			]);
			expect(await adapter.readSubagent(sessionPath, "agent-1")).toEqual({ transcript: subagents[0] });
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
