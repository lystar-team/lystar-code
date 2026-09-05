import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SessionManager } from "../src/core/session-manager.ts";

function writeHeader(path: string, id: string, timestamp: string): void {
	writeFileSync(path, `${JSON.stringify({ type: "session", version: 3, id, timestamp, cwd: "/tmp" })}\n`, "utf8");
}

describe("SessionManager.list duplicate identities", () => {
	it("returns only the newest file when multiple JSONL files share one session id", async () => {
		const directory = join(tmpdir(), `pi-session-duplicate-id-${Date.now()}-${Math.random().toString(16).slice(2)}`);
		mkdirSync(directory, { recursive: true });
		try {
			const olderPath = join(directory, "older.jsonl");
			const newerPath = join(directory, "newer.jsonl");
			writeHeader(olderPath, "same-session", "2026-01-01T00:00:00.000Z");
			writeHeader(newerPath, "same-session", "2026-01-02T00:00:00.000Z");

			const sessions = await SessionManager.list("/tmp", directory);

			expect(sessions).toHaveLength(1);
			expect(sessions[0]).toMatchObject({ id: "same-session", path: newerPath });
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
