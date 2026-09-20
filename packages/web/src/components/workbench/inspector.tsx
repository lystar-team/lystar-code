import { FolderOpen, GitBranch, GitFork, type LucideProps, X, Zap } from "lucide-react";
import { type ComponentType, useEffect, useRef, useState } from "react";
import { cn } from "../../lib/utils";
import type { InspectorMode, WorkbenchState } from "../../state/use-workbench";
import { Button } from "../ui/button";
import { Dialog, DialogContent } from "../ui/dialog";
import { ScrollArea } from "../ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../ui/tabs";
import { GsapReveal } from "../ui/gsap-reveal";
import {
	ExpandableActionBar,
	ExpandableActionBarHighlight,
	ExpandableActionBarLabel,
	useExpandableActionBarItem,
} from "../motion/expandable-action-bar";
import { FilesPanel } from "./files-panel";
import { GitPanel } from "./git-panel";
import { RunPanel } from "./run-panel";
import { SessionTreePanel } from "./session-tree-panel";
import { SubagentPanel } from "./subagent-panel";
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

type InspectorTabIcon = ComponentType<LucideProps>;

const INSPECTOR_TABS: ReadonlyArray<{ icon: InspectorTabIcon; label: string; value: InspectorMode }> = [
	{ icon: FolderOpen, label: "文件", value: "files" },
	{ icon: GitBranch, label: "Git", value: "git" },
	{ icon: Zap, label: "运行", value: "runs" },
	{ icon: GitFork, label: "分支", value: "tree" },
];

function InspectorTabTrigger({ icon: Icon, label, value }: { icon: InspectorTabIcon; label: string; value: InspectorMode }) {
	const item = useExpandableActionBarItem(value);

	return (
		<TabsTrigger
			value={value}
			aria-label={label}
			title={item.labelVisible ? undefined : label}
			onFocus={item.onFocus}
			onPointerEnter={item.onPointerEnter}
			className={cn(
				// 用 beUI 轨道的胶囊形态覆盖基础 TabsTrigger 的等分样式，选中底色交给滑动高亮。
				"isolate relative !h-7 !min-w-0 !flex-1 !gap-0 !rounded-full !border-0 !px-1.5 !py-0 !text-xs !font-medium !text-muted-foreground after:!hidden",
				"data-[state=active]:!bg-transparent data-[state=active]:!text-foreground",
			)}
		>
			<ExpandableActionBarHighlight itemId={value} />
			<Icon className="size-3.5 shrink-0" aria-hidden="true" />
			<ExpandableActionBarLabel visible={item.labelVisible}>{label}</ExpandableActionBarLabel>
		</TabsTrigger>
	);
}

function InspectorTabBar({ value }: { value: InspectorMode }) {
	return (
		<TabsList className="mx-4 mt-3 !h-auto !w-auto self-stretch !justify-start !gap-0 !rounded-none !border-0 !bg-transparent !p-0">
			{/* 四个 Tab 的文字默认全部呈现：轨道常驻展开，悬停和聚焦只驱动高亮滑动。 */}
			<ExpandableActionBar
				activeId={value}
				defaultExpanded
				expandOnFocus={false}
				expandOnHover={false}
				size="sm"
			>
				{INSPECTOR_TABS.map((tab) => (
					<InspectorTabTrigger key={tab.value} {...tab} />
				))}
			</ExpandableActionBar>
		</TabsList>
	);
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
				<InspectorTabBar value={state.inspectorMode} />
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
