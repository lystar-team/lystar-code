import { describe, expect, it } from "vitest";
import type { ToolBatchTool } from "../src/components/ai-elements/tool-batch.tsx";
import { initialToolStackPresentation, shouldLoadEarlierHistory } from "../src/components/workbench/conversation.tsx";

function tool(id: string, name: string, state: ToolBatchTool["state"]): ToolBatchTool {
	return { id, name, state, summary: id };
}

describe("conversation rendering stability", () => {
	it("loads earlier history when pagination becomes available while the viewport remains at the top", () => {
		const unavailable = {
			hasMorePrevious: false,
			loadingEarlier: false,
			previousCursor: undefined,
			transcriptError: undefined,
		};
		const available = {
			hasMorePrevious: true,
			loadingEarlier: false,
			previousCursor: "before-entry",
			transcriptError: undefined,
		};

		expect(shouldLoadEarlierHistory(true, unavailable, false)).toBe(false);
		expect(shouldLoadEarlierHistory(true, available, false)).toBe(true);
		expect(shouldLoadEarlierHistory(false, available, false)).toBe(false);
		expect(shouldLoadEarlierHistory(true, { ...available, loadingEarlier: true }, false)).toBe(false);
		expect(shouldLoadEarlierHistory(true, { ...available, transcriptError: "加载失败" }, false)).toBe(false);
	});

	it("waits for the viewport to leave the top before requesting another page", () => {
		const firstPageState = {
			hasMorePrevious: true,
			loadingEarlier: false,
			previousCursor: "before-entry",
			transcriptError: undefined,
		};
		const nextPageState = { ...firstPageState, previousCursor: "before-older-entry" };

		expect(shouldLoadEarlierHistory(true, firstPageState, false)).toBe(true);
		expect(shouldLoadEarlierHistory(true, { ...firstPageState, loadingEarlier: true }, true)).toBe(false);
		expect(shouldLoadEarlierHistory(true, nextPageState, true)).toBe(false);
		expect(shouldLoadEarlierHistory(false, nextPageState, false)).toBe(false);
		expect(shouldLoadEarlierHistory(true, nextPageState, false)).toBe(true);
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
