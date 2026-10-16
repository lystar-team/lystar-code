import { type ReactNode, useMemo } from "react";
import { sessionTitle } from "../../state/workbench-state.ts";
import type { WebProject, WebSessionSummary } from "../../types.ts";
import { Button } from "../ui/button.tsx";
import { isSessionRunning, isSessionUnread } from "./project-rail-utils.ts";
import type { ScrollRef } from "./virtualized-session-list.tsx";
import { VirtualizedSessionList } from "./virtualized-session-list.tsx";

export interface SessionResultEntry {
	project: WebProject;
	session: WebSessionSummary;
}

export function sessionResultEntryKey(entry: SessionResultEntry): string {
	return entry.session.id;
}

export function SessionResultsList({
	entries,
	unreadSessionIds,
	selectedSessionId,
	retainedUnread,
	visibleCount,
	pageSize,
	onLoadMore,
	onCollapse,
	onMarkAllRead,
	markingAllRead,
	markAllReadDisabled,
	query,
	loading,
	scrollRef,
	focusRequest,
	renderEntry,
}: {
	entries: readonly SessionResultEntry[];
	unreadSessionIds: Readonly<Record<string, true>>;
	selectedSessionId?: string;
	retainedUnread?: { sessionId: string; index: number };
	visibleCount: number;
	pageSize: number;
	onLoadMore: () => void;
	onCollapse: () => void;
	onMarkAllRead: () => void;
	markingAllRead: boolean;
	markAllReadDisabled: boolean;
	query: string;
	loading: boolean;
	scrollRef: ScrollRef;
	focusRequest?: { sessionId?: string; id: number };
	renderEntry: (entry: SessionResultEntry, waitingIndex?: number) => ReactNode;
}) {
	const { waiting, recent } = useMemo(() => {
		const results = entries.filter(({ session }) => !isSessionRunning(session));
		const waiting = results.filter(({ session }) => isSessionUnread(session, unreadSessionIds));
		// 点击位置按当前搜索后的列表记录，确认已读后仍留在同一行。
		const filteredWaiting = waiting.filter(({ project, session }) => !query || project.name.toLowerCase().includes(query) ||
			sessionTitle(session).toLowerCase().includes(query));
		const retained = retainedUnread?.sessionId === selectedSessionId
			? results.find(({ session }) => session.id === selectedSessionId) : undefined;
		if (retained && retainedUnread && !filteredWaiting.some(({ session }) => session.id === retained.session.id) &&
			(!query || retained.project.name.toLowerCase().includes(query) || sessionTitle(retained.session).toLowerCase().includes(query)))
			filteredWaiting.splice(Math.min(retainedUnread.index, filteredWaiting.length), 0, retained);
		// 先取全局最近五个，再筛选搜索，避免搜索把更早记录重新带入结果入口。
		const recent = results
			.filter(({ session }) => session.result?.viewedAt !== undefined && !isSessionUnread(session, unreadSessionIds))
			.sort((left, right) => right.session.result!.viewedAt! - left.session.result!.viewedAt!)
			.slice(0, 5)
			.filter(({ session }) => session.id !== retained?.session.id);
		return {
			waiting: filteredWaiting,
			recent: recent.filter(({ project, session }) => !query || project.name.toLowerCase().includes(query) ||
				sessionTitle(session).toLowerCase().includes(query)),
		};
	}, [entries, unreadSessionIds, retainedUnread, selectedSessionId, query]);
	const unreadCount = waiting.filter(({ session }) => isSessionUnread(session, unreadSessionIds)).length;
	const shown = waiting.slice(0, visibleCount);
	const hasMore = waiting.length > shown.length;
	const canCollapse = visibleCount > pageSize && waiting.length > pageSize;
	return (
		<div className="grid gap-4 pb-5">
			<section aria-label="待查看结果">
				<div className="flex items-center justify-between gap-2 px-2 pb-2 text-xs font-medium text-muted-foreground">
					<span>待查看</span>
					<div className="flex items-center gap-2">
						<Button
							className="h-8 px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-transparent hover:text-foreground"
							variant="ghost"
							disabled={markingAllRead || markAllReadDisabled}
							aria-busy={markingAllRead}
							onClick={onMarkAllRead}
						>
							{markingAllRead ? "正在标记" : "全部已读"}
						</Button>
						<span>{unreadCount}</span>
					</div>
				</div>
				{shown.length ? (
					<VirtualizedSessionList
						items={shown}
						getKey={sessionResultEntryKey}
						scrollRef={scrollRef}
						scrollToKey={focusRequest?.sessionId}
						scrollRequestId={focusRequest?.id}
						renderItem={(entry, index) => renderEntry(entry, index)}
					/>
				) : <p className="px-2 py-3 text-xs text-muted-foreground">{loading ? "正在加载会话结果" : query ? "没有匹配的待查看结果" : "没有待查看的结果"}</p>}
				{hasMore || canCollapse ? (
					<div className="mt-0.5 flex min-w-0 items-center gap-1" role="group" aria-label="结果列表分页">
						{hasMore ? (
							<Button
								className="h-8 min-w-0 flex-1 justify-start gap-2 py-1 pr-2 !pl-8 text-left text-xs text-muted-foreground transition-colors hover:bg-transparent hover:text-foreground"
								variant="ghost"
								onClick={onLoadMore}
							>
								<span className="project-list-item-label min-w-0 flex-1 truncate">加载更多</span>
							</Button>
						) : (
							<span className="min-w-0 flex-1" aria-hidden="true" />
						)}
						{canCollapse ? (
							<Button
								className="h-8 shrink-0 justify-end px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-transparent hover:text-foreground"
								variant="ghost"
								onClick={onCollapse}
							>
								<span className="project-list-item-label">收起更多</span>
							</Button>
						) : null}
					</div>
				) : null}
			</section>
			<section aria-label="最近查看结果">
				<div className="flex items-center justify-between px-2 pb-2 text-xs font-medium text-muted-foreground">
					<span>最近查看</span><span>{recent.length}</span>
				</div>
				{recent.length ? (
					<VirtualizedSessionList
						items={recent}
						getKey={sessionResultEntryKey}
						scrollRef={scrollRef}
						scrollToKey={focusRequest?.sessionId}
						scrollRequestId={focusRequest?.id}
						renderItem={(entry) => renderEntry(entry)}
					/>
				) : <p className="px-2 py-3 text-xs text-muted-foreground">{query ? "没有匹配的最近查看结果" : "查看后的结果会显示在这里，最多五个"}</p>}
			</section>
		</div>
	);
}
