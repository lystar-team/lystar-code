import type { GitFileStatus, GitRepositoryStatus } from "@lystar/code-web-protocol";
import {
	ArrowDown,
	ArrowUp,
	Check,
	ChevronDown,
	ChevronRight,
	File,
	Folder,
	FolderTree,
	GitBranch,
	GitCommitHorizontal,
	GitMerge,
	History,
	List,
	LoaderCircle,
	Minus,
	Plus,
	RefreshCw,
	RotateCcw,
	Trash2,
	X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { cn } from "../../lib/utils";
import { gitFileStatsKey, type WorkbenchState } from "../../state/use-workbench";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card, CardContent } from "../ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../ui/collapsible";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "../ui/dialog";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuSub,
	DropdownMenuSubContent,
	DropdownMenuSubTrigger,
	DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { Input } from "../ui/input";
import { ScrollArea } from "../ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../ui/tabs";
import { Textarea } from "../ui/textarea";
import type { WorkbenchActions } from "./types";

type GitDirectoryNode = {
	name: string;
	path: string;
	directories: Map<string, GitDirectoryNode>;
	files: GitFileStatus[];
};

function repositoriesForStatus(status: WorkbenchState["gitStatus"]): GitRepositoryStatus[] {
	if (!status) return [];
	if (status.repositories?.length) return status.repositories;
	return [
		{
			root: status.root,
			path: "",
			kind: "root",
			...(status.branch ? { branch: status.branch } : {}),
			...(status.upstream ? { upstream: status.upstream } : {}),
			...(status.detached ? { detached: true } : {}),
			...(status.merging ? { merging: true } : {}),
			ahead: status.ahead,
			behind: status.behind,
			files: status.files,
		},
	];
}

function buildGitTree(files: GitFileStatus[]): GitDirectoryNode {
	const root: GitDirectoryNode = { name: "", path: "", directories: new Map(), files: [] };
	for (const file of files) {
		const segments = file.path.replaceAll("\\", "/").split("/").filter(Boolean);
		const fileName = segments.pop();
		if (!fileName) continue;
		let directory = root;
		for (const segment of segments) {
			const path = directory.path ? `${directory.path}/${segment}` : segment;
			let child = directory.directories.get(segment);
			if (!child) {
				child = { name: segment, path, directories: new Map(), files: [] };
				directory.directories.set(segment, child);
			}
			directory = child;
		}
		directory.files.push(file);
	}
	return root;
}

function repositoryLabel(repository: GitRepositoryStatus): string {
	return repository.path || "项目根仓库";
}

function branchLabel(repository: GitRepositoryStatus): string {
	if (repository.merging) return `${repository.branch ?? "Detached HEAD"} · 合并中`;
	if (repository.detached) return "Detached HEAD";
	return repository.branch ?? "未创建分支";
}

function formattedCommitDate(value: string): string {
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return value;
	return date.toLocaleString("zh-CN", {
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
	});
}

export function GitPanel({ state, actions }: { state: WorkbenchState; actions: WorkbenchActions }) {
	const status = state.gitStatus;
	const repositories = useMemo(() => repositoriesForStatus(status), [status]);
	const [selectedRepositoryPath, setSelectedRepositoryPath] = useState("");
	const [panelTab, setPanelTab] = useState<"changes" | "history">("changes");
	const [viewMode, setViewMode] = useState<"tree" | "list">("tree");
	const [commitMessage, setCommitMessage] = useState("");
	const [createBranchOpen, setCreateBranchOpen] = useState(false);
	const [newBranchName, setNewBranchName] = useState("");
	const [discardPath, setDiscardPath] = useState<string>();
	const [deleteBranch, setDeleteBranch] = useState<string>();
	const selectedRepository =
		repositories.find((repository) => repository.path === selectedRepositoryPath) ?? repositories[0];
	const repositoryPath = selectedRepository?.path ?? "";
	const branches = state.gitBranches?.repositoryPath === repositoryPath ? state.gitBranches : undefined;
	const history = state.gitHistory?.repositoryPath === repositoryPath ? state.gitHistory : undefined;
	const commit = state.gitCommit?.repositoryPath === repositoryPath ? state.gitCommit : undefined;
	const busy = Boolean(state.gitOperation);

	useEffect(() => {
		if (selectedRepository && selectedRepository.path !== selectedRepositoryPath) {
			setSelectedRepositoryPath(selectedRepository.path);
		}
	}, [selectedRepository, selectedRepositoryPath]);

	useEffect(() => {
		if (!status || !selectedRepository) return;
		actions.closeGitCommit();
		void actions.loadGitRepositoryStats(selectedRepository.path);
		void actions.loadGitBranches(selectedRepository.path);
	}, [actions.closeGitCommit, actions.loadGitBranches, actions.loadGitRepositoryStats, selectedRepository?.path, status]);

	useEffect(() => {
		if (panelTab !== "history" || !selectedRepository) return;
		if (state.gitHistory?.repositoryPath === selectedRepository.path) return;
		void actions.loadGitHistory(selectedRepository.path);
	}, [actions.loadGitHistory, panelTab, selectedRepository?.path, state.gitHistory?.repositoryPath]);

	const stagedFiles = selectedRepository?.files.filter((file) => file.staged) ?? [];
	const unstagedFiles = selectedRepository?.files.filter((file) => file.unstaged) ?? [];
	const untrackedCount = selectedRepository?.files.filter((file) => file.untracked).length ?? 0;
	const localBranches = branches?.branches.filter((branch) => !branch.remote) ?? [];
	const mergeBranches = localBranches.filter((branch) => !branch.current);

	const refresh = async () => {
		await actions.loadGitStatus();
		if (!selectedRepository) return;
		await Promise.allSettled([
			actions.loadGitRepositoryStats(repositoryPath),
			actions.loadGitBranches(repositoryPath),
			...(panelTab === "history" ? [actions.loadGitHistory(repositoryPath)] : []),
		]);
	};

	const createBranch = async () => {
		const name = newBranchName.trim();
		if (!name) return;
		if (await actions.mutateGit({ type: "create_branch", name }, repositoryPath)) {
			setCreateBranchOpen(false);
			setNewBranchName("");
		}
	};

	const commitChanges = async () => {
		const message = commitMessage.trim();
		if (!message) return;
		if (await actions.mutateGit({ type: "commit", message }, repositoryPath)) setCommitMessage("");
	};

	return (
		<div className="flex h-full min-h-0 flex-col gap-2 p-4 text-xs">
			<div className="flex shrink-0 items-start justify-between gap-3">
				<div className="min-w-0 flex-1">
					<div className="flex min-w-0 items-center gap-1.5">
						<BranchMenu
							repository={selectedRepository}
							branches={localBranches}
							mergeBranches={mergeBranches}
							loading={state.gitBranchesLoading}
							busy={busy}
							onCreate={() => setCreateBranchOpen(true)}
							onSwitch={(name) => void actions.mutateGit({ type: "switch_branch", name }, repositoryPath)}
							onMerge={(source) => void actions.mutateGit({ type: "merge", source }, repositoryPath)}
							onDelete={setDeleteBranch}
						/>
						{repositories.length > 1 ? (
							<RepositoryMenu
								repositories={repositories}
								selected={selectedRepository}
								onSelect={setSelectedRepositoryPath}
							/>
						) : null}
					</div>
					<p className="mt-1 truncate text-xs text-muted-foreground">
						{selectedRepository
							? `${selectedRepository.files.length} 个文件 · ${stagedFiles.length} 暂存 · ${unstagedFiles.length} 未暂存${untrackedCount > 0 ? ` · ${untrackedCount} 未跟踪` : ""}${repositories.length > 1 ? ` · ${repositoryLabel(selectedRepository)}` : ""}`
							: "查看、提交和同步当前项目的 Git 仓库。"}
					</p>
				</div>
				<Button size="icon" variant="ghost" onClick={() => void refresh()} aria-label="刷新 Git 数据">
					<RefreshCw
						className={cn(
							"size-4",
							(state.gitLoading || state.gitBranchesLoading || state.gitHistoryLoading) && "animate-spin",
						)}
					/>
				</Button>
			</div>

			{status && selectedRepository ? (
				<>
					<div className="flex shrink-0 items-center gap-1.5">
						<Button
							size="xs"
							variant="outline"
							disabled={busy || (branches?.remotes.length ?? 0) === 0}
							onClick={() => void actions.mutateGit({ type: "fetch" }, repositoryPath)}
						>
							<RefreshCw className={cn("size-3.5", state.gitOperation === "fetch" && "animate-spin")} />
							获取(Fetch)
						</Button>
						<Button
							size="xs"
							variant="outline"
							disabled={busy || selectedRepository.detached || !selectedRepository.upstream}
							onClick={() => void actions.mutateGit({ type: "pull" }, repositoryPath)}
						>
							<ArrowDown className="size-3.5" />
							拉取(Pull)
							{selectedRepository.behind > 0 ? <Badge variant="secondary">{selectedRepository.behind}</Badge> : null}
						</Button>
						<Button
							size="xs"
							variant="outline"
							disabled={busy || selectedRepository.detached || (branches?.remotes.length ?? 0) === 0}
							onClick={() => void actions.mutateGit({ type: "push" }, repositoryPath)}
						>
							<ArrowUp className="size-3.5" />
							推送(Push)
							{selectedRepository.ahead > 0 ? <Badge variant="secondary">{selectedRepository.ahead}</Badge> : null}
						</Button>
						{selectedRepository.merging ? (
							<Button
								className="ml-auto"
								size="xs"
								variant="destructive"
								disabled={busy}
								onClick={() => void actions.mutateGit({ type: "abort_merge" }, repositoryPath)}
							>
								<X className="size-3.5" />
								中止合并
							</Button>
						) : null}
					</div>

					<Tabs
						value={panelTab}
						onValueChange={(value) => setPanelTab(value as "changes" | "history")}
						className="min-h-0 flex-1 gap-2"
					>
						<TabsList className="grid h-9 w-full grid-cols-2">
							<TabsTrigger value="changes" className="text-xs">
								<GitCommitHorizontal className="size-3.5" />
								变更
							</TabsTrigger>
							<TabsTrigger value="history" className="text-xs">
								<History className="size-3.5" />
								历史
							</TabsTrigger>
						</TabsList>
						<TabsContent value="changes" className="flex min-h-0 flex-1 flex-col gap-2 overflow-hidden">
							<div className="flex shrink-0 items-center justify-end gap-0.5">
								<Button
									type="button"
									size="xs"
									className="!text-xs"
									variant={viewMode === "tree" ? "secondary" : "ghost"}
									aria-pressed={viewMode === "tree"}
									onClick={() => setViewMode("tree")}
								>
									<FolderTree className="size-3.5" />
									树形
								</Button>
								<Button
									type="button"
									size="xs"
									className="!text-xs"
									variant={viewMode === "list" ? "secondary" : "ghost"}
									aria-pressed={viewMode === "list"}
									onClick={() => setViewMode("list")}
								>
									<List className="size-3.5" />
									列表
								</Button>
							</div>
							<div className="min-h-0 flex-1 overflow-hidden rounded-lg border bg-background">
								<ScrollArea className="h-full w-full">
									<div className="grid gap-3 p-2">
										{stagedFiles.length > 0 ? (
											<GitFileSection
												label="暂存的更改"
												files={stagedFiles}
												mode="staged"
												viewMode={viewMode}
												repositoryPath={repositoryPath}
												stats={state.gitFileStats}
												busy={busy}
												onOpen={(path) => void actions.loadGitDiff(path, true, repositoryPath || undefined)}
												onPrimary={(paths) =>
													void actions.mutateGit({ type: "unstage", paths }, repositoryPath)
												}
											/>
										) : null}
										{unstagedFiles.length > 0 ? (
											<GitFileSection
												label="更改"
												files={unstagedFiles}
												mode="unstaged"
												viewMode={viewMode}
												repositoryPath={repositoryPath}
												stats={state.gitFileStats}
												busy={busy}
												onOpen={(path) => void actions.loadGitDiff(path, false, repositoryPath || undefined)}
												onPrimary={(paths) =>
													void actions.mutateGit({ type: "stage", paths }, repositoryPath)
												}
												onDiscard={setDiscardPath}
											/>
										) : null}
										{stagedFiles.length === 0 && unstagedFiles.length === 0 ? (
											<p className="py-8 text-center text-muted-foreground">工作区没有改动</p>
										) : null}
									</div>
								</ScrollArea>
							</div>
							<div className="shrink-0 rounded-lg border bg-muted/20 p-2">
								<Textarea
									value={commitMessage}
									onChange={(event) => setCommitMessage(event.target.value)}
									placeholder={selectedRepository.merging ? "说明本次合并" : "填写提交说明"}
									maxLength={65_536}
									className="min-h-12 resize-none text-xs"
								/>
								<Button
									className="mt-1.5 h-8 w-full !text-xs"
									disabled={busy || stagedFiles.length === 0 || !commitMessage.trim()}
									onClick={() => void commitChanges()}
								>
									{state.gitOperation === "commit" ? (
										<LoaderCircle className="size-3.5 animate-spin" />
									) : (
										<Check className="size-3.5" />
									)}
									提交 {stagedFiles.length > 0 ? `(${stagedFiles.length})` : ""}
								</Button>
							</div>
						</TabsContent>
						<TabsContent value="history" className="min-h-0 flex-1 overflow-hidden">
							<GitHistoryPanel
								state={state}
								actions={actions}
								repositoryPath={repositoryPath}
								history={history}
								commit={commit}
							/>
						</TabsContent>
					</Tabs>
				</>
			) : (
				<Card>
					<CardContent className="py-8 text-center">
						<Button className="!text-xs" variant="outline" onClick={() => void actions.loadGitStatus()}>
							<GitBranch className="size-4" />
							加载 Git 状态
						</Button>
					</CardContent>
				</Card>
			)}

			<Dialog open={createBranchOpen} onOpenChange={setCreateBranchOpen}>
				<DialogContent className="sm:max-w-md">
					<DialogHeader>
						<DialogTitle>新建分支</DialogTitle>
						<DialogDescription>新分支从当前 HEAD 创建，创建后切换到该分支。</DialogDescription>
					</DialogHeader>
					<Input
						autoFocus
						value={newBranchName}
						onChange={(event) => setNewBranchName(event.target.value)}
						placeholder="feature/example"
						onKeyDown={(event) => {
							if (event.key === "Enter") void createBranch();
						}}
					/>
					<DialogFooter>
						<Button variant="outline" onClick={() => setCreateBranchOpen(false)}>
							取消
						</Button>
						<Button disabled={busy || !newBranchName.trim()} onClick={() => void createBranch()}>
							创建并切换
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>

			<ConfirmDialog
				open={Boolean(discardPath)}
				title="恢复文件改动"
				description={discardPath ? `将永久丢弃 ${discardPath} 的未暂存改动。` : ""}
				confirmLabel="恢复文件"
				destructive
				busy={busy}
				onOpenChange={(open) => {
					if (!open) setDiscardPath(undefined);
				}}
				onConfirm={async () => {
					if (!discardPath) return;
					if (await actions.mutateGit({ type: "discard", paths: [discardPath] }, repositoryPath)) {
						setDiscardPath(undefined);
					}
				}}
			/>
			<ConfirmDialog
				open={Boolean(deleteBranch)}
				title="删除本地分支"
				description={deleteBranch ? `安全删除本地分支 ${deleteBranch}。未合并分支不会被删除。` : ""}
				confirmLabel="删除分支"
				destructive
				busy={busy}
				onOpenChange={(open) => {
					if (!open) setDeleteBranch(undefined);
				}}
				onConfirm={async () => {
					if (!deleteBranch) return;
					if (await actions.mutateGit({ type: "delete_branch", name: deleteBranch }, repositoryPath)) {
						setDeleteBranch(undefined);
					}
				}}
			/>
		</div>
	);
}

function BranchMenu({
	repository,
	branches,
	mergeBranches,
	loading,
	busy,
	onCreate,
	onSwitch,
	onMerge,
	onDelete,
}: {
	repository?: GitRepositoryStatus;
	branches: NonNullable<WorkbenchState["gitBranches"]>["branches"];
	mergeBranches: NonNullable<WorkbenchState["gitBranches"]>["branches"];
	loading: boolean;
	busy: boolean;
	onCreate: () => void;
	onSwitch: (name: string) => void;
	onMerge: (name: string) => void;
	onDelete: (name: string) => void;
}) {
	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<Button className="h-8 min-w-0 max-w-full justify-start gap-1.5 px-2" variant="outline">
					{loading ? <LoaderCircle className="size-3.5 animate-spin" /> : <GitBranch className="size-3.5" />}
					<span className="truncate font-mono text-xs">{repository ? branchLabel(repository) : "Git 工作区"}</span>
					<ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="start" className="w-64">
				<DropdownMenuLabel className="text-xs">本地分支</DropdownMenuLabel>
				{branches.length > 0 ? (
					branches.map((branch) => (
						<DropdownMenuItem
							key={branch.name}
							disabled={busy || branch.current}
							onSelect={() => onSwitch(branch.name)}
						>
							{branch.current ? <Check className="size-3.5" /> : <GitBranch className="size-3.5" />}
							<span className="min-w-0 flex-1 truncate font-mono text-xs">{branch.name}</span>
							<span className="font-mono text-[10px] text-muted-foreground">{branch.commit.slice(0, 7)}</span>
						</DropdownMenuItem>
					))
				) : (
					<DropdownMenuItem disabled>没有本地分支</DropdownMenuItem>
				)}
				<DropdownMenuSeparator />
				<DropdownMenuItem disabled={busy} onSelect={onCreate}>
					<Plus className="size-3.5" />
					新建分支…
				</DropdownMenuItem>
				<DropdownMenuSub>
					<DropdownMenuSubTrigger disabled={busy || mergeBranches.length === 0}>
						<GitMerge className="size-3.5" />
						合并分支
					</DropdownMenuSubTrigger>
					<DropdownMenuSubContent className="w-56">
						{mergeBranches.map((branch) => (
							<DropdownMenuItem key={branch.name} onSelect={() => onMerge(branch.name)}>
								<span className="truncate font-mono text-xs">{branch.name}</span>
							</DropdownMenuItem>
						))}
					</DropdownMenuSubContent>
				</DropdownMenuSub>
				<DropdownMenuSub>
					<DropdownMenuSubTrigger disabled={busy || mergeBranches.length === 0}>
						<Trash2 className="size-3.5" />
						删除本地分支
					</DropdownMenuSubTrigger>
					<DropdownMenuSubContent className="w-56">
						{mergeBranches.map((branch) => (
							<DropdownMenuItem key={branch.name} variant="destructive" onSelect={() => onDelete(branch.name)}>
								<span className="truncate font-mono text-xs">{branch.name}</span>
							</DropdownMenuItem>
						))}
					</DropdownMenuSubContent>
				</DropdownMenuSub>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

function RepositoryMenu({
	repositories,
	selected,
	onSelect,
}: {
	repositories: GitRepositoryStatus[];
	selected?: GitRepositoryStatus;
	onSelect: (path: string) => void;
}) {
	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<Button className="h-8 min-w-0 px-2" variant="ghost" aria-label="选择 Git 仓库">
					<Folder className="size-3.5" />
					<span className="max-w-32 truncate font-mono text-xs">{selected ? repositoryLabel(selected) : "仓库"}</span>
					<ChevronDown className="size-3.5" />
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="start" className="w-64">
				<DropdownMenuLabel className="text-xs">项目仓库</DropdownMenuLabel>
				{repositories.map((repository) => (
					<DropdownMenuItem key={repository.root} onSelect={() => onSelect(repository.path)}>
						{repository.path === selected?.path ? <Check className="size-3.5" /> : <GitBranch className="size-3.5" />}
						<span className="min-w-0 flex-1 truncate font-mono text-xs">{repositoryLabel(repository)}</span>
						<span className="text-[10px] text-muted-foreground">{repository.files.length}</span>
					</DropdownMenuItem>
				))}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

function GitFileSection({
	label,
	files,
	mode,
	viewMode,
	repositoryPath,
	stats,
	busy,
	onOpen,
	onPrimary,
	onDiscard,
}: {
	label: string;
	files: GitFileStatus[];
	mode: "staged" | "unstaged";
	viewMode: "tree" | "list";
	repositoryPath: string;
	stats: WorkbenchState["gitFileStats"];
	busy: boolean;
	onOpen: (path: string) => void;
	onPrimary: (paths: string[]) => void;
	onDiscard?: (path: string) => void;
}) {
	const tree = useMemo(() => buildGitTree(files), [files]);
	return (
		<section className="grid gap-1">
			<div className="flex h-7 items-center justify-between gap-2 px-1">
				<span className="font-medium">
					{label} <span className="text-muted-foreground">{files.length}</span>
				</span>
				{files.length > 0 ? (
					<Button
						size="icon-xs"
						variant="ghost"
						disabled={busy}
						title={mode === "staged" ? "全部取消暂存" : "全部暂存"}
						aria-label={mode === "staged" ? "全部取消暂存" : "全部暂存"}
						onClick={() => onPrimary(files.map((file) => file.path))}
					>
						{mode === "staged" ? <Minus className="size-3.5" /> : <Plus className="size-3.5" />}
					</Button>
				) : null}
			</div>
			{files.length === 0 ? (
				<p className="px-2 py-3 text-center text-xs text-muted-foreground">没有{label}</p>
			) : viewMode === "tree" ? (
				<GitDirectoryTree
					directory={tree}
					mode={mode}
					repositoryPath={repositoryPath}
					stats={stats}
					busy={busy}
					onOpen={onOpen}
					onPrimary={(path) => onPrimary([path])}
					onDiscard={onDiscard}
				/>
			) : (
				files
					.slice()
					.sort((left, right) => left.path.localeCompare(right.path))
					.map((file) => (
						<GitFileRow
							key={file.path}
							file={file}
							mode={mode}
							showPath
							stats={stats[gitFileStatsKey(repositoryPath, file.path)]}
							busy={busy}
							onOpen={() => onOpen(file.path)}
							onPrimary={() => onPrimary([file.path])}
							onDiscard={onDiscard ? () => onDiscard(file.path) : undefined}
						/>
					))
			)}
		</section>
	);
}

function GitDirectoryTree({
	directory,
	mode,
	repositoryPath,
	stats,
	busy,
	onOpen,
	onPrimary,
	onDiscard,
}: {
	directory: GitDirectoryNode;
	mode: "staged" | "unstaged";
	repositoryPath: string;
	stats: WorkbenchState["gitFileStats"];
	busy: boolean;
	onOpen: (path: string) => void;
	onPrimary: (path: string) => void;
	onDiscard?: (path: string) => void;
}) {
	const directories = [...directory.directories.values()].sort((left, right) => left.name.localeCompare(right.name));
	const files = directory.files.slice().sort((left, right) => left.path.localeCompare(right.path));
	return (
		<div className="grid gap-0.5">
			{directories.map((child) => (
				<Collapsible key={child.path} defaultOpen>
					<CollapsibleTrigger asChild>
						<Button
							className="group h-7 w-full min-w-0 justify-start gap-1.5 px-2 text-left !text-xs !leading-4"
							variant="ghost"
						>
							<ChevronRight className="size-3.5 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-90" />
							<Folder className="size-3.5 shrink-0 text-muted-foreground" />
							<span className="min-w-0 truncate font-mono">{child.name}</span>
						</Button>
					</CollapsibleTrigger>
					<CollapsibleContent className="pl-3">
						<GitDirectoryTree
							directory={child}
							mode={mode}
							repositoryPath={repositoryPath}
							stats={stats}
							busy={busy}
							onOpen={onOpen}
							onPrimary={onPrimary}
							onDiscard={onDiscard}
						/>
					</CollapsibleContent>
				</Collapsible>
			))}
			{files.map((file) => (
				<GitFileRow
					key={file.path}
					file={file}
					mode={mode}
					stats={stats[gitFileStatsKey(repositoryPath, file.path)]}
					busy={busy}
					onOpen={() => onOpen(file.path)}
					onPrimary={() => onPrimary(file.path)}
					onDiscard={onDiscard ? () => onDiscard(file.path) : undefined}
				/>
			))}
		</div>
	);
}

function GitFileRow({
	file,
	mode,
	showPath = false,
	stats,
	busy,
	onOpen,
	onPrimary,
	onDiscard,
}: {
	file: GitFileStatus;
	mode: "staged" | "unstaged";
	showPath?: boolean;
	stats?: { additions: number; deletions: number };
	busy: boolean;
	onOpen: () => void;
	onPrimary: () => void;
	onDiscard?: () => void;
}) {
	const statusCode = mode === "staged" ? file.indexStatus : file.untracked ? "?" : file.worktreeStatus;
	return (
		<div className="group flex h-7 min-w-0 items-center rounded-md hover:bg-accent">
			<button
				type="button"
				className="flex h-full min-w-0 flex-1 items-center gap-1.5 px-2 font-mono text-xs"
				title={file.path}
				onClick={onOpen}
			>
				<Badge
					className="size-5 shrink-0 px-0 text-xs font-medium leading-none"
					variant={file.conflicted ? "destructive" : "outline"}
					aria-label={file.conflicted ? "冲突" : mode === "staged" ? "已暂存" : file.untracked ? "未跟踪" : "未暂存"}
				>
					{file.conflicted ? "!" : statusCode === "." ? "M" : statusCode}
				</Badge>
				<File className="size-3.5 shrink-0 text-muted-foreground" />
				<span className="min-w-0 flex-1 truncate text-left">
					{showPath ? file.path : (file.path.split("/").at(-1) ?? file.path)}
				</span>
				{stats ? (
					<span className="flex shrink-0 items-center gap-1 tabular-nums text-xs">
						<span className="text-emerald-600 dark:text-emerald-400">+{stats.additions}</span>
						<span className="text-red-600 dark:text-red-400">-{stats.deletions}</span>
					</span>
				) : null}
			</button>
			<div className="flex shrink-0 items-center pr-1 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
				{onDiscard ? (
					<Button
						size="icon-xs"
						variant="ghost"
						disabled={busy}
						title="恢复文件"
						aria-label={`恢复 ${file.path}`}
						onClick={onDiscard}
					>
						<RotateCcw className="size-3.5" />
					</Button>
				) : null}
				<Button
					size="icon-xs"
					variant="ghost"
					disabled={busy}
					title={mode === "staged" ? "取消暂存" : "暂存文件"}
					aria-label={`${mode === "staged" ? "取消暂存" : "暂存"} ${file.path}`}
					onClick={onPrimary}
				>
					{mode === "staged" ? <Minus className="size-3.5" /> : <Plus className="size-3.5" />}
				</Button>
			</div>
		</div>
	);
}

function GitHistoryPanel({
	state,
	actions,
	repositoryPath,
	history,
	commit,
}: {
	state: WorkbenchState;
	actions: WorkbenchActions;
	repositoryPath: string;
	history: WorkbenchState["gitHistory"];
	commit: WorkbenchState["gitCommit"];
}) {
	return (
		<div className="h-full min-h-0 overflow-hidden rounded-lg border bg-background">
			<ScrollArea className="h-full w-full">
				<div className="grid gap-2 p-2">
					{commit ? (
						<Card className="gap-0 py-0 shadow-none">
							<CardContent className="grid gap-2 p-3">
								<div className="flex min-w-0 items-start justify-between gap-2">
									<div className="min-w-0">
										<p className="font-medium leading-5">{commit.subject || "无标题提交"}</p>
										<p className="mt-1 truncate font-mono text-[10px] text-muted-foreground">{commit.hash}</p>
									</div>
									<Button size="icon-xs" variant="ghost" onClick={actions.closeGitCommit} aria-label="关闭提交详情">
										<X className="size-3.5" />
									</Button>
								</div>
								<p className="text-xs text-muted-foreground">
									{commit.authorName} · {formattedCommitDate(commit.authoredAt)}
								</p>
								{commit.body.trim() && commit.body.trim() !== commit.subject ? (
									<p className="whitespace-pre-wrap text-xs leading-5">{commit.body.trim()}</p>
								) : null}
								<div className="grid gap-0.5 border-t pt-2">
									{commit.files.map((file) => (
										<Button
											key={`${commit.hash}:${file.path}`}
											className="h-7 min-w-0 justify-start gap-2 px-2 font-mono !text-xs"
											variant="ghost"
											onClick={() => void actions.loadGitCommit(commit.hash, repositoryPath, file.path)}
										>
											<File className="size-3.5 shrink-0" />
											<span className="min-w-0 flex-1 truncate text-left">{file.path}</span>
											{file.binary ? (
												<span className="text-muted-foreground">二进制</span>
											) : (
												<span className="flex gap-1 tabular-nums">
													<span className="text-emerald-600 dark:text-emerald-400">+{file.additions}</span>
													<span className="text-red-600 dark:text-red-400">-{file.deletions}</span>
												</span>
											)}
										</Button>
									))}
								</div>
							</CardContent>
						</Card>
					) : state.gitCommitLoading ? (
						<div className="flex items-center justify-center gap-2 py-6 text-muted-foreground">
							<LoaderCircle className="size-3.5 animate-spin" />
							正在读取提交
						</div>
					) : null}
					{history?.commits.map((item) => (
						<Button
							key={item.hash}
							className={cn(
								"h-auto min-w-0 items-start justify-start gap-2 px-2 py-2 text-left",
								commit?.hash === item.hash && "bg-accent",
							)}
							variant="ghost"
							onClick={() => void actions.loadGitCommit(item.hash, repositoryPath)}
						>
							<GitCommitHorizontal className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
							<span className="min-w-0 flex-1">
								<span className="block truncate text-xs font-medium">{item.subject || "无标题提交"}</span>
								<span className="mt-1 flex min-w-0 items-center gap-1.5 text-[10px] text-muted-foreground">
									<span className="shrink-0 font-mono">{item.shortHash}</span>
									<span className="truncate">{item.authorName}</span>
									<span className="ml-auto shrink-0">{formattedCommitDate(item.authoredAt)}</span>
								</span>
							</span>
						</Button>
					))}
					{state.gitHistoryLoading ? (
						<div className="flex items-center justify-center gap-2 py-5 text-muted-foreground">
							<LoaderCircle className="size-3.5 animate-spin" />
							正在读取历史
						</div>
					) : history?.commits.length === 0 ? (
						<p className="py-8 text-center text-muted-foreground">当前仓库没有提交</p>
					) : null}
					{history?.hasMore && history.nextOffset !== undefined ? (
						<Button
							variant="outline"
							disabled={state.gitHistoryLoading}
							onClick={() => void actions.loadGitHistory(repositoryPath, history.nextOffset, true)}
						>
							加载更多
						</Button>
					) : null}
				</div>
			</ScrollArea>
		</div>
	);
}

function ConfirmDialog({
	open,
	title,
	description,
	confirmLabel,
	destructive = false,
	busy,
	onOpenChange,
	onConfirm,
}: {
	open: boolean;
	title: string;
	description: string;
	confirmLabel: string;
	destructive?: boolean;
	busy: boolean;
	onOpenChange: (open: boolean) => void;
	onConfirm: () => Promise<void>;
}) {
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>{title}</DialogTitle>
					<DialogDescription>{description}</DialogDescription>
				</DialogHeader>
				<DialogFooter>
					<Button variant="outline" onClick={() => onOpenChange(false)}>
						取消
					</Button>
					<Button variant={destructive ? "destructive" : "default"} disabled={busy} onClick={() => void onConfirm()}>
						{confirmLabel}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
