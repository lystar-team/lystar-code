import { describe, expect, it } from "vitest";
import { shouldJoinLiveToolBatch, shouldJoinToolBatch } from "../src/state/tool-batching.ts";

type Tool = { name: string; summary: string };

function tool(name: string, summary = name): Tool {
	return { name, summary };
}

function readTool(path: string): Tool {
	return tool("read", JSON.stringify({ path }));
}

describe("Web tool batching", () => {
	it("matches the batching rule: consecutive bash, read, and web search calls join", () => {
		const names = ["bash", "bash", "read", "read", "web_search", "web_search", "bash", "edit", "bash", "bash"];
		const groups: Tool[][] = [];

		for (const name of names) {
			const current = tool(name);
			const previousGroup = groups.at(-1);
			if (previousGroup && shouldJoinToolBatch(previousGroup.at(-1), current)) previousGroup.push(current);
			else groups.push([current]);
		}

		expect(groups.map((group) => group.map((entry) => entry.name))).toEqual([
			["bash", "bash"],
			["read", "read"],
			["web_search", "web_search"],
			["bash"],
			["edit"],
			["bash", "bash"],
		]);
	});

	it("keeps Skill reads out of ordinary file-read batches", () => {
		const ordinaryRead = readTool("src/app.ts");
		const skillRead = readTool("/home/yean/.agents/skills/demo/SKILL.md");

		expect(shouldJoinToolBatch(ordinaryRead, ordinaryRead)).toBe(true);
		expect(shouldJoinToolBatch(ordinaryRead, skillRead)).toBe(false);
		expect(shouldJoinToolBatch(skillRead, ordinaryRead)).toBe(false);
		expect(shouldJoinToolBatch(skillRead, skillRead)).toBe(false);
	});

	it("does not join batched tools across assistant messages", () => {
		expect(shouldJoinLiveToolBatch(tool("bash"), tool("bash"), 1, 1)).toBe(true);
		expect(shouldJoinLiveToolBatch(tool("bash"), tool("bash"), 1, 2)).toBe(false);
		expect(shouldJoinLiveToolBatch(readTool("a.ts"), readTool("b.ts"), 1, 1)).toBe(true);
		expect(shouldJoinLiveToolBatch(readTool("a.ts"), readTool("b.ts"), 1, 2)).toBe(false);
		expect(shouldJoinLiveToolBatch(tool("web_search"), tool("web_search"), 1, 1)).toBe(true);
		expect(shouldJoinLiveToolBatch(tool("web_search"), tool("web_search"), 1, 2)).toBe(false);
	});
});
