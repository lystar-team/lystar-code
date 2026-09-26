import { LoaderCircle, PanelRightOpen } from "lucide-react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cn } from "../lib/utils";
import { connectionPresentation, type ConnectionPresentation } from "../state/connection-recovery";
import { StabilityBoundary, StabilityFallbackPanel } from "./stability-boundary";
import type { WorkbenchState } from "../state/use-workbench";
import { sessionTitle } from "../state/use-workbench";
import type { WebProject, WebSessionSummary } from "../types";
import { useRoomWorkspace, type RoomMemberSelection } from "../state/use-room-workspace";
import { Button } from "./ui/button";
import { GsapReveal } from "./ui/gsap-reveal";
import { Composer } from "./workbench/composer";
import { AgentIdentityIcon, collaborationAlias, collaborationSessionsForSession } from "./workbench/collaboration-session";
import { SIDEBAR_DEFAULT_WIDTH, SIDEBAR_MAX_WIDTH, SIDEBAR_MIN_WIDTH, sidebarWidthFromPointer } from "./workbench/constants";
import { ConversationView } from "./workbench/conversation";
import {
	DirectoryDialog,
	GitCredentialAuthorizationDialog,
	ProjectRenameDialog,
	Toast,
	UiRequestDialog,
} from "./workbench/dialogs";
import { FilePreviewDialog } from "./workbench/file-preview-dialog";
import { InspectorDialog, InspectorPanel } from "./workbench/inspector";
import { MobileProjectRailDialog } from "./workbench/mobile-project-rail-dialog";
import { ProjectRail } from "./workbench/project-rail";
import { RoomRail } from "./workbench/room-rail";
import { RoomWorkspace } from "./workbench/room-workspace";
import type { WorkspaceMode } from "./workbench/workspace-mode-switch";
import { WorkspaceNavigationRail } from "./workbench/workspace-navigation-rail";
import { SettingsDialog } from "./workbench/settings";
import { TokenGate } from "./workbench/token-gate";
import type { PromptEditRequest, WorkbenchActions } from "./workbench/types";

export type { WorkbenchActions } from "./workbench/types";
export { TokenGate } from "./workbench/token-gate";

const GitDiffDialog = lazy(() =>
	import("./workbench/git-diff-dialog").then((module) => ({ default: module.GitDiffDialog })),
);

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
	const [directoryOpen, setDirectoryOpen] = useState(false);
	const [editingProject, setEditingProject] = useState<WebProject>();
	const [sidebarWidth, setSidebarWidth] = useState(SIDEBAR_DEFAULT_WIDTH);
	const [isResizingSidebar, setIsResizingSidebar] = useState(false);
	const resizePointerIdRef = useRef<number | null>(null);
	const [panelOpen, setPanelOpen] = useState(() =>
		typeof window !== "undefined" && window.matchMedia("(min-width: 1280px)").matches,
	);
	const expandButtonRef = useRef<HTMLButtonElement>(null);
	const mainRef = useRef<HTMLElement>(null);
	const [promptEditRequest, setPromptEditRequest] = useState<PromptEditRequest>();
	const [workspaceMode, setWorkspaceMode] = useState<WorkspaceMode>("sessions");
	const [roomSection, setRoomSection] = useState<"chat" | "board">("chat");
	const desktopLayout = useMediaQuery("(min-width: 768px), (horizontal-viewport-segments: 2)");
	const wideLayout = useMediaQuery("(min-width: 1280px)");
	const currentSessions = currentProject?.sessions ?? [];
	const currentSessionSummary = currentSessions.find((session) => session.id === state.sessionId);
	const collaborationSessions = useMemo(
		() => collaborationSessionsForSession(currentSessions, state.sessionId),
		[currentSessions, state.sessionId],
	);
	const roomWorkspace = useRoomWorkspace({
		active: workspaceMode === "rooms",
		projects,
		sessionId: state.sessionId,
		refreshProjectSessions: actions.refreshProjectSessions,
		showToast: actions.showToast,
	});
	const roomAgentSessionIds = useMemo(() => {
		const sessionIds = new Set(
			projects.flatMap((project) => project.sessions.filter((session) => session.roomMember).map((session) => session.id)),
		);
		for (const { rooms } of roomWorkspace.roomProjects) {
			for (const room of rooms) {
				for (const member of room.members) {
					if (member.role === "member") sessionIds.add(member.sessionId);
				}
			}
		}
		return sessionIds;
	}, [projects, roomWorkspace.roomProjects]);
	const roomMentionCompletionItems = useMemo(
		() => roomWorkspace.roomMentionItems.map(({ item }) => item),
		[roomWorkspace.roomMentionItems],
	);
	const sendRoomPrompt = useCallback<WorkbenchActions["sendMessage"]>(
		async (text, _mode, attachments, attachmentPreviews) => {
			await roomWorkspace.sendRoomMessage(
				text,
				attachments?.map((attachment, index) => ({
					...attachment,
					filename: attachmentPreviews?.[index]?.filename ?? `附件 ${index + 1}`,
				})),
			);
		},
		[roomWorkspace.sendRoomMessage],
	);
	const connection = connectionPresentation(state);
	const sessionTitleText = state.session
		? resolvedSessionTitle(state.session, currentSessionSummary)
		: currentProject?.name || "选择会话";
	const roomProject = projects.find((project) => project.id === roomWorkspace.selectedRoomProjectId);
	const viewTitle = workspaceMode === "rooms" ? roomWorkspace.selectedRoom?.room.title || "Room" : sessionTitleText;
	const viewSubtitle = workspaceMode === "rooms" ? roomProject?.name || "选择项目" : currentProject?.name;

	const startSidebarResize = (event: ReactPointerEvent<HTMLDivElement>) => {
		if (event.button !== 0 || resizePointerIdRef.current !== null) return;
		event.preventDefault();
		resizePointerIdRef.current = event.pointerId;
		event.currentTarget.setPointerCapture(event.pointerId);
		setIsResizingSidebar(true);
	};

	const resizeSidebar = (event: ReactPointerEvent<HTMLDivElement>) => {
		if (resizePointerIdRef.current !== event.pointerId) return;
		const panel = event.currentTarget.parentElement!;
		setSidebarWidth(sidebarWidthFromPointer(event.clientX, panel.getBoundingClientRect().left));
	};

	const stopSidebarResize = (event: ReactPointerEvent<HTMLDivElement>) => {
		if (resizePointerIdRef.current !== event.pointerId) return;
		resizePointerIdRef.current = null;
		if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
		setIsResizingSidebar(false);
	};

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

	useEffect(() => {
		setPromptEditRequest(undefined);
	}, [state.sessionId]);

	useEffect(() => {
		setPanelOpen(wideLayout);
		if (!wideLayout) {
			resizePointerIdRef.current = null;
			setIsResizingSidebar(false);
		}
	}, [wideLayout]);

	useEffect(() => {
		const main = mainRef.current;
		if (!main) return;
		main.inert = desktopLayout && !wideLayout && panelOpen;
		return () => {
			main.inert = false;
		};
	}, [desktopLayout, panelOpen, wideLayout]);

	const closeSidebar = useCallback(() => {
		setPanelOpen(false);
		window.requestAnimationFrame(() => expandButtonRef.current?.focus());
	}, []);

	useEffect(() => {
		if (!desktopLayout || wideLayout || !panelOpen) return;
		const handleKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape" && !event.defaultPrevented) closeSidebar();
		};
		window.addEventListener("keydown", handleKeyDown);
		return () => window.removeEventListener("keydown", handleKeyDown);
	}, [closeSidebar, desktopLayout, panelOpen, wideLayout]);

	const openDirectory = useCallback(() => {
		setDirectoryOpen(true);
		if (desktopLayout && !wideLayout) setPanelOpen(false);
	}, [desktopLayout, wideLayout]);
	const beginPromptEdit = useCallback(
		(request: PromptEditRequest) => {
			if (request.sessionId === state.sessionId) setPromptEditRequest(request);
		},
		[state.sessionId],
	);
	const closePromptEdit = useCallback(() => setPromptEditRequest(undefined), []);
	const handleWorkspaceModeChange = useCallback((mode: WorkspaceMode) => {
		setWorkspaceMode(mode);
		if (desktopLayout) setPanelOpen(true);
	}, [desktopLayout]);
	const handleSelectRoom = useCallback(
		(projectId: string, roomId: string) => {
			const summary = roomWorkspace.roomProjects
				.flatMap((entry) => (entry.project.id === projectId ? entry.rooms : []))
				.find((candidate) => candidate.room.id === roomId);
			if (summary) void roomWorkspace.selectRoom(projectId, summary);
		},
		[roomWorkspace.roomProjects, roomWorkspace.selectRoom],
	);
	const handleCreateRoom = useCallback(
		(projectId: string, title: string, member: RoomMemberSelection) => roomWorkspace.createRoom(projectId, title, member),
		[roomWorkspace.createRoom],
	);

	return (
		<div className="flex h-dvh min-h-0 overflow-hidden bg-background text-foreground">
			{desktopLayout ? (
				<div className="relative flex h-full shrink-0">
					<WorkspaceNavigationRail
						branding={state.branding}
						mode={workspaceMode}
						panelOpen={panelOpen}
						onModeChange={handleWorkspaceModeChange}
						onPanelOpen={() => setPanelOpen(true)}
						expandButtonRef={expandButtonRef}
						actions={actions}
					/>
					{panelOpen ? (
						<>
							{!wideLayout ? (
								<button type="button" tabIndex={-1} aria-hidden="true" className="fixed inset-0 z-30 cursor-default bg-black/30" onClick={closeSidebar} />
							) : null}
							<aside
								aria-label={workspaceMode === "rooms" ? "Room 导航" : "项目与会话"}
								className={cn(
									"workspace-navigation-panel relative flex min-h-0 min-w-0 shrink-0 border-r border-border/60 bg-background",
									!wideLayout && "absolute inset-y-0 left-16 z-40 w-[min(392px,calc(100vw-4rem))] shadow-lg",
								)}
								style={wideLayout ? { width: `${sidebarWidth}px`, minWidth: SIDEBAR_MIN_WIDTH, maxWidth: SIDEBAR_MAX_WIDTH } : undefined}
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
									{workspaceMode === "rooms" ? (
										<RoomRail
											state={state}
											actions={actions}
											projects={projects}
											roomProjects={roomWorkspace.roomProjects}
											roomsLoading={roomWorkspace.roomsLoading}
											roomsError={roomWorkspace.roomsError}
											selectedRoomId={roomWorkspace.selectedRoom?.room.id}
											onSelectRoom={(projectId, summary) => handleSelectRoom(projectId, summary.room.id)}
											onCreateRoom={handleCreateRoom}
											onModeChange={handleWorkspaceModeChange}
											onNavigate={wideLayout ? undefined : closeSidebar}
											withNavigationRail
											onCollapse={closeSidebar}
										/>
									) : (
										<ProjectRail
											state={state}
											actions={actions}
											projects={projects}
											roomAgentSessionIds={roomAgentSessionIds}
											currentProject={currentProject}
											onAddProject={openDirectory}
											onEditProject={setEditingProject}
											onNavigate={wideLayout ? undefined : closeSidebar}
											workspaceMode={workspaceMode}
											onWorkspaceModeChange={handleWorkspaceModeChange}
											withNavigationRail
											onCollapse={closeSidebar}
										/>
									)}
								</StabilityBoundary>
								{wideLayout ? (
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
											"absolute top-0 right-0 z-20 block h-full w-1 translate-x-1/2 cursor-col-resize touch-none",
											isResizingSidebar ? "bg-border" : "hover:bg-border",
										)}
										onPointerDown={startSidebarResize}
										onPointerMove={resizeSidebar}
										onPointerUp={stopSidebarResize}
										onPointerCancel={stopSidebarResize}
										onLostPointerCapture={stopSidebarResize}
									/>
								) : null}
							</aside>
						</>
					) : null}
				</div>
			) : null}

			<main ref={mainRef} className="flex min-w-0 flex-1 flex-col overflow-hidden">
				<header className="relative flex min-h-16 shrink-0 items-center justify-between gap-3 border-b border-border/60 pl-3 pr-5 pt-[env(safe-area-inset-top)] sm:pl-5 sm:pr-7">
					<div className="flex min-w-0 items-center gap-2">
						{desktopLayout ? null : (
							<MobileProjectRailDialog
								state={state}
								actions={actions}
								projects={projects}
								currentProject={currentProject}
								onAddProject={openDirectory}
								onEditProject={setEditingProject}
								workspaceMode={workspaceMode}
								onWorkspaceModeChange={handleWorkspaceModeChange}
								roomProjects={roomWorkspace.roomProjects}
								roomAgentSessionIds={roomAgentSessionIds}
								roomsLoading={roomWorkspace.roomsLoading}
								roomsError={roomWorkspace.roomsError}
								selectedRoomId={roomWorkspace.selectedRoom?.room.id}
								onSelectRoom={handleSelectRoom}
								onCreateRoom={handleCreateRoom}
							/>
						)}
						<GsapReveal animationKey={state.sessionId ?? "empty"} className="min-w-0" distance={8} duration={0.24}>
							<h1 className="truncate text-base font-semibold tracking-tight sm:text-lg">{viewTitle}</h1>
							{viewSubtitle ? <p className="truncate text-xs text-muted-foreground">{viewSubtitle}</p> : null}
						</GsapReveal>
					</div>
					<div className="flex shrink-0 items-center gap-2">
						{workspaceMode === "rooms" && roomWorkspace.selectedRoom ? (
							<div className="hidden items-center gap-2 sm:flex" aria-label="Room 成员">
								<div className="flex -space-x-1">
									{roomWorkspace.selectedRoom.members
										.filter((member) => !member.leftAt)
										.slice(0, 4)
										.map((member) => {
											const session = roomProject?.sessions.find((candidate) => candidate.id === member.sessionId);
											const nickname = member.role === "owner" ? "你" : member.nickname?.trim() || collaborationAlias(member.sessionId);
											return (
												<span
													className="grid size-6 place-items-center overflow-hidden rounded-full border-2 border-background bg-muted text-muted-foreground"
													key={member.sessionId}
													title={member.profileName ? `${nickname} · ${member.profileName}` : nickname}
												>
													<AgentIdentityIcon member={member} session={session} className="size-3.5 object-contain" />
												</span>
											);
										})}
								</div>
								<span className="text-xs text-muted-foreground">
									{roomWorkspace.selectedRoom.members.filter((member) => !member.leftAt).length} 位成员
								</span>
							</div>
						) : null}
						<Button
							className="h-10 gap-1.5 px-2 sm:px-3"
							variant="ghost"
							onClick={() => void actions.openInspector()}
							aria-label="打开审阅工作区"
							aria-expanded={state.inspectorOpen}
						>
							<PanelRightOpen className="size-4" aria-hidden="true" />
							<span className="text-xs sm:hidden">审阅</span>
							<span className="hidden text-xs sm:inline">审阅工作区</span>
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
								<GsapReveal
									animationKey={state.sessionId ?? "empty"}
									className="flex min-h-0 w-full flex-1 flex-col"
									distance={12}
									duration={0.34}
								>
									{workspaceMode === "rooms" ? (
										<RoomWorkspace
											state={state}
											controller={roomWorkspace}
											onModeChange={() => setWorkspaceMode("sessions")}
											openResource={actions.openResource}
											section={roomSection}
											onSectionChange={setRoomSection}
										/>
									) : (
										<ConversationView
											state={state}
											actions={actions}
											sessionTitleText={sessionTitleText}
											collaborationSessions={collaborationSessions}
											onEditPrompt={beginPromptEdit}
										/>
									)}
								</GsapReveal>
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
							<GsapReveal animationKey={state.sessionId ?? "empty"} className="w-full shrink-0" distance={8} duration={0.26}>
								{workspaceMode === "rooms" ? (
									roomWorkspace.selectedRoom && roomSection === "chat" ? (
										<Composer
											state={state}
											actions={actions}
											sendMessageOverride={sendRoomPrompt}
											roomMode
											roomId={roomWorkspace.selectedRoom.room.id}
											roomSending={roomWorkspace.roomSending}
											roomMentionItems={roomMentionCompletionItems}
											onCancelEdit={closePromptEdit}
											onEditComplete={closePromptEdit}
										/>
									) : null
								) : (
									<Composer
										state={state}
										actions={actions}
										editRequest={promptEditRequest}
										onCancelEdit={closePromptEdit}
										onEditComplete={closePromptEdit}
									/>
								)}
							</GsapReveal>
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
			<GitCredentialAuthorizationDialog state={state} actions={actions} />
			<UiRequestDialog state={state} actions={actions} />
			{connection.blocking ? <ConnectionRecoveryOverlay presentation={connection} /> : null}
		</div>
	);
}

function ConnectionRecoveryOverlay({ presentation }: { presentation: ConnectionPresentation }) {
	return (
		<div className="fixed inset-0 z-[120] grid place-items-center bg-background/85 p-6 backdrop-blur-sm">
			<div
				className="flex max-w-sm flex-col items-center text-center"
				role="status"
				aria-live="assertive"
				aria-busy="true"
			>
				<div className="grid size-12 place-items-center rounded-full bg-muted text-foreground">
					<LoaderCircle className="size-5 animate-spin" aria-hidden="true" />
				</div>
				<h2 className="mt-4 text-base font-semibold tracking-tight">{presentation.title}</h2>
				<p className="mt-1 text-sm text-muted-foreground">{presentation.description}</p>
			</div>
		</div>
	);
}

function resolvedSessionTitle(session: WorkbenchState["session"], summary?: WebSessionSummary): string {
	return session?.name?.trim() || (summary ? sessionTitle(summary) : sessionTitle(session));
}
