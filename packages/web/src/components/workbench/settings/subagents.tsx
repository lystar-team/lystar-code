import { Bot, Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { cn } from "../../../lib/utils";
import type { SubagentConfig, WebThinkingLevel } from "../../../types";
import { Badge } from "../../ui/badge";
import { Button } from "../../ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../ui/dialog";
import { Input } from "../../ui/input";
import { Spinner } from "../../ui/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../ui/tabs";
import type { WorkbenchActions } from "../types";
import type { WorkbenchState } from "../../../state/use-workbench";
import { MonacoMarkdownEditor } from "./monaco-markdown-editor";
import { SettingSection } from "./shared";

type AgentProviderOption = { id: string; name: string };
type AgentModelOption = Pick<WorkbenchState["modelOptions"][number], "provider" | "id" | "name">;

function AgentConfigurationFields({
	className,
	draft,
	providers,
	availableModels,
	thinkingLevels,
	toolOptions,
	onChange,
}: {
	className?: string;
	draft: AgentDraft;
	providers: readonly AgentProviderOption[];
	availableModels: readonly AgentModelOption[];
	thinkingLevels: readonly WebThinkingLevel[];
	toolOptions: readonly string[];
	onChange: (draft: AgentDraft) => void;
}) {
	return (
		<div className={cn("min-h-0 space-y-5", className)}>
			<SettingSection title="基本信息">
				<div className="grid gap-3">
					<label className="grid gap-2 text-sm font-medium">
						范围
						<select className="h-9 rounded-md border border-input bg-background px-3 text-sm" value={draft.scope} onChange={(event) => onChange({ ...draft, scope: event.target.value as "user" | "project" })} disabled={Boolean(draft.source && draft.source.scope !== "builtin")}>
							<option value="user">个人</option>
							<option value="project">项目</option>
						</select>
					</label>
					<label className="grid gap-2 text-sm font-medium">
						名称
						<Input value={draft.name} onChange={(event) => onChange({ ...draft, name: event.target.value })} placeholder="review-specialist" />
					</label>
					<label className="grid gap-2 text-sm font-medium">
						描述
						<Input value={draft.description} onChange={(event) => onChange({ ...draft, description: event.target.value })} placeholder="说明该智能体负责的任务" />
					</label>
				</div>
			</SettingSection>

			<SettingSection title="模型">
				<div className="grid gap-3">
					<label className="grid gap-2 text-sm font-medium">
						供应商
						<select className="h-9 rounded-md border border-input bg-background px-3 text-sm" value={draft.provider} onChange={(event) => onChange({ ...draft, provider: event.target.value, model: "", thinkingLevel: "" })}>
							<option value="">继承当前会话</option>
							{providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.name}</option>)}
						</select>
					</label>
					<label className="grid gap-2 text-sm font-medium">
						模型
						<select className="h-9 rounded-md border border-input bg-background px-3 text-sm" value={draft.model} onChange={(event) => onChange({ ...draft, model: event.target.value, thinkingLevel: "" })} disabled={!draft.provider && !draft.model}>
							<option value="">继承当前会话</option>
							{availableModels.map((model) => <option key={`${model.provider}:${model.id}`} value={model.id}>{model.name}</option>)}
						</select>
					</label>
					<label className="grid gap-2 text-sm font-medium">
						思考强度
						<select className="h-9 rounded-md border border-input bg-background px-3 text-sm" value={draft.thinkingLevel} onChange={(event) => onChange({ ...draft, thinkingLevel: event.target.value as WebThinkingLevel | "" })}>
							<option value="">继承模型设置</option>
							{thinkingLevels.map((level) => <option key={level} value={level}>{level}</option>)}
						</select>
					</label>
				</div>
			</SettingSection>

			<SettingSection title="工具权限">
				<div className="grid gap-2">
					<div className="flex items-center justify-between gap-3">
						<p className="text-xs text-muted-foreground">不选择时允许全部工具。</p>
						<span className="shrink-0 text-xs text-muted-foreground">
							{draft.tools.length ? `已选择 ${draft.tools.length}/${toolOptions.length}` : "全部工具"}
						</span>
					</div>
					<div className="grid grid-cols-2 gap-x-3 gap-y-2 rounded-lg border border-border/70 p-3">
						{toolOptions.map((tool) => (
							<label key={tool} className="flex items-center gap-2 text-sm">
								<input type="checkbox" checked={draft.tools.includes(tool)} onChange={(event) => onChange({ ...draft, tools: event.target.checked ? [...draft.tools, tool] : draft.tools.filter((candidate) => candidate !== tool) })} />
								<span className="font-mono text-xs">{tool}</span>
							</label>
						))}
					</div>
				</div>
			</SettingSection>
		</div>
	);
}

function AgentMarkdownPanel({
	className,
	draft,
	disabled,
	onChange,
	onSave,
	theme,
}: {
	className?: string;
	draft: AgentDraft;
	disabled: boolean;
	onChange: (content: string) => void;
	onSave: () => void;
	theme: WorkbenchState["theme"];
}) {
	return (
		<div className={cn("min-w-0", className)}>
			<div className="mb-3">
				<h2 className="text-sm font-semibold">智能体正文</h2>
			</div>
			<MonacoMarkdownEditor
				className="h-[min(52dvh,420px)] md:h-[min(52dvh,520px)] lg:h-[clamp(360px,calc(100dvh-19rem),800px)]"
				disabled={disabled}
				onChange={onChange}
				onSave={onSave}
				theme={theme}
				value={draft.content}
				ariaLabel="智能体正文"
				fileName={`${draft.name || "agent"}.md`}
			/>
		</div>
	);
}

const THINKING_LEVELS: WebThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];
const DEFAULT_TOOLS = ["read", "grep", "find", "ls", "bash", "edit", "write", "mcp", "image_gen"];

interface AgentDraft {
	source?: SubagentConfig;
	scope: "user" | "project";
	name: string;
	description: string;
	provider: string;
	model: string;
	thinkingLevel: WebThinkingLevel | "";
	tools: string[];
	content: string;
}

function scopeLabel(scope: SubagentConfig["scope"]): string {
	if (scope === "builtin") return "内置";
	if (scope === "project") return "项目";
	return "个人";
}

function draftFor(config?: SubagentConfig): AgentDraft {
	return {
		source: config,
		scope: config?.scope === "project" ? "project" : "user",
		name: config?.name ?? "",
		description: config?.description ?? "",
		provider: config?.provider ?? "",
		model: config?.model ?? "",
		thinkingLevel: config?.thinkingLevel ?? "",
		tools: config?.tools ?? [],
		content: config?.content ?? "",
	};
}

export function SubagentSettings({ state, actions }: { state: WorkbenchState; actions: WorkbenchActions }) {
	const [draft, setDraft] = useState<AgentDraft>();
	const [mobileEditorTab, setMobileEditorTab] = useState<"config" | "markdown">("config");
	const providers = useMemo(() => {
		const names = new Map(state.modelOptionProviders.map((provider) => [provider.id, provider.name]));
		for (const model of state.modelOptions) if (!names.has(model.provider)) names.set(model.provider, model.provider);
		if (draft?.provider && !names.has(draft.provider)) names.set(draft.provider, draft.provider);
		return [...names.entries()].map(([id, name]) => ({ id, name }));
	}, [draft?.provider, state.modelOptionProviders, state.modelOptions]);
	const availableModels = useMemo(() => {
		const models = state.modelOptions.filter((model) => model.provider === draft?.provider);
		if (draft?.model && !models.some((model) => model.id === draft.model)) {
			return [
				...models,
				{
					provider: draft.provider,
					id: draft.model,
					name: `${draft.model}（目录中不可用）`,
					reasoning: false,
					contextWindow: 0,
					supportedThinkingLevels: [],
				},
			];
		}
		return models;
	}, [draft?.model, draft?.provider, state.modelOptions]);
	const selectedModel = availableModels.find((model) => model.id === draft?.model);
	const thinkingLevels = selectedModel?.supportedThinkingLevels.length
		? THINKING_LEVELS.filter((level) => selectedModel.supportedThinkingLevels.includes(level))
		: THINKING_LEVELS;
	const toolOptions = [...new Set([...DEFAULT_TOOLS, ...(draft?.tools ?? [])])];

	const openDraft = (config?: SubagentConfig) => {
		setDraft(draftFor(config));
		setMobileEditorTab("config");
	};

	const save = async () => {
		if (!draft) return;
		const name = draft.name.trim();
		const description = draft.description.trim();
		if (!name || !description) {
			actions.showToast("名称和描述不能为空");
			return;
		}
		if (draft.provider && !draft.model) {
			actions.showToast("选择供应商后需要选择模型");
			return;
		}
		const saved = await actions.saveSubagentConfig({
			scope: draft.scope,
			...(draft.source && draft.source.scope !== "builtin" ? { originalName: draft.source.name } : {}),
			name,
			description,
			...(draft.provider ? { provider: draft.provider } : {}),
			...(draft.model ? { model: draft.model } : {}),
			...(draft.thinkingLevel ? { thinkingLevel: draft.thinkingLevel } : {}),
			...(draft.tools.length > 0 ? { tools: draft.tools } : {}),
			content: draft.content,
			...(draft.source?.contentHash ? { expectedHash: draft.source.contentHash } : {}),
		});
		if (saved) setDraft(undefined);
	};

	const remove = async (config: SubagentConfig) => {
		if (!window.confirm(`确定删除 ${config.name} 的${scopeLabel(config.scope)}配置吗？`)) return;
		await actions.deleteSubagentConfig(config);
	};

	return (
		<div className="space-y-5">
			<div className="flex flex-wrap items-center justify-between gap-3">
				<p className="text-sm text-muted-foreground">智能体配置文件是唯一配置源。项目配置覆盖个人配置，个人配置覆盖内置配置。</p>
				<div className="flex items-center gap-2">
					<Button variant="outline" size="sm" onClick={() => void actions.refreshSubagentConfigs()} disabled={state.subagentConfigsLoading}>
						<RefreshCw className={state.subagentConfigsLoading ? "size-4 animate-spin" : "size-4"} />
						刷新
					</Button>
					<Button size="sm" onClick={() => openDraft()}>
						<Plus className="size-4" />
						新建智能体
					</Button>
				</div>
			</div>

			{state.subagentConfigsError ? (
				<div className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">{state.subagentConfigsError}</div>
			) : null}

			{state.subagentConfigsLoading && state.subagentConfigs.length === 0 ? (
				<div className="flex min-h-48 items-center justify-center rounded-xl border border-border/60">
					<Spinner className="size-5" />
				</div>
			) : state.subagentConfigs.length === 0 ? (
				<div className="rounded-xl border border-dashed border-border px-6 py-12 text-center text-sm text-muted-foreground">没有可用的智能体</div>
			) : (
				<div className="grid gap-3 md:grid-cols-2">
					{state.subagentConfigs.map((config, index) => (
						<div key={`${config.scope}:${config.name}:${index}`} className="flex min-h-44 flex-col rounded-xl border border-border/70 bg-card p-5">
							<div className="flex items-start justify-between gap-3">
								<div className="min-w-0">
									<div className="flex flex-wrap items-center gap-2">
										<Bot className="size-4 text-muted-foreground" />
										<h3 className="truncate font-semibold">{config.name}</h3>
										<Badge variant="secondary">{scopeLabel(config.scope)}</Badge>
									</div>
									<p className="mt-2 line-clamp-3 text-sm leading-6 text-muted-foreground">{config.description}</p>
								</div>
							</div>
							<div className="mt-auto flex flex-wrap items-center gap-2 pt-4 text-xs text-muted-foreground">
								{config.model ? <Badge variant="outline">{config.provider ? `${config.provider}/` : ""}{config.model}</Badge> : <span>继承当前模型</span>}
								{config.thinkingLevel ? <Badge variant="outline">思考 {config.thinkingLevel}</Badge> : null}
								<span>{config.tools?.length ? `${config.tools.length} 个工具` : "全部工具"}</span>
							</div>
							<div className="mt-4 flex justify-end gap-2 border-t border-border/60 pt-4">
								{config.editable ? (
									<Button variant="ghost" size="sm" disabled={state.subagentConfigsSaving} onClick={() => void remove(config)}>
										<Trash2 className="size-4" />
										删除
									</Button>
								) : null}
								<Button variant="outline" size="sm" onClick={() => openDraft(config)}>
									<Pencil className="size-4" />
									{config.scope === "builtin" ? "创建覆盖" : "编辑"}
								</Button>
							</div>
						</div>
					))}
				</div>
			)}

			<Dialog open={Boolean(draft)} onOpenChange={(open) => !open && setDraft(undefined)}>
				<DialogContent className="flex h-[min(92dvh,820px)] w-[min(96vw,1280px)] max-h-[92dvh] max-w-none flex-col gap-0 overflow-hidden p-0 sm:max-w-[min(96vw,1280px)]">
					<DialogHeader className="shrink-0 border-b border-border/60 px-6 py-5 pr-12">
						<DialogTitle>{draft?.source ? `${draft.source.name} 配置` : "新建智能体"}</DialogTitle>
						<DialogDescription>配置名称、运行模型、思考强度、工具权限和智能体正文。</DialogDescription>
					</DialogHeader>
					{draft ? (
						<div className="min-h-0 flex-1 overflow-hidden px-4 py-4 sm:px-6 sm:py-5">
							<Tabs
								className="flex h-full min-h-0 gap-3 lg:hidden"
								value={mobileEditorTab}
								onValueChange={(value) => setMobileEditorTab(value as "config" | "markdown")}
							>
								<TabsList className="grid h-9 w-full grid-cols-2">
									<TabsTrigger value="config">配置</TabsTrigger>
									<TabsTrigger value="markdown">Markdown</TabsTrigger>
								</TabsList>
								<TabsContent className="min-h-0 overflow-y-auto pr-1" value="config">
									<AgentConfigurationFields
										draft={draft}
										providers={providers}
										availableModels={availableModels}
										thinkingLevels={thinkingLevels}
										toolOptions={toolOptions}
										onChange={setDraft}
									/>
								</TabsContent>
								<TabsContent className="min-h-0 overflow-y-auto" value="markdown">
									<AgentMarkdownPanel
										draft={draft}
										disabled={state.subagentConfigsSaving}
										onChange={(content) => setDraft((current) => current ? { ...current, content } : current)}
										onSave={() => void save()}
										theme={state.theme}
									/>
								</TabsContent>
							</Tabs>

							<div className="hidden h-full min-h-0 gap-0 lg:grid lg:grid-cols-[minmax(280px,340px)_minmax(0,1fr)]">
								<AgentConfigurationFields
									className="overflow-y-auto border-r border-border/60 pr-5"
									draft={draft}
									providers={providers}
									availableModels={availableModels}
									thinkingLevels={thinkingLevels}
									toolOptions={toolOptions}
									onChange={setDraft}
								/>
								<AgentMarkdownPanel
									className="min-h-0 pl-5"
									draft={draft}
									disabled={state.subagentConfigsSaving}
									onChange={(content) => setDraft((current) => current ? { ...current, content } : current)}
									onSave={() => void save()}
									theme={state.theme}
								/>
							</div>
						</div>
					) : null}
					<DialogFooter className="shrink-0 border-t border-border/60 px-6 py-4">
						<Button variant="outline" onClick={() => setDraft(undefined)}>取消</Button>
						<Button disabled={state.subagentConfigsSaving} onClick={() => void save()}>
							{state.subagentConfigsSaving ? <Spinner className="size-4" /> : null}
							保存
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</div>
	);
}
