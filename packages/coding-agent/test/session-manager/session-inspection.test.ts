import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	readSessionHeader,
	readSessionInspection,
	readSessionSnapshot,
	streamSessionEntries,
} from "../../src/core/session-manager.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function sessionFile(entries: Record<string, unknown>[]): string {
	const dir = mkdtempSync(join(tmpdir(), "session-inspection-"));
	dirs.push(dir);
	const path = join(dir, "session.jsonl");
	writeFileSync(path, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
	return path;
}

describe("session inspection", () => {
	it("reads metadata and the last tool-result ID without keeping the full history", async () => {
		const header = {
			type: "session",
			version: 3,
			id: "session-id",
			cwd: "/project",
			timestamp: "2026-09-27T00:00:00Z",
		};
		const entry = (type: string, id: string, parentId: string | null, fields: Record<string, unknown> = {}) => ({
			type,
			id,
			parentId,
			timestamp: "2026-09-27T00:01:00Z",
			...fields,
		});
		const path = sessionFile([
			header,
			entry("message", "first", null, { message: { role: "user", content: "hello" } }),
			entry("session_info", "name", "first", { name: "large session" }),
			entry("model_change", "model", "name", { provider: "provider", modelId: "model-id" }),
			entry("thinking_level_change", "thinking", "model", { thinkingLevel: "high" }),
			entry("message", "last", "thinking", {
				message: {
					role: "toolResult",
					toolName: "read",
					content: [{ type: "text", text: "x".repeat(5 * 1024 * 1024) }],
				},
			}),
		]);
		const inspected = await readSessionInspection(path);
		expect(inspected).toEqual({
			header,
			leafId: "last",
			name: "large session",
			model: { provider: "provider", id: "model-id" },
			thinkingLevel: "high",
		});
		expect(readSessionHeader(path)).toEqual(header);
		expect(readSessionSnapshot(path).leafId).toBe(inspected.leafId);
	});

	it("parses tool results with nonstandard field ordering to preserve their leaf ID", async () => {
		const path = sessionFile([
			{ type: "session", version: 3, id: "session-id", cwd: "/project", timestamp: "2026-09-27T00:00:00Z" },
			{
				type: "message",
				id: "first",
				parentId: null,
				timestamp: "2026-09-27T00:01:00Z",
				message: { role: "user", content: "hi" },
			},
			{
				type: "message",
				timestamp: "2026-09-27T00:02:00Z",
				parentId: "first",
				id: "last",
				message: { role: "toolResult", content: "x".repeat(2048) },
			},
		]);
		expect((await readSessionInspection(path)).leafId).toBe("last");
	});

	it("streams complete entries and retains subagent results with nonstandard field ordering", async () => {
		const path = sessionFile([
			{ type: "session", version: 3, id: "session-id", cwd: "/project", timestamp: "2026-09-27T00:00:00Z" },
			{
				type: "message",
				id: "user",
				parentId: null,
				timestamp: "2026-09-27T00:01:00Z",
				message: { role: "user", content: "hi" },
			},
			{
				type: "message",
				id: "read",
				parentId: "user",
				timestamp: "2026-09-27T00:02:00Z",
				message: { role: "toolResult", toolCallId: "call-1", toolName: "read", content: "x".repeat(1024 * 1024) },
			},
			{
				type: "message",
				id: "subagent",
				parentId: "read",
				timestamp: "2026-09-27T00:03:00Z",
				message: { role: "toolResult", toolCallId: "call-2", toolName: "subagent", details: { results: [] } },
			},
			{
				type: "message",
				id: "unusual",
				parentId: "subagent",
				timestamp: "2026-09-27T00:04:00Z",
				message: {
					role: "toolResult",
					toolCallId: "call-3",
					content: { toolName: "read" },
					toolName: "subagent",
					details: { results: [] },
				},
			},
		]);
		const all: string[] = [];
		for await (const entry of streamSessionEntries(path)) all.push(entry.id);
		expect(all).toEqual(["user", "read", "subagent", "unusual"]);
		const subagents: string[] = [];
		for await (const entry of streamSessionEntries(path, "subagent")) subagents.push(entry.id);
		expect(subagents).toEqual(["user", "subagent", "unusual"]);
	});

	it("keeps legacy migration and read-only snapshot behavior", async () => {
		const path = sessionFile([
			{ type: "session", version: 2, id: "legacy", cwd: "/project", timestamp: "2026-09-27T00:00:00Z" },
			{
				type: "message",
				id: "last",
				parentId: null,
				timestamp: "2026-09-27T00:01:00Z",
				message: { role: "hookMessage", content: "old" },
			},
		]);
		const before = readFileSync(path, "utf8");
		const inspected = await readSessionInspection(path);
		const snapshot = readSessionSnapshot(path);
		expect(inspected.leafId).toBe("last");
		expect(snapshot.entries[0]).toMatchObject({ message: { role: "custom" } });
		expect(Object.isFrozen(snapshot.entries[0])).toBe(true);
		expect(readFileSync(path, "utf8")).toBe(before);
		const streamed = [];
		for await (const entry of streamSessionEntries(path)) streamed.push(entry);
		expect(streamed).toEqual(snapshot.entries);
	});
});
