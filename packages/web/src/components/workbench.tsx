import {
	Archive,
	ArrowDownToLine,
	ArrowLeft,
	ArrowRight,
	ArrowUp,
	Bot,
	BookOpen,
	Check,
	ChevronDown,
	ChevronRight,
	CircleHelp,
	Clock3,
	Clipboard,
	Download,
	Eye,
	FileCode2,
	FileJson,
	FileText,
	Folder,
	FolderOpen,
	GitBranch,
	GitCompare,
	HardDrive,
	ImageIcon,
	LoaderCircle,
	LockKeyhole,
	LogOut,
	Menu,
	MessageSquarePlus,
	MoreHorizontal,
	PanelRight,
	Pencil,
	Pin,
	Plus,
	RefreshCw,
	Save,
	Search,
	Settings,
	ShieldCheck,
	Sparkles,
	Square,
	Sun,
	SunMoon,
	Trash2,
	TreePine,
	WandSparkles,
	X,
	Zap,
} from "lucide-react";
import type { FormEvent, ReactNode, PointerEvent as ReactPointerEvent, DragEvent as ReactDragEvent } from "react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { BundledLanguage } from "shiki";
import { useStickToBottomContext } from "use-stick-to-bottom";
import { type TranscriptToolViewModel, toSessionItemViewModel } from "../adapters/session-view-model";
import { cn } from "../lib/utils";
import { shouldJoinToolBatch } from "../state/tool-batching";
import type { ComposerMode, InspectorMode, SettingsTab, ThemeMode, WorkbenchState } from "../state/use-workbench";
import { sessionTitle } from "../state/use-workbench";
import type {
	ProjectTreeEntry,
	UiRequestEvent,
	WebModelProviderInput,
	WebOperation,
	WebProject,
	WebProviderModelInput,
	WebSessionSummary,
} from "../types";
import {
	Artifact,
	ArtifactContent,
	ArtifactDescription,
	ArtifactHeader,
	ArtifactTitle,
} from "./ai-elements/artifact";
import {
	Attachment,
	AttachmentInfo,
	AttachmentPreview,
	AttachmentRemove,
	Attachments,
} from "./ai-elements/attachments";
import {
	CodeBlock,
	CodeBlockActions,
	CodeBlockCopyButton,
	CodeBlockDownloadButton,
	CodeBlockFilename,
	CodeBlockHeader,
	CodeBlockTitle,
} from "./ai-elements/code-block";
import {
	Conversation,
	ConversationContent,
	ConversationEmptyState,
	ConversationScrollButton,
} from "./ai-elements/conversation";
import { FileTree, FileTreeFile, FileTreeFolder } from "./ai-elements/file-tree";
import { Message, MessageAction, MessageActions, MessageContent, MessageResponse } from "./ai-elements/message";
import {
	ModelSelector,
	ModelSelectorContent,
	ModelSelectorEmpty,
	ModelSelectorGroup,
	ModelSelectorInput,
	ModelSelectorItem,
	ModelSelectorList,
	ModelSelectorName,
	ModelSelectorTrigger,
} from "./ai-elements/model-selector";
import {
	PromptCompletionMenu,
	PromptCompletionProvider,
	PromptCompletionTextarea,
} from "./ai-elements/prompt-completion-menu";
import {
	PromptTokenContent,
	hasPromptTokens,
} from "./ai-elements/prompt-token.tsx";
import {
	PromptInput,
	PromptInputBody,
	PromptInputButton,
	PromptInputFooter,
	PromptInputHeader,
	PromptInputProvider,
	PromptInputSelect,
	PromptInputSelectContent,
	PromptInputSelectItem,
	PromptInputSelectTrigger,
	PromptInputSelectValue,
	PromptInputSubmit,
	PromptInputTools,
	usePromptInputAttachments,
} from "./ai-elements/prompt-input";
import { ResourceImage } from "./ai-elements/resource-preview";
import { Shimmer } from "./ai-elements/shimmer";
import { Source, Sources, SourcesContent, SourcesTrigger } from "./ai-elements/sources";
import { Task, TaskContent, TaskItem, TaskTrigger } from "./ai-elements/task";
import { ToolBatch, type ToolBatchTool } from "./ai-elements/tool-batch";
import { Alert, AlertDescription, AlertTitle } from "./ui/alert";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./ui/collapsible";
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuSeparator,
	ContextMenuTrigger,
} from "./ui/context-menu";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./ui/dialog";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "./ui/hover-card";
import { Input } from "./ui/input";
import { ScrollArea } from "./ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { Separator } from "./ui/separator";
import { Switch } from "./ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs";
import { Textarea } from "./ui/textarea";

const THINKING_LEVEL_LABELS: Record<string, string> = {
	off: "关闭(Off)",
	minimal: "低(Low)",
	low: "低(Low)",
	medium: "中(Medium)",
	high: "高(High)",
	xhigh: "极高(XHigh)",
	max: "最大(Max)",
	ultra: "极致(Ultra)",
};

const ACTIVE_OPERATION_STATUSES = new Set(["accepted", "running", "waiting_for_input"]);
const SIDEBAR_MIN_WIDTH = 280;
const SIDEBAR_MAX_WIDTH = 560;
const SIDEBAR_DEFAULT_WIDTH = 392;

export interface WorkbenchActions {
	selectProject: (projectId: string) => Promise<void>;
	selectSession: (sessionId: string) => Promise<void>;
	createSession: () => Promise<void>;
	sendMessage: (
		text: string,
		mode?: ComposerMode,
		images?: Array<{ data: string; mimeType: string }>,
	) => Promise<void>;
	abort: () => Promise<void>;
	openInspector: (mode?: InspectorMode) => Promise<void>;
	closeInspector: () => void;
	openSettings: (tab?: SettingsTab) => Promise<void>;
	closeSettings: () => void;
	signOut: () => void;
	setComposerMode: (mode: ComposerMode) => void;
	loadEarlier: () => Promise<void>;
	loadTranscript: () => Promise<void>;
	loadGitStatus: () => Promise<void>;
	loadGitDiff: (path?: string, staged?: boolean) => Promise<void>;
	loadProjectTree: (path?: string, preserveCurrentTree?: boolean) => Promise<void>;
	openFile: (path: string) => Promise<void>;
	openResource: (path: string) => Promise<void>;
	closeFilePreview: () => void;
	loadSessionTree: () => Promise<void>;
	navigateTree: (entryId: string) => Promise<void>;
	loadDirectory: (path?: string) => Promise<void>;
	addProject: (cwd: string, name?: string) => Promise<void>;
	updateProject: (
		projectId: string,
		update: Partial<Pick<WebProject, "name" | "pinned" | "color" | "archived">>,
	) => Promise<void>;
	reorderProjects: (projectIds: string[]) => Promise<void>;
	reorderSessions: (projectId: string, sessionIds: string[]) => Promise<void>;
	removeProject: (projectId: string) => Promise<void>;
	deleteSession: (sessionId: string) => Promise<void>;
	renameSession: (sessionId: string, name: string) => Promise<void>;
	setSessionPinned: (sessionId: string, pinned: boolean) => Promise<void>;
	fork: (entryId: string) => Promise<void>;
	compact: () => Promise<void>;
	exportSession: () => Promise<void>;
	updateModel: (provider: string, id: string) => Promise<void>;
	updateThinking: (level: string) => Promise<void>;
	setModelProviderVisibility: (providerId: string, visible: boolean) => void;
	saveModelProvider: (input: WebModelProviderInput) => Promise<void>;
	saveProviderModel: (provider: string, input: WebProviderModelInput) => Promise<void>;
	syncModelProvider: (provider: string) => Promise<void>;
	refreshSkills: () => Promise<void>;
	toggleSkill: (skill: WorkbenchState["skills"][number]) => Promise<void>;
	refreshHostInstructions: () => Promise<void>;
	saveHostInstruction: (content: string, expectedHash?: string) => Promise<void>;
	setTheme: (theme: ThemeMode) => void;
	setProjectTrust: (trusted: boolean) => Promise<void>;
	respondUiRequest: (
		request: UiRequestEvent,
		response: { value?: unknown; confirmed?: boolean; cancelled?: boolean },
	) => Promise<void>;
	showToast: (message: string) => void;
}

export function TokenGate({
	loading,
	error,
	onSubmit,
}: {
	loading: boolean;
	error?: string;
	onSubmit: (token: string) => Promise<void>;
}) {
	const [token, setToken] = useState("");
	const submit = async (event: FormEvent) => {
		event.preventDefault();
		if (!token.trim() || loading) return;
		await onSubmit(token);
	};

	return (
		<main className="grid min-h-dvh place-items-center bg-background p-6 text-foreground">
			<Card className="w-full max-w-md border-border/80 shadow-xl">
				<CardHeader className="gap-6">
					<div className="flex items-center gap-3">
						<img className="size-10 rounded-lg object-contain" src="/brand/lystar-mark.png" alt="LYStar" />
						<div>
							<CardTitle>LYStar Code</CardTitle>
							<CardDescription>浏览器工作台</CardDescription>
						</div>
					</div>
					<div>
						<Badge variant="secondary">私有控制台</Badge>
						<h1 className="mt-4 text-2xl font-semibold tracking-tight">连接你的本机 Agent</h1>
						<p className="mt-2 text-sm leading-6 text-muted-foreground">浏览器用于控制和查看运行状态。</p>
					</div>
				</CardHeader>
				<CardContent>
					<form className="grid gap-4" onSubmit={submit}>
						<div className="grid gap-2">
							<label className="text-sm font-medium" htmlFor="web-token">
								Web Token
							</label>
							<div className="relative">
								<LockKeyhole className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
								<Input
									id="web-token"
									type="password"
									className="pl-9 font-mono"
									value={token}
									onChange={(event) => setToken(event.target.value)}
									placeholder="输入 ~/.pi/agent/web/token"
									autoComplete="off"
								/>
							</div>
						</div>
						{error ? (
							<Alert variant="destructive">
								<AlertTitle>连接失败</AlertTitle>
								<AlertDescription>{error}</AlertDescription>
							</Alert>
						) : null}
						<Button className="w-full" type="submit" disabled={loading || !token.trim()}>
							{loading ? <LoaderCircle className="size-4 animate-spin" /> : <ArrowRight className="size-4" />}
							{loading ? "正在连接" : "进入工作台"}
						</Button>
						<p className="flex items-center gap-2 text-xs text-muted-foreground">
							<ShieldCheck className="size-4 text-emerald-600" />
							Token 只保存在当前浏览器
						</p>
					</form>
				</CardContent>
			</Card>
		</main>
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

function ProjectRail({
	state,
	actions,
	projects,
	currentProject,
	onAddProject,
	onEditProject,
	onNavigate,
}: {
	state: WorkbenchState;
	actions: WorkbenchActions;
	projects: WebProject[];
	currentProject?: WebProject;
	onAddProject: () => void;
	onEditProject: (project: WebProject) => void;
	onNavigate?: () => void;
}) {
	const [query, setQuery] = useState("");
	const filteredProjects = projects.filter((project) => project.name.toLowerCase().includes(query.toLowerCase()));
	const archivedProjects = state.projects.filter((project) => project.archived);
	const [showArchived, setShowArchived] = useState(false);
	const [expandedProjectIds, setExpandedProjectIds] = useState<Set<string>>(() => new Set());
	const [openProjectMenuId, setOpenProjectMenuId] = useState<string | null>(null);
	const [renamingSession, setRenamingSession] = useState<WebSessionSummary>();
	const [renameDraft, setRenameDraft] = useState("");
	const [deletingSession, setDeletingSession] = useState<WebSessionSummary>();
	const [sessionActionId, setSessionActionId] = useState<string>();
	const [projectNameDrafts, setProjectNameDrafts] = useState<Record<string, string>>({});
	const [editingProjectId, setEditingProjectId] = useState<string>();
	const [projectActionId, setProjectActionId] = useState<string>();
	const [draggedProjectId, setDraggedProjectId] = useState<string>();
	const [dragOverProjectId, setDragOverProjectId] = useState<string>();
	const [draggedSession, setDraggedSession] = useState<{ projectId: string; sessionId: string }>();
	const [dragOverSessionId, setDragOverSessionId] = useState<string>();

	useEffect(() => {
		if (!currentProject?.id) return;
		setExpandedProjectIds((current) => {
			if (current.has(currentProject.id)) return current;
			return new Set(current).add(currentProject.id);
		});
	}, [currentProject?.id]);

	const moveId = (ids: readonly string[], sourceId: string, targetId: string): string[] => {
		const next = [...ids];
		const sourceIndex = next.indexOf(sourceId);
		const targetIndex = next.indexOf(targetId);
		if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) return next;
		const [moved] = next.splice(sourceIndex, 1);
		next.splice(targetIndex, 0, moved);
		return next;
	};

	const orderedSessions = (project: WebProject): WebSessionSummary[] => [
		...project.sessions.filter((session) => session.pinned),
		...project.sessions.filter((session) => !session.pinned),
	];

	const openRenameSessionDialog = (session: WebSessionSummary) => {
		setRenamingSession(session);
		setRenameDraft(session.name ?? "");
	};

	const submitRenameDialog = async () => {
		const session = renamingSession;
		const name = renameDraft.trim();
		if (!session || !name) return;
		setSessionActionId(session.id);
		try {
			await actions.renameSession(session.id, name);
			setRenamingSession(undefined);
		} finally {
			setSessionActionId(undefined);
		}
	};

	const saveProjectName = async (project: WebProject) => {
		const name = (projectNameDrafts[project.id] ?? project.name).trim();
		if (!name || name === project.name) return;
		setProjectActionId(project.id);
		try {
			await actions.updateProject(project.id, { name });
		} catch (error) {
			actions.showToast(error instanceof Error ? error.message : String(error));
		} finally {
			setProjectActionId(undefined);
		}
	};

	const confirmDeleteSession = async () => {
		const session = deletingSession;
		if (!session) return;
		setSessionActionId(session.id);
		try {
			await actions.deleteSession(session.id);
			setDeletingSession(undefined);
		} finally {
			setSessionActionId(undefined);
		}
	};

	const handleProjectDragStart = (event: ReactDragEvent<HTMLDivElement>, projectId: string) => {
		if (query.trim()) return;
		event.dataTransfer.effectAllowed = "move";
		event.dataTransfer.setData("text/plain", projectId);
		setDraggedProjectId(projectId);
	};

	const handleProjectDrop = (event: ReactDragEvent<HTMLDivElement>, targetProjectId: string) => {
		event.preventDefault();
		const sourceProjectId = draggedProjectId || event.dataTransfer.getData("text/plain");
		const sourceProject = projects.find((project) => project.id === sourceProjectId);
		const targetProject = projects.find((project) => project.id === targetProjectId);
		if (!sourceProject || !targetProject || sourceProjectId === targetProjectId) {
			setDraggedProjectId(undefined);
			setDragOverProjectId(undefined);
			return;
		}
		if (sourceProject.pinned !== targetProject.pinned) {
			actions.showToast("置顶项目与普通项目分别调整顺序");
			setDraggedProjectId(undefined);
			setDragOverProjectId(undefined);
			return;
		}
		void actions.reorderProjects(moveId(projects.map((project) => project.id), sourceProjectId, targetProjectId));
		setDraggedProjectId(undefined);
		setDragOverProjectId(undefined);
	};

	const handleSessionDrop = (event: ReactDragEvent<HTMLDivElement>, project: WebProject, targetSessionId: string) => {
		event.preventDefault();
		const source = draggedSession;
		if (!source || source.projectId !== project.id || source.sessionId === targetSessionId) {
			setDraggedSession(undefined);
			setDragOverSessionId(undefined);
			return;
		}
		const sessions = orderedSessions(project);
		const sourceSession = sessions.find((session) => session.id === source.sessionId);
		const targetSession = sessions.find((session) => session.id === targetSessionId);
		if (!sourceSession || !targetSession) return;
		if (sourceSession.pinned !== targetSession.pinned) {
			actions.showToast("置顶会话与普通会话分别调整顺序");
			setDraggedSession(undefined);
			setDragOverSessionId(undefined);
			return;
		}
		void actions.reorderSessions(
			project.id,
			moveId(sessions.map((session) => session.id), source.sessionId, targetSessionId),
		);
		setDraggedSession(undefined);
		setDragOverSessionId(undefined);
	};

	return (
		<div className="flex min-h-0 flex-1 flex-col bg-background">
			<div className="flex h-16 shrink-0 items-center justify-between px-4 pr-14 lg:pr-4">
				<div className="flex items-center gap-2.5 font-semibold tracking-tight">
					<img className="size-7 rounded-md object-contain" src="/brand/lystar-mark.png" alt="" />
					<span>LYStar Code</span>
				</div>
				<Button
					className="max-lg:-translate-y-2"
					size="icon"
					variant="ghost"
					onClick={onAddProject}
					aria-label="添加项目"
				>
					<Plus className="size-4" />
				</Button>
			</div>
			<div className="px-3 pb-3">
				<Button
					className="h-10 w-full justify-start gap-2 px-3"
					variant="ghost"
					disabled={!currentProject}
					onClick={() => void actions.createSession()}
				>
					<MessageSquarePlus className="size-4" />
					<span className="project-list-item-label">新对话</span>
				</Button>
			</div>
			<div className="px-3 pb-3">
				<div className="relative">
					<Search
						className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
					/>
					<Input
						aria-label="搜索项目"
						placeholder="搜索项目"
						value={query}
						onChange={(event) => setQuery(event.target.value)}
						className="h-10 border-0 bg-muted/60 pl-9 shadow-none focus-visible:ring-0"
					/>
				</div>
			</div>
			<ScrollArea className="project-list min-h-0 flex-1 px-3">
				<div className="pb-5">
					<div className="flex items-center justify-between px-2 pb-2 text-xs font-medium text-muted-foreground">
						<span>项目</span>
						<span>{filteredProjects.length}</span>
					</div>
					{state.loading && !projects.length ? (
						<div className="px-2 py-8 text-center text-sm text-muted-foreground">正在加载项目与会话</div>
					) : null}
					<div className="grid gap-1">
						{filteredProjects.map((project) => {
							const active = currentProject?.id === project.id;
							const expanded = expandedProjectIds.has(project.id);
							const projectActionsVisible = openProjectMenuId === project.id;
							return (
								<Collapsible
									key={project.id}
									open={expanded}
									onOpenChange={(open) => {
										setExpandedProjectIds((current) => {
											const next = new Set(current);
											if (open) next.add(project.id);
											else next.delete(project.id);
											return next;
										});
									}}
								>
									<div
						className={cn(
							"group relative rounded-md",
							draggedProjectId === project.id && "opacity-50",
							dragOverProjectId === project.id && "ring-1 ring-primary/50",
						)}
						draggable={!query.trim()}
						onDragStart={(event) => handleProjectDragStart(event, project.id)}
						onDragOver={(event) => {
							if (!query.trim() && draggedProjectId && draggedProjectId !== project.id) {
								event.preventDefault();
								setDragOverProjectId(project.id);
							}
						}}
						onDrop={(event) => handleProjectDrop(event, project.id)}
						onDragEnd={() => {
							setDraggedProjectId(undefined);
							setDragOverProjectId(undefined);
						}}
					>
						<HoverCard
							openDelay={140}
							closeDelay={80}
							onOpenChange={(open) => {
								if (open) {
					setProjectNameDrafts((current) => ({ ...current, [project.id]: project.name }));
				}
							}}
						>
							<HoverCardTrigger asChild>
								<CollapsibleTrigger asChild>
									<Button
										className="w-full min-w-0 justify-start gap-2 px-2 pr-20 text-xs"
										variant={active ? "secondary" : "ghost"}
										onClick={() => {
											if (!active) void actions.selectProject(project.id);
										onNavigate?.();
									}}
									>
										<Folder className="size-4 shrink-0 text-muted-foreground" />
										<span className="project-list-item-label min-w-0 flex-1 truncate text-left">
											{project.name}
										</span>
									</Button>
								</CollapsibleTrigger>
							</HoverCardTrigger>
							<HoverCardContent
								side="right"
								align="start"
								sideOffset={8}
								className="w-[min(28rem,calc(100vw-1rem))] rounded-xl border-border bg-background px-4 py-3 shadow-[0_2px_8px_rgb(0_0_0/0.05)]"
								onPointerDown={(event) => event.stopPropagation()}
							>
								<div className="flex items-center gap-2">
									{editingProjectId === project.id ? (
										<Input
											aria-label="项目名称"
											autoFocus
											className="project-list-item-label h-8 min-w-0 flex-1 rounded-md border border-input bg-background px-2 shadow-sm transition-[border-color,box-shadow,background-color] duration-150 focus-visible:border-input focus-visible:ring-0"
											value={projectNameDrafts[project.id] ?? project.name}
											disabled={projectActionId === project.id}
											onChange={(event) =>
												setProjectNameDrafts((current) => ({ ...current, [project.id]: event.target.value }))
											}
											onKeyDown={(event) => {
												if (event.key === "Enter") {
													event.preventDefault();
													event.currentTarget.blur();
												}
												if (event.key === "Escape") {
													event.preventDefault();
													event.stopPropagation();
													setProjectNameDrafts((current) => ({ ...current, [project.id]: project.name }));
													setEditingProjectId(undefined);
												}
											}}
											onBlur={() => {
												setEditingProjectId(undefined);
												void saveProjectName(project);
											}}
											placeholder="输入项目名称"
										/>
									) : (
										<button
											type="button"
											className="project-list-item-label min-w-0 flex-1 cursor-text truncate bg-transparent p-0 text-left text-foreground"
											onClick={() => {
												setProjectNameDrafts((current) => ({ ...current, [project.id]: project.name }));
												setEditingProjectId(project.id);
											}}
											title="点击修改项目名称"
										>
											{project.name}
										</button>
									)}
									<Button
										aria-label={project.pinned ? "取消置顶项目" : "置顶项目"}
										size="icon"
										variant="ghost"
										onClick={(event) => {
											event.stopPropagation();
											void actions.updateProject(project.id, { pinned: !project.pinned });
										}}
									>
										<Pin className={cn("size-5", project.pinned && "text-primary")} />
									</Button>
								</div>
								<div className="mt-3 flex items-center gap-2 text-sm text-foreground">
									<span className="size-2 shrink-0 rounded-full bg-emerald-500" />
									<span>{state.connected ? "已连接" : "未连接"}</span>
									<span className="text-muted-foreground">·</span>
									<span>{project.sessions.length} 个会话</span>
								</div>
								<div className="mt-2 flex min-w-0 items-start gap-2 text-sm text-muted-foreground">
									<Folder className="mt-0.5 size-4 shrink-0" />
									<span className="min-w-0 break-all font-mono text-xs" title={project.path}>
										{project.path}
									</span>
								</div>
							</HoverCardContent>
						</HoverCard>
										<div className="absolute top-1/2 right-1 flex -translate-y-1/2 items-center gap-0.5">
											<Button
												className={cn(
													"text-muted-foreground transition-opacity hover:text-foreground",
													projectActionsVisible ? "opacity-100" : "opacity-0 group-hover:opacity-100",
												)}
												size="icon-sm"
												variant="ghost"
												onClick={(event) => {
													event.stopPropagation();
													void (active
														? actions.createSession()
														: actions.selectProject(project.id).then(() => actions.createSession()));
												}}
												aria-label={`${project.name} 新建会话`}
											>
												<Plus className="size-4" />
											</Button>
											<DropdownMenu
												open={projectActionsVisible}
												onOpenChange={(open) => setOpenProjectMenuId(open ? project.id : null)}
											>
												<DropdownMenuTrigger asChild>
													<Button
														className={cn(
															projectActionsVisible
																? "opacity-100"
																: "opacity-0 group-hover:opacity-100",
														)}
														size="icon-sm"
														variant="ghost"
														aria-label={`${project.name} 更多操作`}
													>
														<MoreHorizontal className="size-4" />
													</Button>
												</DropdownMenuTrigger>
												<DropdownMenuContent align="end">
													<DropdownMenuItem onSelect={() => onEditProject(project)}>
														<Settings className="size-4" />
														编辑项目
													</DropdownMenuItem>
													<DropdownMenuItem
														onSelect={() =>
															void actions.updateProject(project.id, { pinned: !project.pinned })
														}
													>
														<Pin className="size-4" />
														{project.pinned ? "取消置顶" : "置顶项目"}
													</DropdownMenuItem>
													<DropdownMenuItem
														onSelect={() => void actions.updateProject(project.id, { archived: true })}
													>
														<Archive className="size-4" />
														归档项目
													</DropdownMenuItem>
													<DropdownMenuSeparator />
													<DropdownMenuItem
														className="text-destructive focus:text-destructive"
														disabled={project.id === state.currentProjectId}
														onSelect={() => void actions.removeProject(project.id)}
													>
														<Trash2 className="size-4" />
														移除项目
													</DropdownMenuItem>
												</DropdownMenuContent>
											</DropdownMenu>
										</div>
									</div>
									<CollapsibleContent>
										<div className="mt-1 grid gap-1">
										{(() => {
							const sessions = orderedSessions(project);
							return sessions.map((session) => {
												const running =
													session.activity === "running" ||
													session.activity === "waiting_for_input" ||
													state.operations.some(
														(operation) =>
															operation.sessionId === session.id &&
															ACTIVE_OPERATION_STATUSES.has(operation.status),
													);
												return (
													<SessionButton
														key={session.id}
														projectName={project.name}
														session={session}
														active={state.sessionId === session.id}
														running={running}
														unread={Boolean(state.unreadSessionIds[session.id]) && !running}
														onClick={() => {
															void actions.selectSession(session.id);
															onNavigate?.();
														}}
											onRename={(name) => actions.renameSession(session.id, name)}
											onContextRename={() => openRenameSessionDialog(session)}
											onTogglePinned={() => void actions.setSessionPinned(session.id, !session.pinned)}
											onDelete={() => setDeletingSession(session)}
											dragging={draggedSession?.sessionId === session.id}
																dropTarget={dragOverSessionId === session.id}
																onDragStart={(event) => {
																	event.dataTransfer.effectAllowed = "move";
																	event.dataTransfer.setData("text/plain", session.id);
																setDraggedSession({ projectId: project.id, sessionId: session.id });
															}}
																onDragOver={(event) => {
																if (draggedSession?.projectId !== project.id || draggedSession.sessionId === session.id) return;
																event.preventDefault();
																setDragOverSessionId(session.id);
															}}
																onDrop={(event) => handleSessionDrop(event, project, session.id)}
																onDragEnd={() => {
																setDraggedSession(undefined);
																setDragOverSessionId(undefined);
															}}
													/>
												);
											});
										})()}
											{project.sessions.length === 0 ? (
												<span className="px-2 py-2 text-[13px] text-muted-foreground">暂无会话</span>
											) : null}
										</div>
									</CollapsibleContent>
								</Collapsible>
							);
						})}
					</div>
					{!state.loading && !filteredProjects.length ? (
						<div className="px-2 py-8 text-center text-sm text-muted-foreground">暂无项目</div>
					) : null}
					{archivedProjects.length ? (
						<>
							<Separator className="my-4" />
							<Button
								className="w-full justify-between px-2 text-xs text-muted-foreground"
								variant="ghost"
								onClick={() => setShowArchived((value) => !value)}
							>
								<span className="flex items-center gap-2">
									<Archive className="size-3.5" />
									归档项目
								</span>
								<span className="flex items-center gap-2">
									<span>{archivedProjects.length}</span>
									<ChevronDown className={cn("size-4 transition-transform", showArchived && "rotate-180")} />
								</span>
							</Button>
							{showArchived ? (
								<div className="mt-1 grid gap-1">
									{archivedProjects.map((project) => (
										<Button
											className="justify-between text-xs"
											variant="ghost"
											key={project.id}
											onClick={() => void actions.updateProject(project.id, { archived: false })}
										>
											<span className="truncate">{project.name}</span>
											<ArrowRight className="size-3.5" />
										</Button>
									))}
								</div>
							) : null}
						</>
					) : null}
				</div>
			</ScrollArea>
			<div className="grid shrink-0 gap-1 border-t p-3">
				<Button
					className="justify-start gap-2"
					variant="ghost"
					onClick={() => void actions.openSettings("appearance")}
				>
					<SunMoon className="size-4" />
					<span className="project-list-item-label">偏好设置</span>
				</Button>
				<Button className="justify-start gap-2" variant="ghost" onClick={actions.signOut}>
					<LogOut className="size-4" />
					<span className="project-list-item-label">退出</span>
				</Button>
			</div>
							<Dialog open={Boolean(renamingSession)} onOpenChange={(open) => !open && setRenamingSession(undefined)}>
								<DialogContent className="max-w-md">
									<DialogHeader>
										<DialogTitle>重命名会话</DialogTitle>
										<DialogDescription>修改会话在左侧列表中的显示名称。</DialogDescription>
									</DialogHeader>
									<Input
										aria-label="会话名称"
										autoFocus
										value={renameDraft}
										onChange={(event) => setRenameDraft(event.target.value)}
										onKeyDown={(event) => {
											if (event.key === "Enter" && renameDraft.trim()) void submitRenameDialog();
										}}
										placeholder="输入会话名称"
									/>
									<DialogFooter>
										<Button variant="ghost" onClick={() => setRenamingSession(undefined)}>
											取消
										</Button>
										<Button
											onClick={() => void submitRenameDialog()}
											disabled={!renameDraft.trim() || sessionActionId === renamingSession?.id}
										>
											{sessionActionId === renamingSession?.id ? "保存中…" : "保存"}
										</Button>
									</DialogFooter>
								</DialogContent>
							</Dialog>
			<Dialog open={Boolean(deletingSession)} onOpenChange={(open) => !open && setDeletingSession(undefined)}>
				<DialogContent className="max-w-md">
					<DialogHeader>
						<DialogTitle>删除会话？</DialogTitle>
						<DialogDescription>
							“{deletingSession ? sessionTitle(deletingSession) : "当前会话"}”删除后无法恢复，确认继续吗？
						</DialogDescription>
					</DialogHeader>
					<DialogFooter>
						<Button variant="ghost" onClick={() => setDeletingSession(undefined)}>
							取消
						</Button>
						<Button
							variant="destructive"
							onClick={() => void confirmDeleteSession()}
							disabled={sessionActionId === deletingSession?.id}
						>
							{sessionActionId === deletingSession?.id ? "删除中…" : "删除会话"}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</div>
	);
}

function formatSessionAge(timestamp: number): string {
	const elapsed = Math.max(0, Date.now() - timestamp);
	const minute = 60 * 1000;
	const hour = 60 * minute;
	const day = 24 * hour;
	if (elapsed < minute) return "刚刚";
	if (elapsed < hour) return `${Math.floor(elapsed / minute)} 分钟`;
	if (elapsed < day) return `${Math.floor(elapsed / hour)} 小时`;
	if (elapsed < 30 * day) return `${Math.floor(elapsed / day)} 天`;
	if (elapsed < 365 * day) return `${Math.floor(elapsed / (30 * day))} 个月`;
	return `${Math.floor(elapsed / (365 * day))} 年`;
}

function formatSessionDate(timestamp: number): string {
	return new Intl.DateTimeFormat("zh-CN", {
		year: "numeric",
		month: "long",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	}).format(timestamp);
}

function SessionButton({
	projectName,
	session,
	active,
	running,
	unread,
	onClick,
	onRename,
	onContextRename,
	onTogglePinned,
	onDelete,
	dragging,
	dropTarget,
	onDragStart,
	onDragOver,
	onDrop,
	onDragEnd,
}: {
	projectName: string;
	session: WebSessionSummary;
	active: boolean;
	running: boolean;
	unread: boolean;
	onClick: () => void;
	onRename: (name: string) => Promise<void>;
	onContextRename: () => void;
	onTogglePinned: () => void;
	onDelete: () => void;
	dragging: boolean;
	dropTarget: boolean;
	onDragStart: (event: ReactDragEvent<HTMLDivElement>) => void;
	onDragOver: (event: ReactDragEvent<HTMLDivElement>) => void;
	onDrop: (event: ReactDragEvent<HTMLDivElement>) => void;
	onDragEnd: () => void;
}) {
	const title = sessionTitle(session);
	const [editingTitle, setEditingTitle] = useState(false);
	const [renameDraft, setRenameDraft] = useState(title);
	const relativeTime = formatSessionAge(session.updatedAt);
	const absoluteTime = formatSessionDate(session.updatedAt);

	useEffect(() => {
		if (!editingTitle) setRenameDraft(title);
	}, [editingTitle, title]);

	const cancelRename = () => {
		setRenameDraft(title);
		setEditingTitle(false);
	};

	const commitRename = async () => {
		const name = renameDraft.trim();
		if (!name) {
			cancelRename();
			return;
		}
		await onRename(name);
		setEditingTitle(false);
	};

	return (
		<ContextMenu>
			<ContextMenuTrigger asChild>
				<div
					className={cn(
						"min-w-0 rounded-md",
						dragging && "opacity-50",
						dropTarget && "ring-1 ring-primary/50",
					)}
					draggable
					onDragStart={onDragStart}
					onDragOver={onDragOver}
					onDrop={onDrop}
					onDragEnd={onDragEnd}
				>
					<HoverCard openDelay={140} closeDelay={80}>
						<HoverCardTrigger asChild>
							<Button
								className="w-full min-w-0 justify-start gap-2 py-2 pr-2 !pl-8 text-left text-xs"
								variant={active ? "secondary" : "ghost"}
								onClick={onClick}
							>
								<span className="project-list-item-label min-w-0 flex-1 truncate">{title}</span>
								{session.pinned ? <Pin className="size-3.5 shrink-0 text-muted-foreground" aria-label="已置顶" /> : null}
								{running ? (
									<LoaderCircle className="size-3.5 shrink-0 animate-spin text-primary" aria-label="会话进行中" />
								) : unread ? (
									<span
										role="img"
										className="size-2 shrink-0 rounded-full bg-blue-500"
										aria-label="有新的会话内容"
										title="有新的会话内容"
									/>
								) : null}
							</Button>
						</HoverCardTrigger>
						<HoverCardContent
							side="right"
							align="start"
							sideOffset={8}
							className="w-max min-w-72 max-w-[calc(100vw-1rem)] rounded-xl border-border bg-background px-4 py-3 shadow-[0_2px_8px_rgb(0_0_0/0.05)]"
							onPointerDown={(event) => event.stopPropagation()}
						>
							<div className="flex items-start justify-between gap-4 whitespace-nowrap">
								{editingTitle ? (
									<Input
										aria-label="会话名称"
										autoFocus
										className="project-list-item-label h-8 min-w-0 flex-1 rounded-md border border-input bg-background px-2 shadow-sm transition-[border-color,box-shadow,background-color] duration-150 focus-visible:border-input focus-visible:ring-0"
										value={renameDraft}
										onChange={(event) => setRenameDraft(event.target.value)}
										onClick={(event) => event.stopPropagation()}
										onBlur={() => void commitRename()}
										onKeyDown={(event) => {
											if (event.key === "Enter") {
												event.preventDefault();
												event.currentTarget.blur();
											}
											if (event.key === "Escape") {
												event.preventDefault();
												event.stopPropagation();
												cancelRename();
											}
										}}
										placeholder="输入会话名称"
									/>
								) : (
									<button
										type="button"
										className="project-list-item-label min-w-0 max-w-[calc(100vw-3rem)] cursor-text truncate whitespace-nowrap bg-transparent p-0 text-left text-foreground"
										onClick={() => {
											setRenameDraft(title);
											setEditingTitle(true);
										}}
										title="点击修改会话名称"
									>
										{title}
									</button>
								)}
								<time
									className="shrink-0 text-xs text-muted-foreground"
									dateTime={new Date(session.updatedAt).toISOString()}
									title={absoluteTime}
								>
									{relativeTime}
								</time>
							</div>
							<div className="mt-3 grid gap-2 whitespace-nowrap text-xs text-muted-foreground">
								<div className="flex min-w-0 items-center gap-2">
									<Folder className="size-3.5 shrink-0" />
									<span className="truncate">{projectName}</span>
								</div>
								<div className="flex min-w-0 items-center gap-2">
									<Clock3 className="size-3.5 shrink-0" />
									<span className="truncate">最后回复 {absoluteTime}</span>
								</div>
							</div>
						</HoverCardContent>
					</HoverCard>
				</div>
			</ContextMenuTrigger>
			<ContextMenuContent className="w-48">
				<ContextMenuItem onSelect={onContextRename}>
					<Pencil className="size-4" />
					重命名
				</ContextMenuItem>
				<ContextMenuItem onSelect={onTogglePinned}>
					<Pin className="size-4" />
					{session.pinned ? "取消置顶" : "置顶会话"}
				</ContextMenuItem>
				<ContextMenuSeparator />
				<ContextMenuItem className="text-destructive focus:text-destructive" onSelect={onDelete}>
					<Trash2 className="size-4" />
					删除会话
				</ContextMenuItem>
			</ContextMenuContent>
		</ContextMenu>
	);
}

function resolvedSessionTitle(session: WorkbenchState["session"], summary?: WebSessionSummary): string {
	return session?.name?.trim() || (summary ? sessionTitle(summary) : sessionTitle(session));
}

type TranscriptRenderItem =
	| { kind: "item"; item: WorkbenchState["transcript"][number] }
	| { kind: "tool-batch"; key: string; tools: ToolBatchTool[] };

function buildTranscriptRenderItems(
	items: WorkbenchState["transcript"],
	toolIndex: {
		callIds: ReadonlySet<string>;
		results: ReadonlyMap<string, TranscriptToolViewModel>;
		statuses: ReadonlyMap<string, "success" | "error">;
	},
): TranscriptRenderItem[] {
	const rendered: TranscriptRenderItem[] = [];
	let batchTools: ToolBatchTool[] = [];
	let batchKey = "";
	let batchEntryId: string | undefined;

	const flushBatch = () => {
		if (batchTools.length > 0) {
			rendered.push({ kind: "tool-batch", key: batchKey, tools: batchTools });
			batchTools = [];
			batchKey = "";
			batchEntryId = undefined;
		}
	};

	for (const item of items) {
		const viewModel = toSessionItemViewModel(item, toolIndex.statuses);
		if (viewModel.kind === "reasoning") continue;
		if (viewModel.kind === "tools" && item.view?.type === "tool_call") {
			for (const tool of viewModel.tools) {
				const result = toolIndex.results.get(tool.id);
				const resolvedTool = result
					? { ...tool, state: result.state, detail: result.detail, images: result.images, diff: result.diff }
					: tool;
				const previous = batchTools.at(-1);
				if (!previous || batchEntryId !== item.entryId || !shouldJoinToolBatch(previous.name, resolvedTool.name)) {
					flushBatch();
					batchEntryId = item.entryId;
					batchKey = `tool-batch:${item.entryId}:${item.renderId}:${resolvedTool.id}`;
				}
				batchTools.push(resolvedTool);
			}
			continue;
		}
		if (viewModel.kind === "tools" && item.view?.type === "tool_result") {
			if (toolIndex.callIds.has(item.view.callId)) continue;
			flushBatch();
			rendered.push({ kind: "item", item });
			continue;
		}
		flushBatch();
		rendered.push({ kind: "item", item });
	}
	flushBatch();
	return rendered;
}

function ConversationView({
	state,
	actions,
	sessionTitleText,
}: {
	state: WorkbenchState;
	actions: WorkbenchActions;
	sessionTitleText: string;
}) {
	const toolIndex = useMemo(() => {
		const callIds = new Set<string>();
		const results = new Map<string, TranscriptToolViewModel>();
		const statuses = new Map<string, "success" | "error">();
		for (const item of state.transcript) {
			if (item.view?.type === "tool_call") {
				for (const call of item.view.calls) callIds.add(call.id);
			}
			if (item.view?.type === "tool_result") {
				const tool: TranscriptToolViewModel = {
					id: item.view.callId,
					name: item.view.name,
					summary: item.view.summary,
					state: item.view.status === "success" ? "output-available" : "output-error",
					detail: item.view.detail,
					images: item.view.images,
					diff: item.view.diff,
				};
				results.set(item.view.callId, tool);
				statuses.set(item.view.callId, item.view.status);
			}
		}
		return { callIds, results, statuses };
	}, [state.transcript]);
	const renderItems = useMemo(
		() => buildTranscriptRenderItems(state.transcript, toolIndex),
		[state.transcript, toolIndex],
	);

	return (
		<Conversation key={state.sessionId ?? "empty"} className="min-h-0 flex-1">
			<ConversationBody
				state={state}
				actions={actions}
				sessionTitleText={sessionTitleText}
				renderItems={renderItems}
				toolStatuses={toolIndex.statuses}
			/>
			<ConversationScrollButton aria-label="回到最新消息" />
		</Conversation>
	);
}

function ConversationBody({
	state,
	actions,
	sessionTitleText,
	renderItems,
	toolStatuses,
}: {
	state: WorkbenchState;
	actions: WorkbenchActions;
	sessionTitleText: string;
	renderItems: TranscriptRenderItem[];
	toolStatuses: ReadonlyMap<string, "success" | "error">;
}) {
	const { scrollRef, scrollToBottom, isAtBottom } = useStickToBottomContext();
	const pendingScrollRef = useRef<{ top: number; height: number } | undefined>(undefined);
	const responseActive = Boolean(
		state.liveText ||
			state.liveThinking ||
			state.liveTurnItems.length ||
			state.session?.activity === "running" ||
			state.session?.activity === "waiting_for_input" ||
			(state.currentOperation && ACTIVE_OPERATION_STATUSES.has(state.currentOperation.status)),
	);
	const lastAssistantMessageIndex = renderItems.reduce<number>((lastIndex, entry, index) => {
		if (entry.kind !== "item") return lastIndex;
		const viewModel = toSessionItemViewModel(entry.item, toolStatuses);
		return viewModel.kind === "message" && viewModel.role === "assistant" && viewModel.text ? index : lastIndex;
	}, -1);
	const autoScrollFrameRef = useRef<number | undefined>(undefined);

	useLayoutEffect(() => {
		if (!isAtBottom || !scrollRef.current || autoScrollFrameRef.current !== undefined) return;
		autoScrollFrameRef.current = window.requestAnimationFrame(() => {
			autoScrollFrameRef.current = undefined;
			void scrollToBottom({ animation: "instant", preserveScrollPosition: true });
		});
	}, [
		isAtBottom,
		scrollRef,
		scrollToBottom,
		state.hasMorePrevious,
		state.liveText,
		state.liveThinking,
		state.liveTools,
		state.liveTurnItems,
		state.statusText,
		state.transcript,
	]);

	useEffect(() => {
		return () => {
			if (autoScrollFrameRef.current !== undefined) {
				window.cancelAnimationFrame(autoScrollFrameRef.current);
				autoScrollFrameRef.current = undefined;
			}
		};
	}, []);

	const loadEarlier = useCallback(async () => {
		const scroller = scrollRef.current;
		if (scroller) pendingScrollRef.current = { top: scroller.scrollTop, height: scroller.scrollHeight };
		try {
			await actions.loadEarlier();
		} catch (error) {
			pendingScrollRef.current = undefined;
			throw error;
		}
	}, [actions.loadEarlier, scrollRef]);

	useLayoutEffect(() => {
		if (state.loadingEarlier || !pendingScrollRef.current) return;
		const frame = window.requestAnimationFrame(() => {
			const scroller = scrollRef.current;
			const pending = pendingScrollRef.current;
			if (scroller && pending) {
				scroller.scrollTop = pending.top + (scroller.scrollHeight - pending.height);
			}
			pendingScrollRef.current = undefined;
		});
		return () => window.cancelAnimationFrame(frame);
	}, [scrollRef, state.loadingEarlier]);

	const transcriptNodes: ReactNode[] = [];
	for (let index = 0; index < renderItems.length; index++) {
		const entry = renderItems[index];
		if (entry.kind === "tool-batch") {
			const batches = [entry];
			while (index + 1 < renderItems.length) {
				const next = renderItems[index + 1];
				if (next.kind !== "tool-batch") break;
				batches.push(next);
				index += 1;
			}
			transcriptNodes.push(
				<div className="tool-batch-stack" key={`tool-stack:${batches[0].key}`}>
					{batches.map((batch) => (
						<ToolBatch
							key={batch.key}
							className="tool-batch-render-item"
							tools={batch.tools}
							sessionId={state.sessionId}
							onOpenPath={(path) => void actions.openResource(path)}
						/>
					))}
				</div>,
			);
			continue;
		}
		transcriptNodes.push(
			<TranscriptItemView
				key={entry.item.renderId}
				item={entry.item}
				showCopy={!responseActive && index === lastAssistantMessageIndex}
				toolStatuses={toolStatuses}
				actions={actions}
				sessionId={state.sessionId}
			/>,
		);
	}

	return (
		<ConversationContent className="conversation-content mx-auto w-full max-w-[var(--conversation-width)] gap-3 px-5 py-10 sm:px-10 sm:py-12">
			{state.hasMorePrevious ? (
				<Button
					className="mx-auto"
					size="sm"
					variant="outline"
					disabled={state.loadingEarlier}
					onClick={() => void loadEarlier()}
				>
					{state.loadingEarlier ? (
						<LoaderCircle className="size-4 animate-spin" />
					) : (
						<ArrowDownToLine className="size-4" />
					)}
					{state.loadingEarlier ? "正在加载" : "加载更早消息"}
				</Button>
			) : null}
			{state.loading ? (
				<div
					className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground"
					aria-live="polite"
					aria-busy="true"
				>
					<LoaderCircle className="size-4 animate-spin" />
					正在加载项目与会话
				</div>
			) : state.sessionError ? (
				<AgentErrorCard
					title="会话信息加载失败"
					message={state.sessionError}
					onRetry={state.sessionId ? () => void actions.selectSession(state.sessionId!) : undefined}
				/>
			) : state.transcriptLoading && !state.transcript.length ? (
				<div
					className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground"
					aria-live="polite"
					aria-busy="true"
				>
					<LoaderCircle className="size-4 animate-spin" />
					正在加载会话记录
				</div>
			) : state.transcriptError && !state.transcript.length ? (
				<AgentErrorCard
					title="会话记录加载失败"
					message={state.transcriptError}
					onRetry={() => void actions.loadTranscript()}
				/>
			) : state.transcript.length ? (
				transcriptNodes
			) : (
				<ConversationEmptyState
					className="min-h-[56vh]"
					icon={<Sparkles className="size-6" />}
					title={state.session ? sessionTitleText : "选择一个会话"}
					description={state.session ? "从底部输入任务，运行进展会显示在这里。" : "从左侧选择会话或新建会话。"}
				/>
			)}
			<LiveTurn state={state} actions={actions} />
		</ConversationContent>
	);
}

function AgentErrorCard({ title, message, onRetry }: { title: string; message: string; onRetry?: () => void }) {
	return (
		<div
			className="agent-error-card mx-auto flex w-full max-w-none items-center gap-3 rounded-[48px] border border-border bg-background px-5 py-4 text-foreground shadow-none"
			role="alert"
		>
			<CircleHelp className="size-5 shrink-0" />
			<div className="min-w-0 flex-1">
				<div className="text-base font-medium">{title}</div>
				<div className="mt-1 break-words text-sm text-muted-foreground">{message}</div>
			</div>
			{onRetry ? (
				<Button className="shrink-0" size="sm" variant="outline" onClick={onRetry}>
					重试
				</Button>
			) : null}
		</div>
	);
}

function TranscriptItemView({
	item,
	toolStatuses,
	actions,
	sessionId,
	showCopy,
}: {
	item: WorkbenchState["transcript"][number];
	toolStatuses: ReadonlyMap<string, "success" | "error">;
	actions: WorkbenchActions;
	sessionId?: string;
	showCopy: boolean;
}) {
	const viewModel = toSessionItemViewModel(item, toolStatuses);
	if (viewModel.kind === "message") {
		return (
			<Message
				from={viewModel.role}
				className={cn(
					viewModel.role === "user" && "max-w-[84%] self-end",
					viewModel.role === "system" && "rounded-md bg-muted/50 p-3",
				)}
			>
				<TranscriptSources urls={viewModel.sources} />
				<MessageContent>
					{viewModel.role === "user" && hasPromptTokens(viewModel.text) ? (
						<PromptTokenContent text={viewModel.text} />
					) : (
						<MessageResponse
							mode="static"
							parseIncompleteMarkdown
							linkSafety={{ enabled: true }}
							controls={{ code: { copy: true, download: true }, table: { copy: true, download: true } }}
							onOpenPath={(path) => void actions.openResource(path)}
						>
							{viewModel.text || " "}
						</MessageResponse>
					)}
					<TranscriptAttachments attachments={viewModel.attachments} sessionId={sessionId} />
				</MessageContent>
				{showCopy && viewModel.role === "assistant" && viewModel.text ? (
					<CopyMessageAction text={viewModel.text} />
				) : null}
			</Message>
		);
	}
	if (viewModel.kind === "reasoning") return null;
	if (viewModel.kind === "tools")
		return (
			<ToolBatch
				className="tool-batch-render-item"
				tools={viewModel.tools}
				sessionId={sessionId}
				onOpenPath={(path) => void actions.openResource(path)}
			/>
		);
	if (viewModel.kind === "code") return <CodeBlockView code={viewModel.code} language={viewModel.language} />;
	return (
		<Task defaultOpen>
			<TaskTrigger title={viewModel.title} />
			<TaskContent>
				<MessageResponse mode="static" onOpenPath={(path) => void actions.openResource(path)}>
					{viewModel.text}
				</MessageResponse>
			</TaskContent>
		</Task>
	);
}

function TranscriptSources({ urls }: { urls: string[] }) {
	if (!urls.length) return null;
	return (
		<Sources>
			<SourcesTrigger count={urls.length}>
				<span>来源 · {urls.length}</span>
			</SourcesTrigger>
			<SourcesContent>
				{urls.map((url) => (
					<Source href={url} key={url} title={url.replace(/^https?:\/\//iu, "").slice(0, 72)} />
				))}
			</SourcesContent>
		</Sources>
	);
}

function TranscriptAttachments({
	attachments,
	sessionId,
}: {
	attachments: Array<{ id: string; filename: string; mediaType: string; url: string }>;
	sessionId?: string;
}) {
	if (!attachments.length) return null;
	return (
		<Attachments className="mt-2" variant="inline">
			{attachments.map((attachment) => (
				<Attachment key={attachment.id} data={{ ...attachment, type: "file" }}>
					{attachment.mediaType.startsWith("image/") && sessionId ? (
						<ResourceImage
							sessionId={sessionId}
							contentRef={attachment.id}
							alt={attachment.filename}
							className="w-48"
						/>
					) : (
						<AttachmentPreview />
					)}
					<AttachmentInfo />
				</Attachment>
			))}
		</Attachments>
	);
}

function CodeBlockView({
	code,
	language,
	wrap = false,
	embedded = false,
}: {
	code: string;
	language: string;
	wrap?: boolean;
	embedded?: boolean;
}) {
	return (
		<CodeBlock
			className={cn("my-0", embedded && "border-0 bg-transparent shadow-none")}
			code={code}
			language={language as BundledLanguage}
			transparent={embedded}
			wrap={wrap}
		>
			<CodeBlockHeader
				className={cn(embedded ? "justify-end border-b-0 bg-transparent px-0 py-0 text-foreground" : undefined)}
			>
				{embedded ? null : (
					<CodeBlockTitle>
						<FileCode2 className="size-4" />
						<CodeBlockFilename>{language}</CodeBlockFilename>
					</CodeBlockTitle>
				)}
				<CodeBlockActions className={embedded ? "-my-1 -mr-1" : undefined}>
					<CodeBlockDownloadButton aria-label="下载代码" filename={`code.${language}`} />
					<CodeBlockCopyButton aria-label="复制代码" />
				</CodeBlockActions>
			</CodeBlockHeader>
		</CodeBlock>
	);
}

function CopyMessageAction({ text }: { text: string }) {
	const [copied, setCopied] = useState(false);
	const copy = async () => {
		try {
			await navigator.clipboard.writeText(text);
			setCopied(true);
			window.setTimeout(() => setCopied(false), 1600);
		} catch {
			setCopied(false);
		}
	};
	return (
		<MessageActions className="opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
			<MessageAction label="复制回复" tooltip="复制回复" onClick={() => void copy()}>
				{copied ? <Check className="size-4" /> : <Clipboard className="size-4" />}
			</MessageAction>
		</MessageActions>
	);
}

function latestThinkingLine(text: string): string {
	const lines = text
		.replace(/\r\n?/gu, "\n")
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
	const line = lines[lines.length - 1] ?? text.trim();
	return line.replace(/\*\*\s*(.*?)\s*\*\*/gu, "$1").replace(/__\s*(.*?)\s*__/gu, "$1");
}

function LiveTurn({ state, actions }: { state: WorkbenchState; actions: WorkbenchActions }) {
	const liveItems = state.liveTurnItems.filter((item) => item.kind !== "thinking");
	const hasLive = Boolean(state.liveText || state.liveThinking || liveItems.length || state.statusText);
	if (!hasLive) return null;

	return (
		<div className="live-turn grid gap-3" aria-live="polite">
			{liveItems.map((item) => {
				if (item.kind === "text") {
					return item.text ? (
						<Message key={item.id} from="assistant">
							<MessageContent>
								<MessageResponse
									mode="streaming"
									parseIncompleteMarkdown
									onOpenPath={(path) => void actions.openResource(path)}
								>
									{item.text}
								</MessageResponse>
							</MessageContent>
						</Message>
					) : null;
				}

				const tools = item.toolIds.flatMap((toolId) => {
					const tool = state.liveTools[toolId];
					if (!tool) return [];
					return [
						{
							id: tool.id,
							name: tool.name,
							summary: tool.summary,
							state:
								tool.state === "success"
									? ("output-available" as const)
									: tool.state === "error"
										? ("output-error" as const)
										: tool.state === "cancelled"
											? ("output-cancelled" as const)
											: tool.state === "interrupted"
												? ("output-interrupted" as const)
												: tool.state === "preparing" || tool.state === "queued"
													? ("input-queued" as const)
													: ("input-available" as const),
							detail: tool.result,
							inputPreview: tool.inputPreview,
							diff: tool.diff,
						},
					];
				});
				if (!tools.length) return null;
				return (
					<ToolBatch
						key={`${item.id}:${item.batchId}`}
						className="tool-batch-render-item"
						tools={tools}
						sessionId={state.sessionId}
						onOpenPath={(path) => void actions.openResource(path)}
						initialOpen={tools.some(
							(tool) => tool.state === "input-available" || tool.state === "input-queued",
						)}
						autoCollapseWhenComplete
					/>
				);
			})}
			{state.liveThinking ? (
				<div className="text-sm font-normal text-muted-foreground" aria-live="polite">
					<Shimmer as="span" className="text-sm font-normal">
						{latestThinkingLine(state.liveThinking)}
					</Shimmer>
				</div>
			) : null}
			{!liveItems.length && !state.liveThinking && state.statusText ? <Shimmer>{state.statusText}</Shimmer> : null}
		</div>
	);
}

function Composer({ state, actions }: { state: WorkbenchState; actions: WorkbenchActions }) {
	const [modelSelectorOpen, setModelSelectorOpen] = useState(false);
	const disabled = !state.sessionId || state.readOnly || !state.connected;
	const active = Boolean(
		state.session?.activity === "running" ||
			state.session?.activity === "waiting_for_input" ||
			(state.currentOperation && ACTIVE_OPERATION_STATUSES.has(state.currentOperation.status)),
	);
	const stopping = active;
	const selectedModel = state.models.find(
		(model) => model.provider === state.session?.model?.provider && model.id === state.session?.model?.id,
	);
	const contextWindow = state.session?.contextWindow ?? selectedModel?.contextWindow ?? 0;
	const contextTokens = state.session?.contextTokens ?? 0;
	const thinkingLevels = (
		selectedModel?.supportedThinkingLevels.length ? selectedModel.supportedThinkingLevels : ["off"]
	).filter((level) => level !== "minimal");
	const modelsByProvider = useMemo(() => {
		const groups = new Map<string, typeof state.models>();
		for (const model of state.models) {
			if (state.hiddenModelProviders.includes(model.provider)) continue;
			groups.set(model.provider, [...(groups.get(model.provider) ?? []), model]);
		}
		return [...groups.entries()].sort(([left], [right]) => {
			const leftProvider = state.providers.find((provider) => provider.id === left);
			const rightProvider = state.providers.find((provider) => provider.id === right);
			if (leftProvider?.builtIn !== rightProvider?.builtIn) return leftProvider?.builtIn ? 1 : -1;
			return (leftProvider?.name ?? left).localeCompare(rightProvider?.name ?? right, "zh-CN");
		});
	}, [state.hiddenModelProviders, state.models, state.providers]);

	return (
		<div className="shrink-0 bg-background px-4 pt-3 pb-[max(16px,env(safe-area-inset-bottom))] sm:px-8">
			<div className="mx-auto w-full max-w-[var(--conversation-width)]">
				<PromptInputProvider>
					<PromptCompletionProvider
						disabled={disabled}
						onError={(error) => actions.showToast(error instanceof Error ? error.message : String(error))}
						projectId={state.currentProjectId}
						sessionId={state.sessionId}
					>
						<div className="relative">
							<PromptCompletionMenu />
							<PromptInput
								className="prompt-input-shell [&_[data-slot=input-group]]:rounded-[48px] [&_[data-slot=input-group]]:bg-background [&_[data-slot=input-group]]:shadow-[0_2px_12px_rgb(0_0_0/0.05)]"
								accept="image/*"
								globalDrop
								multiple
								maxFiles={8}
								maxFileSize={8 * 1024 * 1024}
								onError={(error) => {
									if (error.code === "max_files") actions.showToast("最多添加 8 个附件");
									else if (error.code === "max_file_size") actions.showToast("单个附件不能超过 8 MB");
									else if (error.code === "accept") actions.showToast("只能上传图片");
									else actions.showToast("附件类型不受支持");
								}}
								onSubmit={async ({ text, files, submitMode }) => {
									if (!text.trim() || disabled) return;
									const mode = stopping
										? submitMode === "steer"
											? "steer"
											: "follow-up"
										: state.composerMode;
									await actions.sendMessage(
										text,
										mode,
										files.map((file) => ({
											data: file.url ?? "",
											mimeType: file.mediaType || "application/octet-stream",
										})),
									);
								}}
							>
								<PromptInputHeader className="empty:hidden">
									<ComposerAttachments />
								</PromptInputHeader>
								<PromptInputBody>
									<PromptCompletionTextarea
										className="!pt-4 !pb-2 !pl-5 text-left"
										placeholder={disabled ? "当前会话不可写" : "描述你想完成的工作…"}
										disabled={disabled}
									/>
								</PromptInputBody>
								<PromptInputFooter className="items-center !pb-2">
									<PromptInputTools className="shrink-0">
										<ImageUploadButton disabled={disabled} />
									</PromptInputTools>
									<PromptInputTools className="min-w-0 flex-1 justify-end gap-1">
										<ContextRing contextWindow={contextWindow} usedTokens={contextTokens} />
										<ModelSelector open={modelSelectorOpen} onOpenChange={setModelSelectorOpen}>
											<ModelSelectorTrigger asChild>
												<PromptInputButton
													className="data-[state=open]:bg-accent"
													disabled={!state.sessionId}
												>
													<span className="max-w-40 truncate">
														{formatModelDisplayName(
															selectedModel ??
																(state.session?.model ? { id: state.session.model.id } : undefined),
														)}
													</span>
													<ChevronDown className="size-3" />
												</PromptInputButton>
											</ModelSelectorTrigger>
											<ModelSelectorContent title="选择模型">
												<ModelSelectorInput placeholder="搜索模型…" />
												<ModelSelectorList>
													<ModelSelectorEmpty>没有找到模型</ModelSelectorEmpty>
													{modelsByProvider.map(([provider, models]) => (
														<ModelSelectorGroup heading={provider} key={provider}>
															{models.map((model) => (
																<ModelSelectorItem
																	key={`${model.provider}/${model.id}`}
																	value={`${model.provider} ${model.name} ${model.id}`}
																	onSelect={() => {
																		void actions.updateModel(model.provider, model.id);
																		setModelSelectorOpen(false);
																	}}
																>
																	<ModelSelectorName>
																		{formatModelDisplayName(model)}
																	</ModelSelectorName>
																	{state.session?.model?.provider === model.provider &&
																	state.session.model.id === model.id ? (
																		<Check className="size-4" />
																	) : null}
																</ModelSelectorItem>
															))}
														</ModelSelectorGroup>
													))}
												</ModelSelectorList>
											</ModelSelectorContent>
										</ModelSelector>
										{selectedModel?.reasoning ? (
											<PromptInputSelect
												value={
													state.session?.thinkingLevel === "minimal"
														? "low"
														: (state.session?.thinkingLevel ?? "off")
												}
												onValueChange={actions.updateThinking}
											>
												<PromptInputSelectTrigger
													className="hidden h-8 w-auto border-0 px-2 text-xs shadow-none focus-visible:ring-0 sm:flex"
													aria-label="思考强度"
												>
													<PromptInputSelectValue />
												</PromptInputSelectTrigger>
												<PromptInputSelectContent>
													{thinkingLevels.map((level) => (
														<PromptInputSelectItem key={level} value={level}>
															{THINKING_LEVEL_LABELS[level] ?? level}
														</PromptInputSelectItem>
													))}
												</PromptInputSelectContent>
											</PromptInputSelect>
										) : null}
										<PromptInputSubmit
											className="size-10 rounded-full bg-foreground text-background hover:bg-foreground/90"
											status={stopping ? "streaming" : "ready"}
											onStop={stopping ? () => void actions.abort() : undefined}
											disabled={disabled || (!stopping && !state.sessionId)}
											aria-label={stopping ? "停止" : "发送"}
										>
											{stopping ? (
												<Square className="size-4 fill-current" />
											) : (
												<ArrowUp className="size-5" />
											)}
										</PromptInputSubmit>
									</PromptInputTools>
								</PromptInputFooter>
							</PromptInput>
						</div>
					</PromptCompletionProvider>
				</PromptInputProvider>
			</div>
		</div>
	);
}

function ImageUploadButton({ disabled }: { disabled: boolean }) {
	const attachments = usePromptInputAttachments();
	return (
		<PromptInputButton
			className="size-9"
			disabled={disabled}
			onClick={attachments.openFileDialog}
			aria-label="上传图片"
		>
			<Plus className="size-5" />
		</PromptInputButton>
	);
}

function formatContextTokens(tokens: number): string {
	if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, "")}m`;
	if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`;
	return `${tokens}`;
}

function ContextRing({ contextWindow, usedTokens }: { contextWindow: number; usedTokens: number }) {
	const radius = 8;
	const circumference = 2 * Math.PI * radius;
	const usage = contextWindow > 0 ? Math.min(1, Math.max(0, usedTokens / contextWindow)) : 0;
	const percent = Math.round(usage * 100);

	return (
		<HoverCard openDelay={0} closeDelay={0}>
			<HoverCardTrigger asChild>
				<button
					type="button"
					className="inline-flex size-8 cursor-pointer items-center justify-center rounded-full text-muted-foreground outline-none"
					aria-label={`上下文使用率 ${percent}%`}
				>
					<svg
						className="size-5"
						viewBox="0 0 24 24"
						role="img"
						aria-label={`上下文使用率 ${percent}%`}
					>
						<circle cx="12" cy="12" r={radius} fill="none" stroke="currentColor" strokeWidth="2" opacity="0.25" />
						<circle
							cx="12"
							cy="12"
							r={radius}
							fill="none"
							stroke="currentColor"
							strokeDasharray={`${circumference} ${circumference}`}
							strokeDashoffset={circumference * (1 - usage)}
							strokeLinecap="round"
							strokeWidth="2"
							style={{ transform: "rotate(-90deg)", transformOrigin: "center" }}
						/>
					</svg>
				</button>
			</HoverCardTrigger>
			<HoverCardContent
				side="top"
				align="center"
				sideOffset={4}
				className="w-max max-w-[calc(100vw-1rem)] rounded-xl border-border bg-background px-4 py-3 text-center text-sm shadow-[0_2px_8px_rgb(0_0_0/0.05)]"
			>
				<div className="grid gap-2 whitespace-nowrap">
					<div className="text-muted-foreground">背景信息窗口：</div>
					<div className="text-muted-foreground">{percent}% 已用</div>
					<div className="font-medium text-foreground">
						已用 {formatContextTokens(usedTokens)} 标记，共 {formatContextTokens(contextWindow)}
					</div>
				</div>
			</HoverCardContent>
		</HoverCard>
	);
}

function ComposerAttachments() {
	const attachments = usePromptInputAttachments();
	if (!attachments.files.length) return null;
	return (
		<Attachments variant="inline">
			{attachments.files.map((file) => (
				<Attachment key={file.id} data={file} onRemove={() => attachments.remove(file.id)}>
					<AttachmentPreview />
					<AttachmentInfo />
					<AttachmentRemove label="移除附件" />
				</Attachment>
			))}
		</Attachments>
	);
}

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

function InspectorPanel({
	state,
	actions,
	floating = false,
}: {
	state: WorkbenchState;
	actions: WorkbenchActions;
	floating?: boolean;
}) {
	return (
		<div
			className={cn(
				"flex h-full min-h-0 flex-col overflow-hidden bg-background",
				floating && "inspector-panel rounded-[28px] border border-border/70 shadow-[0_12px_36px_rgb(0_0_0/0.06)]",
			)}
		>
			<div className="flex shrink-0 items-start justify-between gap-3 border-b border-border/60 px-5 py-4">
				<div className="min-w-0">
					<h2 className="truncate text-base font-semibold">审阅工作区</h2>
					<p className="mt-1 truncate text-xs text-muted-foreground">运行、文件、会话树和 Git 改动</p>
				</div>
				<Button size="icon" variant="ghost" onClick={actions.closeInspector} aria-label="关闭审阅工作区">
					<X className="size-4" />
				</Button>
			</div>
			<Tabs
				value={state.inspectorMode}
				onValueChange={(value) => void actions.openInspector(value as InspectorMode)}
				className="min-h-0 flex-1 gap-0"
			>
				<TabsList className="mx-4 mt-3 grid h-10 w-auto grid-cols-4 gap-1 rounded-none border-0 bg-transparent p-0">
					<TabsTrigger
						className="h-9 rounded-xl border-0 px-2 text-xs font-medium text-muted-foreground after:hidden data-[state=active]:bg-accent data-[state=active]:text-foreground data-[state=active]:shadow-none"
						value="runs"
					>
						<Zap className="size-3.5" />
						运行
					</TabsTrigger>
					<TabsTrigger
						className="h-9 rounded-xl border-0 px-2 text-xs font-medium text-muted-foreground after:hidden data-[state=active]:bg-accent data-[state=active]:text-foreground data-[state=active]:shadow-none"
						value="files"
					>
						<FolderOpen className="size-3.5" />
						文件
					</TabsTrigger>
					<TabsTrigger
						className="h-9 rounded-xl border-0 px-2 text-xs font-medium text-muted-foreground after:hidden data-[state=active]:bg-accent data-[state=active]:text-foreground data-[state=active]:shadow-none"
						value="tree"
					>
						<TreePine className="size-3.5" />
						会话树
					</TabsTrigger>
					<TabsTrigger
						className="h-9 rounded-xl border-0 px-2 text-xs font-medium text-muted-foreground after:hidden data-[state=active]:bg-accent data-[state=active]:text-foreground data-[state=active]:shadow-none"
						value="git"
					>
						<GitBranch className="size-3.5" />
						Git
					</TabsTrigger>
				</TabsList>
				<TabsContent className="min-h-0 flex-1 overflow-hidden" value="runs">
					<ScrollArea className="h-full">
						<RunPanel state={state} actions={actions} />
					</ScrollArea>
				</TabsContent>
				<TabsContent className="min-h-0 flex-1 overflow-hidden" value="files">
					<ScrollArea className="h-full">
						<FilesPanel state={state} actions={actions} />
					</ScrollArea>
				</TabsContent>
				<TabsContent className="min-h-0 flex-1 overflow-hidden" value="tree">
					<ScrollArea className="h-full">
						<SessionTreePanel state={state} actions={actions} />
					</ScrollArea>
				</TabsContent>
				<TabsContent className="min-h-0 flex-1 overflow-hidden" value="git">
					<ScrollArea className="h-full">
						<GitPanel state={state} actions={actions} />
					</ScrollArea>
				</TabsContent>
			</Tabs>
		</div>
	);
}

function InspectorDialog({ state, actions }: { state: WorkbenchState; actions: WorkbenchActions }) {
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

function RunPanel({ state, actions }: { state: WorkbenchState; actions: WorkbenchActions }) {
	const operations = state.operations
		.filter((operation) => !operation.sessionId || operation.sessionId === state.sessionId)
		.sort((a, b) => b.updatedAt - a.updatedAt);
	return (
		<div className="grid gap-4 p-4">
			<Task defaultOpen>
				<TaskTrigger title="实时运行" />
				<TaskContent>
					{state.currentOperation ? (
						<OperationCard operation={state.currentOperation} />
					) : (
						<TaskItem>当前没有运行中的任务</TaskItem>
					)}
				</TaskContent>
			</Task>
			<div className="flex items-center justify-between text-xs font-medium text-muted-foreground">
				<span>任务记录</span>
				<span>{operations.length}</span>
			</div>
			{operations.length ? (
				<div className="grid gap-2">
					{operations.slice(0, 20).map((operation) => (
						<OperationCard key={operation.operationId} operation={operation} />
					))}
				</div>
			) : (
				<Card>
					<CardContent className="py-6 text-center text-sm text-muted-foreground">还没有任务记录</CardContent>
				</Card>
			)}
			<div className="grid grid-cols-2 gap-2">
				<Button
					variant="outline"
					onClick={() => void actions.compact()}
					disabled={
						state.readOnly ||
						Boolean(state.currentOperation && ACTIVE_OPERATION_STATUSES.has(state.currentOperation.status))
					}
				>
					<ArrowDownToLine className="size-4" />
					整理上下文
				</Button>
				<Button variant="outline" onClick={() => void actions.exportSession()} disabled={state.readOnly}>
					<Download className="size-4" />
					导出会话
				</Button>
			</div>
		</div>
	);
}

function OperationCard({ operation }: { operation: WebOperation }) {
	const labels: Record<string, string> = {
		prompt: "对话",
		steer: "引导",
		follow_up: "后续消息",
		compact: "整理上下文",
		run_bash: "运行命令",
		login_model_provider: "Provider 登录",
	};
	const status = operationStatusLabel(operation.status);
	const updatedAt = new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" }).format(
		operation.updatedAt,
	);
	return (
		<Card className="py-0 shadow-none">
			<CardHeader className="gap-1.5 p-3">
				<div className="flex min-w-0 items-center justify-between gap-2">
					<CardTitle className="min-w-0 truncate text-sm">{labels[operation.type] ?? "其他任务"}</CardTitle>
					<Badge
						className="h-6 shrink-0 px-2 text-xs"
						variant={operation.status === "failed" ? "destructive" : "secondary"}
					>
						{status}
					</Badge>
				</div>
				<CardDescription className="text-xs">{updatedAt}</CardDescription>
				{operation.error ? (
					<CardDescription className="truncate text-xs text-destructive" title={operation.error}>
						{operation.error}
					</CardDescription>
				) : null}
			</CardHeader>
		</Card>
	);
}

function operationStatusLabel(status: string): string {
	return status === "running"
		? "执行中"
		: status === "accepted"
			? "已接收"
			: status === "completed"
				? "已完成"
				: status === "failed"
					? "失败"
					: status === "aborted"
						? "已停止"
						: status;
}

function FilesPanel({ state, actions }: { state: WorkbenchState; actions: WorkbenchActions }) {
	const tree = state.fileTree;
	const entries = tree?.entries ?? [];
	const cachedTrees = state.fileTreeCache;

	const findEntry = (path: string, items: readonly ProjectTreeEntry[]): ProjectTreeEntry | undefined => {
		for (const entry of items) {
			if (entry.path === path) return entry;
			if (entry.kind === "directory") {
				const childTree = cachedTrees[entry.path];
				const childEntry = childTree ? findEntry(path, childTree.entries) : undefined;
				if (childEntry) return childEntry;
			}
		}
		return undefined;
	};

	const renderEntries = (items: readonly ProjectTreeEntry[]): ReactNode =>
		items.map((entry) =>
			entry.kind === "directory" ? (
				<FileTreeFolder
					key={entry.path}
					path={entry.path}
					name={entry.name}
					onToggle={(path, expanded) => {
						if (expanded && !cachedTrees[path]) void actions.loadProjectTree(path, true);
					}}
				>
					{cachedTrees[entry.path] ? renderEntries(cachedTrees[entry.path].entries) : null}
				</FileTreeFolder>
			) : (
				<FileTreeFile
					key={entry.path}
					path={entry.path}
					name={entry.name}
					icon={<FileTypeIcon path={entry.path} />}
				/>
			),
		);

	return (
		<div className="grid gap-4 p-4">
			<div className="flex items-start justify-between gap-3">
				<div>
					<h2 className="font-semibold">项目文件</h2>
					<p className="mt-1 truncate text-xs text-muted-foreground">{tree?.path || "项目根目录"}</p>
				</div>
				<Button
					size="icon"
					variant="ghost"
					onClick={() => void actions.loadProjectTree(tree?.path)}
					aria-label="刷新文件树"
				>
					<RefreshCw className={cn("size-4", state.fileTreeLoading && "animate-spin")} />
				</Button>
			</div>
			<div className="flex gap-2">
				<Button size="sm" variant="outline" onClick={() => void actions.loadProjectTree("")}>
					<HardDrive className="size-4" />
					根目录
				</Button>
				{tree?.parent !== undefined ? (
					<Button size="sm" variant="outline" onClick={() => void actions.loadProjectTree(tree.parent)}>
						<ArrowLeft className="size-4" />
						上一级
					</Button>
				) : null}
			</div>
			{tree ? (
				<FileTree
					selectedPath={state.filePath}
					onSelect={(path) => {
						const entry = findEntry(path, entries);
						if (entry?.kind === "file") void actions.openFile(entry.path);
					}}
				>
					{renderEntries(entries)}
				</FileTree>
			) : (
				<Card>
					<CardContent className="py-8 text-center">
						<Button variant="outline" onClick={() => void actions.loadProjectTree()}>
							<FolderOpen className="size-4" />
							加载文件树
						</Button>
					</CardContent>
				</Card>
			)}
		</div>
	);
}

function FileTypeIcon({ path }: { path: string }) {
	const fileName = path.split(/[\\/]/u).at(-1)?.toLowerCase() ?? "";
	const extension = fileName.split(".").at(-1) ?? "";
	const Icon = ["avif", "gif", "jpeg", "jpg", "png", "svg", "webp"].includes(extension)
		? ImageIcon
		: extension === "md" || extension === "mdx"
			? FileText
			: extension === "json"
				? FileJson
				: ["css", "go", "java", "js", "jsx", "py", "rs", "sql", "ts", "tsx", "vue", "yaml", "yml"].includes(
							extension,
						)
					? FileCode2
					: FileText;
	return <Icon className="size-4 shrink-0 text-muted-foreground" />;
}

function FilePreviewDialog({ state, actions }: { state: WorkbenchState; actions: WorkbenchActions }) {
	const open = Boolean(state.fileLoading || state.fileContent);
	return (
		<Dialog
			open={open}
			onOpenChange={(nextOpen) => {
				if (!nextOpen) actions.closeFilePreview();
			}}
		>
			<DialogContent className="flex h-[min(88vh,900px)] w-[min(94vw,1200px)] max-w-none flex-col gap-0 overflow-hidden p-0 sm:max-w-[min(94vw,1200px)]">
				<DialogHeader className="shrink-0 border-b border-border/60 px-5 py-4 text-left">
					<DialogTitle className="flex min-w-0 items-center gap-2 pr-8 text-sm">
						<FileTypeIcon path={state.filePath ?? ""} />
						<span className="min-w-0 truncate font-mono">{state.filePath || "文件预览"}</span>
					</DialogTitle>
					{state.fileLoading || state.fileContent?.kind === "image" ? (
						<DialogDescription>{state.fileLoading ? "正在读取文件…" : "图片预览"}</DialogDescription>
					) : null}
				</DialogHeader>
				<div className="min-h-0 flex-1 overflow-auto bg-background p-4 sm:p-6">
					{state.fileLoading ? (
						<div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
							<LoaderCircle className="size-4 animate-spin" />
							正在读取文件
						</div>
					) : state.fileContent?.kind === "image" && state.fileContent.data ? (
						<div className="flex h-full items-center justify-center overflow-auto rounded-xl bg-muted/20 p-4">
							<img
								className="max-h-full max-w-full object-contain"
								src={`data:${state.fileContent.mimeType};base64,${state.fileContent.data}`}
								alt={state.fileContent.path}
							/>
						</div>
					) : state.fileContent ? (
						<CodeBlockView
							code={state.fileContent.content ?? ""}
							language={languageForPath(state.fileContent.path)}
							embedded
							wrap
						/>
					) : null}
				</div>
			</DialogContent>
		</Dialog>
	);
}

function languageForPath(path: string): string {
	const extension = path.split(".").at(-1)?.toLowerCase();
	return extension === "ts" || extension === "tsx"
		? "typescript"
		: extension === "js" || extension === "jsx"
			? "javascript"
			: extension === "json"
				? "json"
				: extension === "css"
					? "css"
					: extension === "md"
						? "markdown"
						: extension === "sh"
							? "bash"
							: "text";
}

function SessionTreePanel({ state, actions }: { state: WorkbenchState; actions: WorkbenchActions }) {
	return (
		<div className="grid gap-4 p-4">
			<div className="flex items-start justify-between gap-3">
				<div>
					<h2 className="font-semibold">会话树</h2>
					<p className="mt-1 text-xs text-muted-foreground">从父级消息回到另一个上下文分支。</p>
				</div>
				<Button size="icon" variant="ghost" onClick={() => void actions.loadSessionTree()} aria-label="刷新会话树">
					<RefreshCw className={cn("size-4", state.sessionTreeLoading && "animate-spin")} />
				</Button>
			</div>
			<Task defaultOpen>
				<TaskTrigger title="上下文分支" />
				<TaskContent>
					{state.sessionTree.length ? (
						state.sessionTree.map((node) => (
							<Button
								key={node.id}
								className="w-full justify-start gap-2 text-left"
								variant={node.isLeaf ? "secondary" : "ghost"}
								style={{ paddingLeft: `${12 + node.depth * 14}px` }}
								onClick={() => void actions.navigateTree(node.id)}
							>
								<span className="size-2 shrink-0 rounded-full border border-primary" />
								<span className="min-w-0 flex-1 truncate">{node.label || node.preview || node.kind}</span>
								{node.isLeaf ? <Badge variant="outline">当前</Badge> : null}
							</Button>
						))
					) : (
						<TaskItem>还没有会话树记录</TaskItem>
					)}
				</TaskContent>
			</Task>
		</div>
	);
}

function GitPanel({ state, actions }: { state: WorkbenchState; actions: WorkbenchActions }) {
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

function SettingsDialog({ state, actions }: { state: WorkbenchState; actions: WorkbenchActions }) {
	const [query, setQuery] = useState("");
	const settingItems: Array<{ value: SettingsTab; label: string; icon: ReactNode; section: string }> = [
		{ value: "appearance", label: "外观", icon: <SunMoon className="size-4" />, section: "个人" },
		{ value: "instructions", label: "全局提示词", icon: <BookOpen className="size-4" />, section: "个人" },
		{ value: "models", label: "模型与认证", icon: <Bot className="size-4" />, section: "工作区" },
		{ value: "skills", label: "技能", icon: <WandSparkles className="size-4" />, section: "工作区" },
		{ value: "diagnostics", label: "诊断", icon: <CircleHelp className="size-4" />, section: "工作区" },
		{ value: "about", label: "关于", icon: <Sparkles className="size-4" />, section: "其他" },
	];
	const visibleItems = settingItems.filter((item) => item.label.toLowerCase().includes(query.toLowerCase()));
	const currentLabel = settingItems.find((item) => item.value === state.settingsTab)?.label ?? "设置";
	return (
		<Dialog
			open={state.settingsOpen}
			onOpenChange={(open) => {
				if (!open) actions.closeSettings();
			}}
		>
			<DialogContent className="inset-0 h-dvh w-screen max-w-none translate-x-0 translate-y-0 rounded-none border-0 bg-background p-0 sm:max-w-none">
				<DialogHeader className="sr-only">
					<DialogTitle>设置</DialogTitle>
					<DialogDescription>工作台外观、模型、诊断和版本信息</DialogDescription>
				</DialogHeader>
				<Tabs
					value={state.settingsTab}
					onValueChange={(value) => void actions.openSettings(value as SettingsTab)}
					orientation="vertical"
					className="flex h-full min-h-0 flex-col sm:flex-row"
				>
					<aside className="flex w-full shrink-0 flex-col border-b border-border/60 bg-background sm:w-[var(--sidebar-width)] sm:border-r sm:border-b-0">
						<div className="flex h-16 shrink-0 items-center px-5">
							<Button
								className="justify-start gap-2 px-0 text-base font-medium"
								variant="ghost"
								onClick={actions.closeSettings}
							>
								<ArrowLeft className="size-5" />
								返回工作台
							</Button>
						</div>
						<div className="px-5 pb-5">
							<div className="relative">
								<Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
								<Input
									value={query}
									onChange={(event) => setQuery(event.target.value)}
									placeholder="搜索设置"
									aria-label="搜索设置"
									className="h-10 rounded-xl border-0 bg-muted/60 pl-9 shadow-none focus-visible:ring-0"
								/>
							</div>
						</div>
						<TabsList
							className="min-h-0 w-full flex-1 items-stretch justify-start gap-1 overflow-auto px-3 pb-5 sm:flex"
							variant="line"
						>
							{["个人", "工作区", "其他"].map((section) => {
								const items = visibleItems.filter((item) => item.section === section);
								if (!items.length) return null;
								return (
									<div className="grid w-full gap-1" key={section}>
										<p className="px-3 pb-2 pt-4 text-xs font-medium text-muted-foreground">{section}</p>
										{items.map((item) => (
											<TabsTrigger
												className="h-10 w-full justify-start gap-3 px-3 text-sm after:hidden data-[state=active]:bg-accent data-[state=active]:text-foreground"
												key={item.value}
												value={item.value}
											>
												{item.icon}
												{item.label}
											</TabsTrigger>
										))}
									</div>
								);
							})}
						</TabsList>
					</aside>
					<section className="min-w-0 flex-1 overflow-auto">
						<div className="mx-auto max-w-[1120px] p-7 sm:p-12 lg:p-16">
							<div className="mb-12">
								<h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">{currentLabel}</h1>
								<p className="mt-3 max-w-2xl text-base leading-7 text-muted-foreground">
									{state.settingsTab === "instructions"
										? "为所有项目的任务提供说明和上下文。"
										: state.settingsTab === "skills"
											? "查看和管理当前项目可用的 Skill。"
											: "配置工作台的外观、模型连接和运行信息。"}
								</p>
							</div>
							<TabsContent className="m-0" value="appearance">
								<AppearanceSettings state={state} actions={actions} />
							</TabsContent>
							<TabsContent className="m-0" value="instructions">
								<GlobalInstructionsSettings state={state} actions={actions} />
							</TabsContent>
							<TabsContent className="m-0" value="skills">
								<SkillsSettings state={state} actions={actions} />
							</TabsContent>
							<TabsContent className="m-0" value="diagnostics">
								<DiagnosticsSettings state={state} />
							</TabsContent>
							<TabsContent className="m-0" value="about">
								<AboutSettings state={state} />
							</TabsContent>
						</div>
					</section>
				</Tabs>
			</DialogContent>
		</Dialog>
	);
}

function GlobalInstructionsSettings({ state, actions }: { state: WorkbenchState; actions: WorkbenchActions }) {
	const file = state.hostInstructions.find((candidate) => candidate.fileName === "AGENTS.md");
	const [content, setContent] = useState("");

	useEffect(() => {
		setContent(file?.content ?? "");
	}, [state.hostInstructions]);

	const dirty = content !== (file?.content ?? "");
	const save = () => void actions.saveHostInstruction(content, file?.contentHash);

	return (
		<div className="grid gap-6">
			<SettingSection title="全局提示词">
				<Card className="shadow-none">
					<CardHeader className="gap-2">
						<div className="flex items-center justify-between gap-3">
							<div className="min-w-0">
								<CardTitle className="text-base">AGENTS.md</CardTitle>
								<CardDescription>为所有项目的任务提供说明和上下文。</CardDescription>
							</div>
							<Badge variant={file?.active ? "secondary" : "outline"}>{file?.active ? "生效中" : "未创建"}</Badge>
						</div>
					</CardHeader>
					<CardContent className="grid gap-3">
						{state.hostInstructionsLoading ? (
							<div className="flex min-h-72 items-center justify-center gap-2 text-sm text-muted-foreground" role="status">
								<LoaderCircle className="size-4 animate-spin" />正在读取 AGENTS.md
							</div>
						) : (
							<Textarea
								aria-label="全局 AGENTS.md 内容"
								className="min-h-72 resize-y font-mono text-sm leading-6"
								value={content}
								disabled={state.hostInstructionSaving}
								spellCheck={false}
								onChange={(event) => setContent(event.target.value)}
								placeholder="添加全局说明…"
							/>
						)}
						{state.hostInstructionsError ? (
							<Alert variant="destructive">
								<AlertTitle>操作失败</AlertTitle>
								<AlertDescription>{state.hostInstructionsError}</AlertDescription>
							</Alert>
						) : null}
						<div className="flex flex-wrap items-center justify-end gap-2">
							<Button variant="outline" onClick={() => void actions.refreshHostInstructions()} disabled={state.hostInstructionsLoading || state.hostInstructionSaving}>
								<RefreshCw className="size-4" />重新加载
							</Button>
							<Button onClick={save} disabled={!dirty || state.hostInstructionsLoading || state.hostInstructionSaving}>
								{state.hostInstructionSaving ? <LoaderCircle className="size-4 animate-spin" /> : <Save className="size-4" />}
								{state.hostInstructionSaving ? "正在保存" : file?.exists ? "保存" : "创建"}
							</Button>
						</div>
					</CardContent>
				</Card>
			</SettingSection>
		</div>
	);
}

function SkillsSettings({ state, actions }: { state: WorkbenchState; actions: WorkbenchActions }) {
	const [query, setQuery] = useState("");
	const [scope, setScope] = useState<"all" | "user" | "project">("all");
	const currentProject = state.projects.find((project) => project.id === state.currentProjectId);
	const visibleSkills = state.skills
		.filter((skill) => scope === "all" || skill.scope === scope)
		.filter((skill) => `${skill.name} ${skill.description}`.toLowerCase().includes(query.trim().toLowerCase()));
	const counts = {
		all: state.skills.length,
		user: state.skills.filter((skill) => skill.scope === "user").length,
		project: state.skills.filter((skill) => skill.scope === "project").length,
	};
	const scopeLabel = (value: "user" | "project" | "temporary") =>
		value === "user" ? "个人" : value === "project" ? "项目" : "临时";

	return (
		<div className="grid gap-6">
			<SettingSection title="技能">
				<div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
					<div className="flex flex-wrap gap-1 rounded-lg bg-muted/60 p-1">
						{(["all", "user", "project"] as const).map((value) => (
							<Button key={value} size="sm" variant={scope === value ? "secondary" : "ghost"} onClick={() => setScope(value)}>
								{value === "all" ? "全部" : value === "user" ? "个人" : "项目"} {counts[value]}
							</Button>
						))}
					</div>
					<div className="flex items-center gap-2">
						<div className="relative w-full sm:w-64">
							<Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
							<Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索技能" aria-label="搜索技能" className="pl-9" />
						</div>
						<Button variant="outline" size="icon" onClick={() => void actions.refreshSkills()} disabled={state.skillsLoading} aria-label="重新加载技能" title="重新加载技能">
							<RefreshCw className={cn("size-4", state.skillsLoading && "animate-spin")} />
						</Button>
					</div>
				</div>
				{!currentProject ? (
					<Card className="shadow-none">
						<CardContent className="py-10 text-center text-sm text-muted-foreground">请先选择一个项目，再查看该项目可用的 Skill。</CardContent>
					</Card>
				) : state.skillsLoading ? (
					<Card className="shadow-none">
						<CardContent className="flex min-h-48 items-center justify-center gap-2 text-sm text-muted-foreground" role="status">
							<LoaderCircle className="size-4 animate-spin" />正在读取技能
						</CardContent>
					</Card>
				) : state.skillsError ? (
					<Alert variant="destructive">
						<AlertTitle>技能读取失败</AlertTitle>
						<AlertDescription>{state.skillsError}</AlertDescription>
					</Alert>
				) : (
					<Card className="shadow-none">
						<CardContent className="p-0">
							{visibleSkills.length ? visibleSkills.map((skill) => {
								const updating = state.skillUpdatingPath === skill.path;
								const editable = skill.scope !== "temporary";
								return (
									<div className="flex items-center gap-3 border-b px-4 py-4 last:border-b-0 sm:gap-4 sm:px-5" key={`${skill.scope}:${skill.path}`}>
										<div className="grid size-10 shrink-0 place-items-center rounded-full border bg-muted/30 text-muted-foreground">
											<WandSparkles className="size-4" />
										</div>
										<div className="min-w-0 flex-1">
											<div className="flex min-w-0 items-center gap-2">
												<strong className="truncate text-sm font-medium">{skill.name}</strong>
												<Badge variant="outline" className="shrink-0">{scopeLabel(skill.scope)}</Badge>
											</div>
											<p className="mt-1 line-clamp-2 text-sm leading-5 text-muted-foreground" title={skill.description}>{skill.description || "暂无描述"}</p>
										</div>
										<Switch checked={skill.enabled} disabled={!editable || updating} onCheckedChange={() => void actions.toggleSkill(skill)} aria-label={`${skill.enabled ? "停用" : "启用"} ${skill.name}`} />
									</div>
								);
							}) : (
								<div className="py-10 text-center text-sm text-muted-foreground">没有找到匹配的 Skill。</div>
							)}
						</CardContent>
					</Card>
				)}
				{Array.isArray(state.skillDiagnostics) && state.skillDiagnostics.length > 0 ? (
					<Alert>
						<AlertTitle>发现 {state.skillDiagnostics.length} 条加载诊断</AlertTitle>
						<AlertDescription>部分 Skill 可能无法加载，请检查 Skill 文件和配置。</AlertDescription>
					</Alert>
				) : null}
			</SettingSection>
		</div>
	);
}

function AppearanceSettings({ state, actions }: { state: WorkbenchState; actions: WorkbenchActions }) {
	return (
		<div className="grid gap-6">
			<SettingSection title="主题">
				<div className="grid gap-2 sm:grid-cols-3">
					{(["system", "light", "dark"] as ThemeMode[]).map((theme) => (
						<Button
							key={theme}
							className="h-auto justify-between p-3"
							variant={state.theme === theme ? "secondary" : "outline"}
							onClick={() => actions.setTheme(theme)}
						>
							<span className="flex items-center gap-2">
								{theme === "light" ? <Sun className="size-4" /> : <SunMoon className="size-4" />}
								{theme === "system" ? "跟随系统" : theme === "light" ? "浅色" : "深色"}
							</span>
							{state.theme === theme ? <Check className="size-4" /> : null}
						</Button>
					))}
				</div>
			</SettingSection>
		</div>
	);
}

type ProviderDraft = {
	isNew: boolean;
	provider: string;
	name: string;
	baseUrl: string;
	api: string;
	apiKey: string;
	catalogProvider: string;
};

type ModelDraft = {
	isNew: boolean;
	provider: string;
	id: string;
	name: string;
	api: string;
	baseUrl: string;
	reasoning: boolean;
	manualThinking: boolean;
	thinkingLevelMap: Record<string, string | null>;
	input: ("text" | "image")[];
	contextWindow: string;
	maxTokens: string;
};

const MODEL_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"] as const;

const PROVIDER_ICON_IDS: Record<string, string> = {
	"amazon-bedrock": "bedrock",
	anthropic: "anthropic",
	"ant-ling": "antgroup",
	"azure-openai-responses": "azure",
	baseten: "baseten",
	cerebras: "cerebras",
	"cloudflare-ai-gateway": "cloudflare",
	"cloudflare-workers-ai": "workersai",
	deepseek: "deepseek",
	fireworks: "fireworks",
	"github-copilot": "githubcopilot",
	google: "google",
	"google-vertex": "vertexai",
	groq: "groq",
	huggingface: "huggingface",
	"kimi-coding": "kimi",
	minimax: "minimax",
	"minimax-cn": "minimax",
	mistral: "mistral",
	moonshotai: "moonshot",
	"moonshotai-cn": "moonshot",
	nvidia: "nvidia",
	openai: "openai",
	"openai-codex": "openai",
	opencode: "opencode",
	"opencode-go": "opencode",
	openrouter: "openrouter",
	together: "together",
	"vercel-ai-gateway": "vercel",
	xai: "xai",
	xiaomi: "xiaomimimo",
	zai: "zai",
	"zai-coding-cn": "zai",
};

function providerIconId(providerId: string) {
	const normalized = providerId.toLowerCase();
	if (PROVIDER_ICON_IDS[normalized]) return PROVIDER_ICON_IDS[normalized];
	if (normalized.startsWith("qwen")) return "qwen";
	if (normalized.startsWith("xiaomi")) return "xiaomimimo";
	if (normalized.startsWith("moonshot")) return "moonshot";
	if (normalized.startsWith("zai")) return "zai";
	return "llmapi";
}

function modelIconId(providerId: string, modelId: string, name: string) {
	const value = `${providerId} ${modelId} ${name}`.toLowerCase();
	if (/\bclaude\b/iu.test(value)) return "claude";
	if (/\bgemini\b/iu.test(value)) return "gemini";
	if (/\bgemma\b/iu.test(value)) return "gemma";
	if (/\bdeepseek\b/iu.test(value)) return "deepseek";
	if (/\bqwen\b/iu.test(value)) return "qwen";
	if (/\bkimi\b/iu.test(value)) return "kimi";
	if (/\bmistral\b/iu.test(value)) return "mistral";
	if (/\bminimax\b/iu.test(value)) return "minimax";
	if (/\bmoonshot\b/iu.test(value)) return "moonshot";
	if (/\b(chatglm|glm)\b/iu.test(value)) return "chatglm";
	if (/\byi\b/iu.test(value)) return "yi";
	if (/\bnova\b/iu.test(value)) return "nova";
	if (/\b(gpt|openai|o[1-9]\d*)\b/iu.test(value)) return "openai";
	return undefined;
}

function formatModelDisplayName(model: { id: string; name?: string } | undefined): string {
	if (!model) return "未选择模型";
	const raw = model.name?.trim() || model.id;
	const normalized = raw.replace(/(\d+)-(\d+)/gu, "$1.$2").replace(/[-_/]+/gu, " ");
	return normalized
		.split(/\s+/u)
		.filter(Boolean)
		.map((token) => {
			if (/^gpt$/iu.test(token)) return "GPT";
			if (/^o\d+[a-z]*$/iu.test(token)) return token.toUpperCase();
			if (/^\d+[a-z]+$/iu.test(token)) return token.toUpperCase();
			return token.charAt(0).toUpperCase() + token.slice(1).toLowerCase();
		})
		.join(" ");
}

function ModelBrandIcon({
	providerId,
	modelId,
	name,
	small = false,
}: {
	providerId: string;
	modelId: string;
	name: string;
	small?: boolean;
}) {
	const iconId = modelIconId(providerId, modelId, name);
	const src = iconId ? `/brand/models/${iconId}.svg` : `/brand/providers/${providerIconId(providerId)}.svg`;
	return (
		<span
			className={cn(
				"inline-flex shrink-0 items-center justify-center rounded-md border border-border bg-background",
				small ? "size-9" : "size-9",
			)}
			aria-hidden="true"
		>
			<img src={src} className={cn("object-contain dark:invert", small ? "size-6" : "size-5")} alt="" />
		</span>
	);
}

function MonochromeProviderIcon({ providerId, small = false }: { providerId: string; small?: boolean }) {
	return (
		<span
			className={cn(
				"inline-flex shrink-0 items-center justify-center rounded-md border border-border bg-background",
				small ? "size-7" : "size-9",
			)}
			aria-hidden="true"
		>
			<img
				src={`/brand/providers/${providerIconId(providerId)}.svg`}
				className={cn("object-contain dark:invert", small ? "size-4" : "size-5")}
				alt=""
			/>
		</span>
	);
}

function ModelSettings({ state, actions }: { state: WorkbenchState; actions: WorkbenchActions }) {
	const [selectedProvider, setSelectedProvider] = useState("");
	const [providerDraft, setProviderDraft] = useState<ProviderDraft | null>(null);
	const [modelDraft, setModelDraft] = useState<ModelDraft | null>(null);
	const [submitting, setSubmitting] = useState(false);
	const [syncingProvider, setSyncingProvider] = useState<string | null>(null);
	const [providerTab, setProviderTab] = useState<"custom" | "builtin">("custom");
	const [modelListProviderId, setModelListProviderId] = useState<string | null>(null);
	const orderedProviders = useMemo(
		() =>
			[...state.providers].sort((left, right) => {
				if (left.builtIn !== right.builtIn) return left.builtIn ? 1 : -1;
				return left.name.localeCompare(right.name, "zh-CN");
			}),
		[state.providers],
	);
	const visibleProviders = useMemo(
		() => orderedProviders.filter((provider) => !state.hiddenModelProviders.includes(provider.id)),
		[state.hiddenModelProviders, orderedProviders],
	);
	const customProviders = orderedProviders.filter((provider) => !provider.builtIn);
	const builtinProviders = orderedProviders.filter((provider) => provider.builtIn);
	const providersInTab = providerTab === "custom" ? customProviders : builtinProviders;
	const activeProvider = visibleProviders.some((provider) => provider.id === selectedProvider)
		? selectedProvider
		: visibleProviders[0]?.id || "";
	const currentModel = state.models.find(
		(model) => model.provider === state.session?.model?.provider && model.id === state.session?.model?.id,
	);
	const modelListProvider = modelListProviderId
		? state.providers.find((provider) => provider.id === modelListProviderId)
		: undefined;
	const modelListModels = modelListProviderId
		? state.models.filter((model) => model.provider === modelListProviderId)
		: [];

	useEffect(() => {
		if (providerTab === "custom" && customProviders.length === 0 && builtinProviders.length > 0)
			setProviderTab("builtin");
	}, [builtinProviders.length, customProviders.length, providerTab]);

	useEffect(() => {
		if (selectedProvider && visibleProviders.some((provider) => provider.id === selectedProvider)) return;
		if (visibleProviders[0]?.id) setSelectedProvider(visibleProviders[0].id);
	}, [selectedProvider, visibleProviders]);

	const viewProviderModels = (providerId: string) => {
		setSelectedProvider(providerId);
		setModelListProviderId(providerId);
	};

	const toggleProviderVisibility = (providerId: string, visible: boolean) => {
		actions.setModelProviderVisibility(providerId, visible);
	};

	const openProvider = (provider?: WorkbenchState["providers"][number]) => {
		setProviderDraft({
			isNew: !provider,
			provider: provider?.id ?? "",
			name: provider?.name ?? "",
			baseUrl: provider?.baseUrl ?? "",
			api: provider?.api ?? "openai-completions",
			apiKey: "",
			catalogProvider: provider?.catalogProvider ?? "__none__",
		});
	};

	const openModel = (providerId: string, model?: WorkbenchState["models"][number]) => {
		const provider = state.providers.find((candidate) => candidate.id === providerId);
		setSelectedProvider(providerId);
		setModelDraft({
			isNew: !model,
			provider: providerId,
			id: model?.id ?? "",
			name: model?.name ?? "",
			api: model?.api ?? provider?.api ?? "openai-completions",
			baseUrl: provider?.baseUrl ?? "",
			reasoning: model?.reasoning ?? false,
			manualThinking: Boolean(model?.thinkingLevelMap),
			thinkingLevelMap: { ...(model?.thinkingLevelMap ?? {}) },
			input: (model?.input ?? ["text"]) as ("text" | "image")[],
			contextWindow: model?.capabilitiesPending ? "" : model ? String(model.contextWindow) : "",
			maxTokens: model?.capabilitiesPending ? "" : model ? String(model.maxTokens) : "",
		});
	};

	const submitProvider = async (event: FormEvent) => {
		event.preventDefault();
		if (!providerDraft?.provider.trim() || !providerDraft.baseUrl.trim() || !providerDraft.api.trim()) return;
		setSubmitting(true);
		try {
			await actions.saveModelProvider({
				provider: providerDraft.provider.trim(),
				name: providerDraft.name.trim() || undefined,
				baseUrl: providerDraft.baseUrl.trim(),
				api: providerDraft.api.trim(),
				apiKey: providerDraft.apiKey.trim() || undefined,
				catalogProvider: providerDraft.catalogProvider === "__none__" ? undefined : providerDraft.catalogProvider,
				clearCatalogProvider:
					!providerDraft.isNew && providerDraft.catalogProvider === "__none__" ? true : undefined,
			});
			setSelectedProvider(providerDraft.provider.trim());
			setProviderDraft(null);
		} catch (error) {
			actions.showToast(error instanceof Error ? error.message : String(error));
		} finally {
			setSubmitting(false);
		}
	};

	const submitModel = async (event: FormEvent) => {
		event.preventDefault();
		if (!modelDraft?.provider.trim() || !modelDraft.id.trim() || modelDraft.input.length === 0) return;
		setSubmitting(true);
		try {
			const contextWindow = Number(modelDraft.contextWindow);
			const maxTokens = Number(modelDraft.maxTokens);
			await actions.saveProviderModel(modelDraft.provider, {
				id: modelDraft.id.trim(),
				name: modelDraft.name.trim() || undefined,
				reasoning: modelDraft.reasoning,
				...(modelDraft.isNew
					? { api: modelDraft.api.trim() || undefined, baseUrl: modelDraft.baseUrl.trim() || undefined }
					: {}),
				...(modelDraft.manualThinking ? { thinkingLevelMap: modelDraft.thinkingLevelMap } : {}),
				input: modelDraft.input,
				...(Number.isSafeInteger(contextWindow) && contextWindow > 0 ? { contextWindow } : {}),
				...(Number.isSafeInteger(maxTokens) && maxTokens > 0 ? { maxTokens } : {}),
				...(!modelDraft.manualThinking && !modelDraft.isNew ? { resetOverride: true } : {}),
			});
			setModelDraft(null);
		} catch (error) {
			actions.showToast(error instanceof Error ? error.message : String(error));
		} finally {
			setSubmitting(false);
		}
	};

	const resetModel = async () => {
		if (!modelDraft || modelDraft.isNew) return;
		setSubmitting(true);
		try {
			await actions.saveProviderModel(modelDraft.provider, {
				id: modelDraft.id,
				input: modelDraft.input,
				reasoning: modelDraft.reasoning,
				resetOverride: true,
			});
			setModelDraft(null);
		} catch (error) {
			actions.showToast(error instanceof Error ? error.message : String(error));
		} finally {
			setSubmitting(false);
		}
	};

	const syncProvider = async (providerId: string) => {
		setSyncingProvider(providerId);
		try {
			await actions.syncModelProvider(providerId);
		} catch (error) {
			actions.showToast(error instanceof Error ? error.message : String(error));
		} finally {
			setSyncingProvider(null);
		}
	};

	return (
		<div className="grid gap-6">
			<SettingSection title="当前模型">
				<Card className="!py-1 shadow-none">
					<CardContent className="p-3">
						<div className="flex items-center gap-2">
							<ModelBrandIcon
								providerId={currentModel?.provider ?? state.session?.model?.provider ?? ""}
								modelId={currentModel?.id ?? state.session?.model?.id ?? ""}
								name={currentModel?.name ?? state.session?.model?.id ?? ""}
							/>
							<div className="min-w-0">
								<p className="truncate font-medium">
									{formatModelDisplayName(
										currentModel ?? (state.session?.model ? { id: state.session.model.id } : undefined),
									)}
								</p>
								<p className="text-xs text-muted-foreground">
									思考强度：{THINKING_LEVEL_LABELS[state.session?.thinkingLevel ?? "off"] ?? "关闭"}
								</p>
							</div>
						</div>
						<Tabs
							value={
								state.session?.thinkingLevel === "minimal" ? "low" : (state.session?.thinkingLevel ?? "off")
							}
							onValueChange={(level) => void actions.updateThinking(level)}
							className="mt-3 gap-0"
						>
							<TabsList className="grid h-auto w-full grid-flow-col auto-cols-max items-center justify-start gap-1 overflow-x-auto rounded-none bg-transparent p-0 py-0.5">
								{["off", "low", "medium", "high", "xhigh", "max", "ultra"].map((level) => (
									<TabsTrigger
										className="!h-8 !w-auto !min-w-max !flex-none whitespace-nowrap rounded-xl border-0 !px-3 !text-[13px] !leading-5 font-medium text-muted-foreground after:hidden data-[state=active]:bg-accent data-[state=active]:text-foreground data-[state=active]:shadow-none"
										style={{ fontSize: "13px", lineHeight: "20px" }}
										key={level}
										value={level}
										disabled={!state.sessionId || !state.connected}
									>
										{THINKING_LEVEL_LABELS[level] ?? level}
									</TabsTrigger>
								))}
							</TabsList>
						</Tabs>
					</CardContent>
				</Card>
			</SettingSection>

			<SettingSection title="模型供应商">
				<div className="flex items-center justify-between gap-3">
					<p className="text-sm text-muted-foreground">管理供应商、目录来源和在模型选择器中的显示状态。</p>
					<Button size="sm" onClick={() => openProvider()}>
						<Plus className="size-4" />
						新增 Provider
					</Button>
				</div>
				{state.modelSettingsError ? (
					<Alert variant="destructive">
						<AlertTitle>模型配置读取失败</AlertTitle>
						<AlertDescription>{state.modelSettingsError}</AlertDescription>
					</Alert>
				) : null}
				{state.modelSettingsLoading ? (
					<div className="flex items-center gap-2 text-sm text-muted-foreground">
						<LoaderCircle className="size-4 animate-spin" />
						正在读取模型配置
					</div>
				) : null}
				<Tabs
					value={providerTab}
					onValueChange={(value) => setProviderTab(value as "custom" | "builtin")}
					className="gap-2"
				>
					<TabsList className="!flex-row h-9 w-fit flex-nowrap">
						<TabsTrigger value="custom">
							自定义<span className="ml-1 text-xs text-muted-foreground">{customProviders.length}</span>
						</TabsTrigger>
						<TabsTrigger value="builtin">
							内置<span className="ml-1 text-xs text-muted-foreground">{builtinProviders.length}</span>
						</TabsTrigger>
					</TabsList>
					{providersInTab.length ? (
						<div className="grid gap-1">
							{providersInTab.map((provider) => {
								const visible = !state.hiddenModelProviders.includes(provider.id);
								return (
									<Card
										key={provider.id}
										className={cn(
											"!py-1 shadow-none transition-colors",
											activeProvider === provider.id && "border-primary/50 bg-accent/30",
											!visible && "opacity-65",
										)}
									>
										<CardContent className="flex items-center gap-2 p-2">
											<MonochromeProviderIcon providerId={provider.id} />
											<div className="min-w-0 flex-1">
												<div className="flex flex-wrap items-center gap-1.5">
													<span className="font-medium">{provider.name}</span>
													<Badge
														className="h-5 px-1.5 text-[10px]"
														variant={provider.builtIn ? "secondary" : "outline"}
													>
														{provider.builtIn ? "内置" : "自定义"}
													</Badge>
													{provider.authenticated ? (
														<Badge className="h-5 px-1.5 text-[10px]" variant="secondary">
															已连接
														</Badge>
													) : null}
												</div>
												<p className="truncate font-mono text-[11px] text-muted-foreground">
													{provider.id}
												</p>
												<p className="truncate text-[11px] text-muted-foreground">
													{provider.baseUrl ?? "未配置 Base URL"}
													{provider.catalogProvider ? ` · 目录来源 ${provider.catalogProvider}` : ""}
												</p>
											</div>
											<div className="flex shrink-0 items-center gap-1">
												<Badge className="h-5 px-1.5 text-[10px]" variant="outline">
													{provider.modelCount} 个模型
												</Badge>
												<Button
													size="icon"
													variant="ghost"
													onClick={() => viewProviderModels(provider.id)}
													aria-label={`查看 ${provider.name} 的模型`}
													title="查看模型"
												>
													<Eye className="size-4" />
												</Button>
												<div
													className="flex items-center gap-1 px-1"
													title={visible ? "在模型列表中显示" : "已从模型列表隐藏"}
												>
													<Switch
														size="default"
														className="h-5 w-10"
														checked={visible}
														onCheckedChange={(checked) => toggleProviderVisibility(provider.id, checked)}
														aria-label={`${visible ? "隐藏" : "显示"} ${provider.id}`}
													/>
												</div>
												<Button
													size="icon"
													variant="ghost"
													onClick={() => openProvider(provider)}
													aria-label={`编辑 ${provider.id}`}
												>
													<Settings className="size-4" />
												</Button>
												<Button
													size="icon"
													variant="ghost"
													onClick={() => void syncProvider(provider.id)}
													disabled={syncingProvider === provider.id}
													aria-label={`同步 ${provider.id}`}
												>
													{syncingProvider === provider.id ? (
														<LoaderCircle className="size-4 animate-spin" />
													) : (
														<RefreshCw className="size-4" />
													)}
												</Button>
											</div>
										</CardContent>
									</Card>
								);
							})}
						</div>
					) : (
						<Card>
							<CardContent className="py-8 text-center text-sm text-muted-foreground">
								暂无可用 Provider
							</CardContent>
						</Card>
					)}
					{state.hiddenModelProviders.some((id) => orderedProviders.some((provider) => provider.id === id)) ? (
						<p className="text-xs text-muted-foreground">已隐藏的供应商仍保留配置，可通过右侧开关重新显示。</p>
					) : null}
				</Tabs>
			</SettingSection>

			<Dialog
				open={Boolean(modelListProviderId)}
				onOpenChange={(open) => {
					if (!open) setModelListProviderId(null);
				}}
			>
				<DialogContent className="max-h-[min(720px,calc(100vh-2rem))] max-w-2xl overflow-hidden">
					<DialogHeader>
						<DialogTitle>{modelListProvider?.name ?? modelListProviderId} 的模型</DialogTitle>
						<DialogDescription>查看当前供应商可用的模型，并按需调整模型配置。</DialogDescription>
					</DialogHeader>
					<div className="flex shrink-0">
						<Button
							type="button"
							variant="outline"
							onClick={() => {
								if (modelListProviderId) openModel(modelListProviderId);
							}}
							disabled={!modelListProviderId}
						>
							<Plus className="size-4" />
							新增模型
						</Button>
					</div>
					<ScrollArea className="max-h-[min(560px,calc(100vh-12rem))] pr-3">
						<div className="grid gap-1">
							{modelListModels.length ? (
								modelListModels.map((model) => (
									<div
										key={`${model.provider}/${model.id}`}
										className="flex items-center gap-2 rounded-md px-2 py-2 hover:bg-accent/60"
									>
										<ModelBrandIcon providerId={model.provider} modelId={model.id} name={model.name} small />
										<div className="min-w-0 flex-1">
											<p className="truncate text-sm font-medium">{formatModelDisplayName(model)}</p>
											<p className="truncate font-mono text-xs text-muted-foreground">{model.id}</p>
											<p className="mt-1 text-xs text-muted-foreground">
												{model.capabilitiesPending
													? "能力待补充"
													: `上下文 ${model.contextWindow.toLocaleString()} · 最大输出 ${model.maxTokens.toLocaleString()}`}{" "}
												· {model.reasoning ? "支持思考" : "普通模型"}
											</p>
										</div>
										<div className="flex shrink-0 items-center gap-1">
											<Badge
												variant={
													model.capabilitiesPending
														? "outline"
														: model.hasOverrides
															? "secondary"
															: "outline"
												}
											>
												{model.capabilitiesPending
													? "待补充"
													: model.hasOverrides
														? "手工覆盖"
														: "自动匹配"}
											</Badge>
											<Button
												size="icon"
												variant="ghost"
												onClick={() => openModel(model.provider, model)}
												aria-label={`编辑 ${formatModelDisplayName(model)}`}
											>
												<Settings className="size-4" />
											</Button>
										</div>
									</div>
								))
							) : (
								<div className="py-10 text-center text-sm text-muted-foreground">当前供应商暂无模型</div>
							)}
						</div>
					</ScrollArea>
				</DialogContent>
			</Dialog>
			<Dialog
				open={Boolean(providerDraft)}
				onOpenChange={(open) => {
					if (!open) setProviderDraft(null);
				}}
			>
				<DialogContent className="max-h-[min(720px,calc(100vh-2rem))] max-w-lg overflow-y-auto">
					<DialogHeader>
						<DialogTitle>{providerDraft?.isNew ? "新增模型 Provider" : "编辑模型 Provider"}</DialogTitle>
						<DialogDescription>配置连接地址、API 类型和可选的模型目录来源。</DialogDescription>
					</DialogHeader>
					{providerDraft ? (
						<form className="grid gap-4" onSubmit={(event) => void submitProvider(event)}>
							<div className="grid gap-2">
								<label className="text-sm font-medium" htmlFor="provider-id">
									Provider ID
								</label>
								<Input
									id="provider-id"
									value={providerDraft.provider}
									readOnly={!providerDraft.isNew}
									onChange={(event) => setProviderDraft({ ...providerDraft, provider: event.target.value })}
									placeholder="例如 my-proxy"
								/>
							</div>
							<div className="grid gap-2">
								<label className="text-sm font-medium" htmlFor="provider-name">
									显示名称
								</label>
								<Input
									id="provider-name"
									value={providerDraft.name}
									onChange={(event) => setProviderDraft({ ...providerDraft, name: event.target.value })}
									placeholder="例如 我的代理"
								/>
							</div>
							<div className="grid gap-2">
								<label className="text-sm font-medium" htmlFor="provider-base-url">
									Base URL
								</label>
								<Input
									id="provider-base-url"
									value={providerDraft.baseUrl}
									onChange={(event) => setProviderDraft({ ...providerDraft, baseUrl: event.target.value })}
									placeholder="https://api.example.com/v1"
								/>
							</div>
							<div className="grid gap-2">
								<label className="text-sm font-medium" htmlFor="provider-api">
									API 类型
								</label>
								<Input
									id="provider-api"
									value={providerDraft.api}
									onChange={(event) => setProviderDraft({ ...providerDraft, api: event.target.value })}
									placeholder="openai-completions"
								/>
							</div>
							<div className="grid gap-2">
								<label className="text-sm font-medium" htmlFor="provider-key">
									API Key
								</label>
								<Input
									id="provider-key"
									type="password"
									value={providerDraft.apiKey}
									onChange={(event) => setProviderDraft({ ...providerDraft, apiKey: event.target.value })}
									placeholder={providerDraft.isNew ? "sk-..." : "留空表示不更改"}
								/>
							</div>
							<div className="grid gap-2">
								<span className="text-sm font-medium">模型目录来源</span>
								<Select
									value={providerDraft.catalogProvider}
									onValueChange={(value) => setProviderDraft({ ...providerDraft, catalogProvider: value })}
								>
									<SelectTrigger>
										<SelectValue placeholder="选择目录来源" />
									</SelectTrigger>
									<SelectContent>
										<SelectItem value="__none__">不绑定，直接请求 /models</SelectItem>
										{state.providers
											.filter((provider) => provider.id !== providerDraft.provider)
											.map((provider) => (
												<SelectItem key={provider.id} value={provider.id}>
													{provider.name} · {provider.id}
												</SelectItem>
											))}
									</SelectContent>
								</Select>
							</div>
							<DialogFooter>
								<Button type="button" variant="outline" onClick={() => setProviderDraft(null)}>
									取消
								</Button>
								<Button
									type="submit"
									disabled={
										submitting ||
										!providerDraft.provider.trim() ||
										!providerDraft.baseUrl.trim() ||
										!providerDraft.api.trim()
									}
								>
									{submitting ? <LoaderCircle className="size-4 animate-spin" /> : null}保存 Provider
								</Button>
							</DialogFooter>
						</form>
					) : null}
				</DialogContent>
			</Dialog>

			<Dialog
				open={Boolean(modelDraft)}
				onOpenChange={(open) => {
					if (!open) setModelDraft(null);
				}}
			>
				<DialogContent className="max-h-[min(720px,calc(100vh-2rem))] max-w-lg overflow-y-auto">
					<DialogHeader>
						<DialogTitle>{modelDraft?.isNew ? "新增模型" : "编辑模型配置"}</DialogTitle>
						<DialogDescription>自动匹配结果可按需调整，手工调整后会保留。</DialogDescription>
					</DialogHeader>
					{modelDraft ? (
						<form className="grid gap-4" onSubmit={(event) => void submitModel(event)}>
							<div className="grid gap-2">
								<label className="text-sm font-medium" htmlFor="model-id">
									模型 ID
								</label>
								<Input
									id="model-id"
									value={modelDraft.id}
									readOnly={!modelDraft.isNew}
									onChange={(event) => setModelDraft({ ...modelDraft, id: event.target.value })}
									placeholder="例如 gpt-5"
								/>
							</div>
							<div className="grid gap-2">
								<label className="text-sm font-medium" htmlFor="model-name">
									显示名称
								</label>
								<Input
									id="model-name"
									value={modelDraft.name}
									onChange={(event) => setModelDraft({ ...modelDraft, name: event.target.value })}
									placeholder="模型名称"
								/>
							</div>
							{modelDraft.isNew ? (
								<>
									<div className="grid gap-2">
										<label className="text-sm font-medium" htmlFor="model-api">
											API 类型
										</label>
										<Input
											id="model-api"
											value={modelDraft.api}
											onChange={(event) => setModelDraft({ ...modelDraft, api: event.target.value })}
										/>
									</div>
									<div className="grid gap-2">
										<label className="text-sm font-medium" htmlFor="model-base-url">
											Base URL
										</label>
										<Input
											id="model-base-url"
											value={modelDraft.baseUrl}
											onChange={(event) => setModelDraft({ ...modelDraft, baseUrl: event.target.value })}
										/>
									</div>
								</>
							) : null}
							<div className="grid gap-3 sm:grid-cols-2">
								<label className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm">
									<input
										type="checkbox"
										checked={modelDraft.reasoning}
										onChange={(event) => setModelDraft({ ...modelDraft, reasoning: event.target.checked })}
									/>
									支持思考
								</label>
								<label className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm">
									<input
										type="checkbox"
										checked={modelDraft.input.includes("image")}
										onChange={(event) =>
											setModelDraft({
												...modelDraft,
												input: event.target.checked
													? [...new Set<"text" | "image">([...modelDraft.input, "image"])]
													: modelDraft.input.filter((value) => value !== "image"),
											})
										}
									/>
									支持图片输入
								</label>
							</div>
							<div className="grid gap-2">
								<div className="flex items-center justify-between">
									<span className="text-sm font-medium">思考强度映射</span>
									<Button
										type="button"
										size="sm"
										variant="ghost"
										onClick={() =>
											setModelDraft({ ...modelDraft, manualThinking: !modelDraft.manualThinking })
										}
									>
										{modelDraft.manualThinking ? "使用自动匹配" : "手工设置"}
									</Button>
								</div>
								{modelDraft.manualThinking ? (
									<div className="flex flex-wrap gap-2">
										{MODEL_THINKING_LEVELS.map((level) => (
											<Button
												type="button"
												key={level}
												size="sm"
												variant={modelDraft.thinkingLevelMap[level] ? "secondary" : "outline"}
												onClick={() =>
													setModelDraft({
														...modelDraft,
														thinkingLevelMap: {
															...modelDraft.thinkingLevelMap,
															[level]: modelDraft.thinkingLevelMap[level] ? null : level,
														},
													})
												}
											>
												{THINKING_LEVEL_LABELS[level]}
											</Button>
										))}
									</div>
								) : (
									<p className="text-xs text-muted-foreground">保留上游目录或 Provider 自动匹配的结果。</p>
								)}
							</div>
							<div className="grid gap-3 sm:grid-cols-2">
								<div className="grid gap-2">
									<label className="text-sm font-medium" htmlFor="model-context">
										上下文长度
									</label>
									<Input
										id="model-context"
										type="number"
										min="1"
										value={modelDraft.contextWindow}
										onChange={(event) => setModelDraft({ ...modelDraft, contextWindow: event.target.value })}
										placeholder="例如 200000"
									/>
								</div>
								<div className="grid gap-2">
									<label className="text-sm font-medium" htmlFor="model-output">
										最大输出 Token
									</label>
									<Input
										id="model-output"
										type="number"
										min="1"
										value={modelDraft.maxTokens}
										onChange={(event) => setModelDraft({ ...modelDraft, maxTokens: event.target.value })}
										placeholder="例如 64000"
									/>
								</div>
							</div>
							<DialogFooter>
								<div className="mr-auto">
									{!modelDraft.isNew ? (
										<Button
											type="button"
											variant="ghost"
											onClick={() => void resetModel()}
											disabled={submitting}
										>
											恢复自动匹配
										</Button>
									) : null}
								</div>
								<Button type="button" variant="outline" onClick={() => setModelDraft(null)}>
									取消
								</Button>
								<Button
									type="submit"
									disabled={submitting || !modelDraft.id.trim() || modelDraft.input.length === 0}
								>
									{submitting ? <LoaderCircle className="size-4 animate-spin" /> : null}保存模型
								</Button>
							</DialogFooter>
						</form>
					) : null}
				</DialogContent>
			</Dialog>
		</div>
	);
}

function DiagnosticsSettings({ state }: { state: WorkbenchState }) {
	const diagnostics = state.diagnostics ?? {};
	const checks = Array.isArray(diagnostics.checks) ? diagnostics.checks : [];
	return (
		<div className="grid gap-6">
			<SettingSection title="运行环境">
				<div className="grid gap-2 sm:grid-cols-2">
					<StatText label="前端" value="React" />
					<StatText
						label="平台"
						value={typeof diagnostics.platform === "string" ? diagnostics.platform : "Web Host"}
					/>
					<StatText label="连接" value={state.connected ? "已连接" : "离线"} />
				</div>
			</SettingSection>
			<SettingSection title="检查结果">
				{checks.length ? (
					<div className="grid gap-1">
						{checks.map((check, index) => {
							const item = check as { id?: string; status?: string; message?: string };
							const ok = item.status === "ok" || item.status === "pass";
							return (
								<div className="flex items-start gap-2 rounded-md px-3 py-2 text-sm" key={item.id ?? index}>
									<span
										className={cn(
											"mt-1.5 size-2 shrink-0 rounded-full",
											ok ? "bg-emerald-500" : "bg-amber-500",
										)}
									/>
									<span>{item.message ?? "检查完成"}</span>
								</div>
							);
						})}
					</div>
				) : (
					<Card>
						<CardContent className="py-6 text-center text-sm text-muted-foreground">暂无诊断信息</CardContent>
					</Card>
				)}
			</SettingSection>
		</div>
	);
}

function AboutSettings({ state }: { state: WorkbenchState }) {
	const productVersion = typeof state.about?.productVersion === "string" ? state.about.productVersion : "LYStar Code";
	return (
		<div className="grid gap-6">
			<Card className="shadow-none">
				<CardHeader>
					<div className="flex items-center gap-3">
						<img className="size-12 rounded-lg object-contain" src="/brand/lystar-mark.png" alt="" />
						<div>
							<CardTitle>LYStar Code</CardTitle>
							<CardDescription>本机 Agent 工作台</CardDescription>
						</div>
					</div>
				</CardHeader>
				<CardContent>
					<p className="text-sm leading-6 text-muted-foreground">
						让 Session、运行状态和项目上下文在浏览器里保持清晰可见。
					</p>
				</CardContent>
			</Card>
			<SettingSection title="版本信息">
				<div className="flex items-center justify-between rounded-md border px-3 py-3 text-sm">
					<span className="text-muted-foreground">产品版本</span>
					<span className="font-mono">{productVersion}</span>
				</div>
			</SettingSection>
		</div>
	);
}

function SettingSection({ title, children }: { title: string; children: ReactNode }) {
	return (
		<section className="grid gap-3">
			<h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</h2>
			{children}
		</section>
	);
}

function StatText({ label, value }: { label: string; value: string }) {
	return (
		<Card className="shadow-none">
			<CardContent className="p-3">
				<p className="text-xs text-muted-foreground">{label}</p>
				<p className="mt-1 truncate font-mono text-sm">{value}</p>
			</CardContent>
		</Card>
	);
}

function DirectoryDialog({
	open,
	state,
	actions,
	onClose,
}: {
	open: boolean;
	state: WorkbenchState;
	actions: WorkbenchActions;
	onClose: () => void;
}) {
	const [name, setName] = useState("");
	const listing = state.directoryListing;
	return (
		<Dialog
			open={open}
			onOpenChange={(value) => {
				if (!value) onClose();
			}}
		>
			<DialogContent className="max-w-2xl">
				<DialogHeader>
					<DialogTitle>选择项目目录</DialogTitle>
					<DialogDescription>添加一个本机项目到工作台</DialogDescription>
				</DialogHeader>
				{listing ? (
					<>
						<div className="flex items-center gap-2">
							<HardDrive className="size-4 text-muted-foreground" />
							<Input
								value={listing.path}
								onChange={(event) => void actions.loadDirectory(event.target.value)}
								aria-label="当前目录"
							/>
						</div>
						<div className="flex gap-2">
							<Button size="sm" variant="outline" onClick={() => void actions.loadDirectory(listing.home)}>
								<HardDrive className="size-4" />
								主目录
							</Button>
							{listing.parent ? (
								<Button size="sm" variant="outline" onClick={() => void actions.loadDirectory(listing.parent)}>
									<ArrowLeft className="size-4" />
									上一级
								</Button>
							) : null}
						</div>
						<ScrollArea className="h-72 rounded-md border">
							<div className="grid gap-1 p-2">
								{listing.entries.map((entry) => (
									<Button
										key={entry.path}
										className="justify-start gap-2"
										variant={name === entry.name ? "secondary" : "ghost"}
										onClick={() => setName(entry.name)}
										onDoubleClick={() => void actions.loadDirectory(entry.path)}
									>
										<Folder className="size-4 text-amber-600" />
										<span className="truncate">{entry.name}</span>
										<ChevronRight className="ml-auto size-4" />
									</Button>
								))}
							</div>
						</ScrollArea>
						<DialogFooter>
							<div className="mr-auto min-w-0 text-left">
								<p className="text-xs text-muted-foreground">当前选择</p>
								<p className="max-w-80 truncate font-mono text-xs">{listing.path}</p>
							</div>
							<Button
								onClick={() => {
									void actions.addProject(listing.path, name || undefined);
									onClose();
								}}
							>
								<Plus className="size-4" />
								添加项目
							</Button>
						</DialogFooter>
					</>
				) : (
					<div className="flex items-center justify-center py-10 text-sm text-muted-foreground">
						<LoaderCircle className="mr-2 size-4 animate-spin" />
						正在读取目录
					</div>
				)}
			</DialogContent>
		</Dialog>
	);
}

function ProjectRenameDialog({
	project,
	actions,
	onClose,
}: {
	project?: WebProject;
	actions: WorkbenchActions;
	onClose: () => void;
}) {
	const [name, setName] = useState("");
	useEffect(() => {
		setName(project?.name ?? "");
	}, [project]);
	return (
		<Dialog
			open={Boolean(project)}
			onOpenChange={(open) => {
				if (!open) onClose();
			}}
		>
			<DialogContent className="max-w-md">
				<DialogHeader>
					<DialogTitle>编辑项目</DialogTitle>
					<DialogDescription>修改项目在工作台中的显示名称</DialogDescription>
				</DialogHeader>
				<Input value={name} onChange={(event) => setName(event.target.value)} autoFocus />
				<DialogFooter>
					<Button variant="outline" onClick={onClose}>
						取消
					</Button>
					<Button
						disabled={!name.trim() || !project}
						onClick={() => {
							if (project) void actions.updateProject(project.id, { name: name.trim() });
							onClose();
						}}
					>
						保存
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

function UiRequestDialog({ state, actions }: { state: WorkbenchState; actions: WorkbenchActions }) {
	const request = state.pendingUiRequests[0];
	const [value, setValue] = useState("");
	const inputRef = useRef<HTMLInputElement>(null);
	useEffect(() => {
		if (request) inputRef.current?.focus();
	}, [request]);
	if (!request) return null;
	const payload =
		request.payload && typeof request.payload === "object" ? (request.payload as Record<string, unknown>) : {};
	const options = Array.isArray(payload.options)
		? payload.options.filter((option): option is string => typeof option === "string")
		: [];
	const finish = (response: { value?: unknown; confirmed?: boolean; cancelled?: boolean }) =>
		void actions
			.respondUiRequest(request, response)
			.catch((error) => actions.showToast(error instanceof Error ? error.message : String(error)));
	return (
		<Dialog open onOpenChange={() => undefined}>
			<DialogContent className="max-w-md">
				<DialogHeader>
					<DialogTitle>{request.title || "需要你的输入"}</DialogTitle>
					<DialogDescription>
						{typeof payload.message === "string"
							? payload.message
							: typeof payload.text === "string"
								? payload.text
								: "Agent 正在等待你的确认。"}
					</DialogDescription>
				</DialogHeader>
				{request.kind === "select" && options.length ? (
					<Select onValueChange={(selected) => finish({ value: selected })}>
						<SelectTrigger>
							<SelectValue placeholder="选择一项" />
						</SelectTrigger>
						<SelectContent>
							{options.map((option) => (
								<SelectItem key={option} value={option}>
									{option}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				) : request.kind === "confirm" ? (
					<DialogFooter>
						<Button variant="outline" onClick={() => finish({ confirmed: false, cancelled: true })}>
							取消
						</Button>
						<Button onClick={() => finish({ confirmed: true })}>确认</Button>
					</DialogFooter>
				) : (
					<>
						<Input
							ref={inputRef}
							type={request.kind === "secret" ? "password" : "text"}
							value={value}
							onChange={(event) => setValue(event.target.value)}
							placeholder={request.kind === "secret" ? "输入内容不会显示" : "输入你的回复"}
						/>
						<DialogFooter>
							<Button variant="outline" onClick={() => finish({ cancelled: true })}>
								取消
							</Button>
							<Button disabled={!value.trim()} onClick={() => finish({ value })}>
								提交
							</Button>
						</DialogFooter>
					</>
				)}
			</DialogContent>
		</Dialog>
	);
}

function Toast({ message }: { message?: string }) {
	if (!message) return null;
	return (
		<Alert
			className="fixed right-4 bottom-4 z-[60] w-[min(420px,calc(100vw-2rem))] border-border/70 bg-background shadow-[0_8px_30px_rgb(0_0_0/0.08)]"
			role="status"
		>
			<Check className="size-4 text-emerald-600" />
			<AlertDescription>{message}</AlertDescription>
		</Alert>
	);
}
