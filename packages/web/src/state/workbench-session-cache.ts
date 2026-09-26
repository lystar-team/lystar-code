import type { WorkbenchState } from "./workbench-types.ts";

export type SessionDetailCache = Pick<
	WorkbenchState,
	| "session"
	| "transcript"
	| "agentSteps"
	| "transcriptPageLoaded"
	| "transcriptGeneration"
	| "transcriptRevision"
	| "transcriptLeafId"
	| "previousCursor"
	| "toolActivityEpoch"
	| "toolActivityRevision"
	| "hasMorePrevious"
	| "liveTools"
	| "liveSteps"
	| "liveTurnItems"
	| "liveTurnId"
	| "liveTurnStartRevision"
	| "liveTurnActive"
	| "lastOutputSpeed"
	| "liveCompaction"
	| "pendingUserPrompts"
	| "promptSendTimes"
	| "queuedUserPrompts"
	| "statusText"
>;

export function sessionDetailCacheFromState(state: WorkbenchState): SessionDetailCache {
	return {
		session: state.session,
		transcript: state.transcript,
		agentSteps: state.agentSteps,
		transcriptPageLoaded: state.transcriptPageLoaded,
		transcriptGeneration: state.transcriptGeneration,
		transcriptRevision: state.transcriptRevision,
		transcriptLeafId: state.transcriptLeafId,
		previousCursor: state.previousCursor,
		toolActivityEpoch: state.toolActivityEpoch,
		toolActivityRevision: state.toolActivityRevision,
		hasMorePrevious: state.hasMorePrevious,
		liveTools: state.liveTools,
		liveSteps: state.liveSteps,
		liveTurnItems: state.liveTurnItems,
		liveTurnId: state.liveTurnId,
		liveTurnStartRevision: state.liveTurnStartRevision,
		liveTurnActive: state.liveTurnActive,
		lastOutputSpeed: state.lastOutputSpeed,
		liveCompaction: state.liveCompaction,
		pendingUserPrompts: state.pendingUserPrompts,
		promptSendTimes: state.promptSendTimes,
		queuedUserPrompts: state.queuedUserPrompts,
		statusText: state.statusText,
	};
}

export const SESSION_DETAIL_CACHE_LIMIT = 8;
export const SESSION_DETAIL_CACHE_BYTES_LIMIT = 24 * 1024 * 1024;

export type CachedSessionDetail = {
	detail: SessionDetailCache;
	bytes: number;
};

export function approximateValueBytes(value: unknown, seen = new WeakSet<object>(), depth = 0): number {
	if (typeof value === "string") return value.length * 2;
	if (typeof value === "number" || typeof value === "bigint") return 8;
	if (typeof value === "boolean") return 4;
	if (!value || typeof value !== "object") return 0;
	if (seen.has(value) || depth > 12) return 0;
	seen.add(value);
	if (Array.isArray(value)) {
		return 24 + value.reduce((total, item) => total + approximateValueBytes(item, seen, depth + 1), 0);
	}
	let bytes = 48;
	for (const [key, item] of Object.entries(value)) {
		bytes += key.length * 2 + approximateValueBytes(item, seen, depth + 1);
	}
	return bytes;
}

export function cacheSessionDetail(
	cache: Map<string, CachedSessionDetail>,
	sessionId: string,
	detail: SessionDetailCache,
): void {
	cache.delete(sessionId);
	const entry = { detail, bytes: approximateValueBytes(detail) };
	cache.set(sessionId, entry);
	let totalBytes = [...cache.values()].reduce((total, current) => total + current.bytes, 0);
	while (cache.size > SESSION_DETAIL_CACHE_LIMIT || totalBytes > SESSION_DETAIL_CACHE_BYTES_LIMIT) {
		const oldest = cache.keys().next().value;
		if (oldest === undefined) break;
		const removed = cache.get(oldest);
		cache.delete(oldest);
		totalBytes -= removed?.bytes ?? 0;
	}
}

export function readCachedSessionDetail(
	cache: Map<string, CachedSessionDetail>,
	sessionId: string,
): SessionDetailCache | undefined {
	const entry = cache.get(sessionId);
	if (!entry) return undefined;
	cache.delete(sessionId);
	cache.set(sessionId, entry);
	return entry.detail;
}
