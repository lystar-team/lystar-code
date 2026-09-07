import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setKeybindings } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { type SessionInfo, type SessionListOptions, SessionManager } from "../src/core/session-manager.ts";
import { SessionSelectorComponent, type SessionsLoader } from "../src/modes/interactive/components/session-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

const summary: SessionInfo = {
	id: "resume-fixture",
	path: "/tmp/resume-fixture.jsonl",
	cwd: "/tmp",
	created: new Date(0),
	modified: new Date(1),
	messageCount: 0,
	firstMessage: "first request",
	allMessagesText: "",
};

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
const directories: string[] = [];

beforeEach(() => {
	initTheme("dark");
	setKeybindings(new KeybindingsManager());
});

afterEach(() => {
	vi.unstubAllEnvs();
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function picker(current: SessionsLoader, all: SessionsLoader = current, requestRender = vi.fn()) {
	return new SessionSelectorComponent(current, all, vi.fn(), vi.fn(), vi.fn(), requestRender);
}

describe("resume list loading", () => {
	it("shows the first message when a metadata title was explicitly cleared", async () => {
		const selector = picker(async () => [{ ...summary, name: "", firstMessage: "清空标题后保留原始请求" }]);
		await flush();
		expect(selector.render(100).join("\n")).toContain("清空标题后保留原始请求");
		selector.getSessionList().handleInput("\x1b");
	});
	it("loads summaries first, then loads searchable history once without losing the query", async () => {
		let finishSearch!: (sessions: SessionInfo[]) => void;
		const loader = vi.fn<SessionsLoader>(async (_progress, options) => {
			if (options?.metadataOnly) return [summary];
			return new Promise((resolve) => {
				finishSearch = resolve;
			});
		});
		const selector = picker(loader);
		await flush();
		expect(loader).toHaveBeenCalledTimes(1);
		expect(loader.mock.calls[0][1]).toMatchObject({ metadataOnly: true, includeAllMessagesText: false });
		expect(selector.getSessionList().getSelectedSessionPath()).toBe(summary.path);

		selector.getSessionList().handleInput("needle");
		expect(loader).toHaveBeenCalledTimes(2);
		expect(loader.mock.calls[1][1]).toMatchObject({ metadataOnly: false, includeAllMessagesText: true });
		expect(selector.getSessionList().getSelectedSessionPath()).toBeUndefined();
		finishSearch([{ ...summary, messageCount: 2, allMessagesText: "first request needle" }]);
		await flush();
		expect(selector.getSessionList().getSelectedSessionPath()).toBe(summary.path);
		selector.getSessionList().handleInput(" ");
		await flush();
		expect(loader).toHaveBeenCalledTimes(2);
		selector.getSessionList().handleInput("\x1b");
	});

	it("uses summaries for the all-project scope and shares the metadata cache", async () => {
		const current = vi.fn<SessionsLoader>(async () => [summary]);
		const all = vi.fn<SessionsLoader>(async () => [summary]);
		const selector = picker(current, all);
		await flush();
		selector.getSessionList().handleInput("\t");
		await flush();
		expect(all.mock.calls[0][1]).toMatchObject({ metadataOnly: true, includeAllMessagesText: false });
		expect(all.mock.calls[0][1]?.cache).toBe(current.mock.calls[0][1]?.cache);
		selector.getSessionList().handleInput("\t");
		expect(current).toHaveBeenCalledTimes(1);
		selector.getSessionList().handleInput("\x1b");
	});

	it("cancels I/O and ignores late results after closing the picker", async () => {
		let finish!: (sessions: SessionInfo[]) => void;
		const loader = vi.fn<SessionsLoader>(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		const requestRender = vi.fn();
		const selector = picker(loader, loader, requestRender);
		const signal = loader.mock.calls[0][1]?.signal;
		expect(signal?.aborted).toBe(false);
		selector.getSessionList().handleInput("\x1b");
		expect(signal?.aborted).toBe(true);
		const renderCount = requestRender.mock.calls.length;
		finish([summary]);
		await flush();
		expect(requestRender).toHaveBeenCalledTimes(renderCount);
		expect(selector.getSessionList().getSelectedSessionPath()).toBeUndefined();
	});

	it("finishes a search typed before the initial summary load", async () => {
		let finish!: (sessions: SessionInfo[]) => void;
		const loader = vi.fn<SessionsLoader>(async (_progress, options) => {
			if (options?.metadataOnly)
				return new Promise((resolve) => {
					finish = resolve;
				});
			return [{ ...summary, allMessagesText: "needle" }];
		});
		const selector = picker(loader);
		selector.getSessionList().handleInput("needle");
		expect(loader).toHaveBeenCalledTimes(1);
		finish([summary]);
		await flush();
		expect(loader).toHaveBeenCalledTimes(2);
		expect(selector.getSessionList().getSelectedSessionPath()).toBe(summary.path);
		selector.getSessionList().handleInput("\x1b");
	});

	it("forwards metadata options through both listAll forms and preserves full-text fallback", async () => {
		const root = mkdtempSync(join(tmpdir(), "lystar-resume-list-"));
		directories.push(root);
		vi.stubEnv(ENV_AGENT_DIR, root);
		const directory = join(root, "sessions", "project");
		mkdirSync(directory, { recursive: true });
		const entries = [
			{ type: "session", version: 3, id: summary.id, cwd: "/tmp", timestamp: new Date(0).toISOString() },
			{ type: "message", message: { role: "user", content: "first request", timestamp: 1 } },
			{
				type: "message",
				message: { role: "toolResult", content: [{ type: "text", text: "x".repeat(4 * 1024 * 1024) }] },
			},
			{ type: "session_info", name: "首轮标题" },
			{ type: "message", message: { role: "user", content: "second request", timestamp: 2 } },
			{
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "text", text: `${"x".repeat(100_000)}needle` }],
					timestamp: 3,
					stopReason: "stop",
				},
			},
		];
		writeFileSync(join(directory, "session.jsonl"), `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
		const options: SessionListOptions = {
			metadataOnly: true,
			includeAllMessagesText: false,
			cache: { entries: new Map() },
		};
		const local = await SessionManager.listAll(directory, undefined, options);
		expect(local).toHaveLength(1);
		expect(local[0]).toMatchObject({ name: "首轮标题", firstMessage: "first request", allMessagesText: "" });
		const global = await SessionManager.listAll(undefined, undefined, options);
		expect(global[0]).toBe(local[0]);
		const parse = vi.spyOn(JSON, "parse");
		try {
			const full = await SessionManager.listAll(directory);
			expect(full[0].allMessagesText).toContain("needle");
			expect(full[0].messageCount).toBe(4);
			expect(full[0].lastOutcome).toBe("completed");
			expect(
				parse.mock.calls.some(([line]) => line.startsWith('{"type":"message","message":{"role":"toolResult"')),
			).toBe(false);
		} finally {
			parse.mockRestore();
		}

		const duringRead = new AbortController();
		await expect(
			SessionManager.listAll(directory, () => duringRead.abort(), { signal: duringRead.signal }),
		).rejects.toThrow();

		const abort = new AbortController();
		abort.abort();
		await expect(SessionManager.listAll(directory, undefined, { signal: abort.signal })).rejects.toThrow();
		await expect(SessionManager.list("/tmp", directory, undefined, { signal: abort.signal })).rejects.toThrow();
	});
});
