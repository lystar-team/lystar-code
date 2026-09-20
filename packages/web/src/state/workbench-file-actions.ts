import { useCallback } from "react";
import { webApi } from "../adapters/host-protocol/api.ts";
import { isAbsoluteResourcePath } from "../lib/resource-path.ts";
import { errorMessage, normalizedProjectFilePath, parentProjectPath, sameProjectTree } from "./workbench-state.ts";
import type { FileResponse } from "../types.ts";
import type { InspectorMode, WorkbenchState } from "./workbench-types.ts";

type StateRef = { current: WorkbenchState };
type StateUpdate = WorkbenchState | ((current: WorkbenchState) => WorkbenchState);
type UpdateState = (update: StateUpdate) => WorkbenchState;
type RequestRef = { current: number };
type PromiseMapRef = { current: Map<string, Promise<void>> };

export interface WorkbenchFileActionsContext {
	stateRef: StateRef;
	updateState: UpdateState;
	showToast: (message: string) => void;
	fileRequestRef: RequestRef;
	fileMetadataPromisesRef: PromiseMapRef;
	projectTreeRefreshPromisesRef: PromiseMapRef;
	projectTreeGenerationRef: RequestRef;
	loadProjectTreeRef: { current: (path?: string) => Promise<void> };
	loadSessionTreeRef: { current: () => Promise<void> };
	loadGitStatus: (silent?: boolean) => Promise<void>;
	loadGitStatusRef: { current: (silent?: boolean) => Promise<void> };
	loadGitBranchesRef: { current: (repositoryPath?: string) => Promise<void> };
	loadGitHistoryRef: { current: (repositoryPath?: string) => Promise<void> };
}

export function useWorkbenchFileActions({
	stateRef,
	updateState,
	showToast,
	fileRequestRef,
	fileMetadataPromisesRef,
	projectTreeRefreshPromisesRef,
	projectTreeGenerationRef,
	loadProjectTreeRef,
	loadSessionTreeRef,
	loadGitStatus,
	loadGitStatusRef,
	loadGitBranchesRef,
	loadGitHistoryRef,
}: WorkbenchFileActionsContext) {
	const openInspector = useCallback(
		async (mode: InspectorMode = "files") => {
			updateState((current) => ({ ...current, inspectorOpen: true, inspectorMode: mode }));
			if (mode === "git") await loadGitStatus();
			if (mode === "files" && !stateRef.current.fileTree) await loadProjectTreeRef.current();
			if (mode === "tree" && !stateRef.current.sessionTree.length) await loadSessionTreeRef.current();
		},
		[loadGitStatus, updateState],
	);

	const closeInspector = useCallback(
		() => updateState((current) => ({ ...current, inspectorOpen: false })),
		[updateState],
	);

	const loadProjectTree = useCallback(
		async (path = "", preserveCurrentTree = false) => {
			const projectId = stateRef.current.currentProjectId;
			if (!projectId) return;
			const projectGeneration = projectTreeGenerationRef.current;
			updateState((current) => ({ ...current, fileTreeLoading: true }));
			try {
				const result = await webApi.projectTree(projectId, path);
				if (
					projectGeneration !== projectTreeGenerationRef.current ||
					stateRef.current.currentProjectId !== projectId
				)
					return;
				updateState((current) => ({
					...current,
					fileTree: preserveCurrentTree ? current.fileTree : result,
					fileTreeRootPath: preserveCurrentTree ? current.fileTreeRootPath : result.path,
					fileTreeCache: { ...current.fileTreeCache, [result.path]: result },
				}));
			} finally {
				if (
					projectGeneration === projectTreeGenerationRef.current &&
					stateRef.current.currentProjectId === projectId
				)
					updateState((current) => ({ ...current, fileTreeLoading: false }));
			}
		},
		[updateState],
	);

	const refreshProjectTreePath = useCallback(
		(path: string): Promise<void> => {
			const projectId = stateRef.current.currentProjectId;
			if (!projectId) return Promise.resolve();
			const key = `${projectId}\0${path}`;
			const pending = projectTreeRefreshPromisesRef.current.get(key);
			if (pending) return pending;
			const run = webApi
				.projectTree(projectId, path)
				.then((result) => {
					if (stateRef.current.currentProjectId !== projectId) return;
					updateState((current) => {
						if (sameProjectTree(current.fileTreeCache[result.path], result)) return current;
						return {
							...current,
							fileTree: current.fileTreeRootPath === result.path ? result : current.fileTree,
							fileTreeCache: { ...current.fileTreeCache, [result.path]: result },
						};
					});
				})
				.catch(() => {});
			const tracked = run.finally(() => {
				if (projectTreeRefreshPromisesRef.current.get(key) === tracked) {
					projectTreeRefreshPromisesRef.current.delete(key);
				}
			});
			projectTreeRefreshPromisesRef.current.set(key, tracked);
			return tracked;
		},
		[updateState],
	);

	const openResource = useCallback(
		async (path: string) => {
			const projectId = stateRef.current.currentProjectId;
			if (!projectId) return;
			const requestId = ++fileRequestRef.current;
			updateState((current) => ({
				...current,
				fileLoading: true,
				filePath: path,
				fileError: undefined,
			}));
			try {
				const result = isAbsoluteResourcePath(path)
					? await webApi.externalFile(path)
					: await webApi.projectFile(projectId, path);
				if (requestId !== fileRequestRef.current) return;
				updateState((current) => ({
					...current,
					fileContent: result,
					fileError: undefined,
				}));
			} catch (error) {
				if (requestId !== fileRequestRef.current) return;
				updateState((current) => ({
					...current,
					fileContent: current.fileContent?.path === path ? current.fileContent : undefined,
					fileError: errorMessage(error),
				}));
			} finally {
				if (requestId === fileRequestRef.current) {
					updateState((current) => ({ ...current, fileLoading: false }));
				}
			}
		},
		[updateState],
	);

	const closeFilePreview = useCallback(() => {
		fileRequestRef.current += 1;
		updateState((current) => ({
			...current,
			fileContent: undefined,
			fileError: undefined,
			filePath: undefined,
			fileLoading: false,
		}));
	}, [updateState]);

	const refreshOpenFile = useCallback(
		(path = stateRef.current.filePath, force = false): Promise<void> => {
			const projectId = stateRef.current.currentProjectId;
			if (!projectId || !path || isAbsoluteResourcePath(path)) return Promise.resolve();
			const key = `${projectId}\0${path}`;
			const pending = fileMetadataPromisesRef.current.get(key);
			if (pending) return pending;
			const run = (async () => {
				const metadata = await webApi.projectFileMetadata(projectId, path);
				if (stateRef.current.currentProjectId !== projectId || stateRef.current.filePath !== path) return;
				if (!force && metadata.contentVersion && metadata.contentVersion === stateRef.current.fileContent?.contentVersion) {
					return;
				}
				const result = await webApi.projectFile(projectId, path);
				if (stateRef.current.currentProjectId !== projectId || stateRef.current.filePath !== path) return;
				updateState((current) => ({ ...current, fileContent: result, fileError: undefined }));
			})().catch(() => {});
			const tracked = run.finally(() => {
				if (fileMetadataPromisesRef.current.get(key) === tracked) fileMetadataPromisesRef.current.delete(key);
			});
			fileMetadataPromisesRef.current.set(key, tracked);
			return tracked;
		},
		[updateState],
	);

	const refreshProjectFiles = useCallback(
		async (paths: readonly string[], refreshOpenedFile = true) => {
			const current = stateRef.current;
			const project = current.projects.find((candidate) => candidate.id === current.currentProjectId);
			if (!project) return;
			const refreshAll = paths.includes("");
			const normalized = paths.flatMap((path) => {
				const value = normalizedProjectFilePath(project.path, path);
				return value ? [value] : [];
			});
			const directories = new Set(
				refreshAll ? Object.keys(current.fileTreeCache) : normalized.map(parentProjectPath),
			);
			const loadedDirectories = new Set(Object.keys(current.fileTreeCache));
			await Promise.all(
				[...directories]
					.filter((path) => path === current.fileTreeRootPath || loadedDirectories.has(path))
					.map(refreshProjectTreePath),
			);
			if (refreshOpenedFile && current.filePath && (refreshAll || normalized.includes(current.filePath))) {
				await refreshOpenFile(current.filePath, true);
			}
			if (current.inspectorOpen && current.inspectorMode === "git") {
				await loadGitStatusRef.current(true);
				const repositoryPath =
					stateRef.current.gitBranches?.repositoryPath ?? stateRef.current.gitHistory?.repositoryPath;
				if (repositoryPath !== undefined) {
					await Promise.allSettled([
						loadGitBranchesRef.current(repositoryPath),
						loadGitHistoryRef.current(repositoryPath),
					]);
				}
			}
		},
		[refreshOpenFile, refreshProjectTreePath],
	);

	const saveFile = useCallback(
		async (path: string, content: string, expectedHash: string): Promise<FileResponse> => {
			const current = stateRef.current;
			if (!current.currentProjectId || isAbsoluteResourcePath(path)) throw new Error("当前文件不可保存");
			const sessionId = current.sessionId && current.lease && !current.readOnly ? current.sessionId : undefined;
			try {
				const result = await webApi.saveProjectFile(
					current.currentProjectId,
					path,
					content,
					expectedHash,
					sessionId,
				);
				if (stateRef.current.currentProjectId === current.currentProjectId && stateRef.current.filePath === path) {
					updateState((value) => ({ ...value, fileContent: result, fileError: undefined }));
				}
				await refreshProjectFiles([path], false);
				showToast("文件已保存");
				return result;
			} catch (error) {
				if ((error as { code?: string }).code === "project_file_conflict") void refreshOpenFile(path, true);
				throw error;
			}
		},
		[refreshOpenFile, refreshProjectFiles, showToast, updateState],
	);

	const openFile = openResource;

	return {
		openInspector,
		closeInspector,
		loadProjectTree,
		openFile,
		openResource,
		saveFile,
		closeFilePreview,
		refreshProjectFiles,
	};
}
