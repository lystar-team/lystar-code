import { mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	hashOperationPayload,
	OperationJournal,
	OperationJournalCorruptError,
	OperationPayloadMismatchError,
} from "../src/operation-journal.ts";

const tempDirs: string[] = [];

afterEach(() => {
	vi.restoreAllMocks();
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function journalPath(): string {
	const dir = mkdtempSync(join(tmpdir(), "web-runtime-journal-"));
	tempDirs.push(dir);
	return join(dir, "operations.jsonl");
}

describe("OperationJournal", () => {
	it("hashes semantic payloads deterministically and distinguishes sessions", () => {
		const first = hashOperationPayload({
			command: "prompt",
			sessionPath: "/tmp/a.jsonl",
			payload: { images: [], text: "hello" },
		});
		const reordered = hashOperationPayload({
			payload: { text: "hello", images: [] },
			sessionPath: "/tmp/a.jsonl",
			command: "prompt",
		});
		const otherSession = hashOperationPayload({
			command: "prompt",
			sessionPath: "/tmp/b.jsonl",
			payload: { images: [], text: "hello" },
		});

		expect(reordered).toBe(first);
		expect(otherSession).not.toBe(first);
	});

	it("returns the accepted receipt for an identical retry and rejects payload reuse", () => {
		const journal = new OperationJournal(journalPath());
		const input = {
			clientInstanceId: "client",
			clientRequestId: "request",
			sessionPath: "/tmp/session.jsonl",
			type: "prompt",
			payloadHash: hashOperationPayload({ text: "hello" }),
		};
		const first = journal.accept(input);
		const retry = journal.accept(input);
		const otherSessionHash = hashOperationPayload({
			command: "prompt",
			sessionPath: "/tmp/other-session.jsonl",
			payload: { text: "hello" },
		});

		expect(retry).toEqual({ operation: first.operation, duplicate: true });
		expect(() => journal.accept({ ...input, payloadHash: otherSessionHash })).toThrow(OperationPayloadMismatchError);
		expect(() => journal.accept({ ...input, payloadHash: hashOperationPayload({ text: "changed" }) })).toThrow(
			OperationPayloadMismatchError,
		);
	});

	it("marks unfinished operations interrupted after restart", () => {
		const path = journalPath();
		const first = new OperationJournal(path);
		const accepted = first.accept({
			clientInstanceId: "client",
			clientRequestId: "request",
			sessionPath: "/tmp/session.jsonl",
			type: "prompt",
			payloadHash: hashOperationPayload({ text: "hello" }),
		}).operation;
		first.update(accepted.operationId, "running");

		const restarted = new OperationJournal(path);
		restarted.markInterrupted();

		expect(restarted.get(accepted.operationId)?.status).toBe("interrupted");
		expect(restarted.get(accepted.operationId)?.error).toBe("runtime_restarted");
	});

	it("keeps update timestamps strictly increasing", () => {
		vi.spyOn(Date, "now").mockReturnValue(100);
		const journal = new OperationJournal(journalPath());
		const accepted = journal.accept({
			clientInstanceId: "client",
			clientRequestId: "request",
			sessionPath: "/tmp/session.jsonl",
			type: "prompt",
			payloadHash: "hash",
		}).operation;
		const running = journal.update(accepted.operationId, "running");
		const completed = journal.update(accepted.operationId, "completed");

		expect(running.updatedAt).toBeGreaterThan(accepted.updatedAt);
		expect(completed.updatedAt).toBeGreaterThan(running.updatedAt);
	});

	it("prunes the in-memory index when compaction drops expired operations", () => {
		const path = journalPath();
		const expired = {
			operationId: "expired-operation",
			clientInstanceId: "expired-client",
			clientRequestId: "expired-request",
			sessionPath: "/tmp/expired.jsonl",
			type: "prompt",
			status: "completed",
			acceptedAt: 1,
			updatedAt: 1,
			payloadHash: "expired-hash",
			result: "x".repeat(16 * 1024 * 1024),
		};
		writeFileSync(path, `${JSON.stringify(expired)}\n`);
		const journal = new OperationJournal(path);

		const current = journal.accept({
			clientInstanceId: "current-client",
			clientRequestId: "current-request",
			sessionPath: "/tmp/current.jsonl",
			type: "prompt",
			payloadHash: "current-hash",
		}).operation;

		expect(journal.get(expired.operationId)).toBeUndefined();
		expect(journal.list()).toEqual([current]);
		expect(new OperationJournal(path).list()).toEqual([current]);
	});

	it("cleans temporary files and leaves a reopenable journal when compaction rename or directory fsync fails", () => {
		for (const failurePoint of ["rename", "directory fsync"] as const) {
			const path = journalPath();
			const expired = {
				operationId: "expired-operation",
				clientInstanceId: "expired-client",
				clientRequestId: "expired-request",
				sessionPath: "/tmp/expired.jsonl",
				type: "prompt",
				status: "completed",
				acceptedAt: 1,
				updatedAt: 1,
				payloadHash: "expired-hash",
				result: "x".repeat(16 * 1024 * 1024),
			};
			writeFileSync(path, `${JSON.stringify(expired)}\n`);
			const journal = new OperationJournal(path, {
				compactFileOperations:
					failurePoint === "rename"
						? {
								rename: () => {
									throw new Error("rename failed");
								},
								fsyncParentDirectory: () => undefined,
							}
						: {
								rename: renameSync,
								fsyncParentDirectory: () => {
									throw new Error("directory fsync failed");
								},
							},
			});

			expect(() =>
				journal.accept({
					clientInstanceId: "current-client",
					clientRequestId: "current-request",
					sessionPath: "/tmp/current.jsonl",
					type: "prompt",
					payloadHash: "current-hash",
				}),
			).toThrow(failurePoint === "rename" ? "rename failed" : "directory fsync failed");

			const reopened = new OperationJournal(path);
			expect(reopened.find("current-client", "current-request", "current-hash")?.status).toBe("accepted");
			expect(readdirSync(dirname(path)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
		}
	});

	it("refuses writes when a journal record fails the protocol schema", () => {
		const path = journalPath();
		writeFileSync(
			path,
			`${JSON.stringify({
				operationId: "operation",
				clientInstanceId: "client",
				clientRequestId: "request",
				sessionPath: "/tmp/session.jsonl",
				type: "prompt",
				status: "unknown",
				acceptedAt: 1,
				updatedAt: 1,
				payloadHash: "hash",
			})}\n`,
		);
		const journal = new OperationJournal(path);

		expect(() =>
			journal.accept({
				clientInstanceId: "client",
				clientRequestId: "request",
				sessionPath: "/tmp/session.jsonl",
				type: "prompt",
				payloadHash: "hash",
			}),
		).toThrow(OperationJournalCorruptError);
	});
});
