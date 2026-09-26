import { RUNTIME_MAX_FRAME_LENGTH } from "@lystar/code-web-protocol";
import { describe, expect, it, vi } from "vitest";
import { readTranscriptPageWithinFrameBudget } from "../src/transcript-page-budget.ts";

describe("historical transcript response budget", () => {
	it("returns a normal 400-entry page without another read", async () => {
		const page = { items: Array.from({ length: 400 }, (_, index) => ({ entryId: `entry-${index}` })) };
		const readPage = vi.fn(async () => page);

		expect(await readTranscriptPageWithinFrameBudget(400, readPage)).toEqual(page);
		expect(readPage).toHaveBeenCalledExactlyOnceWith(400);
	});

	it("reads a smaller cursor page if the projected response exceeds the budget", async () => {
		const page = { items: [{ entryId: "first" }], previousCursor: "older" };
		const readPage = vi.fn(async (limit: number) =>
			limit === 400 ? { items: [{ text: "x".repeat(RUNTIME_MAX_FRAME_LENGTH / 2) }] } : page,
		);

		expect(await readTranscriptPageWithinFrameBudget(400, readPage)).toEqual(page);
		expect(readPage.mock.calls.map(([limit]) => limit)).toEqual([400, 200]);
	});

	it("rejects a single entry larger than the Runtime frame", async () => {
		const readPage = vi.fn(async () => ({ items: [{ text: "x".repeat(RUNTIME_MAX_FRAME_LENGTH) }] }));

		await expect(readTranscriptPageWithinFrameBudget(1, readPage)).rejects.toThrow("超过 Runtime 响应大小上限");
		expect(readPage).toHaveBeenCalledExactlyOnceWith(1);
	});
});
