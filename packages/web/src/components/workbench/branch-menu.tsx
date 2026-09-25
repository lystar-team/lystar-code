import type { GitRepositoryStatus } from "@lystar/code-web-protocol";
import { Check, ChevronDown, GitBranch, GitMerge, LoaderCircle, Plus, Trash2 } from "lucide-react";
import type { WorkbenchState } from "../../state/use-workbench";
import { Button } from "../ui/button";
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

function branchLabel(repository: GitRepositoryStatus): string {
	if (repository.merging) return `${repository.branch ?? "Detached HEAD"} · 合并中`;
	if (repository.detached) return "Detached HEAD";
	return repository.branch ?? "未创建分支";
}

export function BranchMenu({
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
