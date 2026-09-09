import { Check, LoaderCircle, Pencil, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { sessionTitle } from "../../state/use-workbench.ts";
import type { WebProject, WebSessionSummary } from "../../types.ts";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../ui/dialog";
import { Input } from "../ui/input";
import { ScrollArea } from "../ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import {
	formatSessionTimestamp,
	SESSION_SORT_OPTIONS,
	type SessionSortMode,
	sortSessionSummaries,
} from "./session-management.ts";
import type { WorkbenchActions } from "./types.ts";

function sessionWithName(session: WebSessionSummary, name: string | undefined): WebSessionSummary {
	if (name === undefined) return session;
	return { ...session, name };
}

export function SessionManagementDialog({
	project,
	actions,
	onClose,
}: {
	project?: WebProject;
	actions: WorkbenchActions;
	onClose: () => void;
}) {
	const [sortMode, setSortMode] = useState<SessionSortMode>("manual");
	const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
	const [removedIds, setRemovedIds] = useState<Set<string>>(() => new Set());
	const [renamed, setRenamed] = useState<Record<string, string>>({});
	const [editingId, setEditingId] = useState<string>();
	const [renameDraft, setRenameDraft] = useState("");
	const [pendingDeleteIds, setPendingDeleteIds] = useState<string[]>([]);
	const [busyAction, setBusyAction] = useState<"sort" | "delete" | string>();

	useEffect(() => {
		setSortMode("manual");
		setSelectedIds(new Set());
		setRemovedIds(new Set());
		setRenamed({});
		setEditingId(undefined);
		setPendingDeleteIds([]);
	}, [project?.id]);

	const sessions = useMemo(() => {
		const current = (project?.sessions ?? [])
			.filter((session) => !removedIds.has(session.id))
			.map((session) => sessionWithName(session, renamed[session.id]));
		return sortSessionSummaries(current, sortMode);
	}, [project?.sessions, removedIds, renamed, sortMode]);

	const allSelected = sessions.length > 0 && sessions.every((session) => selectedIds.has(session.id));
	const selectedCount = sessions.filter((session) => selectedIds.has(session.id)).length;

	const toggleSelected = (sessionId: string) => {
		setSelectedIds((current) => {
			const next = new Set(current);
			if (next.has(sessionId)) next.delete(sessionId);
			else next.add(sessionId);
			return next;
		});
	};

	const toggleAll = () => {
		setSelectedIds(allSelected ? new Set() : new Set(sessions.map((session) => session.id)));
	};

	const beginRename = (session: WebSessionSummary) => {
		setEditingId(session.id);
		setRenameDraft(sessionTitle(session));
	};

	const commitRename = async (session: WebSessionSummary) => {
		const name = renameDraft.trim();
		if (!name) return;
		setBusyAction(session.id);
		try {
			await actions.renameSession(session.id, name);
			setRenamed((current) => ({ ...current, [session.id]: name }));
			setEditingId(undefined);
		} finally {
			setBusyAction(undefined);
		}
	};

	const confirmDelete = async () => {
		if (!pendingDeleteIds.length) return;
		const ids = pendingDeleteIds;
		setBusyAction("delete");
		try {
			for (const sessionId of ids) await actions.deleteSession(sessionId);
			setRemovedIds((current) => new Set([...current, ...ids]));
			setSelectedIds((current) => {
				const next = new Set(current);
				for (const sessionId of ids) next.delete(sessionId);
				return next;
			});
			setPendingDeleteIds([]);
		} finally {
			setBusyAction(undefined);
		}
	};

	const handleSortChange = async (value: string) => {
		const nextMode = value as SessionSortMode;
		setSortMode(nextMode);
		if (!project || nextMode === "manual") return;

		const source = project.sessions
			.filter((session) => !removedIds.has(session.id))
			.map((session) => sessionWithName(session, renamed[session.id]));
		const ordered = sortSessionSummaries(source, nextMode);
		setBusyAction("sort");
		try {
			await actions.reorderSessions(
				project.id,
				ordered.map((session) => session.id),
			);
		} finally {
			setBusyAction(undefined);
		}
	};

	return (
		<>
			<Dialog
				open={Boolean(project)}
				onOpenChange={(open) => {
					if (!open) onClose();
				}}
			>
				<DialogContent className="!flex min-h-0 max-h-[min(88vh,760px)] w-[min(100%-1rem,760px)] max-w-none flex-col gap-0 overflow-hidden p-0 max-sm:inset-0 max-sm:h-dvh max-sm:max-h-none max-sm:w-screen max-sm:max-w-none max-sm:translate-x-0 max-sm:translate-y-0 max-sm:rounded-none sm:max-w-[760px]">
					<DialogHeader className="shrink-0 border-b border-border/60 px-5 py-4 pr-12 text-left">
						<DialogTitle>会话管理</DialogTitle>
						<DialogDescription>
							{project?.name ?? "项目"} · {sessions.length} 个会话
						</DialogDescription>
					</DialogHeader>
					<div className="flex shrink-0 items-center gap-3 border-b border-border/60 px-5 py-3">
						<label className="flex h-8 items-center gap-2 text-sm text-muted-foreground">
							<input
								className="size-4 accent-primary"
								type="checkbox"
								checked={allSelected}
								onChange={toggleAll}
								aria-label="全选会话"
							/>
							<span>全选</span>
						</label>
						<span className="ml-auto text-sm text-muted-foreground">排序方式</span>
						<Select
							value={sortMode}
							onValueChange={(value) => void handleSortChange(value)}
							disabled={busyAction !== undefined}
						>
							<SelectTrigger aria-label="排序方式" size="sm" className="ml-auto w-40 min-w-0">
								<SelectValue placeholder="排序方式" />
							</SelectTrigger>
							<SelectContent position="popper" align="end" className="min-w-[var(--radix-select-trigger-width)]">
								{SESSION_SORT_OPTIONS.map((option) => (
									<SelectItem key={option.value} value={option.value}>
										{option.label}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</div>
					<ScrollArea className="min-h-0 flex-1 overflow-hidden px-5">
						<div className="grid gap-1 py-3">
							{sessions.map((session) => {
								const editing = editingId === session.id;
								const busy = busyAction === session.id;
								return (
									<div
										key={session.id}
										className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-3 rounded-md border border-transparent px-2 py-3 hover:bg-muted/50"
									>
										<input
											className="mt-1 size-4 accent-primary"
											type="checkbox"
											checked={selectedIds.has(session.id)}
											onChange={() => toggleSelected(session.id)}
											aria-label={`选择会话：${sessionTitle(session)}`}
										/>
										<div className="min-w-0">
											{editing ? (
												<div className="flex items-center gap-2">
													<Input
														className="h-8 min-w-0"
														value={renameDraft}
														autoFocus
														disabled={busy}
														onChange={(event) => setRenameDraft(event.target.value)}
														onKeyDown={(event) => {
															if (event.key === "Enter") {
																event.preventDefault();
																void commitRename(session);
															}
															if (event.key === "Escape") setEditingId(undefined);
														}}
													/>
													<Button
														size="icon-xs"
														variant="ghost"
														onClick={() => void commitRename(session)}
														disabled={busy || !renameDraft.trim()}
														aria-label="保存会话名称"
													>
														{busy ? (
															<LoaderCircle className="size-3 animate-spin" />
														) : (
															<Check className="size-3" />
														)}
													</Button>
													<Button
														size="icon-xs"
														variant="ghost"
														onClick={() => setEditingId(undefined)}
														disabled={busy}
														aria-label="取消重命名"
													>
														<X className="size-3" />
													</Button>
												</div>
											) : (
												<p className="truncate text-sm font-medium">{sessionTitle(session)}</p>
											)}
											<div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
												<time dateTime={new Date(session.createdAt).toISOString()}>
													创建 {formatSessionTimestamp(session.createdAt)}
												</time>
												<time dateTime={new Date(session.updatedAt).toISOString()}>
													最后回复 {formatSessionTimestamp(session.updatedAt)}
												</time>
											</div>
										</div>
										<div className="flex shrink-0 items-center gap-1">
											<Button
												size="icon-xs"
												variant="ghost"
												onClick={() => beginRename(session)}
												disabled={busy || editing}
												aria-label={`重命名会话：${sessionTitle(session)}`}
											>
												<Pencil className="size-3.5" />
											</Button>
											<Button
												size="icon-xs"
												variant="ghost"
												className="text-muted-foreground hover:text-destructive"
												onClick={() => setPendingDeleteIds([session.id])}
												disabled={busy}
												aria-label={`删除会话：${sessionTitle(session)}`}
											>
												<Trash2 className="size-3.5" />
											</Button>
										</div>
									</div>
								);
							})}
							{!sessions.length ? (
								<div className="py-12 text-center text-sm text-muted-foreground">暂无会话</div>
							) : null}
						</div>
					</ScrollArea>
					<DialogFooter className="shrink-0 flex-row items-center justify-between border-t border-border/60 bg-background px-5 py-3">
						<span className="text-xs text-muted-foreground">已选择 {selectedCount} 个会话</span>
						<Button
							size="sm"
							variant="destructive"
							disabled={!selectedCount || busyAction !== undefined}
							onClick={() =>
								setPendingDeleteIds(
									sessions.filter((session) => selectedIds.has(session.id)).map((session) => session.id),
								)
							}
						>
							<Trash2 className="size-4" />
							删除所选
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
			<Dialog
				open={pendingDeleteIds.length > 0}
				onOpenChange={(open) => !open && !busyAction && setPendingDeleteIds([])}
			>
				<DialogContent className="max-w-md">
					<DialogHeader>
						<DialogTitle>删除会话？</DialogTitle>
						<DialogDescription>
							{pendingDeleteIds.length === 1
								? "这个会话删除后无法恢复。"
								: `已选择 ${pendingDeleteIds.length} 个会话，删除后无法恢复。`}
						</DialogDescription>
					</DialogHeader>
					<DialogFooter>
						<Button variant="outline" onClick={() => setPendingDeleteIds([])} disabled={busyAction === "delete"}>
							取消
						</Button>
						<Button variant="destructive" onClick={() => void confirmDelete()} disabled={busyAction === "delete"}>
							{busyAction === "delete" ? (
								<LoaderCircle className="size-4 animate-spin" />
							) : (
								<Trash2 className="size-4" />
							)}
							确认删除
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</>
	);
}
