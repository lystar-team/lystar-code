import type { ToolActivity, WebSearchProgress } from "@lystar/code-web-protocol";
import { describe, expect, it } from "vitest";
import { liveToolFromActivity } from "../src/state/workbench-live-state.ts";
import type { LiveTool } from "../src/state/workbench-types.ts";

describe("web search live state", () => {
	it("keeps structured search details when a later activity update replaces the tool", () => {
		const webSearch: WebSearchProgress = {
			status: "searching",
			action: "search",
			query: "uni-app H5 Canvas touch event",
			sources: [{ url: "https://uniapp.dcloud.net.cn/api/canvas" }],
		};
		const previous: LiveTool = {
			id: "web-search-1",
			name: "web_search",
			batchId: "batch-1",
			summary: "uni-app H5 Canvas touch event",
			state: "running",
			status: "running",
			webSearch,
		};
		const activity: ToolActivity = {
			activityEpoch: "epoch-1",
			revision: 2,
			toolCallId: "web-search-1",
			name: "web_search",
			state: "running",
			summary: "网页搜索",
			updatedAt: 2,
		};

		const next = liveToolFromActivity(activity, previous, "batch-1");

		expect(next.webSearch).toEqual(webSearch);
		expect(next.summary).toBe("uni-app H5 Canvas touch event");
	});
});
