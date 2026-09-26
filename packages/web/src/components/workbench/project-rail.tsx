import { gsap } from "gsap";
import {
	Archive,
	ArrowRight,
	Bot,
	ChevronDown,
	CircleCheck,
	Folder,
	FolderPlus,
	FolderTree,
	List,
	LoaderCircle,
	MessageSquarePlus,
	MoreHorizontal,
	Pencil,
	Pin,
	PanelLeftClose,
	Play,
	Plus,
	Search,
	Settings,
	Trash2,
} from "lucide-react";
import type { DragEvent as ReactDragEvent } from "react";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { cn } from "../../lib/utils";
import { sessionTitle, type WorkbenchState } from "../../state/use-workbench";
import type { ProjectGroup, SubagentConfig, WebProject, WebSessionSummary } from "../../types";
import { BrandLogo } from "../brand-logo";
import { Button } from "../ui/button";
import { Collapsible, CollapsibleTrigger } from "../ui/collapsible";
import { GsapCollapsibleContent } from "../ui/gsap-collapsible-content";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../ui/dialog";
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuSeparator,
	ContextMenuTrigger,
} from "../ui/context-menu";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "../ui/hover-card";
import { Input } from "../ui/input";
import { ScrollArea } from "../ui/scroll-area";
import { Separator } from "../ui/separator";
import { Tabs, TabsContent } from "../ui/tabs";
import { ProjectGroupDialog, ProjectGroupPickerDialog, ProjectGroupProjectPickerDialog } from "./project-group-dialog";
import { AgentSessionDialog } from "./agent-session-dialog";
import { RailFooter } from "./rail-footer";
import { type DropPosition, type SessionListTab, countSessionsByTab, hasUnreadSessions, isResumedCompletedSession, isSessionRunning, isSessionUnread, orderedSessions, reorderIds, searchProjectSessions, sessionMatchesTab } from "./project-rail-utils";
import { SessionRenameDialog } from "./dialogs";
import { SessionButton, type SessionButtonProps } from "./session-button";
import { SessionManagementDialog } from "./session-management-dialog";
import type { WorkbenchActions } from "./types";
import { VirtualizedSessionList } from "./virtualized-session-list";
import { WorkbenchTabBar, type WorkbenchTabOption } from "./workbench-tab-bar";
import { WorkspaceModeSwitch, type WorkspaceMode } from "./workspace-mode-switch";

const SESSION_PAGE_SIZE = 7;
const SESSION_TABS: ReadonlyArray<WorkbenchTabOption<SessionListTab>> = [
	{ icon: List, label: "全部", value: "all" },
	{ icon: Play, label: "进行中", value: "running" },
	{ icon: CircleCheck, label: "已完成", value: "completed" },
];

type ProjectDropTarget =
	| { kind: "project"; projectId: string; position: DropPosition }
	| { kind: "group"; groupId: string }
	| { kind: "ungrouped" };
type GroupDropTarget = { groupId: string; position: DropPosition };
type SessionDrag = { projectId: string; sessionId: string };
type SessionDropTarget = { projectId: string; sessionId: string; position: DropPosition };
type SessionButtonHandlers = Pick<
	SessionButtonProps,
	| "onClick"
	| "onRename"
	| "onContextRename"
	| "onTogglePinned"
	| "onDelete"
	| "onDragStart"
	| "onDragOver"
	| "onDrop"
	| "onDragEnd"
>;

type ProjectRailProps = {
	state: WorkbenchState;
	actions: WorkbenchActions;
	projects: WebProject[];
	roomAgentSessionIds: ReadonlySet<string>;
	currentProject?: WebProject;
	onAddProject: () => void;
	onEditProject: (project: WebProject) => void;
	onNavigate?: () => void;
	withNavigationRail?: boolean;
	onCollapse?: () => void;
	workspaceMode: WorkspaceMode;
	onWorkspaceModeChange: (mode: WorkspaceMode) => void;
};

function projectRailPropsEqual(previous: ProjectRailProps, next: ProjectRailProps): boolean {
	return (
		previous.projects === next.projects &&
		previous.roomAgentSessionIds === next.roomAgentSessionIds &&
		previous.currentProject === next.currentProject &&
		previous.actions === next.actions &&
		previous.onAddProject === next.onAddProject &&
		previous.onEditProject === next.onEditProject &&
		previous.onNavigate === next.onNavigate &&
		previous.withNavigationRail === next.withNavigationRail &&
		previous.onCollapse === next.onCollapse &&
		previous.workspaceMode === next.workspaceMode &&
		previous.onWorkspaceModeChange === next.onWorkspaceModeChange &&
		previous.state.connected === next.state.connected &&
		previous.state.networkOnline === next.state.networkOnline &&
		previous.state.reconnecting === next.state.reconnecting &&
		previous.state.currentProjectId === next.state.currentProjectId &&
		previous.state.loading === next.state.loading &&
		previous.state.projects === next.state.projects &&
		previous.state.projectGroups === next.state.projectGroups &&
		previous.state.sessionId === next.state.sessionId &&
		previous.state.branding === next.state.branding &&
		previous.state.unreadSessionIds === next.state.unreadSessionIds
	);
}

function dropPosition(event: ReactDragEvent<HTMLElement>): DropPosition {
	const rect = event.currentTarget.getBoundingClientRect();
	return event.clientY < rect.top + rect.height / 2 ? "before" : "after";
}

function sessionItemKey(session: WebSessionSummary): string {
	return session.id;
}

function ProjectRailChevron({ className, open }: { className?: string; open: boolean }) {
	const iconRef = useRef<SVGSVGElement>(null);
	const initializedRef = useRef(false);

	useLayoutEffect(() => {
		const icon = iconRef.current;
		if (!icon) return;
		const rotation = open ? 0 : -90;
		gsap.killTweensOf(icon);
		if (!initializedRef.current || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
			initializedRef.current = true;
			gsap.set(icon, { rotation });
			return;
		}
		gsap.to(icon, { duration: 0.18, ease: "power2.out", overwrite: "auto", rotation });
		return () => gsap.killTweensOf(icon);
	}, [open]);

	return <ChevronDown aria-hidden="true" className={className} ref={iconRef} />;
}

export const ProjectRail = memo(function ProjectRail({
	state,
	actions,
	projects,
	roomAgentSessionIds,
	currentProject,
	onAddProject,
	onEditProject,
	onNavigate,
	withNavigationRail = false,
	onCollapse,
	workspaceMode,
	onWorkspaceModeChange,
}: ProjectRailProps) {
	const [query, setQuery] = useState("");
	const [sessionTab, setSessionTab] = useState<SessionListTab>("all");
	const [showArchived, setShowArchived] = useState(false);
	const [ungroupedOpen, setUngroupedOpen] = useState(true);
	const [expandedProjectIds, setExpandedProjectIds] = useState<Set<string>>(() => new Set());
	const [selectedProjectId, setSelectedProjectId] = useState<string | undefined>(state.currentProjectId);
	const [expandedGroupIds, setExpandedGroupIds] = useState<Set<string>>(() => new Set());
	const [sessionVisibleCounts, setSessionVisibleCounts] = useState<Record<string, number>>({});
	const [openProjectMenuId, setOpenProjectMenuId] = useState<string | null>(null);
	const [openGroupMenuId, setOpenGroupMenuId] = useState<string | null>(null);
	const [projectDropTarget, setProjectDropTarget] = useState<ProjectDropTarget>();
	const [draggedProjectId, setDraggedProjectId] = useState<string>();
	const [draggedGroupId, setDraggedGroupId] = useState<string>();
	const [groupDropTarget, setGroupDropTarget] = useState<GroupDropTarget>();
	const [draggedSession, setDraggedSession] = useState<SessionDrag>();
	const [sessionDropTarget, setSessionDropTarget] = useState<SessionDropTarget>();
	const [editingGroup, setEditingGroup] = useState<ProjectGroup>();
	const [groupDialogOpen, setGroupDialogOpen] = useState(false);
	const [movingProject, setMovingProject] = useState<WebProject>();
	const [addingProjectToGroup, setAddingProjectToGroup] = useState<ProjectGroup>();
	const [sessionManagementProject, setSessionManagementProject] = useState<WebProject>();
	const [sessionRenameTarget, setSessionRenameTarget] = useState<WebSessionSummary>();
	const [pendingDeleteSession, setPendingDeleteSession] = useState<{ id: string; title: string }>();
	const [agentSessionProject, setAgentSessionProject] = useState<WebProject>();
	const [deletingSessionId, setDeletingSessionId] = useState<string>();
	const [projectNameDrafts, setProjectNameDrafts] = useState<Record<string, string>>({});
	const [editingProjectId, setEditingProjectId] = useState<string>();
	const [projectActionId, setProjectActionId] = useState<string>();
	const sessionViewportRef = useRef<HTMLDivElement>(null);
	const draggedSessionRef = useRef<SessionDrag>();
	draggedSessionRef.current = draggedSession;
	const selectedSessionActivity = currentProject?.sessions.find((session) => session.id === state.sessionId)?.activity;
	const previousSelectedSessionRef = useRef({ id: state.sessionId, activity: selectedSessionActivity });

	useEffect(() => {
		const current = { id: state.sessionId, activity: selectedSessionActivity };
		if (sessionTab === "completed" && isResumedCompletedSession(previousSelectedSessionRef.current, current)) {
			setSessionTab("running");
		}
		previousSelectedSessionRef.current = current;
	}, [sessionTab, state.sessionId, selectedSessionActivity]);

	const normalizedQuery = query.trim().toLowerCase();
	const archivedProjects = state.projects.filter((project) => project.archived);
	const searchedSessionsByProject = useMemo(
		() => new Map(projects.map((project) => [
			project.id,
			searchProjectSessions(project, "all", normalizedQuery, roomAgentSessionIds, state.unreadSessionIds),
		] as const)),
		[projects, normalizedQuery, roomAgentSessionIds, state.unreadSessionIds],
	);
	const tabCounts = useMemo(
		() => countSessionsByTab(searchedSessionsByProject, state.unreadSessionIds),
		[searchedSessionsByProject, state.unreadSessionIds],
	);
	const tabsWithCounts = useMemo(
		() => SESSION_TABS.map((tab) => ({ ...tab, count: tabCounts[tab.value] })),
		[tabCounts],
	);
	const matchingSessionsByProject = useMemo(
		() => sessionTab === "all" ? searchedSessionsByProject : new Map(projects.map((project) => [
			project.id,
			searchedSessionsByProject.get(project.id)!.filter((session) => sessionMatchesTab(session, sessionTab, state.unreadSessionIds)),
		] as const)),
		[projects, searchedSessionsByProject, sessionTab, state.unreadSessionIds],
	);
	const visibleProjects = useMemo(
		() => projects.filter((project) =>
			(!normalizedQuery && sessionTab === "all") ||
			(matchingSessionsByProject.get(project.id)?.length ?? 0) > 0 ||
			(sessionTab === "all" && project.name.toLowerCase().includes(normalizedQuery)),
		),
		[projects, sessionTab, normalizedQuery, matchingSessionsByProject],
	);
	const sessionMatchedProjectIds = useMemo(
		() => new Set(visibleProjects
			.filter((project) => normalizedQuery && matchingSessionsByProject.get(project.id)!
				.some((session) => sessionTitle(session).toLowerCase().includes(normalizedQuery)))
			.map((project) => project.id)),
		[visibleProjects, normalizedQuery, matchingSessionsByProject],
	);
	const selectedProject = projects.find((project) => project.id === selectedProjectId);
	const pinnedSessions = useMemo(
		() => visibleProjects.flatMap((project) =>
			matchingSessionsByProject.get(project.id)!
				.filter((session) => session.pinned)
				.map((session) => ({ project, session })),
		),
		[visibleProjects, matchingSessionsByProject],
	);

	const projectSections = useMemo(() => {
		const assigned = new Set<string>();
		const groups = state.projectGroups.map((group) => {
			const groupProjects = projects.filter(
				(project) => group.projectIds.includes(project.id) && !assigned.has(project.id),
			);
			for (const project of groupProjects) assigned.add(project.id);
			return { group, projects: groupProjects };
		});
		return {
			groups,
			ungrouped: projects.filter((project) => !assigned.has(project.id)),
		};
	}, [projects, state.projectGroups]);

	const filteredProjectSections = useMemo(() => {
		const visibleIds = new Set(visibleProjects.map((project) => project.id));
		return {
			groups: projectSections.groups
				.map((section) => ({
					...section,
					projects: section.projects.filter((project) => visibleIds.has(project.id)),
				}))
				.filter((section) => (sessionTab === "all" && !normalizedQuery) || section.projects.length > 0),
			ungrouped: projectSections.ungrouped.filter((project) => visibleIds.has(project.id)),
		};
	}, [projectSections, visibleProjects, sessionTab, normalizedQuery]);

	useEffect(() => {
		if (!normalizedQuery) return;
		setExpandedGroupIds((current) => {
			const next = new Set(current);
			for (const section of filteredProjectSections.groups) next.add(section.group.id);
			return next.size === current.size ? current : next;
		});
		if (filteredProjectSections.ungrouped.length) setUngroupedOpen(true);
		if (!sessionMatchedProjectIds.size) return;
		setExpandedProjectIds((current) => {
			const next = new Set(current);
			for (const id of sessionMatchedProjectIds) next.add(id);
			return next.size === current.size ? current : next;
		});
	}, [normalizedQuery, filteredProjectSections, sessionMatchedProjectIds]);

	const displayedProjectIds = useMemo(
		() => [
			...projectSections.groups.flatMap((section) => section.projects.map((project) => project.id)),
			...projectSections.ungrouped.map((project) => project.id),
		],
		[projectSections],
	);

	useEffect(() => {
		if (!currentProject?.id) return;
		setExpandedProjectIds((current) =>
			current.has(currentProject.id) ? current : new Set(current).add(currentProject.id),
		);
		const currentGroup = state.projectGroups.find((group) => group.projectIds.includes(currentProject.id));
		if (currentGroup)
			setExpandedGroupIds((current) =>
				current.has(currentGroup.id) ? current : new Set(current).add(currentGroup.id),
			);
	}, [currentProject?.id, state.projectGroups]);

	useEffect(() => {
		setSelectedProjectId(state.currentProjectId);
	}, [state.currentProjectId]);

	const groupForProject = (projectId: string): ProjectGroup | undefined =>
		state.projectGroups.find((group) => group.projectIds.includes(projectId));

	const createProjectSession = async (
		projectId: string,
		agentProfile?: Pick<SubagentConfig, "name" | "icon">,
	) => {
		if (projectId !== state.currentProjectId) await actions.selectProject(projectId);
		await actions.createSession(agentProfile);
		onNavigate?.();
	};

	const resetProjectDrag = () => {
		setDraggedProjectId(undefined);
		setProjectDropTarget(undefined);
	};

	const resetSessionDrag = useCallback(() => {
		setDraggedSession(undefined);
		setSessionDropTarget(undefined);
	}, []);

	const handleProjectDragStart = (event: ReactDragEvent<HTMLElement>, projectId: string) => {
		if (normalizedQuery) return;
		event.dataTransfer.effectAllowed = "move";
		event.dataTransfer.setData("text/plain", projectId);
		setDraggedProjectId(projectId);
	};

	const handleProjectDragOver = (event: ReactDragEvent<HTMLElement>, projectId: string) => {
		if (!draggedProjectId || draggedProjectId === projectId || normalizedQuery) return;
		event.preventDefault();
		event.dataTransfer.dropEffect = "move";
		setProjectDropTarget({ kind: "project", projectId, position: dropPosition(event) });
	};

	const handleProjectDrop = (event: ReactDragEvent<HTMLElement>, targetProjectId: string) => {
		event.preventDefault();
		const sourceProjectId = draggedProjectId || event.dataTransfer.getData("text/plain");
		const sourceProject = projects.find((project) => project.id === sourceProjectId);
		const targetProject = projects.find((project) => project.id === targetProjectId);
		if (!sourceProject || !targetProject || sourceProjectId === targetProjectId) {
			resetProjectDrag();
			return;
		}
		if (sourceProject.pinned !== targetProject.pinned) {
			actions.showToast("置顶项目与普通项目分别调整顺序");
			resetProjectDrag();
			return;
		}
		const position = dropPosition(event);
		const sourceGroup = groupForProject(sourceProjectId)?.id;
		const targetGroup = groupForProject(targetProjectId)?.id;
		if (sourceGroup !== targetGroup) void actions.setProjectGroup(sourceProjectId, targetGroup);
		void actions.reorderProjects(reorderIds(displayedProjectIds, sourceProjectId, targetProjectId, position));
		resetProjectDrag();
	};

	const projectIdsAfterGroupDrop = (groupId: string, sourceProjectId: string): string[] => {
		const next = displayedProjectIds.filter((projectId) => projectId !== sourceProjectId);
		const group = projectSections.groups.find((section) => section.group.id === groupId);
		if (!group) return next;
		const lastProjectId = group.projects
			.map((project) => project.id)
			.filter((projectId) => projectId !== sourceProjectId)
			.at(-1);
		if (lastProjectId) {
			const index = next.indexOf(lastProjectId);
			if (index >= 0) {
				next.splice(index + 1, 0, sourceProjectId);
				return next;
			}
		}
		const groupIndex = projectSections.groups.findIndex((section) => section.group.id === groupId);
		const insertIndex = projectSections.groups
			.slice(0, groupIndex)
			.reduce((count, section) => count + section.projects.length, 0);
		next.splice(Math.min(insertIndex, next.length), 0, sourceProjectId);
		return next;
	};

	const resetGroupDrag = () => {
		setDraggedGroupId(undefined);
		setGroupDropTarget(undefined);
	};

	const handleGroupHeaderDragStart = (event: ReactDragEvent<HTMLElement>, groupId: string) => {
		if (normalizedQuery) return;
		event.dataTransfer.effectAllowed = "move";
		event.dataTransfer.setData("text/plain", `project-group:${groupId}`);
		setDraggedGroupId(groupId);
	};

	const handleGroupHeaderDragOver = (event: ReactDragEvent<HTMLElement>, groupId: string) => {
		if (!draggedGroupId || draggedGroupId === groupId || normalizedQuery) return;
		event.preventDefault();
		event.stopPropagation();
		event.dataTransfer.dropEffect = "move";
		setGroupDropTarget({ groupId, position: dropPosition(event) });
	};

	const handleGroupHeaderDrop = (event: ReactDragEvent<HTMLElement>, groupId: string) => {
		const transfer = event.dataTransfer.getData("text/plain");
		const sourceGroupId =
			draggedGroupId ?? (transfer.startsWith("project-group:") ? transfer.slice("project-group:".length) : undefined);
		if (!sourceGroupId) return;
		event.preventDefault();
		event.stopPropagation();
		if (sourceGroupId !== groupId) {
			void actions.reorderProjectGroups(
				reorderIds(
					state.projectGroups.map((candidate) => candidate.id),
					sourceGroupId,
					groupId,
					dropPosition(event),
				),
			);
		}
		resetGroupDrag();
	};

	const handleGroupDragOver = (event: ReactDragEvent<HTMLElement>, groupId: string) => {
		if (!draggedProjectId || normalizedQuery) return;
		event.preventDefault();
		event.dataTransfer.dropEffect = "move";
		setProjectDropTarget({ kind: "group", groupId });
	};

	const handleGroupDrop = (event: ReactDragEvent<HTMLElement>, groupId: string) => {
		event.preventDefault();
		const sourceProjectId = draggedProjectId || event.dataTransfer.getData("text/plain");
		const sourceProject = projects.find((project) => project.id === sourceProjectId);
		if (!sourceProject) {
			resetProjectDrag();
			return;
		}
		if (groupForProject(sourceProjectId)?.id !== groupId) void actions.setProjectGroup(sourceProjectId, groupId);
		void actions.reorderProjects(projectIdsAfterGroupDrop(groupId, sourceProjectId));
		resetProjectDrag();
	};

	const handleUngroupedDragOver = (event: ReactDragEvent<HTMLElement>) => {
		if (!draggedProjectId || normalizedQuery) return;
		event.preventDefault();
		event.dataTransfer.dropEffect = "move";
		setProjectDropTarget({ kind: "ungrouped" });
	};

	const handleUngroupedDrop = (event: ReactDragEvent<HTMLElement>) => {
		event.preventDefault();
		const sourceProjectId = draggedProjectId || event.dataTransfer.getData("text/plain");
		const sourceProject = projects.find((project) => project.id === sourceProjectId);
		if (!sourceProject) {
			resetProjectDrag();
			return;
		}
		if (groupForProject(sourceProjectId)) void actions.setProjectGroup(sourceProjectId);
		void actions.reorderProjects([
			...displayedProjectIds.filter((projectId) => projectId !== sourceProjectId),
			sourceProjectId,
		]);
		resetProjectDrag();
	};

	const handleSessionDragStart = useCallback(
		(event: ReactDragEvent<HTMLElement>, projectId: string, sessionId: string) => {
			event.dataTransfer.effectAllowed = "move";
			event.dataTransfer.setData("text/plain", sessionId);
			setDraggedSession({ projectId, sessionId });
		},
		[],
	);

	const handleSessionDragOver = useCallback(
		(event: ReactDragEvent<HTMLElement>, projectId: string, sessionId: string) => {
			const source = draggedSessionRef.current;
			if (!source || source.projectId !== projectId || source.sessionId === sessionId) return;
			event.preventDefault();
			event.dataTransfer.dropEffect = "move";
			setSessionDropTarget({ projectId, sessionId, position: dropPosition(event) });
		},
		[],
	);

	const handleSessionDrop = useCallback(
		(event: ReactDragEvent<HTMLElement>, projectId: string, targetSessionId: string) => {
			event.preventDefault();
			const source = draggedSessionRef.current;
			const project = projects.find((candidate) => candidate.id === projectId);
			if (!source || !project || source.projectId !== projectId || source.sessionId === targetSessionId) {
				resetSessionDrag();
				return;
			}
			const sessions = orderedSessions(project);
			const sourceSession = sessions.find((session) => session.id === source.sessionId);
			const targetSession = sessions.find((session) => session.id === targetSessionId);
			if (!sourceSession || !targetSession) {
				resetSessionDrag();
				return;
			}
			if (sourceSession.pinned !== targetSession.pinned) {
				actions.showToast("置顶会话与普通会话分别调整顺序");
				resetSessionDrag();
				return;
			}
			void actions.reorderSessions(
				project.id,
				reorderIds(
					sessions.map((session) => session.id),
					source.sessionId,
					targetSessionId,
					dropPosition(event),
				),
			);
			resetSessionDrag();
		},
		[actions.reorderSessions, actions.showToast, projects, resetSessionDrag],
	);

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

	const openCreateGroup = () => {
		setEditingGroup(undefined);
		setGroupDialogOpen(true);
	};

	const openRenameGroup = (group: ProjectGroup) => {
		setEditingGroup(group);
		setGroupDialogOpen(true);
	};

	const saveGroup = (name: string): Promise<boolean> =>
		editingGroup ? actions.updateProjectGroup(editingGroup.id, name) : actions.addProjectGroup(name);

	const requestSessionDelete = useCallback((session: WebSessionSummary) => {
		setPendingDeleteSession({ id: session.id, title: sessionTitle(session) });
	}, []);

	const sessionHandlers = useMemo(() => {
		const handlers = new Map<string, SessionButtonHandlers>();
		for (const project of projects) {
			for (const session of project.sessions) {
				handlers.set(session.id, {
					onClick: () => {
						setSelectedProjectId(project.id);
						if (sessionTab === "completed") {
							if (!session.pinned) {
								const index = searchedSessionsByProject.get(project.id)!.findIndex((candidate) => candidate.id === session.id);
								setSessionVisibleCounts((current) => index >= (current[project.id] ?? SESSION_PAGE_SIZE)
									? { ...current, [project.id]: index + 1 }
									: current);
							}
							setSessionTab("all");
						}
						void actions.selectSession(session.id);
						onNavigate?.();
					},
					onRename: (name) => actions.renameSession(session.id, name),
					onContextRename: () => setSessionRenameTarget(session),
					onTogglePinned: () => void actions.setSessionPinned(session.id, !session.pinned),
					onDelete: () => requestSessionDelete(session),
					onDragStart: (event) => handleSessionDragStart(event, project.id, session.id),
					onDragOver: (event) => handleSessionDragOver(event, project.id, session.id),
					onDrop: (event) => handleSessionDrop(event, project.id, session.id),
					onDragEnd: resetSessionDrag,
				});
			}
		}
		return handlers;
	}, [
		actions.renameSession,
		actions.selectSession,
		actions.setSessionPinned,
		handleSessionDragOver,
		handleSessionDragStart,
		handleSessionDrop,
		onNavigate,
		projects,
		requestSessionDelete,
		resetSessionDrag,
		searchedSessionsByProject,
		sessionTab,
	]);

	const confirmSessionDelete = async () => {
		const pending = pendingDeleteSession;
		if (!pending || deletingSessionId) return;
		setDeletingSessionId(pending.id);
		try {
			if (await actions.deleteSession(pending.id)) setPendingDeleteSession(undefined);
		} finally {
			setDeletingSessionId(undefined);
		}
	};

	const renderProject = (project: WebProject, nested = false) => {
		const selected = selectedProjectId === project.id;
		const expanded = expandedProjectIds.has(project.id);
		const projectActionsVisible = openProjectMenuId === project.id;
		const sessions = matchingSessionsByProject.get(project.id)!;
		const sessionDepths = new Map<string, number>();
		for (const session of sessions) {
			const parentDepth = session.parentId ? sessionDepths.get(session.parentId) : undefined;
			sessionDepths.set(
				session.id,
				session.relation === "collaboration" && parentDepth !== undefined ? parentDepth + 1 : 0,
			);
		}
		const runningSessionCount = sessions.filter(isSessionRunning).length;
		const hasUnread = hasUnreadSessions(sessions, state.unreadSessionIds);
		const visibleSessionCount = sessionVisibleCounts[project.id] ?? SESSION_PAGE_SIZE;
		const visibleSessions = sessions.slice(0, visibleSessionCount);
		const hasMoreSessions = visibleSessions.length < sessions.length;
		const canCollapseSessions = visibleSessionCount > SESSION_PAGE_SIZE && sessions.length > SESSION_PAGE_SIZE;
		const hasSessionPagination = hasMoreSessions || canCollapseSessions;

		return (
			<ContextMenu key={project.id}>
				<ContextMenuTrigger asChild>
					<div
						className={cn(
							"group relative rounded-md",
							nested && "ml-6",
							draggedProjectId === project.id && "opacity-50",
						)}
					>
						<Collapsible
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
							<li
								className={cn(
									"list-none relative rounded-md",
									projectDropTarget?.kind === "project" &&
										projectDropTarget.position === "before" &&
										"before:absolute before:-top-1 before:right-0 before:left-0 before:h-0.5 before:bg-border",
									projectDropTarget?.kind === "project" &&
										projectDropTarget.position === "after" &&
										"after:absolute after:-bottom-1 after:right-0 after:left-0 after:h-0.5 after:bg-border",
								)}
								draggable={!normalizedQuery}
								onDragStart={(event) => handleProjectDragStart(event, project.id)}
								onDragOver={(event) => {
									event.stopPropagation();
									handleProjectDragOver(event, project.id);
								}}
								onDrop={(event) => {
									event.stopPropagation();
									handleProjectDrop(event, project.id);
								}}
								onDragEnd={resetProjectDrag}
							>
								<HoverCard
									openDelay={140}
									closeDelay={80}
									onOpenChange={(open) =>
										open && setProjectNameDrafts((current) => ({ ...current, [project.id]: project.name }))
									}
								>
									<HoverCardTrigger asChild>
										<CollapsibleTrigger asChild>
											<Button
												className="h-8 w-full min-w-0 justify-start gap-2 px-2 py-1 pr-20 text-xs"
														variant={selected ? "secondary" : "ghost"}
												onClick={() => setSelectedProjectId(project.id)}
											>
												<Folder className="size-4 shrink-0 text-muted-foreground" />
												<span className="project-list-item-label min-w-0 flex-1 truncate text-left">
													{project.name}
												</span>
												<span className="mobile-project-indicators flex shrink-0 items-center gap-1.5 group-hover:invisible">
													{hasUnread ? (
														<span
															role="img"
															className="size-2 shrink-0 rounded-full bg-blue-500 ring-2 ring-blue-500/20"
															aria-label={`${project.name} 有新的会话内容`}
															title="有新的会话内容"
														/>
													) : null}
													{runningSessionCount > 0 ? (
														<LoaderCircle
															className="size-3.5 shrink-0 animate-spin text-primary"
															aria-label="项目中有会话进行中"
														/>
													) : null}
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
										<div className="flex items-start justify-between gap-4 whitespace-nowrap">
											{editingProjectId === project.id ? (
												<Input
													aria-label="项目名称"
													autoFocus
													className="project-list-item-label h-8 min-w-0 flex-1 rounded-md border border-input bg-background px-2 shadow-sm"
													value={projectNameDrafts[project.id] ?? project.name}
													disabled={projectActionId === project.id}
													onChange={(event) =>
														setProjectNameDrafts((current) => ({
															...current,
															[project.id]: event.target.value,
														}))
													}
													onKeyDown={(event) => {
														if (event.key === "Enter") {
															event.preventDefault();
															event.currentTarget.blur();
														}
														if (event.key === "Escape") {
															event.preventDefault();
														setProjectNameDrafts((current) => ({
															...current,
															[project.id]: project.name,
														}));
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
													className="project-list-item-label min-w-0 flex-1 cursor-text truncate whitespace-nowrap bg-transparent p-0 text-left leading-5 text-foreground"
													onClick={() => {
														setProjectNameDrafts((current) => ({
															...current,
															[project.id]: project.name,
														}));
														setEditingProjectId(project.id);
													}}
												>
													{project.name}
												</button>
											)}
											<Button
												aria-label={project.pinned ? "取消置顶项目" : "置顶项目"}
												size="icon-xs"
												className="size-5"
												variant="ghost"
												onClick={(event) => {
													event.stopPropagation();
													void actions.updateProject(project.id, { pinned: !project.pinned });
												}}
											>
												<Pin className={cn("size-3.5", project.pinned && "text-primary")} />
											</Button>
										</div>
										<div className="mt-3 grid gap-2 whitespace-nowrap text-xs text-muted-foreground">
											<div className="flex min-w-0 items-center gap-2">
												<span className="size-2 shrink-0 rounded-full bg-emerald-500" />
												<span>{state.connected ? "已连接" : "未连接"}</span>
												<span>·</span>
												<span>{sessions.length} 个会话</span>
											</div>
											{runningSessionCount > 0 ? (
												<div className="flex min-w-0 items-center gap-2 text-primary">
													<LoaderCircle className="size-3.5 shrink-0 animate-spin" aria-hidden="true" />
													<span>{runningSessionCount} 个会话正在进行中</span>
												</div>
											) : null}
											<div className="flex min-w-0 items-start gap-2">
												<Folder className="mt-0.5 size-3.5 shrink-0" />
												<span className="min-w-0 whitespace-normal break-all font-mono">{project.path}</span>
											</div>
										</div>
									</HoverCardContent>
								</HoverCard>
								<div className="absolute top-1/2 right-1 flex -translate-y-1/2 items-center gap-0.5">
									<Button
										className={cn(
											"mobile-hover-action mobile-quick-action text-muted-foreground transition-opacity hover:text-foreground",
											projectActionsVisible
												? "pointer-events-auto opacity-100"
												: "pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100",
										)}
										size="icon-sm"
										variant="ghost"
										onClick={(event) => {
											event.stopPropagation();
											void createProjectSession(project.id);
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
													"mobile-hover-action",
													projectActionsVisible
														? "pointer-events-auto opacity-100"
														: "pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100",
												)}
												size="icon-sm"
												variant="ghost"
												aria-label={`${project.name} 更多操作`}
											>
												<MoreHorizontal className="size-4" />
											</Button>
										</DropdownMenuTrigger>
										<DropdownMenuContent align="end">
											<DropdownMenuItem onSelect={() => void createProjectSession(project.id)}>
												<MessageSquarePlus className="size-4" />
												新建会话
											</DropdownMenuItem>
											<DropdownMenuItem onSelect={() => setSessionManagementProject(project)}>
												<List className="size-4" />
												会话管理
											</DropdownMenuItem>
											<DropdownMenuItem onSelect={() => onEditProject(project)}>
												<Settings className="size-4" />
												编辑项目
											</DropdownMenuItem>
											<DropdownMenuItem onSelect={() => setMovingProject(project)}>
												<FolderPlus className="size-4" />
												移动到项目组
											</DropdownMenuItem>
											<DropdownMenuItem
												onSelect={() => void actions.updateProject(project.id, { pinned: !project.pinned })}
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
							</li>
							<GsapCollapsibleContent open={expanded}>
								<div className="mt-0.5">
									{sessions.length ? (
										<>
											<VirtualizedSessionList
												items={visibleSessions}
															getKey={sessionItemKey}
															scrollRef={sessionViewportRef}
												renderItem={(session) => {
													const running = isSessionRunning(session);
													const sessionDrop =
														sessionDropTarget?.projectId === project.id &&
														sessionDropTarget.sessionId === session.id;
											return (
												<div
													className="h-full"
													style={{ paddingLeft: Math.min(sessionDepths.get(session.id) ?? 0, 5) * 12 }}
												>
													<SessionButton
														projectName={project.name}
														session={session}
														active={state.sessionId === session.id}
														running={running}
														unread={isSessionUnread(session, state.unreadSessionIds)}
														dragging={draggedSession?.sessionId === session.id}
														dropTarget={sessionDrop}
														dropPosition={sessionDrop ? sessionDropTarget?.position : undefined}
														{...sessionHandlers.get(session.id)!}
													/>
												</div>
											);
												}}
											/>
							{hasSessionPagination ? (
								<div
									className="mt-0.5 flex min-w-0 items-center gap-1"
									role="group"
									aria-label="会话列表分页"
								>
									{hasMoreSessions ? (
										<Button
											className="h-8 min-w-0 flex-1 justify-start gap-2 py-1 pr-2 !pl-8 text-left text-xs text-muted-foreground transition-colors hover:bg-transparent hover:text-foreground"
											variant="ghost"
											onClick={() =>
												setSessionVisibleCounts((current) => ({
													...current,
													[project.id]:
														(current[project.id] ?? SESSION_PAGE_SIZE) + SESSION_PAGE_SIZE,
												}))
											}
										>
											<span className="project-list-item-label min-w-0 flex-1 truncate">加载更多</span>
										</Button>
									) : (
										<span className="min-w-0 flex-1" aria-hidden="true" />
									)}
									{canCollapseSessions ? (
										<Button
											className="h-8 shrink-0 justify-end px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-transparent hover:text-foreground"
											variant="ghost"
											onClick={() =>
												setSessionVisibleCounts((current) => ({
													...current,
													[project.id]: SESSION_PAGE_SIZE,
												}))
											}
										>
											<span className="project-list-item-label">收起更多</span>
										</Button>
									) : null}
								</div>
							) : null}
										</>
									) : (
										<span className="px-2 py-2 text-[13px] text-muted-foreground">暂无会话</span>
									)}
								</div>
							</GsapCollapsibleContent>
						</Collapsible>
					</div>
				</ContextMenuTrigger>
				<ContextMenuContent className="w-52">
					<ContextMenuItem onSelect={() => setSessionManagementProject(project)}>
						<List className="size-4" />
						会话管理
					</ContextMenuItem>
					<ContextMenuItem onSelect={() => onEditProject(project)}>
						<Settings className="size-4" />
						编辑项目
					</ContextMenuItem>
					<ContextMenuItem onSelect={() => setMovingProject(project)}>
						<FolderPlus className="size-4" />
						移动到项目组
					</ContextMenuItem>
					<ContextMenuItem onSelect={() => void actions.updateProject(project.id, { pinned: !project.pinned })}>
						<Pin className="size-4" />
						{project.pinned ? "取消置顶" : "置顶项目"}
					</ContextMenuItem>
					<ContextMenuItem onSelect={() => void actions.updateProject(project.id, { archived: true })}>
						<Archive className="size-4" />
						归档项目
					</ContextMenuItem>
					<ContextMenuSeparator />
					<ContextMenuItem
						className="text-destructive focus:text-destructive"
						disabled={project.id === state.currentProjectId}
						onSelect={() => void actions.removeProject(project.id)}
					>
						<Trash2 className="size-4" />
						移除项目
					</ContextMenuItem>
				</ContextMenuContent>
			</ContextMenu>
		);
	};

	const renderGroup = (group: ProjectGroup, groupProjects: WebProject[]) => {
		const expanded = expandedGroupIds.has(group.id);
		const groupDrop = groupDropTarget?.groupId === group.id;
		const visibleGroupSessions = groupProjects.map((project) => matchingSessionsByProject.get(project.id)!);
		const groupRunningSessionCount = visibleGroupSessions.reduce(
			(total, sessions) => total + sessions.filter(isSessionRunning).length,
			0,
		);
		const groupSessionCount = visibleGroupSessions.reduce((total, sessions) => total + sessions.length, 0);
		const groupHasUnread = visibleGroupSessions.some((sessions) => hasUnreadSessions(sessions, state.unreadSessionIds));

		const groupActionsVisible = openGroupMenuId === group.id;
		const groupMenuItems = [
			{ label: "添加项目", icon: Plus, onSelect: () => setAddingProjectToGroup(group) },
			{ label: "重命名项目组", icon: Pencil, onSelect: () => openRenameGroup(group) },
			{ label: "删除项目组", icon: Trash2, onSelect: () => void actions.removeProjectGroup(group.id) },
		];
		return (
			<ContextMenu key={group.id}>
				<div className="min-w-0">
						<Collapsible
							open={expanded}
							onOpenChange={(open) =>
								setExpandedGroupIds((current) => {
									const next = new Set(current);
									if (open) next.add(group.id);
									else next.delete(group.id);
									return next;
								})
							}
						>
							<fieldset
								aria-label={group.name}
								className="m-0 min-w-0 border-0 p-0"
								onDragOver={(event) => handleGroupDragOver(event, group.id)}
								onDrop={(event) => handleGroupDrop(event, group.id)}
							>
								<ContextMenuTrigger asChild>
									<div
										className={cn(
											"group relative cursor-grab rounded-md active:cursor-grabbing",
											groupDrop &&
												groupDropTarget?.position === "before" &&
												"before:pointer-events-none before:absolute before:-top-1 before:right-0 before:left-0 before:z-10 before:h-0.5 before:rounded-full before:bg-border",
											groupDrop &&
												groupDropTarget?.position === "after" &&
												"after:pointer-events-none after:absolute after:right-0 after:-bottom-1 after:left-0 after:z-10 after:h-0.5 after:rounded-full after:bg-border",
											draggedGroupId === group.id && "opacity-50",
										)}
										draggable={!normalizedQuery}
										onDragStart={(event) => handleGroupHeaderDragStart(event, group.id)}
										onDragOver={(event) => handleGroupHeaderDragOver(event, group.id)}
										onDrop={(event) => handleGroupHeaderDrop(event, group.id)}
										onDragEnd={resetGroupDrag}
									>
											<HoverCard openDelay={140} closeDelay={80}>
												<HoverCardTrigger asChild>
													<CollapsibleTrigger asChild>
																<Button className="h-8 w-full min-w-0 justify-start gap-2 px-2 py-1 pr-20 text-xs" variant="ghost">
													<ProjectRailChevron className="size-3.5 shrink-0" open={expanded} />
															<FolderTree className="size-4 shrink-0 text-muted-foreground" />
															<span className="project-list-item-label min-w-0 flex-1 truncate text-left font-medium">
																{group.name}
															</span>
															<span className="mobile-project-indicators flex shrink-0 items-center gap-1.5 text-[11px] text-muted-foreground group-hover:invisible">
																{groupHasUnread ? (
																	<span
																		role="img"
																		className="size-2 shrink-0 rounded-full bg-blue-500 ring-2 ring-blue-500/20"
																					aria-label={`${group.name} 中有新的会话内容`}
																		title="有新的会话内容"
																	/>
																) : null}
																{groupRunningSessionCount > 0 ? (
																	<LoaderCircle
																		className="size-3.5 animate-spin text-primary"
																					aria-label="项目组中有会话进行中"
																	/>
																) : null}
																{groupProjects.length}
															</span>
														</Button>
													</CollapsibleTrigger>
											</HoverCardTrigger>
											<HoverCardContent
												side="right"
												align="start"
												sideOffset={8}
												className="w-max min-w-72 max-w-[calc(100vw-1rem)] rounded-xl border-border bg-background px-4 py-3 shadow-[0_2px_8px_rgb(0_0_0/0.05)]"
												onPointerDown={(event) => event.stopPropagation()}
											>
												<div className="flex items-start justify-between gap-4 whitespace-nowrap">
													<span className="project-list-item-label min-w-0 truncate text-foreground">{group.name}</span>
												</div>
												<div className="mt-3 grid gap-2 whitespace-nowrap text-xs text-muted-foreground">
													<div className="flex min-w-0 items-center gap-2">
														<FolderTree className="size-3.5 shrink-0" />
														<span className="truncate">{groupProjects.length} 个项目</span>
													</div>
													<div className="flex min-w-0 items-center gap-2">
														<List className="size-3.5 shrink-0" />
														<span className="truncate">{groupSessionCount} 个会话</span>
													</div>
													{groupRunningSessionCount > 0 ? (
														<div className="flex items-center gap-2 text-primary">
															<LoaderCircle className="size-3.5 shrink-0 animate-spin" aria-hidden="true" />
															<span>{groupRunningSessionCount} 个会话正在进行中</span>
														</div>
													) : null}
												</div>
											</HoverCardContent>
										</HoverCard>
									<div className="absolute top-1/2 right-1 flex -translate-y-1/2 items-center gap-0.5">
										<Button
											className={cn(
												"mobile-hover-action mobile-quick-action text-muted-foreground transition-opacity hover:text-foreground",
												groupActionsVisible
													? "pointer-events-auto opacity-100"
													: "pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100",
											)}
											size="icon-sm"
											variant="ghost"
											onClick={(event) => {
												event.stopPropagation();
												setAddingProjectToGroup(group);
											}}
											aria-label={`${group.name} 添加已有项目`}
										>
											<Plus className="size-4" />
										</Button>
										<DropdownMenu
											open={groupActionsVisible}
											onOpenChange={(open) => setOpenGroupMenuId(open ? group.id : null)}
										>
											<DropdownMenuTrigger asChild>
												<Button
													className={cn(
														"mobile-hover-action",
														groupActionsVisible
															? "pointer-events-auto opacity-100"
															: "pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100",
													)}
													size="icon-sm"
													variant="ghost"
													aria-label={`${group.name} 更多操作`}
												>
													<MoreHorizontal className="size-4" />
												</Button>
											</DropdownMenuTrigger>
											<DropdownMenuContent align="end">
												{groupMenuItems.map(({ icon: Icon, label, onSelect }) => (
													<DropdownMenuItem key={label} onSelect={onSelect}>
														<Icon className="size-4" />
														{label}
													</DropdownMenuItem>
												))}
											</DropdownMenuContent>
										</DropdownMenu>
									</div>
									</div>
								</ContextMenuTrigger>
								<GsapCollapsibleContent open={expanded}>
									<div className="mt-0.5 grid gap-0.5">
										{groupProjects.length ? (
											groupProjects.map((project) => renderProject(project, true))
										) : (
											<span className="px-2 py-2 text-[13px] text-muted-foreground">
												{normalizedQuery ? "没有匹配项目" : "拖动项目到这里"}
											</span>
										)}
									</div>
								</GsapCollapsibleContent>
							</fieldset>
						</Collapsible>
					</div>
				<ContextMenuContent className="w-52">
					{groupMenuItems.map(({ icon: Icon, label, onSelect }) => (
						<ContextMenuItem key={label} onSelect={onSelect}>
							<Icon className="size-4" />
							{label}
						</ContextMenuItem>
					))}
				</ContextMenuContent>
			</ContextMenu>
		);
	};

	return (
		<div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
			<div
				className={cn(
					"flex h-16 shrink-0 items-center justify-between px-4",
					withNavigationRail ? "pr-4" : onNavigate ? "pr-14 lg:pr-4" : "pr-4",
				)}
			>
				<div className="flex min-w-0 items-center gap-2.5 font-semibold tracking-tight">
					{!withNavigationRail ? <BrandLogo logo={state.branding.logo} className="size-7 rounded-md object-contain" /> : null}
					<span className="truncate">{state.branding.name}</span>
				</div>
				<div className="flex items-center gap-0.5">
					<Button size="icon" variant="ghost" onClick={onAddProject} aria-label="添加项目" title="添加项目">
						<Plus className="size-4" />
					</Button>
					<Button size="icon" variant="ghost" onClick={openCreateGroup} aria-label="新建项目组" title="新建项目组">
						<FolderPlus className="size-4" />
					</Button>
					{onCollapse ? (
						<Button size="icon" variant="ghost" onClick={onCollapse} aria-label="收起项目栏" title="收起项目栏">
							<PanelLeftClose className="size-4" />
						</Button>
					) : null}
				</div>
			</div>
			{!withNavigationRail ? (
				<div className="px-3 pb-3">
					<WorkspaceModeSwitch mode={workspaceMode} onChange={onWorkspaceModeChange} />
				</div>
			) : null}
			<div className="grid grid-cols-2 gap-2 px-3 pb-3">
				<Button
					className="h-10 min-w-0 justify-start gap-2 px-3"
					variant="ghost"
					disabled={!selectedProject}
					onClick={() => {
						if (!selectedProject) return;
						void createProjectSession(selectedProject.id);
					}}
				>
					<MessageSquarePlus className="size-4 shrink-0" />
					<span className="project-list-item-label min-w-0 truncate">新对话</span>
				</Button>
				<Button
					aria-label="使用智能体新建会话"
					className="h-10 min-w-0 justify-start gap-2 px-3"
					disabled={!selectedProject}
					onClick={() => {
						if (selectedProject) setAgentSessionProject(selectedProject);
					}}
					title="使用智能体新建会话"
					variant="ghost"
				>
					<Bot className="size-4 shrink-0" aria-hidden="true" />
					<span className="project-list-item-label min-w-0 truncate xl:hidden">智能体会话</span>
					<span className="project-list-item-label hidden min-w-0 truncate xl:inline">使用智能体新建会话</span>
				</Button>
			</div>
			<div className="px-3 pb-3">
				<div className="relative">
					<Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
					<Input
						aria-label="搜索项目或会话"
						placeholder="搜索项目/会话"
						value={query}
						onChange={(event) => setQuery(event.target.value)}
						className={cn("h-9 border-0 bg-muted/60 pl-9 shadow-none focus-visible:ring-0", onNavigate && "min-h-10")}
					/>
				</div>
			</div>
			<Tabs value={sessionTab} onValueChange={(value) => setSessionTab(value as SessionListTab)} className="min-h-0 flex-1 gap-0">
				<WorkbenchTabBar activeId={sessionTab} tabs={tabsWithCounts} label="会话状态" className="mx-3 mb-3" compact />
				{(["all", "running", "completed"] as const)
					.filter((tab) => tab !== sessionTab)
					.map((tab) => <TabsContent key={tab} value={tab} forceMount className="hidden" />)}
				<TabsContent value={sessionTab} className="flex min-h-0 flex-1 flex-col">
					<ScrollArea viewportRef={sessionViewportRef} className="project-list min-h-0 flex-1 px-3">
				<div className="pb-5">
					{pinnedSessions.length ? (
						<div className="mb-4">
							<div className="flex items-center justify-between px-2 pb-2 text-xs font-medium text-muted-foreground">
								<span>置顶</span>
								<span>{pinnedSessions.length}</span>
							</div>
							<div className="grid gap-0.5">
								{pinnedSessions.map(({ project, session }) => (
									<SessionButton
										key={session.id}
										projectName={project.name}
										session={session}
										active={state.sessionId === session.id}
										running={isSessionRunning(session)}
										unread={isSessionUnread(session, state.unreadSessionIds)}
										dragging={draggedSession?.sessionId === session.id}
										dropTarget={false}
										{...sessionHandlers.get(session.id)!}
									/>
								))}
							</div>
						</div>
					) : null}
					<div className="flex items-center justify-between px-2 pb-2 text-xs font-medium text-muted-foreground">
						<span>项目</span>
						<span>{visibleProjects.length}</span>
					</div>
					{state.loading && !projects.length ? (
						<div className="px-2 py-8 text-center text-sm text-muted-foreground">正在加载项目与会话</div>
					) : null}
					<div className="grid gap-0.5">
						{filteredProjectSections.groups.map((section) => renderGroup(section.group, section.projects))}
						{state.projectGroups.length > 0 && filteredProjectSections.ungrouped.length > 0 ? (
							<Collapsible open={ungroupedOpen} onOpenChange={setUngroupedOpen}>
								<fieldset
									aria-label="未分组项目"
									className={cn("group relative rounded-md border-0 p-0")}
									onDragOver={handleUngroupedDragOver}
									onDrop={handleUngroupedDrop}
								>
									<CollapsibleTrigger asChild>
										<Button className="h-8 w-full min-w-0 justify-start gap-2 px-2 py-1 text-xs" variant="ghost">
											<ProjectRailChevron className="size-3.5 shrink-0" open={ungroupedOpen} />
											<FolderTree className="size-4 shrink-0 text-muted-foreground" />
											<span className="project-list-item-label min-w-0 flex-1 truncate text-left font-medium">
												未分组
											</span>
											<span className="text-[11px] text-muted-foreground">
												{filteredProjectSections.ungrouped.length}
											</span>
										</Button>
									</CollapsibleTrigger>
									<GsapCollapsibleContent open={ungroupedOpen}>
										<div className="mt-0.5 grid gap-0.5">
											{filteredProjectSections.ungrouped.length ? (
												filteredProjectSections.ungrouped.map((project) => renderProject(project))
											) : (
												<span className="px-2 py-2 text-[13px] text-muted-foreground">
													{normalizedQuery ? "没有匹配项目" : "暂无项目"}
												</span>
											)}
										</div>
									</GsapCollapsibleContent>
								</fieldset>
							</Collapsible>
						) : (
							filteredProjectSections.ungrouped.map((project) => renderProject(project))
						)}
					</div>
					{!state.loading && !visibleProjects.length && (normalizedQuery || sessionTab !== "all" || !state.projectGroups.length) ? (
						<div className="px-2 py-8 text-center text-sm text-muted-foreground">
							{normalizedQuery ? "没有匹配的项目或会话" : sessionTab === "running" ? "暂无进行中的会话" : sessionTab === "completed" ? "暂无待查看的会话" : "暂无项目"}
						</div>
					) : null}
					{sessionTab === "all" && archivedProjects.length ? (
						<>
							<Separator className="my-4" />
							<Button
								className="h-8 w-full justify-between px-2 py-1 text-xs text-muted-foreground"
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
								<div className="mt-0.5 grid gap-0.5">
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
				</TabsContent>
			</Tabs>
			<RailFooter actions={actions} connectionState={state} updatesOnly={withNavigationRail} />
			<ProjectGroupDialog
				open={groupDialogOpen}
				group={editingGroup}
				onClose={() => setGroupDialogOpen(false)}
				onSave={saveGroup}
			/>
			<ProjectGroupPickerDialog
				project={movingProject}
				groups={state.projectGroups}
				currentGroupId={movingProject ? groupForProject(movingProject.id)?.id : undefined}
				onClose={() => setMovingProject(undefined)}
				onSave={(groupId) => actions.setProjectGroup(movingProject!.id, groupId)}
			/>
			<ProjectGroupProjectPickerDialog
				group={addingProjectToGroup}
				projects={projects}
				onClose={() => setAddingProjectToGroup(undefined)}
				onSave={(projectId) =>
					addingProjectToGroup
						? actions.setProjectGroup(projectId, addingProjectToGroup.id)
						: Promise.resolve(false)
				}
			/>
			<AgentSessionDialog
				open={Boolean(agentSessionProject)}
				projectId={agentSessionProject?.id}
				onOpenChange={(open) => {
					if (!open) setAgentSessionProject(undefined);
				}}
				onCreateSession={(profile) =>
					agentSessionProject
						? createProjectSession(agentSessionProject.id, profile)
						: Promise.resolve()
				}
				onManageAgents={() => {
					setAgentSessionProject(undefined);
					onNavigate?.();
					void actions.openSettings("subagents");
				}}
			/>
			<SessionManagementDialog
				project={sessionManagementProject}
				actions={actions}
				onClose={() => setSessionManagementProject(undefined)}
			/>
			<SessionRenameDialog
				session={sessionRenameTarget}
				actions={actions}
				onClose={() => setSessionRenameTarget(undefined)}
			/>
			<Dialog
				open={Boolean(pendingDeleteSession)}
				onOpenChange={(open) => {
					if (!open && !deletingSessionId) setPendingDeleteSession(undefined);
				}}
			>
				<DialogContent className="max-w-md">
					<DialogHeader>
						<DialogTitle>删除会话？</DialogTitle>
						<DialogDescription className="break-words">
							“{pendingDeleteSession?.title ?? "这个会话"}”删除后无法恢复。
						</DialogDescription>
					</DialogHeader>
					<DialogFooter>
						<Button
							variant="outline"
							disabled={Boolean(deletingSessionId)}
							onClick={() => setPendingDeleteSession(undefined)}
						>
							取消
						</Button>
						<Button
							variant="destructive"
							disabled={Boolean(deletingSessionId)}
							onClick={() => void confirmSessionDelete()}
						>
							{deletingSessionId ? (
								<LoaderCircle className="size-4 animate-spin" />
							) : (
								<Trash2 className="size-4" />
							)}
							确认删除
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</div>
	);
}, projectRailPropsEqual);
