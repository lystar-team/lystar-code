import { useCallback } from "react";
import { webApi } from "../adapters/host-protocol/api.ts";
import type {
	HostInstructionsResponse,
	ProjectSkillsResponse,
	SubagentConfig,
	SubagentConfigsResponse,
	UiRequestEvent,
	WebModelProviderInput,
	WebProviderModelInput,
	WebThinkingLevel,
} from "../types.ts";
import { applyTheme, errorMessage, MODEL_PROVIDER_VISIBILITY_KEY, savedModelProviderVisibilityOverrides } from "./workbench-state.ts";
import { createSubagentConversationState } from "./workbench-live-state.ts";
import type { ComposerMode, SettingsTab, ThemeMode, WorkbenchState } from "./workbench-types.ts";

type StateRef = { current: WorkbenchState };
type StateUpdate = WorkbenchState | ((current: WorkbenchState) => WorkbenchState);
type UpdateState = (update: StateUpdate) => WorkbenchState;

export interface WorkbenchSettingsActionsContext {
	stateRef: StateRef;
	updateState: UpdateState;
	showToast: (message: string) => void;
	refreshModelOptions: () => Promise<void>;
	refreshModelOptionsRef: { current: () => Promise<void> };
	refreshModelSettings: () => Promise<void>;
	loadSubagent: (agentId: string, sessionId?: string) => Promise<void>;
	loadEarlierSubagent: (agentId: string) => Promise<void>;
}

export function useWorkbenchSettingsActions({
	stateRef,
	updateState,
	showToast,
	refreshModelOptions,
	refreshModelOptionsRef,
	refreshModelSettings,
	loadSubagent,
	loadEarlierSubagent,
}: WorkbenchSettingsActionsContext) {
	const setModelProviderVisibility = useCallback(
		(providerId: string, visible: boolean) => {
			updateState((current) => {
				const hidden = new Set(current.hiddenModelProviders);
				if (visible) hidden.delete(providerId);
				else hidden.add(providerId);
				const hiddenModelProviders = [...hidden];
				if (typeof window !== "undefined") {
					const overrides = savedModelProviderVisibilityOverrides();
					overrides[providerId] = visible;
					window.localStorage.setItem(MODEL_PROVIDER_VISIBILITY_KEY, JSON.stringify(overrides));
				}
				return { ...current, hiddenModelProviders };
			});
			void refreshModelOptionsRef.current().catch(() => {});
		},
		[updateState],
	);

	const saveModelProvider = useCallback(
		async (input: WebModelProviderInput) => {
			await webApi.modelProvider(input);
			await Promise.all([refreshModelSettings(), refreshModelOptions()]);
			showToast("Provider 配置已保存");
		},
		[refreshModelOptions, refreshModelSettings, showToast],
	);

	const removeModelProvider = useCallback(
		async (providerId: string) => {
			const result = await webApi.removeModelProvider(providerId);
			const removed = !result.providers.some((provider) => provider.id === providerId);
			if (removed) {
				if (typeof window !== "undefined") {
					const overrides = savedModelProviderVisibilityOverrides();
					delete overrides[providerId];
					window.localStorage.setItem(MODEL_PROVIDER_VISIBILITY_KEY, JSON.stringify(overrides));
				}
				updateState((current) => ({
					...current,
					hiddenModelProviders: current.hiddenModelProviders.filter((id) => id !== providerId),
				}));
			}
			await Promise.all([refreshModelSettings(), refreshModelOptions()]);
			showToast(removed ? "Provider 已删除" : "Provider 自定义配置已清除");
		},
		[refreshModelOptions, refreshModelSettings, showToast, updateState],
	);

	const saveProviderModel = useCallback(
		async (provider: string, input: WebProviderModelInput) => {
			await webApi.providerModel(provider, input);
			await Promise.all([refreshModelSettings(), refreshModelOptions()]);
			showToast("模型配置已保存");
		},
		[refreshModelOptions, refreshModelSettings, showToast],
	);

	const setProviderModelEnabled = useCallback(
		async (provider: string, modelId: string, enabled: boolean) => {
			await webApi.setProviderModelEnabled(provider, modelId, enabled);
			await Promise.all([refreshModelSettings(), refreshModelOptions()]);
			showToast(enabled ? "模型已启用" : "模型已禁用");
		},
		[refreshModelOptions, refreshModelSettings, showToast],
	);

	const syncModelProvider = useCallback(
		async (provider: string) => {
			await webApi.syncModelProvider(provider);
			await Promise.all([refreshModelSettings(), refreshModelOptions()]);
			showToast("模型目录已同步");
		},
		[refreshModelOptions, refreshModelSettings, showToast],
	);

	const refreshSkills = useCallback(async () => {
		const projectId = stateRef.current.currentProjectId;
		if (!projectId) {
			updateState((current) => ({ ...current, skills: [], skillsLoading: false, skillsError: "请先选择一个项目" }));
			return;
		}
		updateState((current) => ({ ...current, skillsLoading: true, skillsError: undefined }));
		try {
			const result = await webApi.projectSkills(projectId);
			updateState((current) => ({
				...current,
				skills: result.skills,
				skillDiagnostics: result.diagnostics,
				skillsLoading: false,
				skillsError: undefined,
			}));
		} catch (error) {
			const message = errorMessage(error);
			updateState((current) => ({ ...current, skillsLoading: false, skillsError: message }));
			showToast(message);
		}
	}, [showToast, updateState]);

	const refreshDiagnostics = useCallback(async () => {
		const result = (await webApi.diagnostics(stateRef.current.currentProjectId)) as Record<string, unknown>;
		updateState((current) => ({ ...current, diagnostics: result }));
	}, [updateState]);

	const restartDiagnosticService = useCallback(
		async (service: "gateway" | "runtime") => {
			try {
				await webApi.restartDiagnosticService(service);
				showToast(service === "gateway" ? "Gateway 重启请求已发送" : "Runtime 已重启");
				if (service === "runtime") await refreshDiagnostics();
			} catch (error) {
				showToast(errorMessage(error));
				throw error;
			}
		},
		[refreshDiagnostics, showToast],
	);

	const toggleSkill = useCallback(
		async (skill: ProjectSkillsResponse["skills"][number]) => {
			if (skill.scope === "temporary") return;
			const projectId = stateRef.current.currentProjectId;
			if (!projectId) {
				showToast("请先选择一个项目");
				return;
			}
			updateState((current) => ({ ...current, skillUpdatingPath: skill.path, skillsError: undefined }));
			try {
				const result = await webApi.setProjectSkillEnabled(projectId, skill.path, skill.scope, !skill.enabled);
				updateState((current) => ({
					...current,
					skills: result.skills,
					skillDiagnostics: result.diagnostics,
					skillUpdatingPath: undefined,
				}));
			} catch (error) {
				const message = errorMessage(error);
				updateState((current) => ({ ...current, skillUpdatingPath: undefined, skillsError: message }));
				showToast(message);
			}
		},
		[showToast, updateState],
	);

	const refreshHarnessImports = useCallback(async () => {
		const projectId = stateRef.current.currentProjectId;
		if (!projectId) {
			updateState((current) => ({
				...current,
				harnessImports: undefined,
				harnessImportsLoading: false,
				harnessImportsError: "请先选择一个项目",
			}));
			return;
		}
		updateState((current) => ({
			...current,
			harnessImportsLoading: true,
			harnessImportsError: undefined,
		}));
		try {
			const result = await webApi.harnessImports(projectId);
			updateState((current) => ({
				...current,
				harnessImports: result,
				harnessImportsLoading: false,
				harnessImportsError: undefined,
			}));
		} catch (error) {
			const message = errorMessage(error);
			updateState((current) => ({ ...current, harnessImportsLoading: false, harnessImportsError: message }));
			showToast(message);
		}
	}, [showToast, updateState]);

	const refreshSubagentConfigs = useCallback(async () => {
		const projectId = stateRef.current.currentProjectId;
		if (!projectId) {
			updateState((current) => ({
				...current,
				subagentConfigs: [],
				subagentConfigsLoading: false,
				subagentConfigsError: "请先选择一个项目",
			}));
			return;
		}
		updateState((current) => ({ ...current, subagentConfigsLoading: true, subagentConfigsError: undefined }));
		try {
			const result: SubagentConfigsResponse = await webApi.subagentConfigs(projectId);
			updateState((current) => ({
				...current,
				subagentConfigs: result.subagents,
				subagentConfigsLoading: false,
				subagentConfigsError: undefined,
			}));
		} catch (error) {
			const message = errorMessage(error);
			updateState((current) => ({ ...current, subagentConfigsLoading: false, subagentConfigsError: message }));
			showToast(message);
		}
	}, [showToast, updateState]);

	const saveSubagentConfig = useCallback(
		async (input: {
			scope: "user" | "project";
			originalName?: string;
			name: string;
			description: string;
			icon?: string;
			provider?: string;
			model?: string;
			thinkingLevel?: WebThinkingLevel;
			tools?: string[];
			skills?: string[];
			tags?: string[];
			content: string;
			expectedHash?: string;
		}): Promise<boolean> => {
			const projectId = stateRef.current.currentProjectId;
			if (!projectId) return false;
			updateState((current) => ({ ...current, subagentConfigsSaving: true, subagentConfigsError: undefined }));
			try {
				const result = await webApi.saveSubagentConfig(projectId, input);
				updateState((current) => ({
					...current,
					subagentConfigs: result.subagents,
					subagentConfigsSaving: false,
					subagentConfigsError: undefined,
				}));
				showToast("智能体已保存");
				return true;
			} catch (error) {
				const message = errorMessage(error);
				if ((error as { code?: string }).code === "subagent_conflict") await refreshSubagentConfigs();
				updateState((current) => ({ ...current, subagentConfigsSaving: false, subagentConfigsError: message }));
				showToast(message);
				return false;
			}
		},
		[refreshSubagentConfigs, showToast, updateState],
	);

	const deleteSubagentConfig = useCallback(
		async (config: SubagentConfig): Promise<boolean> => {
			const projectId = stateRef.current.currentProjectId;
			if (!projectId || config.scope === "builtin" || !config.contentHash) return false;
			updateState((current) => ({ ...current, subagentConfigsSaving: true, subagentConfigsError: undefined }));
			try {
				const result = await webApi.deleteSubagentConfig(projectId, {
					name: config.name,
					scope: config.scope,
					contentHash: config.contentHash,
				});
				updateState((current) => ({
					...current,
					subagentConfigs: result.subagents,
					subagentConfigsSaving: false,
					subagentConfigsError: undefined,
				}));
				showToast("智能体已删除");
				return true;
			} catch (error) {
				const message = errorMessage(error);
				if ((error as { code?: string }).code === "subagent_conflict") await refreshSubagentConfigs();
				updateState((current) => ({ ...current, subagentConfigsSaving: false, subagentConfigsError: message }));
				showToast(message);
				return false;
			}
		},
		[refreshSubagentConfigs, showToast, updateState],
	);

	const importHarnessResources = useCallback(
		async (itemIds: string[]) => {
			const projectId = stateRef.current.currentProjectId;
			if (!projectId || itemIds.length === 0) return;
			updateState((current) => ({
				...current,
				harnessImporting: true,
				harnessImportsError: undefined,
				harnessImportResult: undefined,
			}));
			try {
				const result = await webApi.importHarnessResources(projectId, itemIds);
				updateState((current) => ({ ...current, harnessImporting: false, harnessImportResult: result }));
				await refreshHarnessImports();
				await refreshSkills();
				await refreshSubagentConfigs();
				showToast(result.imported > 0 ? `已迁移 ${result.imported} 项资源` : "没有可迁移的资源");
			} catch (error) {
				const message = errorMessage(error);
				updateState((current) => ({ ...current, harnessImporting: false, harnessImportsError: message }));
				showToast(message);
			}
		},
		[refreshHarnessImports, refreshSkills, refreshSubagentConfigs, showToast, updateState],
	);

	const refreshSecuritySettings = useCallback(async () => {
		updateState((current) => ({ ...current, securitySettingsLoading: true, securitySettingsError: undefined }));
		try {
			const securitySettings = await webApi.securitySettings();
			updateState((current) => ({
				...current,
				securitySettings,
				securitySettingsLoading: false,
				securitySettingsError: undefined,
			}));
		} catch (error) {
			const message = errorMessage(error);
			updateState((current) => ({ ...current, securitySettingsLoading: false, securitySettingsError: message }));
			showToast(message);
		}
	}, [showToast, updateState]);

	const saveSecuritySettings = useCallback(
		async (input: { host: string; allowedHosts: string[]; port: number; runtimePort: number; password?: string }) => {
			updateState((current) => ({ ...current, securitySettingsSaving: true, securitySettingsError: undefined }));
			try {
				const result = await webApi.saveSecuritySettings(input);
				if (input.password?.trim()) webApi.setToken(input.password);
				updateState((current) => ({
					...current,
					securitySettings: result,
					securitySettingsSaving: false,
					securitySettingsError: undefined,
				}));
				showToast("安全与访问设置已保存，Gateway 正在重启；Runtime 会话不会停止");
			} catch (error) {
				const message = errorMessage(error);
				updateState((current) => ({ ...current, securitySettingsSaving: false, securitySettingsError: message }));
				showToast(message);
			}
		},
		[showToast, updateState],
	);

	const saveBranding = useCallback(
		async (input: { name: string; logo?: string | null }) => {
			updateState((current) => ({ ...current, brandingSaving: true, brandingError: undefined }));
			try {
				const branding = await webApi.saveBranding(input);
				updateState((current) => ({
					...current,
					branding,
					brandingSaving: false,
					brandingError: undefined,
				}));
				showToast("系统设置已保存");
			} catch (error) {
				const message = errorMessage(error);
				updateState((current) => ({ ...current, brandingSaving: false, brandingError: message }));
				showToast(message);
			}
		},
		[showToast, updateState],
	);

	const refreshHostInstructions = useCallback(async () => {
		updateState((current) => ({ ...current, hostInstructionsLoading: true, hostInstructionsError: undefined }));
		try {
			const result: HostInstructionsResponse = await webApi.hostInstructions();
			updateState((current) => ({
				...current,
				hostInstructions: result.instructions,
				hostInstructionsLoading: false,
				hostInstructionsError: undefined,
			}));
		} catch (error) {
			const message = errorMessage(error);
			updateState((current) => ({ ...current, hostInstructionsLoading: false, hostInstructionsError: message }));
			showToast(message);
		}
	}, [showToast, updateState]);

	const saveHostInstruction = useCallback(
		async (content: string, expectedHash?: string) => {
			updateState((current) => ({ ...current, hostInstructionSaving: true, hostInstructionsError: undefined }));
			try {
				const result = await webApi.saveHostInstruction(content, expectedHash);
				updateState((current) => ({
					...current,
					hostInstructions: result.instructions,
					hostInstructionSaving: false,
					hostInstructionsError: undefined,
					toast: "全局 AGENTS.md 已保存",
				}));
			} catch (error) {
				const message = errorMessage(error);
				if ((error as { code?: string }).code === "instruction_conflict") await refreshHostInstructions();
				updateState((current) => ({ ...current, hostInstructionSaving: false, hostInstructionsError: message }));
				showToast(message);
			}
		},
		[refreshHostInstructions, showToast, updateState],
	);

	const refreshSessionNameSettings = useCallback(async () => {
		updateState((current) => ({ ...current, sessionNameSettingsLoading: true, sessionNameSettingsError: undefined }));
		try {
			const settings = await webApi.sessionNameSettings();
			updateState((current) => ({
				...current,
				sessionNameSettings: settings,
				sessionNameSettingsLoading: false,
				sessionNameSettingsError: undefined,
			}));
		} catch (error) {
			const message = errorMessage(error);
			updateState((current) => ({
				...current,
				sessionNameSettingsLoading: false,
				sessionNameSettingsError: message,
			}));
			showToast(message);
		}
	}, [showToast, updateState]);

	const saveSessionNameSettings = useCallback(
		async (input: { model?: string; thinkingLevel: WebThinkingLevel }) => {
			updateState((current) => ({ ...current, sessionNameSettingsSaving: true, sessionNameSettingsError: undefined }));
			try {
				const settings = await webApi.saveSessionNameSettings(input);
				updateState((current) => ({
					...current,
					sessionNameSettings: settings,
					sessionNameSettingsSaving: false,
					sessionNameSettingsError: undefined,
				}));
				showToast("会话标题设置已保存");
			} catch (error) {
				const message = errorMessage(error);
				updateState((current) => ({
					...current,
					sessionNameSettingsSaving: false,
					sessionNameSettingsError: message,
				}));
				showToast(message);
			}
		},
		[showToast, updateState],
	);

	const openSettings = useCallback(
		async (tab: SettingsTab = "appearance") => {
			updateState((current) => ({ ...current, settingsOpen: true, settingsTab: tab }));
			if (tab === "models") {
				const tasks: Promise<void>[] = [];
				if (stateRef.current.models.length === 0) tasks.push(refreshModelSettings());
				if (!stateRef.current.sessionNameSettings) tasks.push(refreshSessionNameSettings());
				await Promise.all(tasks);
			}
			if (tab === "instructions") await refreshHostInstructions();
			if (tab === "skills") await refreshSkills();
			if (tab === "subagents") {
				await Promise.all([
					refreshSubagentConfigs(),
					refreshSkills(),
					stateRef.current.modelOptions.length === 0 ? refreshModelSettings() : Promise.resolve(),
				]);
			}
			if (tab === "imports") await refreshHarnessImports();
			if (tab === "security") await refreshSecuritySettings();
			if (tab === "diagnostics") {
				updateState((current) => ({ ...current, diagnostics: undefined }));
				await refreshDiagnostics();
			}
			if (tab === "about" && !stateRef.current.about) {
				const result = (await webApi.about()) as Record<string, unknown>;
				updateState((current) => ({ ...current, about: result }));
			}
		},
		[
			refreshHarnessImports,
			refreshHostInstructions,
			refreshModelSettings,
			refreshSessionNameSettings,
			refreshSecuritySettings,
			refreshSkills,
			refreshSubagentConfigs,
			refreshDiagnostics,
			updateState,
		],
	);
	const closeSettings = useCallback(
		() => updateState((current) => ({ ...current, settingsOpen: false })),
		[updateState],
	);
	const setTheme = useCallback(
		(theme: ThemeMode) => {
			applyTheme(theme);
			updateState((current) => ({ ...current, theme }));
		},
		[updateState],
	);
	const setComposerMode = useCallback(
		(composerMode: ComposerMode) => updateState((current) => ({ ...current, composerMode })),
		[updateState],
	);
	const openSubagent = useCallback(
		async (agentId: string) => {
			const sessionId = stateRef.current.sessionId;
			if (!sessionId) return;
			updateState((current) => {
				const snapshot = current.subagents.find((candidate) => candidate.agentId === agentId);
				return {
					...current,
					inspectorOpen: true,
					inspectorMode: "subagent",
					selectedSubagentId: agentId,
					subagentViews:
						current.subagentViews[agentId] || !snapshot
							? current.subagentViews
							: { ...current.subagentViews, [agentId]: createSubagentConversationState(snapshot) },
				};
			});
			try {
				await loadSubagent(agentId, sessionId);
			} catch (error) {
				showToast(errorMessage(error));
			}
		},
		[loadSubagent, showToast, updateState],
	);
	const closeSubagent = useCallback(
		() => updateState((current) => ({ ...current, selectedSubagentId: undefined, inspectorMode: "runs" })),
		[updateState],
	);
	const loadEarlierSubagentAction = useCallback(
		async () => loadEarlierSubagent(stateRef.current.selectedSubagentId ?? ""),
		[loadEarlierSubagent],
	);
	const abortSubagent = useCallback(async () => {
		const current = stateRef.current;
		if (!current.sessionId || !current.selectedSubagentId) return;
		await webApi.abortSubagent(current.sessionId, current.selectedSubagentId);
	}, []);
	const continueSubagent = useCallback(async (text: string) => {
		const current = stateRef.current;
		const normalized = text.trim();
		if (!current.sessionId || !current.selectedSubagentId || !normalized) return;
		await webApi.continueSubagent(current.sessionId, current.selectedSubagentId, normalized);
	}, []);
	const respondUiRequest = useCallback(
		async (request: UiRequestEvent, response: { value?: unknown; confirmed?: boolean; cancelled?: boolean }) => {
			await webApi.uiResponse(request.id, response);
			updateState((current) => ({
				...current,
				pendingUiRequests: current.pendingUiRequests.filter((candidate) => candidate.id !== request.id),
			}));
		},
		[updateState],
	);

	return {
		setModelProviderVisibility,
		saveModelProvider,
		removeModelProvider,
		saveProviderModel,
		setProviderModelEnabled,
		syncModelProvider,
		refreshSkills,
		refreshDiagnostics,
		restartDiagnosticService,
		toggleSkill,
		refreshHarnessImports,
		importHarnessResources,
		refreshSubagentConfigs,
		saveSubagentConfig,
		deleteSubagentConfig,
		refreshSecuritySettings,
		saveSecuritySettings,
		saveBranding,
		refreshSessionNameSettings,
		saveSessionNameSettings,
		refreshHostInstructions,
		saveHostInstruction,
		openSettings,
		closeSettings,
		setTheme,
		setComposerMode,
		openSubagent,
		closeSubagent,
		loadEarlierSubagentAction,
		abortSubagent,
		continueSubagent,
		respondUiRequest,
	};
}
