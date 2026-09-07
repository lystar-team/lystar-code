import type { SessionPhase, SessionProgress } from "@lystar/code-web-protocol";
import type { WebTranscriptItem } from "../types.ts";

export type LiveCompactionProgress = Extract<SessionProgress, { type: "compaction" }>;
export type LiveCompactionRetry = Extract<SessionProgress, { type: "retry" }>;

export interface LiveCompactionState {
	status: LiveCompactionProgress["status"];
	reason?: LiveCompactionProgress["reason"];
	error?: string;
	summaryCountAtStart: number;
	retry?: Pick<LiveCompactionRetry, "status" | "kind" | "attempt" | "maxAttempts" | "delayMs" | "error">;
}

export function compactionSummaryCount(items: readonly WebTranscriptItem[]): number {
	return items.filter((item) => item.view?.type === "summary" && item.view.variant === "compaction").length;
}

function newCompactionState(items: readonly WebTranscriptItem[], reason?: LiveCompactionProgress["reason"]): LiveCompactionState {
	return {
		status: "running",
		summaryCountAtStart: compactionSummaryCount(items),
		...(reason === undefined ? {} : { reason }),
	};
}

export function restoreCompactionState(
	current: LiveCompactionState | undefined,
	phase: SessionPhase,
	items: readonly WebTranscriptItem[],
): LiveCompactionState | undefined {
	if (phase === "retry") return current;
	if (phase !== "compaction") {
		if (current?.status === "running" || current?.status === "waiting_retry") return undefined;
		return current;
	}
	if (current?.status === "running" || current?.status === "waiting_retry") return current;
	return newCompactionState(items);
}

export function updateCompactionState(
	current: LiveCompactionState | undefined,
	progress: LiveCompactionProgress | LiveCompactionRetry,
	items: readonly WebTranscriptItem[],
): LiveCompactionState | undefined {
	const summaryCountAtStart = current?.summaryCountAtStart ?? compactionSummaryCount(items);
	if (progress.type === "compaction") {
		if (progress.status === "completed" && !current && compactionSummaryCount(items) > 0) return undefined;
		return {
			status: progress.status,
			reason: progress.reason,
			summaryCountAtStart,
			...(progress.error === undefined ? {} : { error: progress.error }),
			...(progress.status === "running" || current?.retry === undefined ? {} : { retry: current.retry }),
		};
	}
	if (progress.kind === "summarization" && !current) return undefined;
	if (progress.kind !== "compaction" && progress.kind !== "summarization") return current;
	return {
		...(current ?? { status: "running", summaryCountAtStart }),
		status: progress.status === "waiting" ? "waiting_retry" : progress.status === "running" ? "running" : current?.status ?? "running",
		...(progress.error === undefined ? {} : { error: progress.error }),
		retry: {
			status: progress.status,
			kind: progress.kind,
			...(progress.attempt === undefined ? {} : { attempt: progress.attempt }),
			...(progress.maxAttempts === undefined ? {} : { maxAttempts: progress.maxAttempts }),
			...(progress.delayMs === undefined ? {} : { delayMs: progress.delayMs }),
			...(progress.error === undefined ? {} : { error: progress.error }),
		},
	};
}

export function reconcileCompactionState(
	current: LiveCompactionState | undefined,
	items: readonly WebTranscriptItem[],
): LiveCompactionState | undefined {
	if (!current || compactionSummaryCount(items) <= current.summaryCountAtStart) return current;
	return undefined;
}
