export const EXTENSION_ACTIVITY_CUSTOM_TYPE = "lystar.web.extension-activity";

export type ExtensionActivityStatus = "running" | "completed" | "failed" | "interrupted";

interface ExtensionActivityRecordBase {
	version: 1;
	activityId: string;
	extensionPath: string;
	hook: string;
	startedAt: number;
}

export type ExtensionActivityRecord =
	| (ExtensionActivityRecordBase & { phase: "start" })
	| (ExtensionActivityRecordBase & {
			phase: "end";
			endedAt: number;
			durationMs: number;
			status: Exclude<ExtensionActivityStatus, "running">;
			relatedEntryIds: string[];
			error?: string;
			details?: string;
	  });

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function stringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string" && item.length > 0);
}

export function parseExtensionActivityRecord(value: unknown): ExtensionActivityRecord | undefined {
	const candidate = record(value);
	if (
		candidate?.version !== 1 ||
		typeof candidate.activityId !== "string" ||
		candidate.activityId.length === 0 ||
		typeof candidate.extensionPath !== "string" ||
		candidate.extensionPath.length === 0 ||
		typeof candidate.hook !== "string" ||
		candidate.hook.length === 0 ||
		typeof candidate.startedAt !== "number" ||
		!Number.isSafeInteger(candidate.startedAt)
	) {
		return undefined;
	}

	const base = {
		version: 1 as const,
		activityId: candidate.activityId,
		extensionPath: candidate.extensionPath,
		hook: candidate.hook,
		startedAt: candidate.startedAt,
	};
	if (candidate.phase === "start") return { ...base, phase: "start" };
	if (
		candidate.phase !== "end" ||
		typeof candidate.endedAt !== "number" ||
		!Number.isSafeInteger(candidate.endedAt) ||
		typeof candidate.durationMs !== "number" ||
		!Number.isSafeInteger(candidate.durationMs) ||
		(candidate.status !== "completed" && candidate.status !== "failed" && candidate.status !== "interrupted") ||
		!stringArray(candidate.relatedEntryIds) ||
		(candidate.error !== undefined && typeof candidate.error !== "string") ||
		(candidate.details !== undefined && typeof candidate.details !== "string")
	) {
		return undefined;
	}

	return {
		...base,
		phase: "end",
		endedAt: candidate.endedAt,
		durationMs: candidate.durationMs,
		status: candidate.status,
		relatedEntryIds: candidate.relatedEntryIds,
		...(typeof candidate.error === "string" ? { error: candidate.error } : {}),
		...(typeof candidate.details === "string" ? { details: candidate.details } : {}),
	};
}
