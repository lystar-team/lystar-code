import { LogOut, Menu, PanelRight, Settings } from "lucide-react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { cn } from "../lib/utils";
import { StabilityBoundary, StabilityFallbackPanel } from "./stability-boundary";
import type { WorkbenchState } from "../state/use-workbench";
import { sessionTitle } from "../state/use-workbench";
import type { WebProject, WebSessionSummary } from "../types";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog";
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

const GitDiffDialog = lazy(() =>
	import("./workbench/git-diff-dialog").then((module) => ({ default: module.GitDiffDialog })),
);

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
	const [editingProject, setEditingProject] = useState<WebProject>();
	const [sidebarWidth, setSidebarWidth] = useState(SIDEBAR_DEFAULT_WIDTH);
	const [isResizingSidebar, setIsResizingSidebar] = useState(false);
	const currentSessions = currentProject?.sessions ?? [];
	const currentSessionSummary = currentSessions.find((session) => session.id === state.sessionId);
	const sessionTitleText = state.session
		? resolvedSessionTitle(state.session, currentSessionSummary)
		: currentProject?.name || "选择会话";

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

	const openDirectory = useCallback(() => setDirectoryOpen(true), []);
	const closeMobileProjects = useCallback(() => setMobileProjectOpen(false), []);

	return (
		<div className="flex h-dvh min-h-0 overflow-hidden bg-background text-foreground">
			<aside
				className="relative hidden shrink-0 border-r border-border/60 bg-background lg:flex"
				style={{ width: `${sidebarWidth}px` }}
			>
				<StabilityBoundary
					scope="project-rail"
					resetKeys={[state.currentProjectId]}
					fallback={({ error, reset }) => (
						<StabilityFallbackPanel
							className="h-full w-full"
							title="项目栏没有正常显示"
							message="聊天区域仍可使用。重新加载项目栏可以恢复导航。"
							error={error}
							onReset={reset}
						/>
					)}
				>
					<ProjectRail
						state={state}
						actions={actions}
						projects={projects}
						currentProject={currentProject}
						onAddProject={openDirectory}
						onEditProject={setEditingProject}
					/>
				</StabilityBoundary>
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
					<StabilityBoundary
						scope="mobile-project-rail"
						resetKeys={[state.currentProjectId]}
						fallback={({ error, reset }) => (
							<StabilityFallbackPanel
								className="h-full"
								title="项目栏没有正常显示"
								message="关闭面板后仍可使用当前会话。"
								error={error}
								onReset={reset}
							/>
						)}
					>
						<ProjectRail
							state={state}
							actions={actions}
							projects={projects}
							currentProject={currentProject}
							onAddProject={openDirectory}
							onEditProject={setEditingProject}
							onNavigate={closeMobileProjects}
						/>
					</StabilityBoundary>
				</DialogContent>
			</Dialog>

			<main className="flex min-w-0 flex-1 flex-col overflow-hidden">
				<header className="relative flex min-h-16 shrink-0 items-center justify-between gap-3 border-b border-border/60 pl-3 pr-5 pt-[env(safe-area-inset-top)] sm:pl-5 sm:pr-7">
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
						<div className="min-w-0">
							<h1 className="truncate text-base font-semibold tracking-tight sm:text-lg">
								{sessionTitleText}
							</h1>
							{currentProject ? (
								<p className="truncate text-xs text-muted-foreground">{currentProject.name}</p>
							) : null}
						</div>
					</div>
					<div className="flex shrink-0 items-center gap-2">
						<span
							className="hidden items-center gap-2 sm:inline-flex"
							role="status"
							aria-label={`连接状态：${state.connected ? (state.reconnecting ? "重新连接中" : "已连接") : "离线"}`}
						>
							<span
								className={cn(
									"size-1.5 rounded-full",
									state.connected
										? state.reconnecting
											? "bg-[var(--warning)]"
											: "bg-[var(--success)]"
										: "bg-destructive",
								)}
							/>
							<span className="text-xs font-medium tracking-tight text-muted-foreground">
								{state.connected ? (state.reconnecting ? "重新连接中" : "已连接") : "离线"}
							</span>
						</span>
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
					<Toast message={state.toast} />
				</header>

				<div className="relative flex min-h-0 flex-1 overflow-hidden">
					<div className="flex min-w-0 flex-1 flex-col overflow-hidden">
						<div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
							<StabilityBoundary
								scope="conversation"
								resetKeys={[state.sessionId]}
								fallback={({ error, reset }) => (
									<StabilityFallbackPanel
										className="min-h-0 flex-1"
										title="聊天区域已停止异常渲染"
										message="项目栏和输入区仍可使用。重新加载聊天记录可以恢复此区域。"
										error={error}
										onReset={() => {
											reset();
											void actions.loadTranscript();
										}}
									/>
								)}
							>
								<ConversationView state={state} actions={actions} sessionTitleText={sessionTitleText} />
							</StabilityBoundary>
						</div>
						<StabilityBoundary
							scope="composer"
							resetKeys={[state.sessionId]}
							fallback={({ error, reset }) => (
								<StabilityFallbackPanel
									title="输入区没有正常显示"
									message="聊天记录仍然保留。重新加载输入区后可以继续发送任务。"
									error={error}
									onReset={reset}
								/>
							)}
						>
							<Composer state={state} actions={actions} />
						</StabilityBoundary>
					</div>
					{state.inspectorOpen ? (
						<aside className="hidden min-h-0 w-[min(420px,34vw)] shrink-0 p-4 pl-0 xl:flex">
							<StabilityBoundary
								scope="inspector"
								resetKeys={[state.currentProjectId, state.inspectorMode]}
								fallback={({ error, reset }) => (
									<StabilityFallbackPanel
										className="h-full rounded-2xl border border-border/60"
										title="审阅区没有正常显示"
										message="聊天区域不受影响。"
										error={error}
										onReset={reset}
									/>
								)}
							>
								<InspectorPanel state={state} actions={actions} floating />
							</StabilityBoundary>
						</aside>
					) : null}
				</div>
			</main>

			<InspectorDialog state={state} actions={actions} />
			<StabilityBoundary
				scope="file-preview"
				resetKeys={[state.filePath]}
				fallback={({ error, reset }) => (
					<div className="fixed inset-0 z-[80] flex items-center justify-center bg-background/85 p-5 backdrop-blur-sm">
						<StabilityFallbackPanel
							title="文件预览已停止异常渲染"
							message="聊天区域没有受到影响。关闭预览后可以继续使用。"
							error={error}
							onReset={() => {
								actions.closeFilePreview();
								reset();
							}}
							retryLabel="关闭文件预览"
						/>
					</div>
				)}
			>
				<FilePreviewDialog state={state} actions={actions} />
			</StabilityBoundary>
			{state.gitDiffLoading || state.gitDiff ? (
				<Suspense fallback={null}>
					<GitDiffDialog state={state} actions={actions} />
				</Suspense>
			) : null}
			<SettingsDialog state={state} actions={actions} />
			<DirectoryDialog
				open={directoryOpen}
				state={state}
				actions={actions}
				onClose={() => setDirectoryOpen(false)}
			/>
			<ProjectRenameDialog project={editingProject} actions={actions} onClose={() => setEditingProject(undefined)} />
			<UiRequestDialog state={state} actions={actions} />
		</div>
	);
}
function resolvedSessionTitle(session: WorkbenchState["session"], summary?: WebSessionSummary): string {
	return session?.name?.trim() || (summary ? sessionTitle(summary) : sessionTitle(session));
}
