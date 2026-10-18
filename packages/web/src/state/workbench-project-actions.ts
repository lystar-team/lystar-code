import { useCallback } from "react";
import { webApi } from "../adapters/host-protocol/api.ts";
import { clearUncommittedUserPrompts } from "./chat-lifecycle.ts";
import type { WebProject } from "../types.ts";
import { errorMessage } from "./workbench-state.ts";
import type { ShowToast, WorkbenchState } from "./workbench-types.ts";

type StateRef = { current: WorkbenchState };
type StateUpdate = WorkbenchState | ((current: WorkbenchState) => WorkbenchState);
type UpdateState = (update: StateUpdate) => WorkbenchState;
type NumberRef = { current: number };

export interface WorkbenchProjectActionsContext {
	stateRef: StateRef;
	updateState: UpdateState;
	showToast: ShowToast;
	loadTranscript: () => Promise<void>;
	selectProject: (projectId: string) => Promise<void>;
	refreshBootstrap: () => Promise<void>;
	sessionTreeRequestRef: NumberRef;
	directoryRequestRef: NumberRef;
}

export function useWorkbenchProjectActions({
	stateRef,
	updateState,
	showToast,
	loadTranscript,
	selectProject,
	sessionTreeRequestRef,
	refreshBootstrap,
	directoryRequestRef,
}: WorkbenchProjectActionsContext) {
	const loadSessionTree = useCallback(async () => {
		const sessionId = stateRef.current.sessionId;
		if (!sessionId) return;
		const requestId = ++sessionTreeRequestRef.current;
		updateState((current) => ({ ...current, sessionTreeLoading: true }));
		try {
			const result = await webApi.tree(sessionId);
			if (requestId !== sessionTreeRequestRef.current || stateRef.current.sessionId !== sessionId) return;
			updateState((current) => ({ ...current, sessionTree: result.tree }));
		} finally {
			if (requestId === sessionTreeRequestRef.current)
				updateState((current) => ({ ...current, sessionTreeLoading: false }));
		}
	}, [updateState]);

	const navigateTree = useCallback(
		async (entryId: string) => {
			const current = stateRef.current;
			const sessionId = current.sessionId;
			if (!sessionId || current.readOnly) return;
			const result = await webApi.navigateTree(sessionId, entryId);
			if (result && typeof result === "object" && "cancelled" in result && result.cancelled) {
				throw new Error("会话分支切换已取消");
			}
			updateState((next) => (next.sessionId === sessionId ? clearUncommittedUserPrompts(next) : next));
			await loadTranscript();
		},
		[loadTranscript, updateState],
	);

	const loadProjectTrust = useCallback(async () => {
		const projectId = stateRef.current.currentProjectId;
		if (!projectId) return;
		try {
			const result = await webApi.projectTrust(projectId);
			updateState((current) => ({ ...current, projectTrust: result }));
		} catch {
			updateState((current) => ({ ...current, projectTrust: undefined }));
		}
	}, [updateState]);

	const setProjectTrust = useCallback(
		async (trusted: boolean | null, inheritCollaboration?: boolean) => {
			const current = stateRef.current;
			if (!current.currentProjectId || !current.sessionId || current.readOnly) return;
			const result = await webApi.setProjectTrust(
				current.currentProjectId,
				current.sessionId,
				trusted,
				inheritCollaboration,
			);
			updateState((next) => ({ ...next, projectTrust: result }));
		},
		[updateState],
	);

	const loadDirectory = useCallback(
		async (path?: string) => {
			const requestId = ++directoryRequestRef.current;
			updateState((current) => ({ ...current, directoryLoading: true }));
			try {
				const result = await webApi.directories(path);
				if (requestId !== directoryRequestRef.current) return;
				updateState((current) => ({ ...current, directoryListing: result }));
			} finally {
				if (requestId === directoryRequestRef.current)
					updateState((current) => ({ ...current, directoryLoading: false }));
			}
		},
		[updateState],
	);

	const updateWorkspaceState = useCallback((revision: number | undefined, update: (current: WorkbenchState) => WorkbenchState) => {
		updateState((current) => current.workspaceRevision === revision ? update(current) : current);
	}, [updateState]);

	const addProject = useCallback(
		async (cwd: string, name?: string) => {
			const revision = stateRef.current.workspaceRevision;
			const result = await webApi.addProject(cwd, name);
			updateWorkspaceState(revision, (current) => ({
				...current,
				projects: [result.project, ...current.projects.filter((project) => project.id !== result.project.id)],
			}));
			await refreshBootstrap();
			await selectProject(result.project.id);
		},
		[selectProject, updateWorkspaceState, refreshBootstrap],
	);

	const addProjectGroup = useCallback(
		async (name: string) => {
			try {
				const revision = stateRef.current.workspaceRevision;
				const result = await webApi.addProjectGroup(name);
				updateWorkspaceState(revision, (current) => ({ ...current, projectGroups: result.groups }));
				await refreshBootstrap();
				return true;
			} catch (error) {
				showToast(errorMessage(error), "error");
				return false;
			}
		},
		[showToast, updateWorkspaceState, refreshBootstrap],
	);

	const updateProjectGroup = useCallback(
		async (groupId: string, name: string) => {
			try {
				const revision = stateRef.current.workspaceRevision;
				const previous = stateRef.current.projectGroups.find((group) => group.id === groupId);
				if (!previous) return false;
				const result = await webApi.updateProjectGroup(groupId, name, previous.name);
				updateWorkspaceState(revision, (current) => ({ ...current, projectGroups: result.groups }));
				await refreshBootstrap();
				return true;
			} catch (error) {
				showToast(errorMessage(error), "error");
				return false;
			}
		},
		[showToast, updateWorkspaceState, refreshBootstrap],
	);

	const removeProjectGroup = useCallback(
		async (groupId: string) => {
			try {
				const revision = stateRef.current.workspaceRevision;
				const result = await webApi.removeProjectGroup(groupId);
				updateWorkspaceState(revision, (current) => ({ ...current, projectGroups: result.groups }));
				await refreshBootstrap();
				return true;
			} catch (error) {
				showToast(errorMessage(error), "error");
				return false;
			}
		},
		[showToast, updateWorkspaceState, refreshBootstrap],
	);

	const setProjectGroup = useCallback(
		async (projectId: string, groupId?: string) => {
			try {
				const revision = stateRef.current.workspaceRevision;
				const result = await webApi.setProjectGroup(projectId, groupId);
				updateWorkspaceState(revision, (current) => ({ ...current, projectGroups: result.groups }));
				await refreshBootstrap();
				return true;
			} catch (error) {
				showToast(errorMessage(error), "error");
				return false;
			}
		},
		[showToast, updateWorkspaceState, refreshBootstrap],
	);

	const reorderProjectGroups = useCallback(
		async (groupIds: string[]) => {
			try {
				const revision = stateRef.current.workspaceRevision;
				const result = await webApi.reorderProjectGroups(groupIds);
				updateWorkspaceState(revision, (current) => ({ ...current, projectGroups: result.groups }));
				await refreshBootstrap();
			} catch (error) {
				showToast(errorMessage(error), "error");
			}
		},
		[showToast, updateWorkspaceState, refreshBootstrap],
	);

	const updateProject = useCallback(
		async (projectId: string, update: Partial<Pick<WebProject, "name" | "pinned" | "color" | "archived">>) => {
			const revision = stateRef.current.workspaceRevision;
			const previous = stateRef.current.projects.find((project) => project.id === projectId);
			if (!previous) return;
			const changed = { ...update };
			for (const key of ["name", "pinned", "color", "archived"] as const) {
				if ((changed[key] ?? false) === (previous[key] ?? false)) delete changed[key];
			}
			const result = await webApi.updateProject(projectId, changed, previous);
			updateWorkspaceState(revision, (current) => ({
				...current,
				projects: current.projects.map((project) => (project.id === projectId ? result.project : project)),
			}));
			await refreshBootstrap();
		},
		[updateWorkspaceState, refreshBootstrap],
	);

	const reorderProjects = useCallback(
		async (projectIds: string[]) => {
			try {
				const revision = stateRef.current.workspaceRevision;
				await webApi.reorderProjects(projectIds);
				const orderedSet = new Set(projectIds);
				updateWorkspaceState(revision, (current) => ({
					...current,
					projects: [
						...projectIds.flatMap((projectId) => current.projects.filter((project) => project.id === projectId)),
						...current.projects.filter((project) => !orderedSet.has(project.id)),
					],
				}));
				await refreshBootstrap();
			} catch (error) {
				showToast(errorMessage(error), "error");
			}
		},
		[showToast, updateWorkspaceState, refreshBootstrap],
	);

	const reorderSessions = useCallback(
		async (projectId: string, sessionIds: string[]) => {
			try {
				const revision = stateRef.current.workspaceRevision;
				const result = await webApi.reorderSessions(projectId, sessionIds);
				updateWorkspaceState(revision, (current) => ({
					...current,
					projects: current.projects.map((project) =>
						project.id === projectId ? { ...project, sessions: result.sessions } : project,
					),
				}));
				await refreshBootstrap();
			} catch (error) {
				showToast(errorMessage(error), "error");
			}
		},
		[showToast, updateWorkspaceState, refreshBootstrap],
	);

	const removeProject = useCallback(
		async (projectId: string) => {
			if (projectId === stateRef.current.currentProjectId) return;
			const revision = stateRef.current.workspaceRevision;
			await webApi.removeProject(projectId);
			updateWorkspaceState(revision, (current) => ({
				...current,
				projects: current.projects.filter((project) => project.id !== projectId),
			}));
			await refreshBootstrap();
		},
		[updateWorkspaceState, refreshBootstrap],
	);

	return {
		loadSessionTree,
		navigateTree,
		loadProjectTrust,
		setProjectTrust,
		loadDirectory,
		addProject,
		addProjectGroup,
		updateProjectGroup,
		removeProjectGroup,
		setProjectGroup,
		reorderProjectGroups,
		updateProject,
		reorderProjects,
		reorderSessions,
		removeProject,
	};
}
