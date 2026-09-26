import { describe, expect, it } from "vitest";
import { toolInputSummary } from "../src/core/tool-activity.ts";

describe("file tool summaries", () => {
	it("keeps the path and requested range of a streamed read", () => {
		expect(toolInputSummary("read", { path: "src/a.ts", offset: 323, limit: 300 })).toBe(
			'{"path":"src/a.ts","offset":323,"limit":300}',
		);
	});

	it("keeps edit paths without exposing edit contents in the title", () => {
		expect(toolInputSummary("edit", { path: "src/b.ts", edits: [{ oldText: "old", newText: "new" }] })).toBe(
			"src/b.ts",
		);
	});

	it("distinguishes real filenames from missing paths when they equal the tool name", () => {
		expect(toolInputSummary("read", { path: "read" })).toBe('{"path":"read"}');
		expect(toolInputSummary("edit", { path: "edit" })).toBe('{"path":"edit"}');
	});
});
