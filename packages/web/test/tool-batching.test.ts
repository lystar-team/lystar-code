import { describe, expect, it } from "vitest";
import { shouldJoinLiveToolBatch, shouldJoinToolBatch } from "../src/state/tool-batching.ts";

describe("Web tool batching", () => {
	it("matches the batching rule: consecutive bash and web search calls join", () => {
		const names = ["bash", "bash", "read", "web_search", "web_search", "bash", "edit", "bash", "bash"];
		const groups: string[][] = [];

		for (const name of names) {
			const previousGroup = groups.at(-1);
			if (previousGroup && shouldJoinToolBatch(previousGroup.at(-1), name)) previousGroup.push(name);
			else groups.push([name]);
		}

		expect(groups).toEqual([
			["bash", "bash"],
			["read"],
			["web_search", "web_search"],
			["bash"],
			["edit"],
			["bash", "bash"],
		]);
	});

	it("does not join bash or web search calls across assistant messages", () => {
		expect(shouldJoinLiveToolBatch("bash", "bash", 1, 1)).toBe(true);
		expect(shouldJoinLiveToolBatch("bash", "bash", 1, 2)).toBe(false);
		expect(shouldJoinLiveToolBatch("web_search", "web_search", 1, 1)).toBe(true);
		expect(shouldJoinLiveToolBatch("web_search", "web_search", 1, 2)).toBe(false);
	});
});
