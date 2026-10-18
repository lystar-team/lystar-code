import { useCallback, useRef } from "react";
import { webApi } from "../adapters/host-protocol/api.ts";
import { isAbsoluteResourcePath } from "../lib/resource-path.ts";
import { errorMessage, normalizedProjectFilePath, parentProjectPath, sameProjectTree } from "./workbench-state.ts";
import type { FileResponse } from "../types.ts";
import type { ShowToast, InspectorMode, WorkbenchState } from "./workbench-types.ts";

type StateRef = { current: WorkbenchState };
type StateUpdate = WorkbenchState | ((current: WorkbenchState) => WorkbenchState);
type UpdateState = (update: StateUpdate) => WorkbenchState;
type RequestRef = { current: number };
type PromiseMapRef = { current: Map<string, Promise<void>> };

interface ProjectFileRefresh {
	directories: Set<string>;
	previewPath?: string;
	gitStatus: boolean;
	branchesPath?: string;
	historyPath?: string;
	promise: Promise<void>;
}

interface ProjectFileRefreshQueue {
	pending?: ProjectFileRefresh;
	tail: Promise<void>;
}

export interface WorkbenchFileActionsContext {
	stateRef: StateRef;
	updateState: UpdateState;
	showToast: ShowToast;
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
	const projectRefreshesRef = useRef(new Map<string, ProjectFileRefreshQueue>());
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
			const generation = projectTreeGenerationRef.current;
			const key = `${projectId}\0${path}`;
			const pending = projectTreeRefreshPromisesRef.current.get(key);
			if (pending) return pending;
			const run = webApi
				.projectTree(projectId, path)
				.then((result) => {
					if (
						generation !== projectTreeGenerationRef.current ||
						stateRef.current.currentProjectId !== projectId
					) return;
					updateState((current) => {
						if (sameProjectTree(current.fileTreeCache[result.path], result)) return current;
						return {
							...current,
							fileTree: current.fileTreeRootPath === result.path ? result : current.fileTree,
							fileTreeCache: { ...current.fileTreeCache, [result.path]: result },
						};
					});
				});
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
			if (!projectId || !path || stateRef.current.filePath !== path || isAbsoluteResourcePath(path))
				return Promise.resolve();
			const requestId = fileRequestRef.current;
			const generation = projectTreeGenerationRef.current;
			const isCurrentPreview = () =>
				requestId === fileRequestRef.current &&
				generation === projectTreeGenerationRef.current &&
				stateRef.current.currentProjectId === projectId &&
				stateRef.current.filePath === path;
			const key = `${projectId}\0${path}`;
			const pending = fileMetadataPromisesRef.current.get(key);
			if (pending)
				return pending.then(() => {
					if (!isCurrentPreview()) return;
					return refreshOpenFile(path, force);
				});
			const run = (async () => {
				const contentVersion = stateRef.current.fileContent?.contentVersion;
				const result = !force && contentVersion
					? await webApi.projectFile(projectId, path, contentVersion)
					: await webApi.projectFile(projectId, path);
				if (!isCurrentPreview()) return;
				updateState((current) => result
					? { ...current, fileContent: result, fileError: undefined }
					: current.fileError ? { ...current, fileError: undefined } : current);
			})().catch((error: unknown) => {
				if (isCurrentPreview()) updateState((current) => ({ ...current, fileError: errorMessage(error) }));
			});
			const tracked = run.finally(() => {
				if (fileMetadataPromisesRef.current.get(key) === tracked) fileMetadataPromisesRef.current.delete(key);
			});
			fileMetadataPromisesRef.current.set(key, tracked);
			return tracked;
		},
		[updateState],
	);

	const refreshProjectFiles = useCallback(
		(paths: readonly string[], refreshOpenedFile = true): Promise<void> => {
			const current = stateRef.current;
			const project = current.projects.find((candidate) => candidate.id === current.currentProjectId);
			if (!project) return Promise.resolve();
			const refreshAll = paths.includes("");
			const normalized = paths.flatMap((path) => {
				const value = normalizedProjectFilePath(project.path, path);
				return value ? [value] : [];
			});
			const directories = new Set(
				(refreshAll
					? Object.keys(current.fileTreeCache)
					: normalized.flatMap((path) => [
						parentProjectPath(path),
						...(Object.hasOwn(current.fileTreeCache, path) ? [path] : []),
					]))
					.filter((path) => path === current.fileTreeRootPath || Object.hasOwn(current.fileTreeCache, path)),
			);
			const previewPath = refreshOpenedFile && current.filePath &&
				(refreshAll || normalized.includes(current.filePath)) ? current.filePath : undefined;
			const gitStatus = current.inspectorOpen && current.inspectorMode === "git" &&
				(refreshAll || normalized.length > 0);
			if (directories.size === 0 && previewPath === undefined && !gitStatus) return Promise.resolve();
			const metadataRepositories = new Set<string>();
			if (gitStatus && !refreshAll) {
				for (const path of normalized) {
					const parts = path.split("/");
					const marker = parts.indexOf(".git");
					if (marker !== -1) metadataRepositories.add(parts.slice(0, marker).join("/"));
				}
			}
			const generation = projectTreeGenerationRef.current;
			const requests: Promise<void>[] = [];
			for (const kind of ["files", "git"] as const) {
				if (kind === "files" && directories.size === 0 && previewPath === undefined) continue;
				if (kind === "git" && !gitStatus) continue;
				const key = `${project.id}\0${generation}\0${kind}`;
				const queue: ProjectFileRefreshQueue = projectRefreshesRef.current.get(key) ?? { tail: Promise.resolve() };
				projectRefreshesRef.current.set(key, queue);
				let pending = queue.pending;
				if (!pending) {
					const run = async () => {
						queue.pending = undefined;
						try {
							if (
								generation !== projectTreeGenerationRef.current ||
								stateRef.current.currentProjectId !== project.id
							) return;
							const reads = [...refresh.directories].map(refreshProjectTreePath);
							if (refresh.previewPath !== undefined) reads.push(refreshOpenFile(refresh.previewPath));
							const metadataReads: Promise<void>[] = [];
							const active = stateRef.current;
							if (active.inspectorOpen && active.inspectorMode === "git") {
								if (refresh.gitStatus) reads.push(loadGitStatusRef.current(true));
								if (
									refresh.branchesPath !== undefined &&
									active.gitBranches?.repositoryPath === refresh.branchesPath
								) metadataReads.push(loadGitBranchesRef.current(refresh.branchesPath));
								if (
									refresh.historyPath !== undefined &&
									active.gitHistory?.repositoryPath === refresh.historyPath
								) metadataReads.push(loadGitHistoryRef.current(refresh.historyPath));
							}
							const [results] = await Promise.all([
								Promise.allSettled(reads), Promise.allSettled(metadataReads),
							]);
							const failure = results.find((result) => result.status === "rejected");
							if (failure) throw failure.reason;
						} finally {
							if (queue.tail === refresh.promise && projectRefreshesRef.current.get(key) === queue)
								projectRefreshesRef.current.delete(key);
						}
					};
					const refresh: ProjectFileRefresh = {
						directories: new Set(),
						gitStatus: false,
						// 前一批失败不阻止后来收到的失效事件；各批次仍返回自己的错误。
						promise: queue.tail.then(run, run),
					};
					queue.pending = refresh;
					queue.tail = refresh.promise;
					pending = refresh;
				}
				if (kind === "files") {
					for (const path of directories) pending.directories.add(path);
					if (previewPath !== undefined) pending.previewPath = previewPath;
				} else {
					pending.gitStatus = true;
					const branchesPath = current.gitBranches?.repositoryPath;
					if (branchesPath !== undefined && (refreshAll || metadataRepositories.has(branchesPath)))
						pending.branchesPath = branchesPath;
					const historyPath = current.gitHistory?.repositoryPath;
					if (historyPath !== undefined && (refreshAll || metadataRepositories.has(historyPath)))
						pending.historyPath = historyPath;
				}
				requests.push(pending.promise);
			}
			return Promise.all(requests).then(() => {});
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
				showToast("文件已保存", "success");
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
