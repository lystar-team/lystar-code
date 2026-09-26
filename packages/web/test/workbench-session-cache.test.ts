import { describe, expect, it, vi } from "vitest";
import { webApi } from "../src/adapters/host-protocol/api.ts";
import {
	type CachedSessionDetail,
	cacheSessionDetail,
	readCachedSessionDetail,
	SESSION_DETAIL_CACHE_LIMIT,
	type SessionDetailCache,
	sessionDetailCacheFromState,
} from "../src/state/workbench-session-cache.ts";
import { initialState } from "../src/state/workbench-state.ts";

describe("session detail cache", () => {
	it("refreshes recently read entries and evicts the oldest entry at the count limit", () => {
		const cache = new Map<string, CachedSessionDetail>();
		const detail = {
			session: undefined,
			transcript: [],
			agentSteps: {},
			transcriptPageLoaded: false,
			transcriptGeneration: undefined,
			transcriptRevision: undefined,
			transcriptLeafId: undefined,
			previousCursor: undefined,
			toolActivityEpoch: undefined,
			toolActivityRevision: undefined,
			hasMorePrevious: false,
			liveTools: {},
			liveSteps: {},
			liveTurnItems: [],
			liveTurnId: 0,
			liveTurnStartRevision: undefined,
			liveTurnActive: undefined,
			liveCompaction: undefined,
			pendingUserPrompts: [],
			promptSendTimes: {},
			queuedUserPrompts: [],
			statusText: "",
		} satisfies SessionDetailCache;
		const sessionIds = Array.from({ length: SESSION_DETAIL_CACHE_LIMIT }, (_, index) => `session-${index}`);

		for (const sessionId of sessionIds) cacheSessionDetail(cache, sessionId, detail);

		expect(readCachedSessionDetail(cache, sessionIds[0]!)).toBe(detail);
		expect([...cache.keys()]).toEqual([...sessionIds.slice(1), sessionIds[0]]);

		cacheSessionDetail(cache, "session-new", detail);

		expect(cache.has(sessionIds[1]!)).toBe(false);
		expect(cache.has(sessionIds[0]!)).toBe(true);
		expect([...cache.keys()]).toEqual([...sessionIds.slice(2), sessionIds[0], "session-new"]);
	});

	it("keeps history boundaries without caching an in-flight history request", () => {
		vi.spyOn(webApi, "hasToken").mockReturnValue(false);
		const detail = sessionDetailCacheFromState({
			...initialState(),
			previousCursor: "older-page",
			hasMorePrevious: true,
			loadingEarlier: true,
		});

		expect(detail.previousCursor).toBe("older-page");
		expect(detail.hasMorePrevious).toBe(true);
		expect(detail).not.toHaveProperty("loadingEarlier");
	});
});
