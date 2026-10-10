import type { ShowToast } from "../../state/workbench-types";
import { Archive, CircleAlert, HardDrive, LoaderCircle, MoreHorizontal, PackageCheck } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { webApi } from "../../adapters/host-protocol/api";
import type {
	WebSessionSummary,
	WebSessionWorkspacesResult,
	WebSessionWorkspaceMode,
	WebSessionWorkspaceStatus,
} from "../../types";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "../ui/dropdown-menu";

const WORKSPACE_MODE_LABELS = {
	shared: "共享工作区",
	worktree: "独立 worktree",
	patch: "补丁交付",
} satisfies Record<WebSessionWorkspaceMode, string>;

const WORKSPACE_STATUS_LABELS = {
	active: "使用中",
	delivered: "已交付",
	accepted: "已接收",
	failed: "失败",
	released: "已回收",
} satisfies Record<WebSessionWorkspaceStatus, string>;

export function workspaceModeLabel(mode: WebSessionWorkspaceMode): string {
	return WORKSPACE_MODE_LABELS[mode];
}

export function workspaceStatusLabel(status: WebSessionWorkspaceStatus): string {
	return WORKSPACE_STATUS_LABELS[status];
}

export function formatWorkspaceSize(sizeBytes: number | undefined): string {
	if (sizeBytes === undefined) return "未提供";
	if (sizeBytes < 1024) return `${sizeBytes} B`;
	const units = ["KiB", "MiB", "GiB", "TiB"];
	let size = sizeBytes;
	let unitIndex = -1;
	while (size >= 1024 && unitIndex < units.length - 1) {
		size /= 1024;
		unitIndex += 1;
	}
	return `${new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 1 }).format(size)} ${units[unitIndex]}`;
}

function workspaceEntryName(entry: WebSessionWorkspacesResult["workspaces"][number], sessions: readonly WebSessionSummary[]): string {
	const session = sessions.find((candidate) => candidate.id === entry.sessionId);
	return session?.name?.trim() || session?.firstMessage.trim() || entry.sessionId;
}

function workspaceEntryReason(entry: WebSessionWorkspacesResult["workspaces"][number]): string | undefined {
	const reasons = [...new Set(
		[entry.workspace.retainedReason, entry.reason].filter((reason): reason is string => Boolean(reason)),
	)];
	return reasons.length ? reasons.join("；") : undefined;
}

export function WorkspaceManagementDialog({
	open,
	projectId,
	sessions,
	initialSessionId,
	onOpenChange,
	onReleased,
}: {
	open: boolean;
	projectId: string;
	sessions: readonly WebSessionSummary[];
	initialSessionId?: string;
	onOpenChange: (open: boolean) => void;
	onReleased?: (sessionIds: string[]) => Promise<void>;
}) {
	const [loading, setLoading] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string>();
	const [notice, setNotice] = useState<string>();
	const [preview, setPreview] = useState<WebSessionWorkspacesResult>();
	const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
	const previewRequestRef = useRef(0);

	const loadPreview = useCallback(async () => {
		const requestId = ++previewRequestRef.current;
		setLoading(true);
		setError(undefined);
		try {
			const result = await webApi.sessionWorkspaces(
				projectId,
				"preview",
				initialSessionId ? [initialSessionId] : undefined,
			);
			if (requestId !== previewRequestRef.current) return;
			setPreview(result);
			setSelectedIds(new Set());
		} catch (cause) {
			if (requestId === previewRequestRef.current) setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			if (requestId === previewRequestRef.current) setLoading(false);
		}
	}, [initialSessionId, projectId]);

	useEffect(() => {
		if (!open || !projectId) return;
		setNotice(undefined);
		setPreview(undefined);
		setSelectedIds(new Set());
		void loadPreview();
		return () => { previewRequestRef.current += 1; };
	}, [loadPreview, open, projectId]);

	const toggleSelected = (sessionId: string, checked: boolean) => {
		setSelectedIds((current) => {
			const next = new Set(current);
			if (checked) next.add(sessionId);
			else next.delete(sessionId);
			return next;
		});
	};

	const cleanup = async () => {
		if (busy || !selectedIds.size) return;
		setBusy(true);
		setError(undefined);
		setNotice(undefined);
		try {
			const result = await webApi.sessionWorkspaces(projectId, "cleanup", [...selectedIds]);
			const released = result.released ?? [];
			await onReleased?.(released);
			setNotice(released.length
				? `已回收 ${released.length} 个工作区，会话记录仍保留。`
				: "没有工作区被回收，会话记录仍保留。",
			);
			await loadPreview();
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setBusy(false);
		}
	};

	const workspaces = preview?.workspaces ?? [];
	const releasableIds = workspaces.filter((entry) => entry.canRelease).map((entry) => entry.sessionId);
	const allReleasableSelected = releasableIds.length > 0 && releasableIds.every((sessionId) => selectedIds.has(sessionId));
	const toggleAllReleasable = (checked: boolean) => setSelectedIds(checked ? new Set(releasableIds) : new Set());

	return (
		<Dialog open={open} onOpenChange={(next) => { if (!busy) onOpenChange(next); }}>
			<DialogContent className="sm:max-w-2xl">
				<DialogHeader>
					<DialogTitle>工作区管理</DialogTitle>
					<DialogDescription>确认列表中的工作区后再回收。回收不会删除会话。</DialogDescription>
				</DialogHeader>
				{error ? <p className="text-sm text-destructive" role="alert">{error}</p> : null}
				{notice ? <p className="text-sm text-[var(--success)]" role="status">{notice}</p> : null}
				{loading ? (
					<div className="flex items-center gap-2 py-8 text-sm text-muted-foreground" role="status">
						<LoaderCircle className="size-4 animate-spin" aria-hidden="true" />正在读取工作区
					</div>
				) : workspaces.length ? (
					<div aria-label="工作区预览列表" className="max-h-[55dvh] overflow-y-auto rounded-md border border-border/70" role="group">
						<label className="flex items-center gap-2 border-b border-border/60 px-3 py-2 text-xs text-muted-foreground">
							<input
								aria-label="选择全部可回收工作区"
								checked={allReleasableSelected}
								className="size-4 accent-primary"
								disabled={releasableIds.length === 0 || busy}
								onChange={(event) => toggleAllReleasable(event.target.checked)}
								type="checkbox"
							/>
							选择全部可回收工作区（{releasableIds.length}）
						</label>
						{workspaces.map((entry) => {
							const reason = workspaceEntryReason(entry);
							const noCleanupRequired = entry.workspace.mode === "shared" || entry.workspace.status === "released";
							return (
								<label
									className="grid grid-cols-[auto_minmax(0,1fr)] gap-3 border-b border-border/60 px-3 py-3 last:border-b-0"
									key={entry.sessionId}
								>
									<input
										aria-label={`选择回收 ${workspaceEntryName(entry, sessions)}`}
										checked={selectedIds.has(entry.sessionId)}
										className="mt-1 size-4 accent-primary"
										disabled={!entry.canRelease || busy}
										onChange={(event) => toggleSelected(entry.sessionId, event.target.checked)}
										type="checkbox"
									/>
									<span className="grid min-w-0 gap-1.5">
										<span className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1 text-sm">
											<strong className="min-w-0 break-words font-medium">{workspaceEntryName(entry, sessions)}</strong>
											<span className="text-xs text-muted-foreground">模式：{WORKSPACE_MODE_LABELS[entry.workspace.mode]}，状态：{WORKSPACE_STATUS_LABELS[entry.workspace.status]}</span>
										</span>
										<span className="break-all font-mono text-[11px] text-muted-foreground">{entry.workspace.worktreePath ?? entry.workspace.cwd}</span>
										<span className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
											<span>大小：{formatWorkspaceSize(entry.workspace.sizeBytes)}</span>
											<span>信任来源：{entry.workspace.trustSource ?? "未提供"}</span>
										</span>
										{reason ? <span className="break-words text-xs text-muted-foreground">说明：{reason}</span> : null}
										{entry.result?.workspace ? (
											<span className="text-xs text-muted-foreground">
												结果工作区：{WORKSPACE_MODE_LABELS[entry.result.workspace.mode]}，状态：{WORKSPACE_STATUS_LABELS[entry.result.workspace.status]}
											</span>
										) : null}
										{entry.result?.resultText ? <span className="line-clamp-3 whitespace-pre-wrap break-words text-xs">{entry.result.resultText}</span> : null}
										{entry.result?.error ? <span className="break-words text-xs text-destructive">{entry.result.error}</span> : null}
										{!entry.canRelease ? (
											<span className="flex items-center gap-1 text-xs text-muted-foreground">
												{noCleanupRequired ? null : <CircleAlert className="size-3" aria-hidden="true" />}
												{noCleanupRequired ? "无需回收" : "不可回收"}
											</span>
										) : null}
									</span>
								</label>
							);
						})}
					</div>
				) : !loading && !error ? (
					<p className="py-8 text-center text-sm text-muted-foreground">当前项目没有可预览的工作区。</p>
				) : null}
				<DialogFooter>
					<Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>关闭</Button>
					<Button variant="outline" disabled={busy || loading} onClick={() => void loadPreview()}>刷新预览</Button>
					<Button disabled={busy || loading || selectedIds.size === 0} onClick={() => void cleanup()}>
						{busy ? <LoaderCircle className="size-4 animate-spin" aria-hidden="true" /> : <Archive className="size-4" aria-hidden="true" />}
						{busy ? "正在回收" : `回收选中的 ${selectedIds.size} 项`}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

export function SessionWorkspaceActions({
	projectId,
	session,
	sessions,
	onRefresh,
	onToast,
}: {
	projectId?: string;
	session: WebSessionSummary;
	sessions: readonly WebSessionSummary[];
	onRefresh: (projectId: string) => Promise<void>;
	onToast: ShowToast;
}) {
	const [manageOpen, setManageOpen] = useState(false);
	const [accepting, setAccepting] = useState(false);
	const workspace = session.workspace;
	if (!workspace || !projectId) return null;

	const acceptResult = async () => {
		if (accepting || workspace.status !== "delivered") return;
		setAccepting(true);
		try {
			await webApi.acceptSessionResult(session.id);
			await onRefresh(projectId);
			onToast("协作结果已接收", "success");
		} catch (cause) {
			onToast(cause instanceof Error ? cause.message : String(cause), "error");
		} finally {
			setAccepting(false);
		}
	};

	return (
		<div className="flex min-w-0 items-center gap-1.5">
			{workspace.status !== "released" ? (
				<DropdownMenu>
					<DropdownMenuTrigger asChild>
						<Button aria-label={`管理 ${session.name?.trim() || "协作子会话"} 的工作区`} className="size-7 shrink-0" size="icon" title="管理工作区" variant="ghost">
							<MoreHorizontal className="size-4" aria-hidden="true" />
						</Button>
					</DropdownMenuTrigger>
					<DropdownMenuContent align="end">
						<DropdownMenuLabel className="max-w-64 whitespace-normal text-xs font-normal text-muted-foreground">
							模式：{WORKSPACE_MODE_LABELS[workspace.mode]}，状态：{WORKSPACE_STATUS_LABELS[workspace.status]}
						</DropdownMenuLabel>
						<DropdownMenuSeparator />
						{workspace.status === "delivered" ? (
							<DropdownMenuItem disabled={accepting} onSelect={() => void acceptResult()}>
								<PackageCheck className="size-4" aria-hidden="true" />接收结果
							</DropdownMenuItem>
						) : null}
						<DropdownMenuItem onSelect={() => setManageOpen(true)}>
							<HardDrive className="size-4" aria-hidden="true" />预览并回收工作区
						</DropdownMenuItem>
					</DropdownMenuContent>
				</DropdownMenu>
			) : null}
			<WorkspaceManagementDialog
				open={manageOpen}
				projectId={projectId}
				sessions={sessions}
				initialSessionId={session.id}
				onOpenChange={setManageOpen}
				onReleased={async () => onRefresh(projectId)}
			/>
		</div>
	);
}
