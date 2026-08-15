import { appendFileSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TranscriptCursorInvalidError, TranscriptReader } from "../src/transcript-reader.ts";

type Entry = Record<string, unknown>;

describe("TranscriptReader", () => {
	let tempDir: string;
	let sessionPath: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "gui-host-transcript-"));
		sessionPath = join(tempDir, "session.jsonl");
	});

	afterEach(() => rmSync(tempDir, { recursive: true, force: true }));

	function header(): Entry {
		return { type: "session", version: 3, id: "session-1", timestamp: "2026-08-13T00:00:00Z", cwd: tempDir };
	}

	function message(id: string, parentId: string | null, role = "user"): Entry {
		return {
			type: "message",
			id,
			parentId,
			timestamp: "2026-08-13T00:00:00Z",
			message: { role, content: id, timestamp: 1 },
		};
	}

	function write(entries: Entry[]): void {
		writeFileSync(sessionPath, `${[header(), ...entries].map((entry) => JSON.stringify(entry)).join("\n")}\n`);
	}

	it("keeps generation stable on append and invalidates a cursor after rewrite", async () => {
		write([message("a", null), message("b", "a"), message("c", "b")]);
		const reader = new TranscriptReader();
		const first = await reader.read(sessionPath, { limit: 1 });
		appendFileSync(sessionPath, `${JSON.stringify(message("d", "c"))}\n`);
		const appended = await reader.read(sessionPath, { limit: 1 });

		expect(appended.transcriptGeneration).toBe(first.transcriptGeneration);
		expect(appended.transcriptRevision).toBeGreaterThan(first.transcriptRevision);
		expect(
			(await reader.read(sessionPath, { cursor: first.previousCursor, limit: 10 })).items.map(
				(item) => item.entryId,
			),
		).toEqual(["a", "b"]);

		const replacement = join(tempDir, "replacement.jsonl");
		writeFileSync(
			replacement,
			`${[header(), message("x", null)].map((entry) => JSON.stringify(entry)).join("\n")}\n`,
		);
		renameSync(replacement, sessionPath);
		const rewritten = await reader.read(sessionPath, { limit: 10 });
		expect(rewritten.transcriptGeneration).not.toBe(first.transcriptGeneration);
		await expect(reader.read(sessionPath, { cursor: first.previousCursor, limit: 10 })).rejects.toBeInstanceOf(
			TranscriptCursorInvalidError,
		);
	});

	it("does not expose or advance past an unterminated JSONL tail", async () => {
		write([message("a", null)]);
		const reader = new TranscriptReader();
		const complete = await reader.read(sessionPath, { limit: 10 });
		const pending = message("b", "a");
		appendFileSync(sessionPath, JSON.stringify(pending));
		const incomplete = await reader.read(sessionPath, { limit: 10 });

		expect(incomplete.items.map((item) => item.entryId)).toEqual(["a"]);
		expect(incomplete.transcriptGeneration).toBe(complete.transcriptGeneration);
		expect(incomplete.transcriptRevision).toBe(complete.transcriptRevision);

		appendFileSync(sessionPath, "\n");
		const committed = await reader.read(sessionPath, { limit: 10 });
		expect(committed.items.map((item) => item.entryId)).toEqual(["a", "b"]);
		expect(committed.transcriptGeneration).toBe(complete.transcriptGeneration);
		expect(committed.transcriptRevision).toBeGreaterThan(complete.transcriptRevision);
	});

	it("returns an empty page for a known active session before JSONL materializes", async () => {
		const page = await new TranscriptReader().read(sessionPath, { limit: 20, emptyGeneration: "session-1" });
		expect(page).toEqual({
			items: [],
			hasMorePrevious: false,
			leafId: null,
			transcriptGeneration: "session-1",
			transcriptRevision: 0,
		});
	});

	it("reads headers and transcript entries across large JSONL lines", async () => {
		const largeText = "x".repeat(256 * 1024);
		writeFileSync(
			sessionPath,
			`${largeText}\n${[
				header(),
				{ ...message("large", null), message: { role: "user", content: largeText, timestamp: 1 } },
				message("leaf", "large"),
			]
				.map((entry) => JSON.stringify(entry))
				.join("\n")}\n`,
		);

		const page = await new TranscriptReader().read(sessionPath, { limit: 10 });
		expect(page.items.map((item) => item.entryId)).toEqual(["large", "leaf"]);
		expect((page.items[0].payload as { message: { content: string } }).message.content).toHaveLength(
			largeText.length,
		);
	});

	it("keeps an assistant tool call with its tool result", async () => {
		write([
			message("root", null),
			{
				...message("assistant", "root", "assistant"),
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "a.txt" } }],
					stopReason: "toolUse",
					timestamp: 1,
				},
			},
			{
				...message("result", "assistant", "toolResult"),
				message: {
					role: "toolResult",
					toolCallId: "call-1",
					toolName: "read",
					content: [{ type: "text", text: "ok" }],
					isError: false,
					timestamp: 1,
				},
			},
			message("leaf", "result"),
		]);

		const page = await new TranscriptReader().read(sessionPath, { limit: 2 });
		expect(page.items.map((item) => item.entryId)).toEqual(["assistant", "result", "leaf"]);
	});

	it("searches a bounded generation cache without exposing incomplete tails", async () => {
		write([
			message("a", null),
			message("needle", "a", "assistant"),
			message("needle-second", "needle", "assistant"),
			message("tail", "needle-second"),
		]);
		const reader = new TranscriptReader();
		const first = await reader.search(sessionPath, { query: "needle", limit: 1 });
		expect(first.hits).toEqual([
			expect.objectContaining({
				entryId: "needle",
				kind: "message",
				matches: expect.arrayContaining([{ start: expect.any(Number), end: expect.any(Number) }]),
			}),
		]);
		expect(first.nextCursor).toBeDefined();
		appendFileSync(sessionPath, JSON.stringify(message("pending", "tail", "assistant")));
		const incomplete = await reader.search(sessionPath, { query: "pending", limit: 10 });
		expect(incomplete.hits).toEqual([]);
		appendFileSync(sessionPath, "\n");
		const appended = await reader.search(sessionPath, { query: "pending", limit: 10 });
		expect(appended.hits.map((hit) => hit.entryId)).toEqual(["pending"]);

		const replacement = join(tempDir, "replacement.jsonl");
		writeFileSync(
			replacement,
			`${[header(), message("rewritten", null)].map((entry) => JSON.stringify(entry)).join("\n")}\n`,
		);
		renameSync(replacement, sessionPath);
		await expect(
			reader.search(sessionPath, { query: "needle", cursor: first.nextCursor, limit: 10 }),
		).rejects.toBeInstanceOf(TranscriptCursorInvalidError);
	});

	it("keeps 10000 tool rounds pageable and hot searches under 50ms p95", async () => {
		const entries: Entry[] = [];
		let parentId: string | null = null;
		for (let index = 0; index < 10_000; index++) {
			const callId = `call-${index}`;
			const assistantId = `assistant-${index}`;
			const resultId = `result-${index}`;
			entries.push({
				...message(assistantId, parentId, "assistant"),
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: callId, name: "read", arguments: { path: `src/${index}.ts` } }],
					stopReason: "toolUse",
					timestamp: index,
				},
			});
			entries.push({
				...message(resultId, assistantId, "toolResult"),
				message: {
					role: "toolResult",
					toolCallId: callId,
					toolName: "read",
					content: [{ type: "text", text: `needle round ${index}` }],
					isError: false,
					timestamp: index,
				},
			});
			parentId = resultId;
		}
		write(entries);
		const reader = new TranscriptReader();
		const tail = await reader.read(sessionPath, { limit: 200 });
		expect(tail.items).toHaveLength(200);
		expect(tail.items.at(-1)?.entryId).toBe("result-9999");
		const samples: number[] = [];
		for (let index = 0; index < 25; index++) {
			const started = performance.now();
			const result = await reader.search(sessionPath, { query: "needle round 9999", limit: 10 });
			samples.push(performance.now() - started);
			expect(result.hits.map((hit) => hit.entryId)).toEqual(["result-9999"]);
		}
		samples.sort((left, right) => left - right);
		expect(samples[Math.ceil(samples.length * 0.95) - 1]).toBeLessThanOrEqual(50);
	});
});
