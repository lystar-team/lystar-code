import { useCallback } from "react";
import { webApi } from "../adapters/host-protocol/api.ts";
import { clearUncommittedUserPrompts } from "./chat-lifecycle.ts";
import type { WebProject } from "../types.ts";
import { errorMessage } from "./workbench-state.ts";
import type { WorkbenchState } from "./workbench-types.ts";

type StateRef = { current: WorkbenchState };
type StateUpdate = WorkbenchState | ((current: WorkbenchState) => WorkbenchState);
type UpdateState = (update: StateUpdate) => WorkbenchState;
type NumberRef = { current: number };

export interface WorkbenchProjectActionsContext {
	stateRef: StateRef;
	updateState: UpdateState;
	showToast: (message: string) => void;
	loadTranscript: () => Promise<void>;
	selectProject: (projectId: string) => Promise<void>;
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
			await webApi.navigateTree(sessionId, entryId);
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
		async (trusted: boolean) => {
			const current = stateRef.current;
			if (!current.currentProjectId || !current.sessionId || current.readOnly) return;
			const result = await webApi.setProjectTrust(current.currentProjectId, current.sessionId, trusted);
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

	const addProject = useCallback(
		async (cwd: string, name?: string) => {
			const result = await webApi.addProject(cwd, name);
			updateState((current) => ({
				...current,
				projects: [result.project, ...current.projects.filter((project) => project.id !== result.project.id)],
			}));
			await selectProject(result.project.id);
		},
		[selectProject, updateState],
	);

	const addProjectGroup = useCallback(
		async (name: string) => {
			try {
				const result = await webApi.addProjectGroup(name);
				updateState((current) => ({ ...current, projectGroups: result.groups }));
				return true;
			} catch (error) {
				showToast(errorMessage(error));
				return false;
			}
		},
		[showToast, updateState],
	);

	const updateProjectGroup = useCallback(
		async (groupId: string, name: string) => {
			try {
				const result = await webApi.updateProjectGroup(groupId, name);
				updateState((current) => ({ ...current, projectGroups: result.groups }));
				return true;
			} catch (error) {
				showToast(errorMessage(error));
				return false;
			}
		},
		[showToast, updateState],
	);

	const removeProjectGroup = useCallback(
		async (groupId: string) => {
			try {
				const result = await webApi.removeProjectGroup(groupId);
				updateState((current) => ({ ...current, projectGroups: result.groups }));
				return true;
			} catch (error) {
				showToast(errorMessage(error));
				return false;
			}
		},
		[showToast, updateState],
	);

	const setProjectGroup = useCallback(
		async (projectId: string, groupId?: string) => {
			try {
				const result = await webApi.setProjectGroup(projectId, groupId);
				updateState((current) => ({ ...current, projectGroups: result.groups }));
				return true;
			} catch (error) {
				showToast(errorMessage(error));
				return false;
			}
		},
		[showToast, updateState],
	);

	const reorderProjectGroups = useCallback(
		async (groupIds: string[]) => {
			try {
				const result = await webApi.reorderProjectGroups(groupIds);
				updateState((current) => ({ ...current, projectGroups: result.groups }));
			} catch (error) {
				showToast(errorMessage(error));
			}
		},
		[showToast, updateState],
	);

	const updateProject = useCallback(
		async (projectId: string, update: Partial<Pick<WebProject, "name" | "pinned" | "color" | "archived">>) => {
			const result = await webApi.updateProject(projectId, update);
			updateState((current) => ({
				...current,
				projects: current.projects.map((project) => (project.id === projectId ? result.project : project)),
			}));
		},
		[updateState],
	);

	const reorderProjects = useCallback(
		async (projectIds: string[]) => {
			try {
				await webApi.reorderProjects(projectIds);
				const orderedSet = new Set(projectIds);
				updateState((current) => ({
					...current,
					projects: [
						...projectIds.flatMap((projectId) => current.projects.filter((project) => project.id === projectId)),
						...current.projects.filter((project) => !orderedSet.has(project.id)),
					],
				}));
			} catch (error) {
				showToast(errorMessage(error));
			}
		},
		[showToast, updateState],
	);

	const reorderSessions = useCallback(
		async (projectId: string, sessionIds: string[]) => {
			try {
				const result = await webApi.reorderSessions(projectId, sessionIds);
				updateState((current) => ({
					...current,
					projects: current.projects.map((project) =>
						project.id === projectId ? { ...project, sessions: result.sessions } : project,
					),
				}));
			} catch (error) {
				showToast(errorMessage(error));
			}
		},
		[showToast, updateState],
	);

	const removeProject = useCallback(
		async (projectId: string) => {
			if (projectId === stateRef.current.currentProjectId) return;
			await webApi.removeProject(projectId);
			updateState((current) => ({
				...current,
				projects: current.projects.filter((project) => project.id !== projectId),
			}));
		},
		[updateState],
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
