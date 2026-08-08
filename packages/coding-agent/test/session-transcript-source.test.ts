import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	SessionTranscriptSource,
	TranscriptCursorInvalidError,
	TranscriptMigrationRequiredError,
} from "../src/modes/interactive/session-transcript-source.ts";

type Entry = Record<string, unknown>;
const READ_BUFFER_TEST_BYTES = 128 * 1024;

describe("SessionTranscriptSource", () => {
	let tempDir: string;
	let sessionFile: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "session-transcript-source-"));
		sessionFile = join(tempDir, "session.jsonl");
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	function header(version = 3): Entry {
		return { type: "session", version, id: "session-1", timestamp: "2025-01-01T00:00:00Z", cwd: "/tmp" };
	}

	function message(id: string, parentId: string | null): Entry {
		return {
			type: "message",
			id,
			parentId,
			timestamp: "2025-01-01T00:00:00Z",
			message: { role: "user", content: id, timestamp: 1 },
		};
	}

	function assistantToolCall(id: string, parentId: string | null, toolCallId: string): Entry {
		return {
			type: "message",
			id,
			parentId,
			timestamp: "2025-01-01T00:00:00Z",
			message: {
				role: "assistant",
				content: [{ type: "toolCall", id: toolCallId, name: "read", arguments: { path: "a.txt" } }],
				stopReason: "toolUse",
				timestamp: 1,
			},
		};
	}

	function toolResult(id: string, parentId: string, toolCallId: string): Entry {
		return {
			type: "message",
			id,
			parentId,
			timestamp: "2025-01-01T00:00:00Z",
			message: {
				role: "toolResult",
				toolCallId,
				toolName: "read",
				content: [{ type: "text", text: "ok" }],
				isError: false,
				timestamp: 1,
			},
		};
	}

	function writeSession(entries: Entry[]): void {
		writeFileSync(sessionFile, `${[header(), ...entries].map((entry) => JSON.stringify(entry)).join("\n")}\n`);
	}

	function entryIds(entries: { id: string }[]): string[] {
		return entries.map((entry) => entry.id);
	}

	it("reads the tail then pages toward the root in chronological order", async () => {
		writeSession([message("a", null), message("b", "a"), message("c", "b"), message("d", "c")]);
		const source = new SessionTranscriptSource(sessionFile);

		const tail = await source.readTail({ leafId: "d", limit: 2 });
		expect(entryIds(tail.entries)).toEqual(["c", "d"]);
		expect(tail.hasMore).toBe(true);
		expect(tail.previousCursor).toBeDefined();

		const previous = await source.readPrevious(tail.previousCursor!, 2);
		expect(entryIds(previous.entries)).toEqual(["a", "b"]);
		expect(previous.hasMore).toBe(false);
	});

	it("keeps an assistant tool call with its following tool result", async () => {
		writeSession([
			message("root", null),
			assistantToolCall("assistant", "root", "call-1"),
			toolResult("result", "assistant", "call-1"),
			message("leaf", "result"),
		]);
		const source = new SessionTranscriptSource(sessionFile);

		const tail = await source.readTail({ leafId: "leaf", limit: 2 });
		expect(entryIds(tail.entries)).toEqual(["assistant", "result", "leaf"]);
		const previous = await source.readPrevious(tail.previousCursor!, 2);
		expect(entryIds(previous.entries)).toEqual(["root"]);
	});

	it("uses an explicit leaf instead of guessing the physical file tail", async () => {
		writeSession([message("root", null), message("main", "root"), message("sibling", "root")]);
		const source = new SessionTranscriptSource(sessionFile);

		const page = await source.readTail({ leafId: "main", limit: 10 });
		expect(entryIds(page.entries)).toEqual(["root", "main"]);
	});

	it("does not mix sibling branches", async () => {
		writeSession([
			message("root", null),
			message("left", "root"),
			message("left-leaf", "left"),
			message("right", "root"),
			message("right-leaf", "right"),
		]);
		const source = new SessionTranscriptSource(sessionFile);

		const page = await source.readTail({ leafId: "left-leaf", limit: 10 });
		expect(entryIds(page.entries)).toEqual(["root", "left", "left-leaf"]);
	});

	it("keeps history before compaction in the transcript", async () => {
		writeSession([
			message("before", null),
			{
				type: "compaction",
				id: "compact",
				parentId: "before",
				timestamp: "2025-01-01T00:00:00Z",
				summary: "summary",
				firstKeptEntryId: "before",
				tokensBefore: 100,
			},
			message("after", "compact"),
		]);
		const source = new SessionTranscriptSource(sessionFile);

		const tail = await source.readTail({ leafId: "after", limit: 2 });
		expect(entryIds(tail.entries)).toEqual(["compact", "after"]);
		const previous = await source.readPrevious(tail.previousCursor!, 2);
		expect(entryIds(previous.entries)).toEqual(["before"]);
	});

	it("follows invisible control entries without returning them", async () => {
		writeSession([
			message("user", null),
			{
				type: "model_change",
				id: "model",
				parentId: "user",
				timestamp: "2025-01-01T00:00:00Z",
				provider: "test",
				modelId: "model",
			},
			message("assistant", "model"),
		]);
		const source = new SessionTranscriptSource(sessionFile);

		const page = await source.readTail({ leafId: "assistant", limit: 2 });
		expect(entryIds(page.entries)).toEqual(["user", "assistant"]);
	});

	it("pages every TUI-visible entry while skipping hidden custom messages", async () => {
		writeSession([
			message("root", null),
			{
				type: "custom_message",
				id: "hidden",
				parentId: "root",
				timestamp: "2025-01-01T00:00:00Z",
				customType: "status",
				content: "hidden",
				display: false,
			},
			{
				type: "custom_message",
				id: "shown",
				parentId: "hidden",
				timestamp: "2025-01-01T00:00:00Z",
				customType: "status",
				content: "shown",
				display: true,
			},
			{
				type: "branch_summary",
				id: "summary",
				parentId: "shown",
				timestamp: "2025-01-01T00:00:00Z",
				summary: "branch summary",
				fromId: "root",
			},
			message("leaf", "summary"),
		]);
		const source = new SessionTranscriptSource(sessionFile);

		const page = await source.readTail({ leafId: "leaf", limit: 10 });
		expect(entryIds(page.entries)).toEqual(["root", "shown", "summary", "leaf"]);
	});

	it("skips malformed lines like SessionManager", async () => {
		writeFileSync(
			sessionFile,
			`${JSON.stringify(header())}\n${JSON.stringify(message("root", null))}\n{not json}\n${JSON.stringify(message("leaf", "root"))}\n`,
		);
		const source = new SessionTranscriptSource(sessionFile);

		const page = await source.readTail({ leafId: "leaf", limit: 10 });
		expect(entryIds(page.entries)).toEqual(["root", "leaf"]);
	});

	it("keeps the file open while a page crosses multiple read buffers", async () => {
		writeSession([
			message("root", null),
			{
				type: "model_change",
				id: "large-control",
				parentId: "root",
				timestamp: "2025-01-01T00:00:00Z",
				provider: "test",
				modelId: "model",
				padding: "x".repeat(READ_BUFFER_TEST_BYTES),
			},
			message("leaf", "large-control"),
		]);
		const source = new SessionTranscriptSource(sessionFile);

		const page = await source.readTail({ leafId: "leaf", limit: 2 });
		expect(entryIds(page.entries)).toEqual(["root", "leaf"]);
	});

	it("continues an old cursor after the file is appended", async () => {
		writeSession([message("a", null), message("b", "a"), message("c", "b")]);
		const source = new SessionTranscriptSource(sessionFile);
		const tail = await source.readTail({ leafId: "c", limit: 1 });
		appendFileSync(sessionFile, `${JSON.stringify(message("d", "c"))}\n`);

		const previous = await source.readPrevious(tail.previousCursor!, 1);
		expect(entryIds(previous.entries)).toEqual(["b"]);
	});

	it("invalidates cursors after a rewrite and after reset", async () => {
		writeSession([message("a", null), message("b", "a"), message("c", "b")]);
		const source = new SessionTranscriptSource(sessionFile);
		const rewrittenCursor = (await source.readTail({ leafId: "c", limit: 1 })).previousCursor!;
		writeSession([message("a", null), message("b", "a"), message("x", "b")]);
		await expect(source.readPrevious(rewrittenCursor, 1)).rejects.toBeInstanceOf(TranscriptCursorInvalidError);

		const resetCursor = (await source.readTail({ leafId: "x", limit: 1 })).previousCursor!;
		source.reset("a");
		await expect(source.readPrevious(resetCursor, 1)).rejects.toBeInstanceOf(TranscriptCursorInvalidError);
	});

	it("finds the persisted tail only when the caller has no leaf", async () => {
		writeSession([message("a", null), message("b", "a")]);
		const source = new SessionTranscriptSource(sessionFile);

		const page = await source.readTail({ leafId: null, limit: 10 });
		expect(entryIds(page.entries)).toEqual(["a", "b"]);
	});

	it("requires full open and migration for old session versions", async () => {
		writeFileSync(sessionFile, `${JSON.stringify(header(2))}\n${JSON.stringify(message("a", null))}\n`);
		const source = new SessionTranscriptSource(sessionFile);

		await expect(source.readTail({ leafId: "a", limit: 1 })).rejects.toBeInstanceOf(TranscriptMigrationRequiredError);
	});
});
