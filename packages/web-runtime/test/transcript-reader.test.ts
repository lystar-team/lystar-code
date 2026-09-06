import { appendFileSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TranscriptCursorInvalidError, TranscriptReader } from "../src/transcript-reader.ts";

type Entry = Record<string, unknown>;

describe("TranscriptReader", () => {
	let tempDir: string;
	let sessionPath: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "web-runtime-transcript-"));
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
			complete: true,
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

	it("rejects search cursors after either matching or nonmatching appends", async () => {
		for (const [id, text] of [
			["matching", "needle matching"],
			["nonmatching", "other content"],
		] as const) {
			write([
				message("root", null, "assistant"),
				message("needle-one", "root", "assistant"),
				message("needle-two", "needle-one", "assistant"),
			]);
			const reader = new TranscriptReader();
			const first = await reader.search(sessionPath, { query: "needle", limit: 1 });
			expect(first.nextCursor).toBeDefined();
			appendFileSync(
				sessionPath,
				`${JSON.stringify({ ...message(id, "needle-two", "assistant"), message: { role: "assistant", content: text, timestamp: 1 } })}\n`,
			);
			await expect(
				reader.search(sessionPath, { query: "needle", cursor: first.nextCursor, limit: 1 }),
			).rejects.toMatchObject({
				code: "cursor_stale",
			});

			const entryIds: string[] = [];
			let page = await reader.search(sessionPath, { query: "needle", limit: 1 });
			while (true) {
				entryIds.push(...page.hits.map((hit) => hit.entryId));
				if (!page.nextCursor) break;
				page = await reader.search(sessionPath, { query: "needle", cursor: page.nextCursor, limit: 1 });
			}
			expect(entryIds).toEqual(id === "matching" ? ["needle-one", "needle-two", id] : ["needle-one", "needle-two"]);
			expect(new Set(entryIds).size).toBe(entryIds.length);
		}
	});

	it("rejects a JSONL line before accumulating beyond the configured bound", async () => {
		writeFileSync(sessionPath, `${"x".repeat(4 * 1024 * 1024 + 1)}\n${JSON.stringify(header())}\n`);
		await expect(new TranscriptReader().read(sessionPath, { limit: 1 })).rejects.toMatchObject({
			code: "transcript_line_too_large",
		});
	});

	it("invalidates cursors and search state after an in-place same-length early rewrite", async () => {
		write([message("aaaa", null), message("bbbb", "aaaa"), message("cccc", "bbbb")]);
		const reader = new TranscriptReader();
		const page = await reader.read(sessionPath, { limit: 1 });
		const search = await reader.search(sessionPath, { query: "user", limit: 1 });
		expect(search.nextCursor).toBeDefined();
		const beforeSize = readFileSync(sessionPath, "utf8").length;
		const original = JSON.stringify(message("aaaa", null));
		const replacement = JSON.stringify(message("zzzz", null));
		expect(replacement).toHaveLength(original.length);
		const body = `${[header(), JSON.parse(replacement), message("bbbb", "zzzz"), message("cccc", "bbbb")]
			.map((entry) => JSON.stringify(entry))
			.join("\n")}\n`;
		expect(body).toHaveLength(beforeSize);
		writeFileSync(sessionPath, body);
		await expect(reader.read(sessionPath, { cursor: page.previousCursor, limit: 10 })).rejects.toBeInstanceOf(
			TranscriptCursorInvalidError,
		);
		await expect(
			reader.search(sessionPath, { query: "user", cursor: search.nextCursor, limit: 10 }),
		).rejects.toBeInstanceOf(TranscriptCursorInvalidError);
	});

	it("keeps oversized raw Tool payloads out of the cached search projection", async () => {
		write([message("large", null, "assistant"), message("tail", "large")]);
		const oversized = `${"x".repeat(300 * 1024)} disk-needle`;
		writeFileSync(
			sessionPath,
			`${[
				header(),
				{
					...message("large", null, "assistant"),
					message: { role: "assistant", content: oversized, timestamp: 1 },
				},
				message("tail", "large"),
			]
				.map((entry) => JSON.stringify(entry))
				.join("\n")}\n`,
		);
		const result = await new TranscriptReader().search(sessionPath, { query: "disk-needle", limit: 10 });
		expect(result.complete).toBe(true);
		expect(result.hits).toEqual([]);
		expect((await new TranscriptReader().search(sessionPath, { query: "assistant", limit: 10 })).hits).toEqual([
			expect.objectContaining({ entryId: "large" }),
		]);
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

		const readIds: string[] = [];
		let readPage = tail;
		while (true) {
			readIds.unshift(...readPage.items.map((item) => item.entryId));
			if (!readPage.previousCursor) break;
			readPage = await reader.read(sessionPath, { cursor: readPage.previousCursor, limit: 200 });
		}
		expect(readIds).toEqual(entries.map((entry) => entry.id));
		expect(new Set(readIds).size).toBe(readIds.length);

		const searchIds: string[] = [];
		let searchPage = await reader.search(sessionPath, { query: "needle round", limit: 137 });
		while (true) {
			searchIds.push(...searchPage.hits.map((hit) => hit.entryId));
			if (!searchPage.nextCursor) break;
			searchPage = await reader.search(sessionPath, {
				query: "needle round",
				cursor: searchPage.nextCursor,
				limit: 137,
			});
		}
		expect(searchIds).toEqual(Array.from({ length: 10_000 }, (_, index) => `result-${index}`));
		expect(new Set(searchIds).size).toBe(searchIds.length);

		const samples: number[] = [];
		for (let index = 0; index < 25; index++) {
			const started = performance.now();
			const result = await reader.search(sessionPath, { query: "needle round 9999", limit: 10 });
			samples.push(performance.now() - started);
			expect(result.hits.map((hit) => hit.entryId)).toEqual(["result-9999"]);
		}
		samples.sort((left, right) => left - right);
		expect(samples[Math.ceil(samples.length * 0.95) - 1]).toBeLessThanOrEqual(50);
	}, 30_000);
});
