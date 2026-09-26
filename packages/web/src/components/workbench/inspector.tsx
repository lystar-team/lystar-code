import { FolderOpen, GitBranch, GitFork, X, Zap } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { cn } from "../../lib/utils";
import type { InspectorMode, WorkbenchState } from "../../state/use-workbench";
import { Button } from "../ui/button";
import { Dialog, DialogContent } from "../ui/dialog";
import { ScrollArea } from "../ui/scroll-area";
import { Tabs, TabsContent } from "../ui/tabs";
import { GsapReveal } from "../ui/gsap-reveal";
import { FilesPanel } from "./files-panel";
import { GitPanel } from "./git-panel";
import { RunPanel } from "./run-panel";
import { SessionTreePanel } from "./session-tree-panel";
import { SubagentPanel } from "./subagent-panel";
import type { WorkbenchActions } from "./types";
import { WorkbenchTabBar, type WorkbenchTabOption } from "./workbench-tab-bar";

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

const INSPECTOR_TABS: ReadonlyArray<WorkbenchTabOption<InspectorMode>> = [
	{ icon: FolderOpen, label: "文件", value: "files" },
	{ icon: GitBranch, label: "Git", value: "git" },
	{ icon: Zap, label: "运行", value: "runs" },
	{ icon: GitFork, label: "分支", value: "tree" },
];

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
					<p className="mt-1 truncate text-xs text-muted-foreground">
						{state.inspectorMode === "subagent" ? "Subagent 子会话" : "文件、Git、运行和分支"}
					</p>
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
				<WorkbenchTabBar activeId={state.inspectorMode} tabs={INSPECTOR_TABS} label="审阅视图" className="mx-4 mt-3" />
				<TabsContent className="min-h-0 w-full min-w-0 flex-1 overflow-hidden" value="files">
					<GsapReveal animationKey={state.inspectorMode} className="h-full min-h-0 w-full" distance={10} duration={0.28}>
						<FilesPanel state={state} actions={actions} />
					</GsapReveal>
				</TabsContent>
				<TabsContent className="min-h-0 w-full min-w-0 flex-1 overflow-hidden" value="git">
					<GsapReveal animationKey={state.inspectorMode} className="h-full min-h-0 w-full" distance={10} duration={0.28}>
						<GitPanel state={state} actions={actions} />
					</GsapReveal>
				</TabsContent>
				<TabsContent className="min-h-0 w-full min-w-0 flex-1 overflow-hidden" value="runs">
					<GsapReveal animationKey={state.inspectorMode} className="h-full min-h-0 w-full" distance={10} duration={0.28}>
						<ScrollArea className="h-full w-full" viewportRef={runViewportRef}>
							<RunPanel state={state} actions={actions} scrollRef={runViewportRef} />
						</ScrollArea>
					</GsapReveal>
				</TabsContent>
				<TabsContent className="min-h-0 w-full min-w-0 flex-1 overflow-hidden" value="tree">
					<GsapReveal animationKey={state.inspectorMode} className="h-full min-h-0 w-full" distance={10} duration={0.28}>
						<ScrollArea className="h-full w-full" viewportRef={treeViewportRef}>
							<SessionTreePanel state={state} actions={actions} scrollRef={treeViewportRef} />
						</ScrollArea>
					</GsapReveal>
				</TabsContent>
				<TabsContent className="min-h-0 w-full min-w-0 flex-1 overflow-hidden" value="subagent">
					<GsapReveal animationKey={state.inspectorMode} className="h-full min-h-0 w-full" distance={10} duration={0.28}>
						<SubagentPanel state={state} actions={actions} />
					</GsapReveal>
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
