import { Archive, ArrowRight, ChevronDown, Folder, LogOut, MessageSquarePlus, MoreHorizontal, Pin, Plus, Search, Settings, SunMoon, Trash2 } from "lucide-react";
import type { DragEvent as ReactDragEvent } from "react";
import { useEffect, useState } from "react";
import { cn } from "../../lib/utils";
import type { WorkbenchState } from "../../state/use-workbench";
import { sessionTitle } from "../../state/use-workbench";
import type { WebProject, WebSessionSummary } from "../../types";
import { Button } from "../ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../ui/collapsible";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "../ui/dropdown-menu";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "../ui/hover-card";
import { Input } from "../ui/input";
import { ScrollArea } from "../ui/scroll-area";
import { Separator } from "../ui/separator";
import { ACTIVE_OPERATION_STATUSES } from "./constants";
import { SessionButton } from "./session-button";
import type { WorkbenchActions } from "./types";

export function ProjectRail({
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
