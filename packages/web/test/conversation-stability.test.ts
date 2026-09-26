import { describe, expect, it } from "vitest";
import type { ToolBatchTool } from "../src/components/ai-elements/tool-batch.tsx";
import { initialToolStackPresentation, shouldLoadEarlierHistory } from "../src/components/workbench/conversation.tsx";

function tool(id: string, name: string, state: ToolBatchTool["state"]): ToolBatchTool {
	return { id, name, state, summary: id };
}

describe("conversation rendering stability", () => {
	it("does not load earlier history from the top state without an upward reading action", () => {
		const available = {
			hasMorePrevious: true,
			loadingEarlier: false,
			previousCursor: "before-entry",
			transcriptError: undefined,
		};

		expect(shouldLoadEarlierHistory(true, false, available, undefined)).toBe(false);
		expect(shouldLoadEarlierHistory(true, true, available, undefined)).toBe(true);
		expect(shouldLoadEarlierHistory(false, true, available, undefined)).toBe(false);
		expect(shouldLoadEarlierHistory(true, true, { ...available, hasMorePrevious: false }, undefined)).toBe(false);
		expect(shouldLoadEarlierHistory(true, true, { ...available, loadingEarlier: true }, undefined)).toBe(false);
		expect(shouldLoadEarlierHistory(true, true, { ...available, transcriptError: "加载失败" }, undefined)).toBe(
			false,
		);
	});

	it("waits for another upward action after a page changes the cursor", () => {
		const firstPageState = {
			hasMorePrevious: true,
			loadingEarlier: false,
			previousCursor: "before-entry",
			transcriptError: undefined,
		};
		const nextPageState = { ...firstPageState, previousCursor: "before-older-entry" };

		expect(shouldLoadEarlierHistory(true, true, firstPageState, undefined)).toBe(true);
		expect(shouldLoadEarlierHistory(true, true, firstPageState, "before-entry")).toBe(false);
		expect(shouldLoadEarlierHistory(true, false, nextPageState, "before-entry")).toBe(false);
		expect(shouldLoadEarlierHistory(true, true, nextPageState, "before-entry")).toBe(true);
		expect(shouldLoadEarlierHistory(true, true, nextPageState, "before-older-entry")).toBe(false);
	});

	it("keeps active and single tools as stable rows across state updates", () => {
		expect(initialToolStackPresentation([tool("bash-1", "bash", "input-available")])).toBe("rows");
		expect(initialToolStackPresentation([tool("bash-1", "bash", "output-available")])).toBe("rows");
		expect(
			initialToolStackPresentation([
				tool("bash-1", "bash", "output-available"),
				tool("bash-2", "bash", "input-available"),
			]),
		).toBe("rows");
	});

	it("groups completed historical activity without changing mixed tool stacks", () => {
		expect(
			initialToolStackPresentation([
				tool("read-1", "read", "output-available"),
				tool("read-2", "read", "output-available"),
			]),
		).toBe("group");
		expect(
			initialToolStackPresentation([
				tool("read-1", "read", "output-available"),
				tool("bash-1", "bash", "output-available"),
			]),
		).toBe("rows");
	});
});
