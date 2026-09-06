import { ChevronRight, GitBranch, GitCompare, RefreshCw } from "lucide-react";
import { cn } from "../../lib/utils";
import type { WorkbenchState } from "../../state/use-workbench";
import { Artifact, ArtifactContent, ArtifactDescription, ArtifactHeader, ArtifactTitle } from "../ai-elements/artifact";
import { CodeBlockView } from "./transcript";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card, CardContent } from "../ui/card";
import type { WorkbenchActions } from "./types";

export function GitPanel({ state, actions }: { state: WorkbenchState; actions: WorkbenchActions }) {
	const status = state.gitStatus;
	return (
		<div className="grid gap-3 p-4">
			<div className="flex items-start justify-between gap-3">
				<div>
					<h2 className="font-semibold">{status?.branch ?? "Git 工作区"}</h2>
					<p className="mt-1 text-xs text-muted-foreground">
						{status ? `${status.files.length} 个文件有变化` : "查看当前项目的分支与改动。"}
					</p>
				</div>
				<Button size="icon" variant="ghost" onClick={() => void actions.loadGitStatus()} aria-label="刷新 Git 状态">
					<RefreshCw className={cn("size-4", state.gitLoading && "animate-spin")} />
				</Button>
			</div>
			{status ? (
				<>
					<div className="grid grid-cols-3 items-start gap-2">
						<StatCard label="暂存" value={status.files.filter((file) => file.staged).length} />
						<StatCard label="未暂存" value={status.files.filter((file) => file.unstaged).length} />
						<StatCard label="未跟踪" value={status.files.filter((file) => file.untracked).length} />
					</div>
					<div className="grid gap-0.5">
						{status.files.map((file) => {
							const stats = state.gitFileStats[file.path];
							return (
								<Button
									key={file.path}
									className="h-8 w-full min-w-0 justify-start gap-2 px-2 font-mono !text-[13px] !leading-5"
									variant="ghost"
									onClick={() => void actions.loadGitDiff(file.path)}
								>
									<Badge
										className="shrink-0 text-[11px]"
										variant={file.conflicted ? "destructive" : "outline"}
									>
										{file.conflicted ? "!" : file.untracked ? "?" : file.staged ? "S" : "M"}
									</Badge>
									<span className="project-list-item-label min-w-0 flex-1 truncate text-left">
										{file.path}
									</span>
									{stats ? (
										<span className="flex shrink-0 items-center gap-1 tabular-nums text-[11px]">
											<span className="text-emerald-600 dark:text-emerald-400">+{stats.additions}</span>
											<span className="text-red-600 dark:text-red-400">-{stats.deletions}</span>
										</span>
									) : null}
									<ChevronRight className="size-4 shrink-0 text-muted-foreground" />
								</Button>
							);
						})}
					</div>
					{state.gitDiff ? (
						<Artifact>
							<ArtifactHeader>
								<div className="min-w-0">
									<ArtifactTitle className="truncate">{state.gitDiff.path ?? "工作区差异"}</ArtifactTitle>
									<ArtifactDescription>
										+{state.gitDiff.additions} -{state.gitDiff.deletions}
									</ArtifactDescription>
								</div>
								<GitCompare className="size-4 text-muted-foreground" />
							</ArtifactHeader>
							<ArtifactContent>
								<CodeBlockView code={state.gitDiff.diff || "没有差异"} language="diff" />
							</ArtifactContent>
						</Artifact>
					) : null}
				</>
			) : (
				<Card>
					<CardContent className="py-8 text-center">
						<Button variant="outline" onClick={() => void actions.loadGitStatus()}>
							<GitBranch className="size-4" />
							加载 Git 状态
						</Button>
					</CardContent>
				</Card>
			)}
		</div>
	);
}

function StatCard({ label, value }: { label: string; value: number }) {
	return (
		<Card className="h-fit min-h-0 self-start rounded-xl !py-2 shadow-none">
			<CardContent className="p-2.5">
				<p className="text-xs text-muted-foreground">{label}</p>
				<p className="mt-0.5 text-lg font-semibold tabular-nums">{value}</p>
			</CardContent>
		</Card>
	);
}
