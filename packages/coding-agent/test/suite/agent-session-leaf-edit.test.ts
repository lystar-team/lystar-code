import { afterEach, describe, expect, it } from "vitest";
import { userMsg } from "../utilities.ts";
import { createHarness, type Harness } from "./harness.ts";

let harness: Harness | undefined;

afterEach(() => {
	harness?.cleanup();
	harness = undefined;
});

describe("AgentSession current leaf editing", () => {
	it("moves a current user leaf to its parent before the replacement is appended", async () => {
		harness = await createHarness();
		const originalId = harness.sessionManager.appendMessage(userMsg("original prompt"));

		const result = await harness.session.navigateTree(originalId, { summarize: false });

		expect(result).toMatchObject({ cancelled: false, editorText: "original prompt" });
		expect(harness.sessionManager.getLeafId()).toBeNull();

		const replacementId = harness.sessionManager.appendMessage(userMsg("replacement prompt"));
		expect(harness.sessionManager.getEntry(replacementId)?.parentId).toBeNull();
		expect(harness.sessionManager.getBranch().map((entry) => entry.id)).toEqual([replacementId]);
		expect(harness.sessionManager.getEntry(originalId)).toBeDefined();
	});

	it("keeps navigation to the current assistant leaf as a no-op", async () => {
		harness = await createHarness();
		harness.sessionManager.appendMessage(userMsg("prompt"));
		const assistantId = harness.sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "reply" }],
			api: "faux",
			provider: "faux",
			model: "faux",
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

		const result = await harness.session.navigateTree(assistantId, { summarize: false });

		expect(result).toEqual({ cancelled: false });
		expect(harness.sessionManager.getLeafId()).toBe(assistantId);
	});
});
