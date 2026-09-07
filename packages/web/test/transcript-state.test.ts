import { describe, expect, it } from "vitest";
import {
	decorateTranscriptItems,
	mergeTranscriptEntries,
	mergeTranscriptPage,
	type TranscriptWindow,
	transcriptRenderIdOverrides,
} from "../src/state/transcript-state.ts";
import type { WebTranscriptItem } from "../src/types.ts";

function item(entryId: string): WebTranscriptItem {
	return {
		entryId,
		parentId: null,
		timestamp: `2026-09-06T00:00:0${entryId.slice(-1)}.000Z`,
		kind: "message",
	};
}

describe("transcript pagination window", () => {
	const empty = (): TranscriptWindow => ({ transcript: [], hasMorePrevious: false, transcriptPageLoaded: false });

	it("keeps the exhausted history boundary after repeated tail refreshes", () => {
		let window = mergeTranscriptPage(
			empty(),
			{
				items: [item("m3"), item("m4")],
				previousCursor: "before-m3",
				hasMorePrevious: true,
			},
			false,
			true,
		);
		window = mergeTranscriptPage(window, { items: [item("m1"), item("m2")], hasMorePrevious: false }, true, true);
		for (let count = 0; count < 3; count++) {
			window = mergeTranscriptPage(
				window,
				{
					items: [item("m3"), item("m4"), item("m5")],
					previousCursor: "before-m3",
					hasMorePrevious: true,
				},
				false,
				true,
			);
			expect(window.transcript.map((entry) => entry.entryId)).toEqual(["m1", "m2", "m3", "m4", "m5"]);
			expect(window.hasMorePrevious).toBe(false);
			expect(window.previousCursor).toBeUndefined();
		}
	});

	it("retains the earliest page cursor while more history remains", () => {
		const current: TranscriptWindow = {
			transcript: decorateTranscriptItems([item("m2"), item("m3"), item("m4")]),
			previousCursor: "before-m2",
			hasMorePrevious: true,
			transcriptPageLoaded: true,
		};
		const refreshed = mergeTranscriptPage(
			current,
			{
				items: [item("m4"), item("m5")],
				previousCursor: "before-m4",
				hasMorePrevious: true,
			},
			false,
			true,
		);
		expect(refreshed.previousCursor).toBe("before-m2");
		expect(refreshed.transcript.map((entry) => entry.entryId)).toEqual(["m2", "m3", "m4", "m5"]);
	});

	it("takes pagination from the first page even when websocket entries arrived first", () => {
		const current = { ...empty(), transcript: decorateTranscriptItems([item("m5")]) };
		const page = mergeTranscriptPage(
			current,
			{
				items: [item("m3"), item("m4")],
				previousCursor: "before-m3",
				hasMorePrevious: true,
			},
			false,
			true,
		);
		expect(page.hasMorePrevious).toBe(true);
		expect(page.previousCursor).toBe("before-m3");
	});

	it("resets both content and pagination for a different history", () => {
		const current: TranscriptWindow = {
			transcript: decorateTranscriptItems([item("m1"), item("m2")]),
			hasMorePrevious: false,
			transcriptPageLoaded: true,
		};
		const next = mergeTranscriptPage(
			current,
			{
				items: [item("n3")],
				previousCursor: "before-n3",
				hasMorePrevious: true,
			},
			false,
			false,
		);
		expect(next.transcript.map((entry) => entry.entryId)).toEqual(["n3"]);
		expect(next.previousCursor).toBe("before-n3");
		expect(next.hasMorePrevious).toBe(true);
	});

	it("advances the earlier cursor only for an earlier page and retains new messages", () => {
		const current: TranscriptWindow = {
			transcript: decorateTranscriptItems([item("m3"), item("m4"), item("m5")]),
			previousCursor: "before-m3",
			hasMorePrevious: true,
			transcriptPageLoaded: true,
		};
		const next = mergeTranscriptPage(
			current,
			{
				items: [item("m2"), item("m3")],
				previousCursor: "before-m2",
				hasMorePrevious: true,
			},
			true,
			true,
		);
		expect(next.transcript.map((entry) => entry.entryId)).toEqual(["m2", "m3", "m4", "m5"]);
		expect(next.previousCursor).toBe("before-m2");
	});
});

describe("transcript state", () => {
	it("keeps live assistant and tool blocks on their committed render identities", () => {
		const liveItems = [
			{ kind: "text" as const, id: "live-text" },
			{ kind: "tools" as const, id: "live-tools", toolIds: ["tool-1"] },
		];
		const incoming: WebTranscriptItem[] = [
			{ ...item("u1"), view: { type: "user", text: "任务" } },
			{ ...item("a1"), view: { type: "assistant", text: "回复" } },
			{ ...item("t1"), view: { type: "tool_call", calls: [{ id: "tool-1", name: "bash", summary: "pwd" }] } },
			{
				...item("r1"),
				view: { type: "tool_result", callId: "tool-1", name: "bash", summary: "完成", status: "success" },
			},
		];
		const overrides = transcriptRenderIdOverrides(liveItems, undefined, incoming);
		const merged = mergeTranscriptEntries([], incoming, false, overrides);

		const existing = mergeTranscriptEntries([], [{ ...item("a1"), view: { type: "assistant", text: "旧回复" } }]);
		const remapped = mergeTranscriptEntries(existing, incoming, false, overrides);

		expect(remapped.find((entry) => entry.view?.type === "assistant")?.renderId).toBe("live-text");
		expect(merged.find((entry) => entry.view?.type === "assistant")?.renderId).toBe("live-text");
		expect(merged.find((entry) => entry.view?.type === "tool_call")?.renderId).toBe("live-tools");
		expect(merged.find((entry) => entry.view?.type === "tool_result")?.renderId).toBe("live-tools");
	});

	it("preserves loaded earlier entries when the tail page refreshes", () => {
		const loaded = mergeTranscriptEntries(mergeTranscriptEntries([], [item("m1"), item("m2"), item("m3")]), [
			item("m4"),
			item("m5"),
		]);
		const refreshed = mergeTranscriptEntries(loaded, [item("m3"), item("m4"), item("m5"), item("m6")]);

		expect(refreshed.map((entry) => entry.entryId)).toEqual(["m1", "m2", "m3", "m4", "m5", "m6"]);
	});

	it("keeps a repeated older commit before a newer user prompt", () => {
		const current = decorateTranscriptItems([item("m1"), item("m2"), item("m3")]);
		const merged = mergeTranscriptEntries(current, [{ ...item("m2"), view: { type: "assistant", text: "更新" } }]);
		expect(merged.map((entry) => entry.entryId)).toEqual(["m1", "m2", "m3"]);
		expect(merged[1].view).toEqual({ type: "assistant", text: "更新" });
	});

	it("尾页刷新复用未变化的 Transcript 对象", () => {
		const current = decorateTranscriptItems([
			{ ...item("m1"), view: { type: "assistant" as const, text: "保留" } },
			{ ...item("m2"), view: { type: "assistant" as const, text: "旧" } },
		]);
		const refreshed = mergeTranscriptEntries(current, [
			{ ...item("m1"), view: { type: "assistant" as const, text: "保留" } },
			{ ...item("m2"), view: { type: "assistant" as const, text: "新" } },
		]);
		expect(refreshed[0]).toBe(current[0]);
		expect(refreshed[1]).not.toBe(current[1]);
	});

	it("keeps websocket messages received after the requested tail in place", () => {
		const current = decorateTranscriptItems([item("m1"), item("m2"), item("m3"), item("m4")]);
		const merged = mergeTranscriptEntries(current, [item("m2"), item("m3")]);
		expect(merged.map((entry) => entry.entryId)).toEqual(["m1", "m2", "m3", "m4"]);
	});

	it("replaces all projections of one entry without moving the next prompt", () => {
		const text = { ...item("m2"), view: { type: "assistant" as const, text: "正文" } };
		const thinking = { ...item("m2"), view: { type: "thinking" as const, text: "思考" } };
		const current = decorateTranscriptItems([item("m1"), thinking, text, item("m3")]);
		const merged = mergeTranscriptEntries(current, [thinking, text]);
		expect(merged.map((entry) => entry.entryId)).toEqual(["m1", "m2", "m2", "m3"]);
		expect(new Set(merged.map((entry) => entry.renderId)).size).toBe(4);
		expect(merged.map((entry) => entry.renderId)).toEqual(current.map((entry) => entry.renderId));
	});

	it("places missing page entries before their existing overlap anchor", () => {
		const current = decorateTranscriptItems([item("m1"), item("m4"), item("m5")]);
		const merged = mergeTranscriptEntries(current, [item("m2"), item("m3"), item("m4")]);
		expect(merged.map((entry) => entry.entryId)).toEqual(["m1", "m2", "m3", "m4", "m5"]);
	});

	it("prepends an earlier page without duplicating the current page", () => {
		const current = decorateTranscriptItems([item("m3"), item("m4")]);
		const merged = mergeTranscriptEntries(current, [item("m1"), item("m2"), item("m3")], true);

		expect(merged.map((entry) => entry.entryId)).toEqual(["m1", "m2", "m3", "m4"]);
	});
});
