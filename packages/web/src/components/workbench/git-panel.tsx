import type { GitFileStatus, GitRepositoryStatus } from "@lystar/code-web-protocol";
import { ChevronRight, File, Folder, FolderTree, GitBranch, List, RefreshCw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { cn } from "../../lib/utils";
import { gitFileStatsKey, type WorkbenchState } from "../../state/use-workbench";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card, CardContent } from "../ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../ui/collapsible";
import { ScrollArea } from "../ui/scroll-area";
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
		directory.files.push({ ...file, path: [...segments, fileName].join("/") });
	}
	return root;
}

export function GitPanel({ state, actions }: { state: WorkbenchState; actions: WorkbenchActions }) {
	const status = state.gitStatus;
	const repositories = useMemo(() => repositoriesForStatus(status), [status]);
	const [selectedRepositoryPath, setSelectedRepositoryPath] = useState("");
	const [viewMode, setViewMode] = useState<"tree" | "list">("tree");
	const selectedRepository =
		repositories.find((repository) => repository.path === selectedRepositoryPath) ?? repositories[0];

	useEffect(() => {
		if (selectedRepository && selectedRepository.path !== selectedRepositoryPath) {
			setSelectedRepositoryPath(selectedRepository.path);
		}
	}, [selectedRepository, selectedRepositoryPath]);

	useEffect(() => {
		if (!status || !selectedRepository) return;
		void actions.loadGitRepositoryStats(selectedRepository.path);
	}, [actions.loadGitRepositoryStats, selectedRepository?.path, status]);

	const tree = useMemo(() => buildGitTree(selectedRepository?.files ?? []), [selectedRepository]);
	const stagedCount = selectedRepository?.files.filter((file) => file.staged).length ?? 0;
	const unstagedCount = selectedRepository?.files.filter((file) => file.unstaged).length ?? 0;
	const untrackedCount = selectedRepository?.files.filter((file) => file.untracked).length ?? 0;

	return (
		<div className="flex h-full min-h-0 flex-col gap-3 p-4 text-xs">
			<div className="flex shrink-0 items-start justify-between gap-3">
				<div className="min-w-0">
					<h2 className="truncate text-xs font-semibold">{selectedRepository?.branch ?? "Git 工作区"}</h2>
					<p className="mt-1 truncate text-xs text-muted-foreground">
						{selectedRepository
							? `${selectedRepository.files.length} 个文件有变化${repositories.length > 1 ? ` · ${repositories.length} 个仓库` : ""}`
							: "查看当前项目的分支与改动。"}
					</p>
				</div>
				<Button size="icon" variant="ghost" onClick={() => void actions.loadGitStatus()} aria-label="刷新 Git 状态">
					<RefreshCw className={cn("size-4", state.gitLoading && "animate-spin")} />
				</Button>
			</div>
			{status ? (
				<>
					{repositories.length > 1 ? (
						<div className="grid shrink-0 gap-1" role="tablist" aria-label="选择 Git 仓库">
							{repositories.map((repository) => {
								const selected = repository.path === selectedRepository?.path;
								return (
									<Button
										key={repository.root}
										className="h-8 min-w-0 justify-start gap-2 px-2 text-left !text-xs"
										variant={selected ? "secondary" : "ghost"}
										role="tab"
										aria-selected={selected}
										onClick={() => setSelectedRepositoryPath(repository.path)}
									>
										<GitBranch className="size-3.5 shrink-0" />
										<span className="min-w-0 flex-1 truncate font-mono !text-xs">
											{repository.path || "项目根仓库"}
										</span>
										<span className="shrink-0 !text-xs text-muted-foreground">{repository.files.length}</span>
									</Button>
								);
							})}
						</div>
					) : null}
					<div className="grid shrink-0 grid-cols-3 items-start gap-2">
						<StatCard label="暂存" value={stagedCount} />
						<StatCard label="未暂存" value={unstagedCount} />
						<StatCard label="未跟踪" value={untrackedCount} />
					</div>
					{selectedRepository ? (
						<div className="flex min-h-0 flex-1 flex-col gap-2">
							<div className="flex shrink-0 items-center justify-between gap-2">
								<span className="text-xs text-muted-foreground">文件</span>
								<div className="flex items-center gap-0.5 rounded-md border p-0.5">
									<Button
										type="button"
										size="xs"
										className="!text-xs"
										variant={viewMode === "tree" ? "secondary" : "ghost"}
										aria-pressed={viewMode === "tree"}
										aria-label="目录树视图"
										title="目录树视图"
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
										aria-label="列表平铺视图"
										title="列表平铺视图"
										onClick={() => setViewMode("list")}
									>
										<List className="size-3.5" />
										列表
									</Button>
								</div>
							</div>
							<div className="min-h-0 flex-1 overflow-hidden rounded-lg border bg-background">
								<ScrollArea className="h-full w-full">
									<div className="grid gap-0.5 p-2">
								{viewMode === "tree" ? (
									<GitDirectoryTree
										directory={tree}
										repositoryPath={selectedRepository.path}
										stats={state.gitFileStats}
										onOpenFile={(path, staged) =>
											void actions.loadGitDiff(path, staged, selectedRepository.path || undefined)
										}
									/>
								) : (
									selectedRepository.files
										.slice()
										.sort((left, right) => left.path.localeCompare(right.path))
										.map((file) => (
											<GitFileRow
												key={file.path}
												file={file}
												showPath
												stats={state.gitFileStats[gitFileStatsKey(selectedRepository.path, file.path)]}
												onOpen={() =>
													void actions.loadGitDiff(
															file.path,
															file.staged && !file.unstaged,
															selectedRepository.path || undefined,
														)
												}
											/>
										))
										)}
									</div>
								</ScrollArea>
							</div>
						</div>
					) : null}
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
		</div>
	);
}

function GitDirectoryTree({
	directory,
	repositoryPath,
	stats,
	onOpenFile,
}: {
	directory: GitDirectoryNode;
	repositoryPath: string;
	stats: WorkbenchState["gitFileStats"];
	onOpenFile: (path: string, staged: boolean) => void;
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
							repositoryPath={repositoryPath}
							stats={stats}
							onOpenFile={onOpenFile}
						/>
					</CollapsibleContent>
				</Collapsible>
			))}
			{files.map((file) => (
				<GitFileRow
					key={file.path}
					file={file}
					stats={stats[gitFileStatsKey(repositoryPath, file.path)]}
					onOpen={() => onOpenFile(file.path, file.staged && !file.unstaged)}
				/>
			))}
		</div>
	);
}

function GitFileRow({
	file,
	showPath = false,
	stats,
	onOpen,
}: {
	file: GitFileStatus;
	showPath?: boolean;
	stats?: { additions: number; deletions: number };
	onOpen: () => void;
}) {
	return (
		<Button
			className="h-7 w-full min-w-0 justify-start gap-1.5 px-2 font-mono !text-xs !leading-4"
			variant="ghost"
			title={file.path}
			onClick={onOpen}
		>
			<Badge
				className="size-5 shrink-0 px-0 text-xs font-medium leading-none"
				variant={file.conflicted ? "destructive" : "outline"}
				aria-label={file.conflicted ? "冲突" : file.untracked ? "未跟踪" : file.staged ? "已暂存" : "已修改"}
			>
				{file.conflicted ? "!" : file.untracked ? "?" : "M"}
			</Badge>
			<File className="size-3.5 shrink-0 text-muted-foreground" />
			<span className="min-w-0 flex-1 truncate text-left">
				{showPath ? file.path : (file.path.split("/").at(-1) ?? file.path)}
			</span>
			{stats ? (
				<span className="flex shrink-0 items-center gap-1 tabular-nums !text-xs">
					<span className="text-emerald-600 dark:text-emerald-400">+{stats.additions}</span>
					<span className="text-red-600 dark:text-red-400">-{stats.deletions}</span>
				</span>
			) : null}
			<ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
		</Button>
	);
}

function StatCard({ label, value }: { label: string; value: number }) {
	return (
		<Card className="h-fit min-h-0 rounded-lg !py-0 shadow-none">
			<CardContent className="flex items-center justify-between gap-2 px-2.5 py-1.5">
				<p className="truncate text-xs text-muted-foreground">{label}</p>
				<p className="text-xs font-semibold tabular-nums">{value}</p>
			</CardContent>
		</Card>
	);
}
