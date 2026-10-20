import type { GatewayEvent } from "../types.ts";
import { webApi } from "../adapters/host-protocol/api.ts";
import type { WorkbenchState } from "./workbench-types.ts";

export type SessionDetailCache = Pick<
	WorkbenchState,
	| "session"
	| "lease"
	| "readOnly"
	| "sessionReady"
	| "subagents"
	| "subagentViews"
	| "transcript"
	| "agentSteps"
	| "settledTurns"
	| "transcriptPageLoaded"
	| "displayedResultRevision"
	| "transcriptGeneration"
	| "transcriptRevision"
	| "transcriptLeafId"
	| "previousCursor"
	| "previousCursorLeafId"
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
		lease: state.lease,
		readOnly: state.readOnly,
		sessionReady: state.sessionReady,
		subagents: state.subagents,
		subagentViews: state.subagentViews,
		transcript: state.transcript,
		agentSteps: state.agentSteps,
		settledTurns: state.settledTurns,
		transcriptPageLoaded: state.transcriptPageLoaded,
		displayedResultRevision: state.displayedResultRevision,
		transcriptGeneration: state.transcriptGeneration,
		transcriptRevision: state.transcriptRevision,
		transcriptLeafId: state.transcriptLeafId,
		previousCursor: state.previousCursor,
		previousCursorLeafId: state.previousCursorLeafId,
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
	subscription?: { socket: WebSocket; seq: number };
	pendingEvents: GatewayEvent[];
};

export function invalidateCachedSessionSubscription(
	sessionId: string,
	entry: CachedSessionDetail,
	unsubscribe = true,
): void {
	const socket = entry.subscription?.socket;
	if (unsubscribe && socket?.readyState === WebSocket.OPEN) webApi.unsubscribeSession(socket, sessionId);
	entry.subscription = undefined;
	entry.pendingEvents = [];
	entry.bytes = approximateValueBytes(entry.detail);
}

function trimSessionDetailCache(cache: Map<string, CachedSessionDetail>): void {
	let totalBytes = [...cache.values()].reduce((total, current) => total + current.bytes, 0);
	while (cache.size > SESSION_DETAIL_CACHE_LIMIT || totalBytes > SESSION_DETAIL_CACHE_BYTES_LIMIT) {
		const oldest = cache.keys().next().value;
		if (oldest === undefined) break;
		const removed = cache.get(oldest);
		cache.delete(oldest);
		totalBytes -= removed?.bytes ?? 0;
		if (removed) invalidateCachedSessionSubscription(oldest, removed);
	}
}

export function cacheSessionEvent(
	cache: Map<string, CachedSessionDetail>,
	sessionId: string,
	event: GatewayEvent,
): void {
	const entry = cache.get(sessionId);
	if (!entry?.subscription) return;
	if ("seq" in event && typeof event.seq === "number") {
		if (event.seq <= entry.subscription.seq) return;
		if (event.seq !== entry.subscription.seq + 1) {
			invalidateCachedSessionSubscription(sessionId, entry);
			return;
		}
		entry.subscription.seq = event.seq;
	}
	entry.pendingEvents.push(event);
	entry.bytes += approximateValueBytes(event);
	trimSessionDetailCache(cache);
}

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
	subscription?: CachedSessionDetail["subscription"],
): void {
	cache.delete(sessionId);
	const entry: CachedSessionDetail = { detail, bytes: approximateValueBytes(detail), subscription, pendingEvents: [] };
	cache.set(sessionId, entry);
	trimSessionDetailCache(cache);
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
