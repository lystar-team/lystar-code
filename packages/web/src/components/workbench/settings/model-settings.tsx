import { Check, Eye, ListChecks, LoaderCircle, Plus, RefreshCw, Settings, SlidersHorizontal, Trash2 } from "lucide-react";
import type { FormEvent } from "react";
import { useEffect, useMemo, useState } from "react";
import { cn } from "../../../lib/utils";
import type { WorkbenchState } from "../../../state/use-workbench";
import type { WebThinkingLevel } from "../../../types";
import { Alert, AlertDescription, AlertTitle } from "../../ui/alert";
import { Badge } from "../../ui/badge";
import { Button } from "../../ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../ui/dialog";
import { Input } from "../../ui/input";
import { ScrollArea } from "../../ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../ui/select";
import { Switch } from "../../ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../ui/tabs";
import {
	THINKING_LEVEL_LABELS,
	VISIBLE_THINKING_LEVELS,
	selectedVisibleThinkingLevel,
	visibleThinkingLevels,
} from "../constants";
import { formatModelDisplayName, providerIconId } from "../model-utils";
import type { WorkbenchActions } from "../types";
import { ModelBrandIcon } from "./model-brand-icon";
import { WorkbenchTabBar, type WorkbenchTabOption } from "../workbench-tab-bar";
import { SettingSection } from "./shared";

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
	fastModeSupported: boolean;
	manualThinking: boolean;
	thinkingLevelMap: Record<string, string | null>;
	input: ("text" | "image")[];
	contextWindow: string;
	maxTokens: string;
};

const MODEL_PROVIDER_API_OPTIONS = [
	{ value: "openai-completions", label: "OpenAI Chat Completions" },
	{ value: "openai-responses", label: "OpenAI Responses" },
	{ value: "anthropic-messages", label: "Anthropic Messages" },
	{ value: "google-generative-ai", label: "Google Generative AI" },
	{ value: "google-vertex", label: "Google Vertex AI" },
	{ value: "mistral-conversations", label: "Mistral Conversations" },
	{ value: "azure-openai-responses", label: "Azure OpenAI Responses" },
	{ value: "bedrock-converse-stream", label: "Amazon Bedrock Converse" },
	{ value: "openai-codex-responses", label: "OpenAI Codex Responses" },
	{ value: "pi-messages", label: "Pi Messages" },
] as const;

const IMAGE_MODEL_OPTIONS = [
	{ value: "gpt-image-1", label: "GPT Image 1" },
	{ value: "gpt-image-2", label: "GPT Image 2" },
	{ value: "gpt-image-2.5-flare", label: "GPT Image 2.5 Flare" },
	{ value: "gpt-image-2.5-sunburst", label: "GPT Image 2.5 Sunburst" },
] as const;

const IMAGE_PROVIDER_MODE_TABS: readonly WorkbenchTabOption<"shared" | "per-model">[] = [
	{ icon: SlidersHorizontal, label: "统一配置", value: "shared" },
	{ icon: ListChecks, label: "单独配置", value: "per-model" },
];

const FOLLOW_CURRENT_SESSION_MODEL = "__follow_current_session_model__";
const FOLLOW_CURRENT_IMAGE_PROVIDER = "__follow_current_image_provider__";
const MIXED_IMAGE_PROVIDER = "__mixed_image_provider__";

function titleModelReference(model: { provider: string; id: string }): string {
	return `${model.provider}/${model.id}`;
}

function supportedModelThinkingLevels(model: WorkbenchState["models"][number] | undefined): string[] {
	return visibleThinkingLevels(model?.supportedThinkingLevels ?? []);
}

function visibleConfiguredThinkingLevel(level: string, supportedLevels: readonly string[]): string {
	if (level === "low" && !supportedLevels.includes("low") && supportedLevels.includes("minimal")) return "minimal";
	return selectedVisibleThinkingLevel(level, supportedLevels);
}

function thinkingLevelForModel(model: WorkbenchState["models"][number] | undefined, level: WebThinkingLevel): WebThinkingLevel {
	const supported = supportedModelThinkingLevels(model);
	if (supported.length === 0 || supported.includes(level)) return level;
	if (supported.includes("low")) return "low";
	if (supported.includes("minimal")) return "minimal";
	return (supported[0] ?? "off") as WebThinkingLevel;
}

function editableThinkingLevelMap(
	model?: WorkbenchState["models"][number],
): Record<string, string | null> {
	const supported = new Set(model?.supportedThinkingLevels ?? ["off", "low", "medium", "high"]);
	const mapping: Record<string, string | null> = { ...(model?.thinkingLevelMap ?? {}), minimal: null };
	for (const level of VISIBLE_THINKING_LEVELS) {
		if (mapping[level] === undefined) mapping[level] = supported.has(level) ? level : null;
	}
	return mapping;
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

export function ModelSettings({ state, actions }: { state: WorkbenchState; actions: WorkbenchActions }) {
	const [selectedProvider, setSelectedProvider] = useState("");
	const [providerDraft, setProviderDraft] = useState<ProviderDraft | null>(null);
	const [modelDraft, setModelDraft] = useState<ModelDraft | null>(null);
	const modelSupportsFastApi = modelDraft?.api === "openai-responses" || modelDraft?.api === "openai-codex-responses";
	const [submitting, setSubmitting] = useState(false);
	const [syncingProvider, setSyncingProvider] = useState<string | null>(null);
	const [removingProvider, setRemovingProvider] = useState<string | null>(null);
	const [removeTarget, setRemoveTarget] = useState<WorkbenchState["providers"][number] | null>(null);
	const [togglingModel, setTogglingModel] = useState<string | null>(null);
	const [providerTab, setProviderTab] = useState<"custom" | "builtin">("custom");
	const [modelListProviderId, setModelListProviderId] = useState<string | null>(null);
	const [imageProviderMode, setImageProviderMode] = useState<"shared" | "per-model">("shared");
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
	const imageModelProviders = state.imageModelProviders ?? {};
	const activeImageProviders = orderedProviders.filter((provider) => provider.authenticated);
	const imageProviderOptions = [
		{ value: FOLLOW_CURRENT_IMAGE_PROVIDER, label: "跟随当前会话供应商" },
		...activeImageProviders.map((provider) => ({ value: provider.id, label: provider.name })),
	];
	const imageProviderById = new Map(imageProviderOptions.map((option) => [option.value, option.label]));
	const configuredImageProviders = IMAGE_MODEL_OPTIONS.map((option) => imageModelProviders[option.value]).filter(
		(provider): provider is string => Boolean(provider),
	);
	const sharedImageProvider =
		configuredImageProviders.length === IMAGE_MODEL_OPTIONS.length &&
		configuredImageProviders.every((provider) => provider === configuredImageProviders[0])
			? configuredImageProviders[0]
			: configuredImageProviders.length === 0
				? FOLLOW_CURRENT_IMAGE_PROVIDER
				: MIXED_IMAGE_PROVIDER;

	const modelListProvider = modelListProviderId
		? state.providers.find((provider) => provider.id === modelListProviderId)
		: undefined;
	const modelListModels = modelListProviderId
		? state.models.filter((model) => model.provider === modelListProviderId)
		: [];
	const disabledModelIds = modelListProvider?.disabledModels ?? [];
	const sessionNameModel = state.sessionNameSettings?.model;
	const sessionModelRef = state.session?.model;
	const currentSessionModel = sessionModelRef
		? state.models.find((model) => titleModelReference(model) === titleModelReference(sessionModelRef))
		: undefined;
	const configuredTitleModel = sessionNameModel
		? state.models.find((model) => titleModelReference(model) === sessionNameModel)
		: undefined;
	const effectiveTitleModel = sessionNameModel ? configuredTitleModel : currentSessionModel;
	const titleModelOptions = state.models
		.filter((model) => model.authenticated)
		.sort((left, right) => left.provider.localeCompare(right.provider) || left.name.localeCompare(right.name));
	const savedTitleThinkingLevel = state.sessionNameSettings?.thinkingLevel ?? "low";
	const titleThinkingLevels = supportedModelThinkingLevels(effectiveTitleModel);
	const selectedTitleThinkingLevel = visibleConfiguredThinkingLevel(savedTitleThinkingLevel, titleThinkingLevels);
	const titleSettingsDisabled =
		state.sessionNameSettingsLoading || state.sessionNameSettingsSaving || !state.sessionNameSettings;
	const recoveryModel = state.toolRecoverySettings?.model;
	const configuredRecoveryModel = recoveryModel
		? state.models.find((model) => titleModelReference(model) === recoveryModel)
		: undefined;
	const effectiveRecoveryModel = recoveryModel ? configuredRecoveryModel : currentSessionModel;
	const savedRecoveryThinkingLevel = state.toolRecoverySettings?.thinkingLevel ?? "low";
	const recoveryThinkingLevels = supportedModelThinkingLevels(effectiveRecoveryModel);
	const selectedRecoveryThinkingLevel = visibleConfiguredThinkingLevel(savedRecoveryThinkingLevel, recoveryThinkingLevels);
	const recoverySettingsDisabled =
		state.toolRecoverySettingsLoading || state.toolRecoverySettingsSaving || !state.toolRecoverySettings;

	useEffect(() => {
		if (providerTab === "custom" && customProviders.length === 0 && builtinProviders.length > 0)
			setProviderTab("builtin");
	}, [builtinProviders.length, customProviders.length, providerTab]);

	useEffect(() => {
		const configuredProviders = Object.values(state.imageModelProviders ?? {});
		if (
			configuredProviders.length > 0 &&
			(configuredProviders.length < IMAGE_MODEL_OPTIONS.length || new Set(configuredProviders).size > 1)
		) {
			setImageProviderMode("per-model");
		}
	}, [state.imageModelProviders]);

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
			fastModeSupported: model?.fastModeSupported ?? false,
			manualThinking: false,
			thinkingLevelMap: editableThinkingLevelMap(model),
			input: (model?.input ?? ["text"]) as ("text" | "image")[],
			contextWindow: model ? String(model.contextWindow) : "",
			maxTokens: model ? String(model.maxTokens) : "",
		});
	};

	const submitProvider = async (event: FormEvent) => {
		event.preventDefault();
		if (!providerDraft?.provider.trim() || !providerDraft.baseUrl.trim() || !providerDraft.api.trim()) return;
		setSubmitting(true);
		try {
			const providerId = providerDraft.provider.trim();
			const isNew = providerDraft.isNew;
			await actions.saveModelProvider({
				provider: providerId,
				name: providerDraft.name.trim() || undefined,
				baseUrl: providerDraft.baseUrl.trim(),
				api: providerDraft.api.trim(),
				apiKey: providerDraft.apiKey.trim() || undefined,
				catalogProvider: providerDraft.catalogProvider === "__none__" ? undefined : providerDraft.catalogProvider,
				clearCatalogProvider:
					!providerDraft.isNew && providerDraft.catalogProvider === "__none__" ? true : undefined,
			});
			if (isNew) {
				try {
					await actions.syncModelProvider(providerId);
				} catch (error) {
					actions.showToast(
						`供应商已保存，模型自动同步失败：${error instanceof Error ? error.message : String(error)}`,
					);
				}
			}
			setSelectedProvider(providerId);
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
				fastModeSupported: modelSupportsFastApi && modelDraft.fastModeSupported,
				...(modelDraft.isNew
					? { api: modelDraft.api.trim() || undefined, baseUrl: modelDraft.baseUrl.trim() || undefined }
					: {}),
				...(modelDraft.manualThinking ? { thinkingLevelMap: modelDraft.thinkingLevelMap } : {}),
				input: modelDraft.input,
				...(Number.isSafeInteger(contextWindow) && contextWindow > 0 ? { contextWindow } : {}),
				...(Number.isSafeInteger(maxTokens) && maxTokens > 0 ? { maxTokens } : {}),
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

	const confirmRemoveProvider = async () => {
		if (!removeTarget) return;
		setRemovingProvider(removeTarget.id);
		try {
			await actions.removeModelProvider(removeTarget.id);
			setRemoveTarget(null);
			if (modelListProviderId === removeTarget.id) setModelListProviderId(null);
		} catch (error) {
			actions.showToast(error instanceof Error ? error.message : String(error));
		} finally {
			setRemovingProvider(null);
		}
	};

	const toggleModelEnabled = async (providerId: string, modelId: string, enabled: boolean) => {
		setTogglingModel(`${providerId}/${modelId}`);
		try {
			await actions.setProviderModelEnabled(providerId, modelId, enabled);
		} catch (error) {
			actions.showToast(error instanceof Error ? error.message : String(error));
		} finally {
			setTogglingModel(null);
		}
	};

	return (
		<div className="grid min-w-0 gap-6 md:grid-cols-2">
			<SettingSection title="会话标题模型">
				<p className="text-sm text-muted-foreground">用于新会话的自动命名，不会更改已有会话名称。</p>
				{state.sessionNameSettingsError ? (
					<Alert variant="destructive">
						<AlertTitle>会话标题配置失败</AlertTitle>
						<AlertDescription>{state.sessionNameSettingsError}</AlertDescription>
					</Alert>
				) : null}
				{state.sessionNameSettingsLoading ? (
					<div className="flex items-center gap-2 text-sm text-muted-foreground">
						<LoaderCircle className="size-4 animate-spin" />
						正在读取会话标题设置
					</div>
				) : null}
				<Card className="min-w-0 rounded-xl py-0 shadow-none">
					<CardContent className="grid min-w-0 items-start gap-4 p-3 sm:grid-cols-[minmax(0,1.7fr)_minmax(8rem,0.8fr)]">
						<div className="grid min-w-0 gap-2">
							<label htmlFor="session-name-model" className="text-sm font-medium">标题模型</label>
							<Select
								value={sessionNameModel ?? FOLLOW_CURRENT_SESSION_MODEL}
								disabled={titleSettingsDisabled}
								onValueChange={(value) => {
									const nextModel = value === FOLLOW_CURRENT_SESSION_MODEL ? undefined : value;
									const selectedModel = nextModel
										? state.models.find((model) => titleModelReference(model) === nextModel)
										: currentSessionModel;
									void actions.saveSessionNameSettings({
										...(nextModel ? { model: nextModel } : {}),
										thinkingLevel: thinkingLevelForModel(selectedModel, savedTitleThinkingLevel),
									});
								}}
							>
								<SelectTrigger id="session-name-model" className="h-9 w-full min-w-0 overflow-hidden">
									<SelectValue className="min-w-0 flex-1 truncate" />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value={FOLLOW_CURRENT_SESSION_MODEL}>跟随当前会话模型</SelectItem>
									{sessionNameModel &&
									!titleModelOptions.some((model) => titleModelReference(model) === sessionNameModel) ? (
										<SelectItem value={sessionNameModel} disabled>
											{configuredTitleModel
											? `${formatModelDisplayName(configuredTitleModel)} · ${sessionNameModel}（未连接）`
											: `${sessionNameModel}（当前配置不可用）`}
										</SelectItem>
									) : null}
									{titleModelOptions.map((model) => (
										<SelectItem key={titleModelReference(model)} value={titleModelReference(model)}>
											{formatModelDisplayName(model)} · {titleModelReference(model)}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>
						<div className="grid min-w-0 gap-2">
							<label htmlFor="session-name-thinking-level" className="text-sm font-medium">思考强度</label>
							<Select
								value={selectedTitleThinkingLevel}
								disabled={titleSettingsDisabled || titleThinkingLevels.length === 0}
								onValueChange={(value) => {
									void actions.saveSessionNameSettings({
										...(sessionNameModel ? { model: sessionNameModel } : {}),
										thinkingLevel: value as WebThinkingLevel,
									});
								}}
							>
								<SelectTrigger id="session-name-thinking-level" className="h-9 w-full min-w-0 overflow-hidden">
									<SelectValue className="min-w-0 flex-1 truncate" />
								</SelectTrigger>
								<SelectContent>
									{!titleThinkingLevels.includes(selectedTitleThinkingLevel) ? (
										<SelectItem value={selectedTitleThinkingLevel} disabled>
											{THINKING_LEVEL_LABELS[savedTitleThinkingLevel] ?? savedTitleThinkingLevel}（当前配置）
										</SelectItem>
									) : null}
									{titleThinkingLevels.map((level) => (
										<SelectItem key={level} value={level}>
											{THINKING_LEVEL_LABELS[level] ?? level}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>
					</CardContent>
				</Card>
			</SettingSection>
			<SettingSection title="错题本模型">
				<p className="text-sm text-muted-foreground">用于提炼工具恢复经验；未指定时跟随当前会话模型。</p>
				{state.toolRecoverySettingsError ? (
					<Alert variant="destructive">
						<AlertTitle>错题本模型配置失败</AlertTitle>
						<AlertDescription>{state.toolRecoverySettingsError}</AlertDescription>
					</Alert>
				) : null}
				{state.toolRecoverySettingsLoading ? (
					<div className="flex items-center gap-2 text-sm text-muted-foreground">
						<LoaderCircle className="size-4 animate-spin" />
						正在读取错题本模型设置
					</div>
				) : null}
				<Card className="min-w-0 rounded-xl py-0 shadow-none">
					<CardContent className="grid min-w-0 items-start gap-4 p-3 sm:grid-cols-[minmax(0,1.7fr)_minmax(8rem,0.8fr)]">
						<div className="grid min-w-0 gap-2">
							<label htmlFor="tool-recovery-model" className="text-sm font-medium">提炼模型</label>
							<Select
								value={recoveryModel ?? FOLLOW_CURRENT_SESSION_MODEL}
								disabled={recoverySettingsDisabled}
								onValueChange={(value) => {
									const nextModel = value === FOLLOW_CURRENT_SESSION_MODEL ? undefined : value;
									const selectedModel = nextModel
										? state.models.find((model) => titleModelReference(model) === nextModel)
										: currentSessionModel;
									void actions.saveToolRecoverySettings({
										...(nextModel ? { model: nextModel } : {}),
										thinkingLevel: thinkingLevelForModel(selectedModel, savedRecoveryThinkingLevel),
									});
								}}
							>
								<SelectTrigger id="tool-recovery-model" className="h-9 w-full min-w-0 overflow-hidden">
									<SelectValue className="min-w-0 flex-1 truncate" />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value={FOLLOW_CURRENT_SESSION_MODEL}>跟随当前会话模型</SelectItem>
									{recoveryModel && !titleModelOptions.some((model) => titleModelReference(model) === recoveryModel) ? (
										<SelectItem value={recoveryModel} disabled>
											{configuredRecoveryModel
												? `${formatModelDisplayName(configuredRecoveryModel)} · ${recoveryModel}（未连接）`
												: `${recoveryModel}（当前配置不可用）`}
										</SelectItem>
									) : null}
									{titleModelOptions.map((model) => (
										<SelectItem key={titleModelReference(model)} value={titleModelReference(model)}>
											{formatModelDisplayName(model)} · {titleModelReference(model)}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>
						<div className="grid min-w-0 gap-2">
							<label htmlFor="tool-recovery-thinking-level" className="text-sm font-medium">思考强度</label>
							<Select
								value={selectedRecoveryThinkingLevel}
								disabled={recoverySettingsDisabled || recoveryThinkingLevels.length === 0}
								onValueChange={(value) => {
									void actions.saveToolRecoverySettings({
										...(recoveryModel ? { model: recoveryModel } : {}),
										thinkingLevel: value as WebThinkingLevel,
									});
								}}
							>
								<SelectTrigger id="tool-recovery-thinking-level" className="h-9 w-full min-w-0 overflow-hidden">
									<SelectValue className="min-w-0 flex-1 truncate" />
								</SelectTrigger>
								<SelectContent>
									{!recoveryThinkingLevels.includes(selectedRecoveryThinkingLevel) ? (
										<SelectItem value={selectedRecoveryThinkingLevel} disabled>
											{THINKING_LEVEL_LABELS[savedRecoveryThinkingLevel] ?? savedRecoveryThinkingLevel}（当前配置）
										</SelectItem>
									) : null}
									{recoveryThinkingLevels.map((level) => (
										<SelectItem key={level} value={level}>
											{THINKING_LEVEL_LABELS[level] ?? level}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>
					</CardContent>
				</Card>
			</SettingSection>
			<SettingSection title="生图模型" className="md:col-span-2">
				<Card className="min-w-0 rounded-xl py-0 shadow-none">
					<CardContent className="grid min-w-0 gap-4 p-3">
						<Tabs
							value={imageProviderMode}
							onValueChange={(value) => setImageProviderMode(value as "shared" | "per-model")}
							className="gap-3"
						>
							<WorkbenchTabBar
								activeId={imageProviderMode}
								tabs={IMAGE_PROVIDER_MODE_TABS}
								label="生图供应商配置方式"
								className="self-start"
							/>
							<TabsContent value="shared" className="grid min-w-0 gap-2 sm:max-w-md">
								<label className="text-sm font-medium" htmlFor="image-provider-shared">供应商</label>
								<Select
									value={sharedImageProvider}
									onValueChange={(value) => {
										const providers =
											value === FOLLOW_CURRENT_IMAGE_PROVIDER
												? {}
												: Object.fromEntries(IMAGE_MODEL_OPTIONS.map((option) => [option.value, value]));
										void actions.saveImageModelProviders(providers);
									}}
								>
									<SelectTrigger id="image-provider-shared" className="h-9 w-full min-w-0 overflow-hidden">
										<SelectValue placeholder="选择已生效供应商" />
									</SelectTrigger>
									<SelectContent>
										<SelectItem value={FOLLOW_CURRENT_IMAGE_PROVIDER}>跟随当前会话供应商</SelectItem>
										{sharedImageProvider === MIXED_IMAGE_PROVIDER ? (
											<SelectItem value={MIXED_IMAGE_PROVIDER} disabled>当前为单独配置</SelectItem>
										) : null}
										{sharedImageProvider !== FOLLOW_CURRENT_IMAGE_PROVIDER &&
										sharedImageProvider !== MIXED_IMAGE_PROVIDER &&
										!imageProviderById.has(sharedImageProvider) ? (
											<SelectItem value={sharedImageProvider} disabled>{sharedImageProvider}（当前配置）</SelectItem>
										) : null}
										{activeImageProviders.map((provider) => (
											<SelectItem key={provider.id} value={provider.id}>{provider.name}</SelectItem>
										))}
									</SelectContent>
								</Select>
							</TabsContent>
							<TabsContent value="per-model" className="grid min-w-0 gap-2">
								<div className="grid gap-2 sm:grid-cols-2">
									{IMAGE_MODEL_OPTIONS.map((option) => {
										const providerId = imageModelProviders[option.value];
										const provider = providerId ? state.providers.find((item) => item.id === providerId) : undefined;
										return (
											<div key={option.value} className="grid min-w-0 gap-1.5">
												<div className="flex items-center justify-between gap-2">
													<label className="truncate text-sm" htmlFor={`image-provider-${option.value}`}>{option.label}</label>
													{provider?.authenticated ? <Badge className="h-5 px-1.5 text-[10px]" variant="secondary">已连接</Badge> : null}
												</div>
												<Select
													value={providerId ?? FOLLOW_CURRENT_IMAGE_PROVIDER}
													onValueChange={(value) => {
														const providers = { ...imageModelProviders };
														if (value === FOLLOW_CURRENT_IMAGE_PROVIDER) delete providers[option.value];
														else providers[option.value] = value;
														void actions.saveImageModelProviders(providers);
													}}
												>
													<SelectTrigger id={`image-provider-${option.value}`} className="h-9 w-full min-w-0 overflow-hidden">
														<SelectValue />
													</SelectTrigger>
													<SelectContent>
														<SelectItem value={FOLLOW_CURRENT_IMAGE_PROVIDER}>跟随当前会话供应商</SelectItem>
														{providerId && !imageProviderById.has(providerId) ? (
															<SelectItem value={providerId} disabled>{providerId}（当前配置）</SelectItem>
														) : null}
														{activeImageProviders.map((item) => (
															<SelectItem key={item.id} value={item.id}>{item.name}</SelectItem>
														))}
													</SelectContent>
												</Select>
											</div>
										);
									})}
								</div>
							</TabsContent>
						</Tabs>
					</CardContent>
				</Card>
			</SettingSection>
			<SettingSection title="模型供应商" className="md:col-span-2">
				<div className="flex min-w-0 flex-col items-stretch justify-between gap-3 sm:flex-row sm:items-center">
					<p className="text-sm text-muted-foreground">管理供应商、目录来源和在模型选择器中的显示状态。</p>
					<Button size="sm" onClick={() => openProvider()}>
						<Plus className="size-4" />
						添加供应商
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
					<TabsList className="!flex-row h-9 w-fit max-w-full flex-nowrap overflow-x-auto">
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
															"!py-1 min-w-0 shadow-none transition-colors",
											activeProvider === provider.id && "border-primary/50 bg-accent/30",
											!visible && "opacity-65",
										)}
									>
										<CardContent className="flex flex-col items-stretch gap-3 p-2 sm:flex-row sm:items-center">
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
											<div className="flex min-w-0 flex-wrap items-center justify-end gap-1 sm:shrink-0">
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
															{provider.custom || provider.hasCustomConfig ? (
																<Button
																	size="icon"
																	variant="ghost"
																	onClick={() => setRemoveTarget(provider)}
																	aria-label={
																		provider.custom ? `删除 ${provider.id}` : `清除 ${provider.id} 的自定义配置`
																	}
																	title={provider.custom ? "删除供应商" : "清除自定义配置"}
																>
																	<Trash2 className="size-4" />
																</Button>
															) : null}
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
				<DialogContent className="w-[calc(100%-1rem)] max-w-[calc(100%-1rem)] max-h-[min(720px,calc(100vh-2rem))] overflow-hidden sm:max-w-2xl">
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
							{modelListModels.length || disabledModelIds.length ? (
								<>
									{modelListModels.map((model) => (
										<div
											key={`${model.provider}/${model.id}`}
											className="flex items-center gap-2 rounded-md px-2 py-2 hover:bg-accent/60"
										>
											<ModelBrandIcon providerId={model.provider} modelId={model.id} name={model.name} small />
											<div className="min-w-0 flex-1">
												<p className="truncate text-sm font-medium">{formatModelDisplayName(model)}</p>
												<p className="truncate font-mono text-xs text-muted-foreground">{model.id}</p>
												<p className="mt-1 text-xs text-muted-foreground">
													上下文 {model.contextWindow.toLocaleString()} · 最大输出 {model.maxTokens.toLocaleString()} ·{" "}
													{model.reasoning ? "支持思考" : "普通模型"}
													{model.capabilitiesPending ? " · 部分能力待补充" : ""}
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
												<div className="flex items-center gap-1 px-1" title="启用后显示在模型选择器">
													<Switch
														className="h-5 w-10"
														checked
														disabled={togglingModel === `${model.provider}/${model.id}`}
														onCheckedChange={(checked) => void toggleModelEnabled(model.provider, model.id, checked)}
														aria-label={`禁用 ${model.id}`}
													/>
												</div>
											</div>
										</div>
									))}
									{disabledModelIds.length ? (
										<p className="px-2 pt-3 pb-1 text-xs font-medium text-muted-foreground">已禁用</p>
									) : null}
									{disabledModelIds.map((modelId) => (
										<div
											key={modelId}
											className="flex items-center gap-2 rounded-md px-2 py-2 opacity-65 hover:bg-accent/60"
										>
											<MonochromeProviderIcon providerId={modelListProviderId ?? ""} small />
											<div className="min-w-0 flex-1">
												<p className="truncate font-mono text-sm font-medium">{modelId}</p>
												<p className="mt-1 text-xs text-muted-foreground">已禁用，不显示在模型选择器</p>
											</div>
											<div className="flex shrink-0 items-center gap-1">
												<div className="flex items-center gap-1 px-1" title="启用后显示在模型选择器">
													<Switch
														className="h-5 w-10"
														checked={false}
														disabled={togglingModel === `${modelListProviderId}/${modelId}`}
														onCheckedChange={(checked) =>
															void toggleModelEnabled(modelListProviderId ?? "", modelId, checked)
														}
														aria-label={`启用 ${modelId}`}
													/>
												</div>
											</div>
										</div>
									))}
								</>
							) : (
								<div className="py-10 text-center text-sm text-muted-foreground">当前供应商暂无模型</div>
							)}
						</div>
					</ScrollArea>
				</DialogContent>
			</Dialog>
			<Dialog
				open={Boolean(removeTarget)}
				onOpenChange={(open) => {
					if (!open) setRemoveTarget(null);
				}}
			>
				<DialogContent className="w-[calc(100%-1rem)] max-w-[calc(100%-1rem)] sm:max-w-md">
					<DialogHeader>
						<DialogTitle>{removeTarget?.custom ? "删除模型 Provider" : "清除自定义配置"}</DialogTitle>
						<DialogDescription>
							{removeTarget?.custom
								? `将删除 ${removeTarget.name}（${removeTarget.id}）及其模型配置，并清除已保存的登录状态。`
								: `将移除 ${removeTarget?.name ?? ""}（${removeTarget?.id ?? ""}）的 baseUrl、API Key 与模型配置，恢复内置默认值，不影响已保存的登录状态。`}
						</DialogDescription>
					</DialogHeader>
					<DialogFooter>
						<Button type="button" variant="outline" onClick={() => setRemoveTarget(null)}>
							取消
						</Button>
						<Button
							type="button"
							variant="destructive"
							onClick={() => void confirmRemoveProvider()}
							disabled={removingProvider !== null}
						>
							{removingProvider ? <LoaderCircle className="size-4 animate-spin" /> : null}
							{removeTarget?.custom ? "删除" : "清除"}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
			<Dialog
				open={Boolean(providerDraft)}
				onOpenChange={(open) => {
					if (!open) setProviderDraft(null);
				}}
			>
				<DialogContent className="w-[calc(100%-1rem)] max-w-[calc(100%-1rem)] max-h-[min(720px,calc(100vh-2rem))] overflow-y-auto sm:max-w-lg">
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
									供应商类型
								</label>
								<Select
									value={providerDraft.api}
									onValueChange={(value) => setProviderDraft({ ...providerDraft, api: value })}
								>
									<SelectTrigger id="provider-api" className="w-full">
										<SelectValue placeholder="选择供应商类型" />
									</SelectTrigger>
									<SelectContent>
										{!MODEL_PROVIDER_API_OPTIONS.some((option) => option.value === providerDraft.api) ? (
											<SelectItem value={providerDraft.api}>{providerDraft.api}（当前配置）</SelectItem>
										) : null}
										{MODEL_PROVIDER_API_OPTIONS.map((option) => (
											<SelectItem key={option.value} value={option.value}>
												{option.label}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
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
				<DialogContent className="w-[calc(100%-1rem)] max-w-[calc(100%-1rem)] max-h-[min(720px,calc(100vh-2rem))] overflow-y-auto sm:max-w-lg">
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
							<div className="grid gap-3 sm:grid-cols-3">
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
								<label className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm" title={!modelSupportsFastApi ? "仅 OpenAI Responses 或 Codex Responses 接口可用" : undefined}>
									<input
										type="checkbox"
										checked={modelSupportsFastApi && modelDraft.fastModeSupported}
										disabled={!modelSupportsFastApi}
										onChange={(event) => setModelDraft({ ...modelDraft, fastModeSupported: event.target.checked })}
									/>
									支持快速模式
								</label>
							</div>
							<div className="grid gap-2">
								<div className="flex items-center justify-between">
									<span className="text-sm font-medium">思考强度映射</span>
									<Button
										type="button"
										size="sm"
										variant="ghost"
										onClick={() => {
											if (modelDraft.manualThinking) {
												const model = state.models.find(
													(candidate) =>
														candidate.provider === modelDraft.provider && candidate.id === modelDraft.id,
												);
												setModelDraft({
													...modelDraft,
													manualThinking: false,
													thinkingLevelMap: editableThinkingLevelMap(model),
												});
												return;
											}
											setModelDraft({ ...modelDraft, manualThinking: true });
										}}
									>
										{modelDraft.manualThinking ? "取消修改" : "手工设置"}
									</Button>
								</div>
								{modelDraft.manualThinking ? (
									<div className="flex flex-wrap gap-2">
										{VISIBLE_THINKING_LEVELS.map((level) => {
											const selected = modelDraft.thinkingLevelMap[level] !== null;
											return (
												<Button
													type="button"
													key={level}
													size="sm"
													variant={selected ? "default" : "outline"}
													aria-pressed={selected}
													onClick={() =>
														setModelDraft({
															...modelDraft,
															thinkingLevelMap: {
																...modelDraft.thinkingLevelMap,
																[level]: selected ? null : level,
															},
														})
													}
												>
													{selected ? <Check className="size-3.5" /> : null}
													{THINKING_LEVEL_LABELS[level]}
												</Button>
											);
										})}
									</div>
								) : (
									<p className="text-xs text-muted-foreground">
										当前使用模型目录中的能力；需要调整时再进入手工设置。
									</p>
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
