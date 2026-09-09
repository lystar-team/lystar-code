import { FolderOpen, GitBranch, GitFork, X, Zap } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { cn } from "../../lib/utils";
import type { InspectorMode, WorkbenchState } from "../../state/use-workbench";
import { Button } from "../ui/button";
import { Dialog, DialogContent } from "../ui/dialog";
import { ScrollArea } from "../ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../ui/tabs";
import { FilesPanel } from "./files-panel";
import { GitPanel } from "./git-panel";
import { RunPanel } from "./run-panel";
import { SessionTreePanel } from "./session-tree-panel";
import type { WorkbenchActions } from "./types";

function useMediaQuery(query: string): boolean {
	const [matches, setMatches] = useState(() => typeof window !== "undefined" && window.matchMedia(query).matches);

	useEffect(() => {
		const mediaQuery = window.matchMedia(query);
		const update = () => setMatches(mediaQuery.matches);
		update();
		mediaQuery.addEventListener("change", update);
		return () => mediaQuery.removeEventListener("change", update);
	}, [query]);

	return matches;
}

export function InspectorPanel({
	state,
	actions,
	floating = false,
}: {
	state: WorkbenchState;
	actions: WorkbenchActions;
	floating?: boolean;
}) {
	const runViewportRef = useRef<HTMLDivElement>(null);
	const treeViewportRef = useRef<HTMLDivElement>(null);

	return (
		<div
			className={cn(
				"flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden bg-background",
				floating && "inspector-panel rounded-[28px] border border-border/70 shadow-[0_12px_36px_rgb(0_0_0/0.06)]",
			)}
		>
			<div className="flex shrink-0 items-start justify-between gap-3 border-b border-border/60 px-5 py-4">
				<div className="min-w-0">
					<h2 className="truncate text-base font-semibold">审阅工作区</h2>
					<p className="mt-1 truncate text-xs text-muted-foreground">文件、Git、运行和分支</p>
				</div>
				<Button size="icon" variant="ghost" onClick={actions.closeInspector} aria-label="关闭审阅工作区">
					<X className="size-4" />
				</Button>
			</div>
			<Tabs
				value={state.inspectorMode}
				onValueChange={(value) => void actions.openInspector(value as InspectorMode)}
				className="min-h-0 w-full min-w-0 flex-1 gap-0"
			>
				<TabsList className="mx-4 mt-3 grid h-10 w-auto grid-cols-4 gap-1 rounded-none border-0 bg-transparent p-0">
					<TabsTrigger
						className="h-9 rounded-xl border-0 px-2 text-xs font-medium text-muted-foreground after:hidden data-[state=active]:bg-accent data-[state=active]:text-foreground data-[state=active]:shadow-none"
						value="files"
					>
						<FolderOpen className="size-3.5" />
						文件
					</TabsTrigger>
					<TabsTrigger
						className="h-9 rounded-xl border-0 px-2 text-xs font-medium text-muted-foreground after:hidden data-[state=active]:bg-accent data-[state=active]:text-foreground data-[state=active]:shadow-none"
						value="git"
					>
						<GitBranch className="size-3.5" />
						Git
					</TabsTrigger>
					<TabsTrigger
						className="h-9 rounded-xl border-0 px-2 text-xs font-medium text-muted-foreground after:hidden data-[state=active]:bg-accent data-[state=active]:text-foreground data-[state=active]:shadow-none"
						value="runs"
					>
						<Zap className="size-3.5" />
						运行
					</TabsTrigger>
					<TabsTrigger
						className="h-9 rounded-xl border-0 px-2 text-xs font-medium text-muted-foreground after:hidden data-[state=active]:bg-accent data-[state=active]:text-foreground data-[state=active]:shadow-none"
						value="tree"
					>
						<GitFork className="size-3.5" />
						分支
					</TabsTrigger>
				</TabsList>
				<TabsContent className="min-h-0 w-full min-w-0 flex-1 overflow-hidden" value="files">
					<FilesPanel state={state} actions={actions} />
				</TabsContent>
				<TabsContent className="min-h-0 w-full min-w-0 flex-1 overflow-hidden" value="git">
					<GitPanel state={state} actions={actions} />
				</TabsContent>
				<TabsContent className="min-h-0 w-full min-w-0 flex-1 overflow-hidden" value="runs">
					<ScrollArea className="h-full w-full" viewportRef={runViewportRef}>
						<RunPanel state={state} actions={actions} scrollRef={runViewportRef} />
					</ScrollArea>
				</TabsContent>
				<TabsContent className="min-h-0 w-full min-w-0 flex-1 overflow-hidden" value="tree">
					<ScrollArea className="h-full w-full" viewportRef={treeViewportRef}>
						<SessionTreePanel state={state} actions={actions} scrollRef={treeViewportRef} />
					</ScrollArea>
				</TabsContent>
			</Tabs>
		</div>
	);
}

export function InspectorDialog({ state, actions }: { state: WorkbenchState; actions: WorkbenchActions }) {
	const wideLayout = useMediaQuery("(min-width: 1280px)");
	return (
		<Dialog
			open={state.inspectorOpen && !wideLayout}
			onOpenChange={(open) => {
				if (!open) actions.closeInspector();
			}}
		>
			<DialogContent
				showCloseButton={false}
				className="left-auto right-0 top-0 h-full max-w-[min(560px,100vw)] translate-x-0 translate-y-0 rounded-none border-y-0 border-r-0 p-0 sm:max-w-[min(560px,100vw)]"
			>
				<InspectorPanel state={state} actions={actions} />
			</DialogContent>
		</Dialog>
	);
}
