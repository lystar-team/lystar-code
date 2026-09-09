import { sessionTitle } from "../../state/use-workbench.ts";
import type { WebSessionSummary } from "../../types.ts";

export type SessionSortMode = "manual" | "last-reply" | "created" | "title";

export const SESSION_SORT_OPTIONS: readonly { value: SessionSortMode; label: string }[] = [
	{ value: "manual", label: "当前顺序" },
	{ value: "last-reply", label: "最后回复时间" },
	{ value: "created", label: "创建时间" },
	{ value: "title", label: "标题" },
];

export function formatSessionTimestamp(timestamp: number): string {
	return new Intl.DateTimeFormat("zh-CN", {
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
	}).format(timestamp);
}

export function sortSessionSummaries(
	sessions: readonly WebSessionSummary[],
	mode: SessionSortMode,
): WebSessionSummary[] {
	const next = [...sessions];
	if (mode === "manual") return next;
	return next.sort((left, right) => {
		if (mode === "title")
			return sessionTitle(left).localeCompare(sessionTitle(right), "zh-CN") || left.id.localeCompare(right.id);
		const leftValue = mode === "created" ? left.createdAt : left.updatedAt;
		const rightValue = mode === "created" ? right.createdAt : right.updatedAt;
		return rightValue - leftValue || left.id.localeCompare(right.id);
	});
}
