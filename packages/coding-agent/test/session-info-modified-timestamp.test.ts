import { writeFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { SessionHeader, SessionInfoCache } from "../src/core/session-manager.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

function createSessionFile(path: string): void {
	const header: SessionHeader = {
		type: "session",
		id: "test-session",
		version: 3,
		timestamp: new Date(0).toISOString(),
		cwd: "/tmp",
	};
	writeFileSync(path, `${JSON.stringify(header)}\n`, "utf8");

	// SessionManager only persists once it has seen at least one assistant message.
	// Add a minimal assistant entry so subsequent appends are persisted.
	const mgr = SessionManager.open(path);
	mgr.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "hi" }],
		api: "openai-completions",
		provider: "openai",
		model: "test",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	});
	mgr.dispose();
}

describe("SessionInfo.modified", () => {
	beforeAll(() => initTheme("dark"));

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("uses last user/assistant message timestamp instead of file mtime", async () => {
		const filePath = join(tmpdir(), `pi-session-${Date.now()}-modified.jsonl`);
		createSessionFile(filePath);

		const before = await stat(filePath);
		// Ensure the file mtime can differ from our message timestamp even on coarse filesystems.
		await new Promise((r) => setTimeout(r, 10));

		const mgr = SessionManager.open(filePath);
		const msgTime = Date.now();
		mgr.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "later" }],
			api: "openai-completions",
			provider: "openai",
			model: "test",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: msgTime,
		});

		const sessions = await SessionManager.list("/tmp", dirname(filePath));
		const s = sessions.find((x) => x.path === filePath);
		expect(s).toBeDefined();
		expect(s!.modified.getTime()).toBe(msgTime);
		expect(s!.modified.getTime()).not.toBe(before.mtime.getTime());
		expect(s!.lastOutcome).toBe("completed");
		mgr.dispose();
	});

	it("supports lightweight cached listing without reusing an incomplete full-text entry", async () => {
		const filePath = join(tmpdir(), `pi-session-${Date.now()}-cached-list.jsonl`);
		writeFileSync(
			filePath,
			`${[
				JSON.stringify({
					type: "session",
					id: "cached-list",
					version: 3,
					timestamp: new Date(0).toISOString(),
					cwd: "/tmp",
				}),
				JSON.stringify({
					type: "message",
					id: "user-1",
					parentId: null,
					timestamp: new Date(1).toISOString(),
					message: { role: "user", content: "hello", timestamp: 1 },
				}),
				JSON.stringify({
					type: "message",
					id: "assistant-1",
					parentId: "user-1",
					timestamp: new Date(2).toISOString(),
					message: {
						role: "assistant",
						content: [{ type: "text", text: "reply" }],
						stopReason: "stop",
						timestamp: 2,
					},
				}),
			].join("\n")}\n`,
		);
		const cache: SessionInfoCache = { entries: new Map() };

		const lightweight = await SessionManager.list("/tmp", dirname(filePath), undefined, {
			cache,
			includeAllMessagesText: false,
		});
		const lightweightSession = lightweight.find((session) => session.path === filePath);
		expect(lightweightSession).toMatchObject({ firstMessage: "hello", messageCount: 2, allMessagesText: "" });
		const cached = await SessionManager.list("/tmp", dirname(filePath), undefined, {
			cache,
			includeAllMessagesText: false,
		});
		const cachedSession = cached.find((session) => session.path === filePath);
		expect(cachedSession).toBe(lightweightSession);

		const full = await SessionManager.list("/tmp", dirname(filePath), undefined, {
			cache,
			includeAllMessagesText: true,
		});
		const fullSession = full.find((session) => session.path === filePath);
		expect(fullSession?.allMessagesText).toContain("hello");
		expect(fullSession?.allMessagesText).toContain("reply");

		const metadataCache: SessionInfoCache = { entries: new Map() };
		const metadataOnly = await SessionManager.list("/tmp", dirname(filePath), undefined, {
			cache: metadataCache,
			includeAllMessagesText: false,
			metadataOnly: true,
		});
		const metadataSession = metadataOnly.find((session) => session.path === filePath);
		expect(metadataSession).toMatchObject({ firstMessage: "hello", messageCount: 0, allMessagesText: "" });
		const metadataAgain = await SessionManager.list("/tmp", dirname(filePath), undefined, {
			cache: metadataCache,
			includeAllMessagesText: false,
			metadataOnly: true,
		});
		expect(metadataAgain.find((session) => session.path === filePath)).toBe(metadataSession);
	});

	it("derives a failed outcome from the last committed Bash execution", async () => {
		const filePath = join(tmpdir(), `pi-session-${Date.now()}-bash-outcome.jsonl`);
		createSessionFile(filePath);
		const mgr = SessionManager.open(filePath);
		mgr.appendMessage({
			role: "bashExecution",
			command: "exit 7",
			output: "",
			exitCode: 7,
			cancelled: false,
			truncated: false,
			timestamp: Date.now(),
			excludeFromContext: false,
		});
		mgr.dispose();

		const sessions = await SessionManager.list("/tmp", dirname(filePath));
		expect(sessions.find((session) => session.path === filePath)?.lastOutcome).toBe("failed");
	});
});
