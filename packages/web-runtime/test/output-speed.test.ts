import type { AssistantMessage } from "@earendil-works/pi-ai/compat";
import { SessionManager, SessionUsageTracker } from "@earendil-works/pi-coding-agent/core";
import { describe, expect, it } from "vitest";

function reply(output: number, decodeDurationMs: number, timestamp = 1): AssistantMessage {
	return {
		role: "assistant", api: "openai-completions", provider: "deepseek", model: "deepseek-chat",
		content: [], timestamp, decodeDurationMs, stopReason: "stop",
		usage: { input: 10, output, reasoning: 31, cacheRead: 30, cacheWrite: 0, totalTokens: 40 + output,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	};
}

describe("SessionUsageTracker", () => {
	it("includes reasoning in provider output and its matching generation time", () => {
		const manager = SessionManager.inMemory();
		manager.appendMessage(reply(131, 1_000));
		const usage = new SessionUsageTracker().snapshot(manager);
		expect(usage.tokens.output).toBe(131);
		expect(usage.outputSpeed).toEqual({ outputTokens: 131, elapsedMs: 1_000 });
		expect(usage.estimatedOutput).toBe(false);
	});

	it("accumulates completed response tokens and generation time without counting settlement twice", () => {
		const manager = SessionManager.inMemory();
		const tracker = new SessionUsageTracker();
		const first = reply(200, 2_000);
		tracker.update({ type: "message_end", message: first });
		expect(tracker.snapshot(manager).outputSpeed).toEqual({ outputTokens: 200, elapsedMs: 2_000 });
		manager.appendMessage(first);
		manager.appendMessage(reply(300, 6_000, 2));
		expect(tracker.snapshot(manager).outputSpeed).toEqual({ outputTokens: 500, elapsedMs: 8_000 });
		expect(new SessionUsageTracker().snapshot(manager).outputSpeed).toEqual({ outputTokens: 500, elapsedMs: 8_000 });
	});

	it("excludes failed output time and keeps completed averages when a new response starts", () => {
		const manager = SessionManager.inMemory();
		const tracker = new SessionUsageTracker();
		manager.appendMessage({ ...reply(12, 100), stopReason: "error" });
		expect(tracker.snapshot(manager).outputSpeed).toBeUndefined();
		manager.appendMessage(reply(100, 1_000, 2));
		tracker.update({ type: "message_start", message: reply(0, 0, 3) });
		expect(tracker.snapshot(manager).outputSpeed).toEqual({ outputTokens: 100, elapsedMs: 1_000 });
		tracker.update({ type: "message_end", message: { ...reply(12, 100, 3), stopReason: "aborted" } });
		expect(tracker.snapshot(manager).outputSpeed).toEqual({ outputTokens: 100, elapsedMs: 1_000 });
	});
});
