import { Check, Eye, LoaderCircle, Plus, RefreshCw, Settings } from "lucide-react";
import type { FormEvent } from "react";
import { useEffect, useMemo, useState } from "react";
import { cn } from "../../../lib/utils";
import type { WorkbenchState } from "../../../state/use-workbench";
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
import { THINKING_LEVEL_LABELS } from "../constants";
import { modelIconId, formatModelDisplayName, providerIconId } from "../model-utils";
import type { WorkbenchActions } from "../types";
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
	manualThinking: boolean;
	thinkingLevelMap: Record<string, string | null>;
	input: ("text" | "image")[];
	contextWindow: string;
	maxTokens: string;
};

const MODEL_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"] as const;
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

export function ModelSettings({ state, actions }: { state: WorkbenchState; actions: WorkbenchActions }) {
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
