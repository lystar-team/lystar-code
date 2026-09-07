import { describe, expect, it } from "vitest";
import {
	compactionSummaryCount,
	reconcileCompactionState,
	restoreCompactionState,
	updateCompactionState,
} from "../src/state/compaction-state.ts";
import type { WebTranscriptItem } from "../src/types.ts";

function summary(entryId: string): WebTranscriptItem {
	return {
		entryId,
		parentId: null,
		timestamp: "2026-09-07T00:00:00Z",
		kind: "compaction",
		view: {
			type: "summary",
			variant: "compaction",
			title: "上下文压缩",
			text: "摘要",
		},
	};
}

describe("compaction state", () => {
	it("tracks start, retry, completion, and failure states", () => {
		const items: WebTranscriptItem[] = [];
		const started = restoreCompactionState(undefined, "compaction", items);
		expect(started).toMatchObject({ status: "running", summaryCountAtStart: 0 });

		const waiting = updateCompactionState(
			started,
			{
				type: "compaction",
				status: "waiting_retry",
				reason: "threshold",
				error: "temporary",
			},
			items,
		);
		expect(waiting).toMatchObject({ status: "waiting_retry", reason: "threshold", error: "temporary" });

		const retrying = updateCompactionState(
			waiting,
			{
				type: "retry",
				status: "running",
				kind: "compaction",
				attempt: 2,
				maxAttempts: 3,
			},
			items,
		);
		expect(retrying).toMatchObject({
			status: "running",
			retry: { status: "running", kind: "compaction", attempt: 2, maxAttempts: 3 },
		});

		const failed = updateCompactionState(
			retrying,
			{ type: "compaction", status: "failed", reason: "threshold", error: "failed" },
			items,
		);
		expect(failed).toMatchObject({ status: "failed", error: "failed" });
	});

	it("clears the temporary state when the persisted summary arrives", () => {
		const state = restoreCompactionState(undefined, "compaction", []);
		expect(state).toBeDefined();
		expect(compactionSummaryCount([summary("summary-1")] as WebTranscriptItem[])).toBe(1);
		expect(reconcileCompactionState(state, [summary("summary-1")])).toBeUndefined();
	});

	it("does not create a compaction card for unrelated retry or a late completion", () => {
		expect(restoreCompactionState(undefined, "retry", [])).toBeUndefined();
		expect(
			updateCompactionState(undefined, { type: "retry", status: "waiting", kind: "summarization", attempt: 1 }, []),
		).toBeUndefined();
		expect(
			updateCompactionState(undefined, { type: "compaction", status: "completed", reason: "manual" }, [
				summary("summary-1"),
			]),
		).toBeUndefined();
	});
});
