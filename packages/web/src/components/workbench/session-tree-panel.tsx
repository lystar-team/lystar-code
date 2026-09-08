import { GitFork, Info, RefreshCw, Wrench } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { cn } from "../../lib/utils";
import type { WorkbenchState } from "../../state/use-workbench";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../ui/dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";
import { VirtualizedSessionList, type ScrollRef } from "./virtualized-session-list";
import {
	buildSessionTurns,
	formatSessionTreeTimestamp,
	sessionTreeNodeKindLabel,
	sessionTreeNodeLabel,
	sessionTurnLabel,
	type SessionTurn,
} from "./session-tree-utils";
import { SessionTurnRow } from "./session-turn-row";
import type { WorkbenchActions } from "./types";

const INITIAL_VISIBLE_TURNS = 24;
const VISIBLE_TURN_BATCH_SIZE = 24;
const LOAD_MORE_THRESHOLD = 480;

export function SessionToolsDialog({ turn, onClose }: { turn?: SessionTurn; onClose: () => void }) {
	return (
		<Dialog open={Boolean(turn)} onOpenChange={(open) => !open && onClose()}>
			<DialogContent className="max-h-[calc(100vh-2rem)] max-w-lg overflow-hidden p-0">
				<div className="max-h-[calc(100vh-2rem)] overflow-y-auto p-6">
					<DialogHeader>
						<DialogTitle>查看工具动作</DialogTitle>
						<DialogDescription>
							{turn ? `${sessionTurnLabel(turn)} · 共 ${turn.toolNodes.length} 个工具动作` : "查看这轮会话中的工具调用和结果。"}
						</DialogDescription>
					</DialogHeader>
					{turn ? (
						<div className="mt-5 grid gap-2">
							{turn.toolNodes.map((node) => (
								<div key={node.id} className="flex min-w-0 items-start gap-2 rounded-md border bg-muted/20 px-3 py-2">
									<Wrench className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
									<div className="min-w-0 flex-1">
										<div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
											<span>{sessionTreeNodeKindLabel(node)}</span>
											<time className="shrink-0" dateTime={node.timestamp}>
												{formatSessionTreeTimestamp(node.timestamp)}
											</time>
										</div>
										<p className="mt-1 break-words text-sm">{sessionTreeNodeLabel(node)}</p>
									</div>
								</div>
							))}
						</div>
					) : null}
				</div>
			</DialogContent>
		</Dialog>
	);
}

export type SessionTreePanelProps = {
	state: WorkbenchState;
	actions: WorkbenchActions;
	scrollRef: ScrollRef;
};

export function SessionTreePanel({
	state,
	actions,
	scrollRef,
}: SessionTreePanelProps) {
	const [pendingTurnId, setPendingTurnId] = useState<string>();
	const [toolTurnId, setToolTurnId] = useState<string>();
	const [visibleTurnCount, setVisibleTurnCount] = useState(INITIAL_VISIBLE_TURNS);
	const [forkingTurnId, setForkingTurnId] = useState<string>();
	const turns = useMemo(() => buildSessionTurns(state.sessionTree), [state.sessionTree]);
	const visibleTurns = useMemo(() => turns.slice(0, visibleTurnCount), [turns, visibleTurnCount]);
	const pendingTurn = turns.find((turn) => turn.id === pendingTurnId);
	const toolTurn = turns.find((turn) => turn.id === toolTurnId);
	const canFork = Boolean(state.sessionId && state.connected && !state.readOnly && !forkingTurnId);

	useEffect(() => {
		setPendingTurnId(undefined);
		setToolTurnId(undefined);
		setVisibleTurnCount(INITIAL_VISIBLE_TURNS);
		setForkingTurnId(undefined);
	}, [state.sessionId]);

	useEffect(() => {
		const viewport = scrollRef.current;
		if (!viewport || visibleTurnCount >= turns.length) return;
		const loadMoreWhenNearBottom = () => {
			const distanceToBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
			if (distanceToBottom > LOAD_MORE_THRESHOLD) return;
			setVisibleTurnCount((count) => Math.min(count + VISIBLE_TURN_BATCH_SIZE, turns.length));
		};
		viewport.addEventListener("scroll", loadMoreWhenNearBottom, { passive: true });
		loadMoreWhenNearBottom();
		return () => viewport.removeEventListener("scroll", loadMoreWhenNearBottom);
	}, [scrollRef, turns.length, visibleTurnCount]);

	const confirmFork = async () => {
		if (!pendingTurn || !canFork) return;
		setForkingTurnId(pendingTurn.id);
		try {
			await actions.fork(pendingTurn.forkEntryId);
			setPendingTurnId(undefined);
		} catch (error) {
			actions.showToast(error instanceof Error ? error.message : String(error));
		} finally {
			setForkingTurnId(undefined);
		}
	};

	return (
		<>
			<div className="grid w-full min-w-0 gap-3 p-4">
				<div className="flex items-start justify-between gap-3">
					<div className="min-w-0">
						<div className="flex items-center gap-2">
							<h2 className="font-semibold">会话分支</h2>
							<Badge className="h-5 px-1.5 text-xs" variant="outline">{turns.length} 轮</Badge>
						<Tooltip>
							<TooltipTrigger asChild>
								<button
									type="button"
									className="inline-flex size-5 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
									aria-label="会话分支说明"
								>
									<Info className="size-3.5" />
								</button>
							</TooltipTrigger>
							<TooltipContent
								side="bottom"
								align="start"
								className="max-w-[min(360px,calc(100vw-2rem))] whitespace-normal leading-5"
							>
								每轮会话包含用户提交、Agent 回复和工具动作。确认后会从该轮用户提交的位置 fork，不会回放或修改当前会话。
							</TooltipContent>
						</Tooltip>
						</div>
						<p className="mt-1 text-xs leading-5 text-muted-foreground">选择一轮历史会话，从该轮用户提交的位置创建新分支。</p>
					</div>
					<Button
						size="icon"
						variant="ghost"
						onClick={() => void actions.loadSessionTree()}
						aria-label="刷新会话分支"
						title="刷新会话分支"
					>
						<RefreshCw className={cn("size-4", state.sessionTreeLoading && "animate-spin")} />
					</Button>
				</div>

				{state.sessionTreeLoading && !turns.length ? (
					<div className="border-b border-border/70 py-6 text-center text-sm text-muted-foreground" role="status">
						正在加载会话轮次…
					</div>
				) : turns.length ? (
					<div className="grid gap-1">
						<VirtualizedSessionList
						items={visibleTurns}
						getKey={(turn) => turn.id}
						scrollRef={scrollRef}
						rowHeight={56}
						rowGap={4}
						renderItem={(turn) => (
							<SessionTurnRow
								turn={turn}
								selected={pendingTurnId === turn.id}
								disabled={!canFork}
									onSelect={() => setPendingTurnId(turn.id)}
							/>
						)}
					/>
						{visibleTurns.length < turns.length ? (
							<div className="py-2 text-center text-xs text-muted-foreground" role="status">
								已显示 {visibleTurns.length} / {turns.length} 轮，继续滚动加载更多
							</div>
						) : null}
					</div>
				) : (
					<div className="border-b border-border/70 py-6 text-center">
						<p className="text-sm font-medium">当前会话还没有可创建分支的历史轮次</p>
						<p className="mt-1 text-xs leading-5 text-muted-foreground">发送一轮消息后，这里会列出可用的 fork 位置。</p>
					</div>
				)}
			</div>

			<SessionToolsDialog turn={toolTurn} onClose={() => setToolTurnId(undefined)} />

			<Dialog
				open={Boolean(pendingTurn)}
				onOpenChange={(open) => {
					if (!open && !forkingTurnId) setPendingTurnId(undefined);
				}}
			>
				<DialogContent className="max-w-md">
					<DialogHeader>
						<DialogTitle>从这轮会话创建分支？</DialogTitle>
						<DialogDescription>
							系统会使用这轮会话的用户提交作为 fork 入口，创建新会话。当前会话和当前分支会保留。
						</DialogDescription>
					</DialogHeader>
					{pendingTurn ? (
						<div className="grid gap-2 rounded-lg border bg-muted/30 p-3">
							<p className="line-clamp-3 text-sm font-medium">{sessionTurnLabel(pendingTurn)}</p>
							<div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
								<span>会话轮次</span>
								<span aria-hidden="true">·</span>
								<time dateTime={pendingTurn.timestamp}>{formatSessionTreeTimestamp(pendingTurn.timestamp)}</time>
								{pendingTurn.toolNodes.length ? (
									<button
										type="button"
										className="rounded-md px-1.5 py-0.5 text-xs text-muted-foreground underline-offset-2 hover:bg-accent hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
										onClick={() => setToolTurnId(pendingTurn.id)}
									>
										{pendingTurn.toolNodes.length} 个工具动作
									</button>
								) : null}
							</div>
							{pendingTurn.userNode ? <p className="text-xs text-muted-foreground">fork 入口：{pendingTurn.userNode.id}</p> : null}
							{pendingTurn.userNode ? null : <p className="text-xs text-destructive">这轮没有用户提交，不能作为 fork 入口。</p>}
						</div>
					) : null}
					<DialogFooter>
						<Button variant="outline" onClick={() => setPendingTurnId(undefined)} disabled={Boolean(forkingTurnId)}>
							取消
						</Button>
						<Button
							onClick={() => void confirmFork()}
							disabled={!canFork || !pendingTurn?.userNode}
						>
							<GitFork className="size-4" />
							{forkingTurnId ? "正在创建…" : "创建新会话"}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</>
	);
}
