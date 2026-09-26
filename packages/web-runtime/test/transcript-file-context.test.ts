import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { projectTranscriptBatch } from "../src/transcript-projection.ts";
import { TranscriptReader } from "../src/transcript-reader.ts";

const directories: string[] = [];
afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function sessionFile(entries: Array<Record<string, unknown>>): string {
	const directory = mkdtempSync(join(tmpdir(), "web-file-context-"));
	directories.push(directory);
	const path = join(directory, "session.jsonl");
	writeFileSync(
		path,
		`${[
			{ type: "session", version: 3, id: "session-1", timestamp: "2026-09-26T00:00:00Z", cwd: directory },
			...entries,
		]
			.map((entry) => JSON.stringify(entry))
			.join("\n")}\n`,
	);
	return path;
}

function entry(id: string, parentId: string | null, message: Record<string, unknown>) {
	return { type: "message", id, parentId, timestamp: "2026-09-26T00:00:00Z", message };
}

describe("cross-page file tool context", () => {
	it("recovers read and edit paths without pulling the call entry into the visible page", async () => {
		const path = sessionFile([
			entry("call", null, {
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "read-1",
						name: "read",
						arguments: { path: "src/a.ts", offset: 323, limit: 300 },
					},
					{
						type: "toolCall",
						id: "edit-1",
						name: "edit",
						arguments: { path: "src/b.ts", edits: [{ oldText: "a", newText: "b" }] },
					},
				],
			}),
			{
				type: "custom",
				id: "marker",
				parentId: "call",
				timestamp: "2026-09-26T00:00:00Z",
				customType: "fixture",
				data: {},
			},
			entry("read-result", "marker", {
				role: "toolResult",
				toolName: "read",
				toolCallId: "read-1",
				content: [{ type: "text", text: "source" }],
			}),
			entry("edit-result", "read-result", {
				role: "toolResult",
				toolName: "edit",
				toolCallId: "edit-1",
				content: [{ type: "text", text: "Edited" }],
				details: { additions: 1, deletions: 1, diff: "+b\n-a" },
			}),
			entry("leaf", "edit-result", { role: "user", content: "继续" }),
		]);
		const reader = new TranscriptReader();
		const page = await reader.read(path, { limit: 2 });
		expect(page.items.map((item) => item.entryId)).toEqual(["marker", "read-result", "edit-result", "leaf"]);
		expect(page.contextCalls).toHaveLength(1);
		const projected = projectTranscriptBatch(page.items, page.agentSteps, page.contextCalls);
		expect(projected.find((item) => item.entryId === "read-result")?.view).toMatchObject({
			type: "tool_result",
			summary: '{"path":"src/a.ts","offset":323,"limit":300}',
		});
		expect(projected.find((item) => item.entryId === "edit-result")?.view).toMatchObject({
			type: "tool_result",
			summary: "src/b.ts",
			diff: { files: [{ path: "src/b.ts", diff: "+b\n-a" }] },
		});
		const earlier = await reader.read(path, { cursor: page.previousCursor, limit: 2 });
		expect(earlier.items.map((item) => item.entryId)).toEqual(["call"]);
	});

	it("keeps a real filename equal to the tool name", async () => {
		const path = sessionFile([
			entry("call", null, {
				role: "assistant",
				content: [{ type: "toolCall", id: "read-1", name: "read", arguments: { path: "read" } }],
			}),
			entry("result", "call", {
				role: "toolResult",
				toolName: "read",
				toolCallId: "read-1",
				content: [{ type: "text", text: "source" }],
			}),
		]);
		const page = await new TranscriptReader().read(path, { limit: 2 });
		expect(projectTranscriptBatch(page.items).at(-1)?.view).toMatchObject({
			type: "tool_result",
			summary: '{"path":"read"}',
		});
	});

	it("does not invent a file path for a result with no matching call", async () => {
		const path = sessionFile([
			entry("orphan", null, {
				role: "toolResult",
				toolName: "read",
				toolCallId: "missing",
				content: [{ type: "text", text: "source" }],
			}),
		]);
		const page = await new TranscriptReader().read(path, { limit: 2 });
		expect(page.contextCalls).toBeUndefined();
		expect(projectTranscriptBatch(page.items)[0]?.view).toMatchObject({ type: "tool_result", summary: "read" });
	});
});
