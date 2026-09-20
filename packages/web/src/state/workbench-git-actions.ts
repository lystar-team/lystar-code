import { useCallback } from "react";
import type { GitMutation } from "@lystar/code-web-protocol";
import { webApi } from "../adapters/host-protocol/api.ts";
import { errorMessage, gitCredentialAuthorizationMessage, gitFileStatsKey, sameGitStatus } from "./workbench-state.ts";
import type { GitFileDiffStats, WorkbenchState } from "./workbench-types.ts";

type StateRef = { current: WorkbenchState };
type StateUpdate = WorkbenchState | ((current: WorkbenchState) => WorkbenchState);
type UpdateState = (update: StateUpdate) => WorkbenchState;

type RequestRef = { current: number };
type PromiseRef = { current: Promise<void> | undefined };
type StringSetRef = { current: Set<string> };

export interface WorkbenchGitActionsContext {
	stateRef: StateRef;
	updateState: UpdateState;
	showToast: (message: string) => void;
	gitStatusRequestRef: RequestRef;
	gitBranchesRequestRef: RequestRef;
	gitHistoryRequestRef: RequestRef;
	gitCommitRequestRef: RequestRef;
	gitDiffRequestRef: RequestRef;
	gitStatusPromiseRef: PromiseRef;
	gitStatsRepositoryRef: StringSetRef;
	loadGitStatusRef: { current: (silent?: boolean) => Promise<void> };
}

export function useWorkbenchGitActions({
	stateRef,
	updateState,
	showToast,
	gitStatusRequestRef,
	gitBranchesRequestRef,
	gitHistoryRequestRef,
	gitCommitRequestRef,
	gitDiffRequestRef,
	gitStatusPromiseRef,
	gitStatsRepositoryRef,
	loadGitStatusRef,
}: WorkbenchGitActionsContext) {
	const loadGitStatus = useCallback(
		(silent = false): Promise<void> => {
			const pending = gitStatusPromiseRef.current;
			if (pending) return pending;
			const projectId = stateRef.current.currentProjectId;
			if (!projectId) return Promise.resolve();
			const requestId = ++gitStatusRequestRef.current;
			gitStatsRepositoryRef.current.clear();
			if (!silent) updateState((current) => ({ ...current, gitLoading: true }));
			const run = (async () => {
				try {
					const result = await webApi.gitStatus(projectId, !silent);
					if (requestId !== gitStatusRequestRef.current || stateRef.current.currentProjectId !== projectId) return;
					updateState((current) =>
						sameGitStatus(current.gitStatus, result)
							? current
							: { ...current, gitStatus: result, gitFileStats: {} },
					);
				} finally {
					if (!silent && requestId === gitStatusRequestRef.current) {
						updateState((current) => ({ ...current, gitLoading: false }));
					}
				}
			})();
			const tracked = run.finally(() => {
				if (gitStatusPromiseRef.current === tracked) gitStatusPromiseRef.current = undefined;
			});
			gitStatusPromiseRef.current = tracked;
			return tracked;
		},
		[updateState],
	);

	const loadGitRepositoryStats = useCallback(
		async (repositoryPath = "") => {
			const projectId = stateRef.current.currentProjectId;
			const status = stateRef.current.gitStatus;
			if (!projectId || !status) return;
			const repositories = status.repositories?.length
				? status.repositories
				: [{ ...status, path: "", kind: "root" as const }];
			const repository = repositories.find((item) => item.path === repositoryPath);
			if (!repository) return;
			const cacheKey = `${projectId}\0${repository.path}`;
			if (gitStatsRepositoryRef.current.has(cacheKey)) return;
			gitStatsRepositoryRef.current.add(cacheKey);
			try {
				const result = await webApi.gitStats(projectId, repository.path || undefined);
				if (stateRef.current.currentProjectId !== projectId || stateRef.current.gitStatus !== status) {
					gitStatsRepositoryRef.current.delete(cacheKey);
					return;
				}
				const stats: Record<string, GitFileDiffStats> = {};
				for (const file of result.files) {
					const key = gitFileStatsKey(repository.path, file.path);
					const current = stats[key] ?? { additions: 0, deletions: 0 };
					stats[key] = {
						additions: current.additions + file.additions,
						deletions: current.deletions + file.deletions,
					};
				}
				updateState((current) => ({
					...current,
					gitFileStats: { ...current.gitFileStats, ...stats },
				}));
			} catch {
				gitStatsRepositoryRef.current.delete(cacheKey);
			}
		},
		[updateState],
	);

	const loadGitBranches = useCallback(
		async (repositoryPath = "") => {
			const projectId = stateRef.current.currentProjectId;
			if (!projectId) return;
			const requestId = ++gitBranchesRequestRef.current;
			updateState((current) => ({ ...current, gitBranchesLoading: true }));
			try {
				const result = await webApi.gitBranches(projectId, repositoryPath || undefined);
				if (requestId !== gitBranchesRequestRef.current || stateRef.current.currentProjectId !== projectId) return;
				updateState((current) => ({ ...current, gitBranches: result }));
			} finally {
				if (requestId === gitBranchesRequestRef.current)
					updateState((current) => ({ ...current, gitBranchesLoading: false }));
			}
		},
		[updateState],
	);

	const loadGitHistory = useCallback(
		async (repositoryPath = "", offset = 0, append = false) => {
			const projectId = stateRef.current.currentProjectId;
			if (!projectId) return;
			const requestId = ++gitHistoryRequestRef.current;
			updateState((current) => ({ ...current, gitHistoryLoading: true }));
			try {
				const result = await webApi.gitHistory(projectId, offset, 50, repositoryPath || undefined);
				if (requestId !== gitHistoryRequestRef.current || stateRef.current.currentProjectId !== projectId) return;
				updateState((current) => {
					const previous =
						append && current.gitHistory?.repositoryPath === result.repositoryPath
							? current.gitHistory.commits
							: [];
					const seen = new Set(previous.map((commit) => commit.hash));
					return {
						...current,
						gitHistory: {
							...result,
							commits: [...previous, ...result.commits.filter((commit) => !seen.has(commit.hash))],
						},
						...(current.gitCommit?.repositoryPath === result.repositoryPath ? {} : { gitCommit: undefined }),
					};
				});
			} finally {
				if (requestId === gitHistoryRequestRef.current)
					updateState((current) => ({ ...current, gitHistoryLoading: false }));
			}
		},
		[updateState],
	);

	const loadGitCommit = useCallback(
		async (revision: string, repositoryPath = "", path?: string) => {
			const projectId = stateRef.current.currentProjectId;
			if (!projectId) return;
			const requestId = ++gitCommitRequestRef.current;
			if (path) gitDiffRequestRef.current++;
			updateState((current) => ({
				...current,
				gitCommitLoading: true,
				...(path ? { gitDiff: undefined, gitDiffLoading: true } : { gitCommit: undefined }),
			}));
			try {
				const result = await webApi.gitCommit(projectId, revision, repositoryPath || undefined, path);
				if (requestId !== gitCommitRequestRef.current || stateRef.current.currentProjectId !== projectId) return;
				updateState((current) => ({
					...current,
					gitCommit: result,
					...(path && result.diff ? { gitDiff: result.diff } : {}),
				}));
			} finally {
				if (requestId === gitCommitRequestRef.current) {
					updateState((current) => ({
						...current,
						gitCommitLoading: false,
						...(path ? { gitDiffLoading: false } : {}),
					}));
				}
			}
		},
		[updateState],
	);

	const closeGitCommit = useCallback(() => {
		gitCommitRequestRef.current++;
		updateState((current) => ({ ...current, gitCommit: undefined, gitCommitLoading: false }));
	}, [updateState]);

	const mutateGit = useCallback(
		async (mutation: GitMutation, repositoryPath = ""): Promise<boolean> => {
			const projectId = stateRef.current.currentProjectId;
			if (!projectId || stateRef.current.gitOperation) return false;
			updateState((current) => ({ ...current, gitOperation: mutation.type }));
			try {
				const result = await webApi.mutateGit(projectId, mutation, repositoryPath || undefined);
				if (stateRef.current.currentProjectId !== projectId) return false;
				gitStatsRepositoryRef.current.clear();
				updateState((current) => ({ ...current, gitStatus: result.status, gitFileStats: {} }));
				await Promise.allSettled([
					loadGitRepositoryStats(repositoryPath),
					loadGitBranches(repositoryPath),
					loadGitHistory(repositoryPath),
				]);
				showToast(result.message);
				return true;
			} catch (error) {
				const authorizationMessage = gitCredentialAuthorizationMessage(error);
				if (authorizationMessage) {
					updateState((current) => ({ ...current, gitCredentialAuthorizationMessage: authorizationMessage }));
				} else {
					showToast(errorMessage(error));
				}
				await loadGitStatusRef.current(true).catch(() => {});
				return false;
			} finally {
				if (stateRef.current.currentProjectId === projectId)
					updateState((current) => ({
						...current,
						...(current.gitOperation === mutation.type ? { gitOperation: undefined } : {}),
					}));
			}
		},
		[loadGitBranches, loadGitHistory, loadGitRepositoryStats, showToast, updateState],
	);

	const closeGitCredentialAuthorization = useCallback(
		() => updateState((current) => ({ ...current, gitCredentialAuthorizationMessage: undefined })),
		[updateState],
	);

	const loadGitDiff = useCallback(
		async (path?: string, staged = false, repositoryPath?: string) => {
			const projectId = stateRef.current.currentProjectId;
			if (!projectId) return;
			const requestId = ++gitDiffRequestRef.current;
			updateState((current) => ({ ...current, gitDiff: undefined, gitDiffLoading: true }));
			try {
				const result = await webApi.gitDiff(projectId, path, staged, repositoryPath);
				if (requestId !== gitDiffRequestRef.current || stateRef.current.currentProjectId !== projectId) return;
				updateState((current) => ({ ...current, gitDiff: result }));
			} finally {
				if (requestId === gitDiffRequestRef.current) {
					updateState((current) => ({ ...current, gitDiffLoading: false }));
				}
			}
		},
		[updateState],
	);

	const closeGitDiff = useCallback(() => {
		gitDiffRequestRef.current += 1;
		updateState((current) => ({ ...current, gitDiff: undefined, gitDiffLoading: false }));
	}, [updateState]);

	return {
		loadGitStatus,
		loadGitRepositoryStats,
		loadGitBranches,
		loadGitHistory,
		loadGitCommit,
		closeGitCommit,
		mutateGit,
		closeGitCredentialAuthorization,
		loadGitDiff,
		closeGitDiff,
	};
}
