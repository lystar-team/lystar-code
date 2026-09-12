import { gsap } from "gsap";
import { LoaderCircle, LogOut, Menu, PanelRight, Settings, X } from "lucide-react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { cn } from "../lib/utils";
import { connectionPresentation, type ConnectionPresentation } from "../state/connection-recovery";
import { StabilityBoundary, StabilityFallbackPanel } from "./stability-boundary";
import type { WorkbenchState } from "../state/use-workbench";
import { sessionTitle } from "../state/use-workbench";
import type { WebProject, WebSessionSummary } from "../types";
import { Button } from "./ui/button";
import { GsapReveal } from "./ui/gsap-reveal";
import { Composer } from "./workbench/composer";
import { SIDEBAR_DEFAULT_WIDTH, SIDEBAR_MAX_WIDTH, SIDEBAR_MIN_WIDTH } from "./workbench/constants";
import { ConversationView } from "./workbench/conversation";
import { DirectoryDialog, ProjectRenameDialog, Toast, UiRequestDialog } from "./workbench/dialogs";
import { FilePreviewDialog } from "./workbench/file-preview-dialog";
import { InspectorDialog, InspectorPanel } from "./workbench/inspector";
import { ProjectRail } from "./workbench/project-rail";
import { SettingsDialog } from "./workbench/settings";
import { TokenGate } from "./workbench/token-gate";
import type { PromptEditRequest, WorkbenchActions } from "./workbench/types";

export type { WorkbenchActions } from "./workbench/types";
export { TokenGate } from "./workbench/token-gate";

const GitDiffDialog = lazy(() =>
	import("./workbench/git-diff-dialog").then((module) => ({ default: module.GitDiffDialog })),
);

function MobileProjectRailDialog({
	actions,
	currentProject,
	onAddProject,
	onEditProject,
	projects,
	state,
}: {
	actions: WorkbenchActions;
	currentProject?: WebProject;
	onAddProject: () => void;
	onEditProject: (project: WebProject) => void;
	projects: WebProject[];
	state: WorkbenchState;
}) {
	const [open, setOpen] = useState(false);
	const closeButtonRef = useRef<HTMLButtonElement>(null);
	const contentRef = useRef<HTMLDivElement>(null);
	const overlayRef = useRef<HTMLButtonElement>(null);
	const timelineRef = useRef<gsap.core.Timeline | null>(null);
	const triggerRef = useRef<HTMLButtonElement>(null);
	const close = useCallback(() => {
		const content = contentRef.current;
		const overlay = overlayRef.current;
		if (!content || !overlay || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
			setOpen(false);
			window.requestAnimationFrame(() => triggerRef.current?.focus());
			return;
		}

		timelineRef.current?.kill();
		gsap.killTweensOf([overlay, content]);
		timelineRef.current = gsap
			.timeline({
				defaults: { overwrite: "auto" },
				onComplete: () => {
					timelineRef.current = null;
					setOpen(false);
					triggerRef.current?.focus();
				},
			})
			.to(overlay, { autoAlpha: 0, duration: 0.12, ease: "power1.in" }, 0)
			.to(content, { duration: 0.16, ease: "power2.inOut", xPercent: -100 }, 0);
	}, []);

	useLayoutEffect(() => {
		const content = contentRef.current;
		const overlay = overlayRef.current;
		if (!content || !overlay) return;
		content.inert = !open;
		timelineRef.current?.kill();
		gsap.killTweensOf([overlay, content]);

		if (!open) {
			gsap.set(overlay, { autoAlpha: 0 });
			gsap.set(content, { autoAlpha: 0, xPercent: -100 });
			return;
		}

		if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
			gsap.set(overlay, { autoAlpha: 1 });
			gsap.set(content, { autoAlpha: 1, xPercent: 0 });
			closeButtonRef.current?.focus();
			return;
		}

		gsap.set(overlay, { autoAlpha: 0 });
		gsap.set(content, { autoAlpha: 1, xPercent: -100 });
		const entranceFrame = window.requestAnimationFrame(() => {
			timelineRef.current = gsap
				.timeline({
					defaults: { overwrite: "auto" },
					onComplete: () => {
						timelineRef.current = null;
						closeButtonRef.current?.focus();
					},
				})
				.to(overlay, { autoAlpha: 1, duration: 0.12, ease: "power1.out" }, 0)
				.to(content, { duration: 0.18, ease: "power2.out", xPercent: 0 }, 0);
		});

		return () => {
			window.cancelAnimationFrame(entranceFrame);
			timelineRef.current?.kill();
			timelineRef.current = null;
			gsap.killTweensOf([overlay, content]);
		};
	}, [open]);

	useEffect(() => {
		if (!open) return;
		const handleKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				event.preventDefault();
				close();
				return;
			}
			if (event.key !== "Tab") return;
			const content = contentRef.current;
			if (!content) return;
			const focusable = Array.from(
				content.querySelectorAll<HTMLElement>(
					'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
				),
			).filter((element) => element.getClientRects().length > 0);
			const first = focusable[0];
			const last = focusable.at(-1);
			if (!first || !last) return;
			if (event.shiftKey && document.activeElement === first) {
				event.preventDefault();
				last.focus();
			} else if (!event.shiftKey && document.activeElement === last) {
				event.preventDefault();
				first.focus();
			}
		};
		window.addEventListener("keydown", handleKeyDown);
		return () => window.removeEventListener("keydown", handleKeyDown);
	}, [close, open]);

	return (
		<>
			<Button
				ref={triggerRef}
				className="lg:hidden"
				size="icon"
				variant="ghost"
				aria-expanded={open}
				aria-label="打开项目和会话"
				onClick={() => setOpen(true)}
			>
				<Menu className="size-4" />
			</Button>
			<button
				ref={overlayRef}
				type="button"
				tabIndex={-1}
				aria-hidden="true"
				className="fixed inset-0 z-50 cursor-default border-0 bg-black/50 p-0 lg:hidden"
				onClick={close}
				style={{ opacity: 0, visibility: "hidden" }}
			/>
			<div
				ref={contentRef}
				role="dialog"
				aria-label="项目与会话"
				aria-modal="true"
				aria-hidden={!open}
				className="fixed inset-y-0 left-0 z-50 flex w-[min(88vw,360px)] flex-col border-r border-border/60 bg-background shadow-lg will-change-transform lg:hidden"
				style={{ opacity: 0, visibility: "hidden" }}
			>
				<Button
					ref={closeButtonRef}
					className="absolute top-4 right-3 z-20"
					size="icon-sm"
					variant="ghost"
					aria-label="关闭项目和会话"
					onClick={close}
				>
					<X className="size-4" />
				</Button>
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
						onAddProject={onAddProject}
						onEditProject={onEditProject}
						onNavigate={close}
					/>
				</StabilityBoundary>
			</div>
		</>
	);
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
	const [promptEditRequest, setPromptEditRequest] = useState<PromptEditRequest>();
	const currentSessions = currentProject?.sessions ?? [];
	const currentSessionSummary = currentSessions.find((session) => session.id === state.sessionId);
	const connection = connectionPresentation(state);
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

	useEffect(() => {
		setPromptEditRequest(undefined);
	}, [state.sessionId]);

	const openDirectory = useCallback(() => setDirectoryOpen(true), []);
	const beginPromptEdit = useCallback(
		(request: PromptEditRequest) => {
			if (request.sessionId === state.sessionId) setPromptEditRequest(request);
		},
		[state.sessionId],
	);
	const closePromptEdit = useCallback(() => setPromptEditRequest(undefined), []);

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

			<main className="flex min-w-0 flex-1 flex-col overflow-hidden">
				<header className="relative flex min-h-16 shrink-0 items-center justify-between gap-3 border-b border-border/60 pl-3 pr-5 pt-[env(safe-area-inset-top)] sm:pl-5 sm:pr-7">
					<div className="flex min-w-0 items-center gap-2">
						<MobileProjectRailDialog
							state={state}
							actions={actions}
							projects={projects}
							currentProject={currentProject}
							onAddProject={openDirectory}
							onEditProject={setEditingProject}
						/>
						<GsapReveal animationKey={state.sessionId ?? "empty"} className="min-w-0" distance={8} duration={0.24}>
							<h1 className="truncate text-base font-semibold tracking-tight sm:text-lg">
								{sessionTitleText}
							</h1>
							{currentProject ? (
								<p className="truncate text-xs text-muted-foreground">{currentProject.name}</p>
							) : null}
						</GsapReveal>
					</div>
					<div className="flex shrink-0 items-center gap-2">
						<span
							className="hidden items-center gap-2 sm:inline-flex"
							role="status"
							aria-label={`连接状态：${connection.label}`}
						>
							<span
								className={cn(
									"size-1.5 rounded-full",
									connection.tone === "connected"
										? "bg-[var(--success)]"
										: connection.tone === "reconnecting"
											? "bg-[var(--warning)]"
											: "bg-destructive",
								)}
							/>
							<span className="text-xs font-medium tracking-tight text-muted-foreground">
								{connection.label}
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
								<GsapReveal
									animationKey={state.sessionId ?? "empty"}
									className="flex min-h-0 w-full flex-1 flex-col"
									distance={12}
									duration={0.34}
								>
									<ConversationView
										state={state}
										actions={actions}
										sessionTitleText={sessionTitleText}
										onEditPrompt={beginPromptEdit}
									/>
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
								<Composer
									state={state}
									actions={actions}
									editRequest={promptEditRequest}
									onCancelEdit={closePromptEdit}
									onEditComplete={closePromptEdit}
								/>
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
