import { FolderOpen, LogOut, Menu, PanelRight, Settings } from "lucide-react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { useEffect, useState } from "react";
import { cn } from "../lib/utils";
import type { WorkbenchState } from "../state/use-workbench";
import { sessionTitle } from "../state/use-workbench";
import type { WebProject, WebSessionSummary } from "../types";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Composer } from "./workbench/composer";
import { SIDEBAR_DEFAULT_WIDTH, SIDEBAR_MAX_WIDTH, SIDEBAR_MIN_WIDTH } from "./workbench/constants";
import { ConversationView } from "./workbench/conversation";
import { DirectoryDialog, ProjectRenameDialog, Toast, UiRequestDialog } from "./workbench/dialogs";
import { FilePreviewDialog } from "./workbench/file-preview-dialog";
import { InspectorDialog, InspectorPanel } from "./workbench/inspector";
import { ProjectRail } from "./workbench/project-rail";
import { SettingsDialog } from "./workbench/settings";
import { TokenGate } from "./workbench/token-gate";
import type { WorkbenchActions } from "./workbench/types";

export type { WorkbenchActions } from "./workbench/types";
export { TokenGate } from "./workbench/token-gate";

export function Workbench({
	state,
	actions,
	projects,
	currentProject,
}: {
	state: WorkbenchState;
	actions: WorkbenchActions;
	projects: WebProject[];
	currentProject?: WebProject;
}) {
	const [mobileProjectOpen, setMobileProjectOpen] = useState(false);
	const [directoryOpen, setDirectoryOpen] = useState(false);
	const [directoryLoaded, setDirectoryLoaded] = useState(false);
	const [editingProject, setEditingProject] = useState<WebProject>();
	const [sidebarWidth, setSidebarWidth] = useState(SIDEBAR_DEFAULT_WIDTH);
	const [isResizingSidebar, setIsResizingSidebar] = useState(false);
	const currentSessions = currentProject?.sessions ?? [];

	const startSidebarResize = (event: ReactPointerEvent<HTMLDivElement>) => {
		if (event.button !== 0) return;
		event.preventDefault();
		event.currentTarget.setPointerCapture(event.pointerId);
		setIsResizingSidebar(true);
	};

	const resizeSidebar = (event: ReactPointerEvent<HTMLDivElement>) => {
		if (!isResizingSidebar) return;
		setSidebarWidth(Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, event.clientX)));
	};

	const stopSidebarResize = () => setIsResizingSidebar(false);

	useEffect(() => {
		if (!isResizingSidebar) return;
		const previousCursor = document.body.style.cursor;
		const previousUserSelect = document.body.style.userSelect;
		document.body.style.cursor = "col-resize";
		document.body.style.userSelect = "none";
		return () => {
			document.body.style.cursor = previousCursor;
			document.body.style.userSelect = previousUserSelect;
		};
	}, [isResizingSidebar]);

	const openDirectory = () => {
		setDirectoryOpen(true);
		if (!directoryLoaded) {
			setDirectoryLoaded(true);
			void actions.loadDirectory();
		}
	};

	return (
		<div className="flex h-dvh min-h-0 overflow-hidden bg-background text-foreground">
			<aside
				className="relative hidden shrink-0 border-r border-border/60 bg-background lg:flex"
				style={{ width: `${sidebarWidth}px` }}
			>
				<ProjectRail
					state={state}
					actions={actions}
					projects={projects}
					currentProject={currentProject}
					onAddProject={openDirectory}
					onEditProject={setEditingProject}
				/>
				<div
					// biome-ignore lint/a11y/useSemanticElements: 可拖拽分隔器需要保留指针事件和数值属性
					role="separator"
					aria-label="调整项目栏宽度"
					aria-orientation="vertical"
					aria-valuemin={SIDEBAR_MIN_WIDTH}
					aria-valuemax={SIDEBAR_MAX_WIDTH}
					aria-valuenow={sidebarWidth}
					tabIndex={0}
					className={cn(
						"absolute top-0 right-0 z-20 hidden h-full w-1 translate-x-1/2 cursor-col-resize touch-none lg:block",
						isResizingSidebar ? "bg-border" : "hover:bg-border",
					)}
					onPointerDown={startSidebarResize}
					onPointerMove={resizeSidebar}
					onPointerUp={stopSidebarResize}
					onPointerCancel={stopSidebarResize}
				/>
			</aside>

			<Dialog open={mobileProjectOpen} onOpenChange={setMobileProjectOpen}>
				<DialogContent className="left-0 top-0 h-full max-w-[min(88vw,360px)] translate-x-0 translate-y-0 rounded-none border-y-0 border-l-0 p-0 sm:max-w-[min(88vw,360px)]">
					<DialogHeader className="sr-only">
						<DialogTitle>项目与会话</DialogTitle>
						<DialogDescription>选择项目和会话</DialogDescription>
					</DialogHeader>
					<ProjectRail
						state={state}
						actions={actions}
						projects={projects}
						currentProject={currentProject}
						onAddProject={openDirectory}
						onEditProject={setEditingProject}
						onNavigate={() => setMobileProjectOpen(false)}
					/>
				</DialogContent>
			</Dialog>

			<main className="flex min-w-0 flex-1 flex-col overflow-hidden">
				<header className="flex h-16 shrink-0 items-center justify-between gap-3 border-b border-border/60 px-5 sm:px-7">
					<div className="flex min-w-0 items-center gap-2">
						<Button
							className="lg:hidden"
							size="icon"
							variant="ghost"
							onClick={() => setMobileProjectOpen(true)}
							aria-label="打开项目和会话"
						>
							<Menu className="size-4" />
						</Button>
						<FolderOpen className="size-4 shrink-0 text-muted-foreground" />
						<div className="min-w-0">
							<h1 className="truncate text-base font-semibold tracking-tight sm:text-lg">
								{state.session
									? resolvedSessionTitle(
											state.session,
											currentSessions.find((session) => session.id === state.sessionId),
										)
									: currentProject?.name || "选择会话"}
							</h1>
							{currentProject ? (
								<p className="truncate text-xs text-muted-foreground">{currentProject.name}</p>
							) : null}
						</div>
					</div>
					<div className="flex shrink-0 items-center gap-1">
						<Badge className="hidden gap-2 sm:inline-flex" variant="outline">
							<span
								className={cn("size-2 rounded-full", state.connected ? "bg-emerald-500" : "bg-destructive")}
							/>
							{state.connected ? (state.reconnecting ? "重新连接中" : "已连接") : "离线"}
						</Badge>
						<Button
							size="icon"
							variant="ghost"
							onClick={() => void actions.openInspector("runs")}
							aria-label="打开运行面板"
						>
							<PanelRight className="size-4" />
						</Button>
						<Button
							size="icon"
							variant="ghost"
							onClick={() => void actions.openSettings("appearance")}
							aria-label="设置"
						>
							<Settings className="size-4" />
						</Button>
						<Button
							className="hidden sm:inline-flex"
							size="icon"
							variant="ghost"
							onClick={actions.signOut}
							aria-label="退出"
						>
							<LogOut className="size-4" />
						</Button>
					</div>
				</header>

				<div className="relative flex min-h-0 flex-1 overflow-hidden">
					<div className="flex min-w-0 flex-1 flex-col overflow-hidden">
						<div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
							<ConversationView
								state={state}
								actions={actions}
								sessionTitleText={resolvedSessionTitle(
									state.session,
									currentSessions.find((session) => session.id === state.sessionId),
								)}
							/>
						</div>
						<Composer state={state} actions={actions} />
					</div>
					{state.inspectorOpen ? (
						<aside className="hidden min-h-0 w-[min(420px,34vw)] shrink-0 p-4 pl-0 xl:flex">
							<InspectorPanel state={state} actions={actions} floating />
						</aside>
					) : null}
				</div>
			</main>

			<InspectorDialog state={state} actions={actions} />
			<FilePreviewDialog state={state} actions={actions} />
			<SettingsDialog state={state} actions={actions} />
			<DirectoryDialog
				open={directoryOpen}
				state={state}
				actions={actions}
				onClose={() => setDirectoryOpen(false)}
			/>
			<ProjectRenameDialog project={editingProject} actions={actions} onClose={() => setEditingProject(undefined)} />
			<UiRequestDialog state={state} actions={actions} />
			<Toast message={state.toast} />
		</div>
	);
}
function resolvedSessionTitle(session: WorkbenchState["session"], summary?: WebSessionSummary): string {
	return session?.name?.trim() || (summary ? sessionTitle(summary) : sessionTitle(session));
}
