import { describe, expect, it } from "vitest";
import {
	bootstrapLeaseForSession,
	isOlderSessionSnapshot,
	isTranscriptResponseObsolete,
	mergeOperationSnapshots,
	needsTranscriptRefreshForCommit,
	runtimeHistoryChanged,
} from "../src/state/session-sync.ts";
import type { WebLease, WebOperation, WebSessionSnapshot } from "../src/types.ts";

describe("连接恢复状态边界", () => {
	it("旧 Bootstrap 不会清除刚取得的租约，恢复后的租约会覆盖旧值", () => {
		const current: WebLease = { leaseId: "current", leaseGeneration: 1, createdAt: 1, updatedAt: 1 };
		const restored: WebLease = { leaseId: "restored", leaseGeneration: 2, createdAt: 2, updatedAt: 2 };
		expect(bootstrapLeaseForSession("session", current, [])).toBe(current);
		expect(bootstrapLeaseForSession("session", current, [{ sessionId: "session", lease: restored }])).toBe(restored);
	});
	it("连续 Transcript 提交不刷新尾页，缺页、换代和 revision 断层才刷新", () => {
		const current = { pageLoaded: true, revision: 20, runtimeGeneration: "generation" };
		expect(needsTranscriptRefreshForCommit(current, { transcriptGeneration: "generation", fromRevision: 20 })).toBe(
			false,
		);
		expect(needsTranscriptRefreshForCommit(current, { transcriptGeneration: "generation", fromRevision: 18 })).toBe(
			false,
		);
		expect(needsTranscriptRefreshForCommit(current, { transcriptGeneration: "generation", fromRevision: 21 })).toBe(
			true,
		);
		expect(needsTranscriptRefreshForCommit(current, { transcriptGeneration: "next", fromRevision: 20 })).toBe(true);
		expect(
			needsTranscriptRefreshForCommit(
				{ ...current, pageLoaded: false },
				{ transcriptGeneration: "generation", fromRevision: 20 },
			),
		).toBe(true);
	});
	it("相同 Runtime 快照不会因历史文件使用独立 generation 而重置", () => {
		const current = {
			id: "session",
			transcriptGeneration: "session",
			transcriptRevision: 721339,
		} as WebSessionSnapshot;
		const historyPage = { transcriptGeneration: "session:2050:6685689:1788744398928", transcriptRevision: 721339 };
		expect(historyPage.transcriptGeneration).not.toBe(current.transcriptGeneration);
		expect(runtimeHistoryChanged(current, { ...current, revision: 9 })).toBe(false);
		expect(runtimeHistoryChanged(current, { ...current, transcriptRevision: 721400 })).toBe(false);
	});
	it("首次 Runtime 快照不代表历史被替换，Runtime generation 真正变化时才失效", () => {
		const snapshot = { id: "session", transcriptGeneration: "runtime-g" } as WebSessionSnapshot;
		expect(runtimeHistoryChanged(undefined, snapshot)).toBe(false);
		expect(runtimeHistoryChanged(snapshot, { ...snapshot, transcriptGeneration: "runtime-next" })).toBe(true);
	});
	it("旧快照不能覆盖新快照", () => {
		const current = { id: "session", revision: 8 } as WebSessionSnapshot;
		expect(isOlderSessionSnapshot(current, { ...current, revision: 7 })).toBe(true);
		expect(isOlderSessionSnapshot(current, { ...current, revision: 9 })).toBe(false);
	});
	it("旧 bootstrap 不会把完成操作恢复成运行中", () => {
		const completed = { operationId: "operation", updatedAt: 20, status: "completed" } as WebOperation;
		const running = { ...completed, updatedAt: 10, status: "running" } as WebOperation;
		expect(mergeOperationSnapshots([completed], [running])).toEqual([completed]);
	});
	it("首屏快照先到而 leaf 尚未加载时接受对应的历史页", () => {
		expect(isTranscriptResponseObsolete({}, { generation: "g" }, { transcriptGeneration: "g", leafId: "tail" })).toBe(
			false,
		);
	});
	it("明确的空分支仍然拒绝切换前的历史页", () => {
		expect(
			isTranscriptResponseObsolete(
				{ generation: "g", leafId: "tail" },
				{ generation: "g", leafId: null },
				{ transcriptGeneration: "g", leafId: "tail" },
			),
		).toBe(true);
	});
	it("generation 改变后拒绝旧历史页", () => {
		expect(
			isTranscriptResponseObsolete(
				{ generation: "old" },
				{ generation: "new" },
				{ transcriptGeneration: "old", leafId: "tail" },
			),
		).toBe(true);
	});
	it("同 generation 的分支切换会拒绝旧分页响应", () => {
		expect(
			isTranscriptResponseObsolete(
				{ generation: "g", leafId: "a" },
				{ generation: "g", leafId: "b" },
				{ transcriptGeneration: "g", leafId: "a" },
			),
		).toBe(true);
		expect(
			isTranscriptResponseObsolete(
				{ generation: "g", leafId: "a" },
				{ generation: "g", leafId: "b" },
				{ transcriptGeneration: "g", leafId: "b" },
			),
		).toBe(false);
	});
});
