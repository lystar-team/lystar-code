import { BrainCircuit, FileText, Layers3, Pencil, Plus, RefreshCw, Trash2, UploadCloud, UserRound, Wrench, X } from "lucide-react";
import { useMemo, useState } from "react";
import { cn } from "../../../lib/utils";
import type { SubagentConfig, WebThinkingLevel } from "../../../types";
import { Badge } from "../../ui/badge";
import { Button } from "../../ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "../../ui/popover";
import { Input } from "../../ui/input";
import { Spinner } from "../../ui/spinner";
import { DEFAULT_ROOM_NICKNAMES, readRoomNicknamePool, saveRoomNicknamePool } from "../room-agent-identity";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../ui/tabs";
import type { WorkbenchActions } from "../types";
import { AgentIdentityIcon, AGENT_ICON_OPTIONS } from "../collaboration-session";
import { AgentTagList } from "../agent-profile-card";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../../ui/tooltip";
import type { WorkbenchState } from "../../../state/use-workbench";
import { MonacoMarkdownEditor } from "./monaco-markdown-editor";
import { SettingSection } from "./shared";

type AgentProviderOption = { id: string; name: string };
type AgentModelOption = Pick<WorkbenchState["modelOptions"][number], "provider" | "id" | "name">;

function sanitizeSvg(svg: string): string {
	const document = new DOMParser().parseFromString(svg, "image/svg+xml");
	if (document.querySelector("parsererror")) throw new Error("SVG 文件格式无效");
	document.querySelectorAll("script, foreignObject").forEach((element) => element.remove());
	for (const element of document.querySelectorAll("*")) {
		for (const attribute of [...element.attributes]) {
			if (/^on/u.test(attribute.name) || ((attribute.name === "href" || attribute.name.endsWith(":href")) && /^https?:/u.test(attribute.value))) {
				element.removeAttribute(attribute.name);
			}
		}
	}
	return new XMLSerializer().serializeToString(document.documentElement);
}

function svgDataUrl(svg: string): string {
	return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(sanitizeSvg(svg))}`;
}

function AgentIconPicker({
	value,
	onChange,
}: {
	value: string;
	onChange: (value: string) => void;
}) {
	const [open, setOpen] = useState(false);
	const [iconError, setIconError] = useState<string>();

	const uploadIcon = (file: File | undefined) => {
		if (!file) return;
		if (file.type !== "image/svg+xml" && !file.name.toLowerCase().endsWith(".svg")) {
			setIconError("只支持 SVG 图标");
			return;
		}
		const reader = new FileReader();
		reader.onload = () => {
			try {
				const nextIcon = svgDataUrl(String(reader.result ?? ""));
				if (nextIcon.length > 4096) throw new Error("SVG 文件过大，请压缩后再上传");
				onChange(nextIcon);
				setIconError(undefined);
				setOpen(false);
			} catch (error) {
				setIconError(error instanceof Error ? error.message : "SVG 图标读取失败");
			}
		};
		reader.readAsText(file);
	};

	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger asChild>
				<button
					aria-label="选择智能体图标"
					className="grid size-12 shrink-0 place-items-center rounded-xl bg-background text-foreground shadow-sm transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
					title="选择图标"
					type="button"
				>
					<AgentIdentityIcon iconKey={value} className="size-6 object-contain" />
				</button>
			</PopoverTrigger>
			<PopoverContent align="start" className="w-80 p-3" side="right">
				<div className="grid gap-3">
					<div className="text-xs font-medium text-muted-foreground">选择图标</div>
					<TooltipProvider delayDuration={180}>
						<div className="grid max-h-64 grid-cols-7 gap-1 overflow-y-auto pr-1">
							{AGENT_ICON_OPTIONS.map((option) => {
								const Icon = option.icon;
								const selected = value === option.value;
								return (
									<Tooltip key={option.value}>
										<TooltipTrigger asChild>
											<button
												aria-label={option.label}
												aria-pressed={selected}
												className={cn(
													"grid size-9 place-items-center rounded-md border text-muted-foreground transition-colors",
													"hover:border-foreground/30 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
													selected && "border-foreground bg-muted text-foreground",
												)}
												onClick={() => {
														onChange(option.value);
														setOpen(false);
													}}
												type="button"
											>
												<Icon className="size-4" aria-hidden="true" />
											</button>
										</TooltipTrigger>
										<TooltipContent>{option.label}</TooltipContent>
									</Tooltip>
								);
							})}
						</div>
					</TooltipProvider>
					<label className="inline-flex cursor-pointer items-center justify-center gap-2 rounded-md border border-border/70 px-3 py-2 text-xs font-medium hover:bg-muted">
						<UploadCloud className="size-3.5" aria-hidden="true" />
						上传 SVG
						<input
							accept="image/svg+xml,.svg"
							className="sr-only"
							type="file"
							onChange={(event) => {
								uploadIcon(event.target.files?.[0]);
								event.currentTarget.value = "";
							}}
						/>
					</label>
					{iconError ? <span className="text-xs text-destructive" role="alert">{iconError}</span> : null}
				</div>
			</PopoverContent>
		</Popover>
	);
}

function AgentTagEditor({
	tags,
	onChange,
}: {
	tags: string[];
	onChange: (tags: string[]) => void;
}) {
	const [input, setInput] = useState("");

	const addTags = (value: string) => {
		const nextTags = value
			.split(/[,，、\n]/u)
			.map((tag) => tag.trim())
			.filter(Boolean);
		if (!nextTags.length) return;
		onChange([...new Set([...tags, ...nextTags])].slice(0, 12));
		setInput("");
	};

	return (
		<div className="grid gap-2 text-sm font-medium">
			<span>擅长标签</span>
			<div className="flex min-h-10 min-w-0 flex-wrap items-center gap-1.5 rounded-md border border-input bg-background px-2 py-1.5 focus-within:ring-2 focus-within:ring-ring">
				{tags.map((tag) => (
					<span className="inline-flex max-w-full items-center gap-1 rounded-full bg-muted px-2 py-1 text-xs" key={tag}>
						<span className="max-w-48 truncate" title={tag}>{tag}</span>
						<button
							aria-label={`移除标签 ${tag}`}
							className="grid size-4 shrink-0 place-items-center rounded-full text-muted-foreground hover:bg-background hover:text-foreground"
							onClick={() => onChange(tags.filter((candidate) => candidate !== tag))}
							type="button"
						>
							<X className="size-3" aria-hidden="true" />
						</button>
					</span>
				))}
				<input
					aria-label="添加擅长标签"
					className="h-7 min-w-32 flex-1 bg-transparent px-1 text-sm outline-none placeholder:text-muted-foreground"
					placeholder={tags.length ? "继续添加标签" : "输入标签后按 Enter"}
					value={input}
					onChange={(event) => setInput(event.target.value)}
					onKeyDown={(event) => {
						if (event.key === "Enter" || event.key === "," || event.key === "，") {
							event.preventDefault();
							addTags(input);
						}
						if (event.key === "Backspace" && !input && tags.length) onChange(tags.slice(0, -1));
					}}
				/>
			</div>
			<span className="text-xs font-normal text-muted-foreground">每个智能体可添加多个标签，添加到 Room 时会显示这些标签。</span>
		</div>
	);
}

function AgentConfigurationFields({
	className,
	section,
	draft,
	providers,
	availableModels,
	thinkingLevels,
	toolOptions,
	skillOptions,
	onChange,
}: {
	className?: string;
	section: Exclude<AgentEditorSection, "content">;
	draft: AgentDraft;
	providers: readonly AgentProviderOption[];
	availableModels: readonly AgentModelOption[];
	thinkingLevels: readonly WebThinkingLevel[];
	toolOptions: readonly string[];
	skillOptions: Readonly<WorkbenchState["skills"]>;
	onChange: (draft: AgentDraft) => void;
}) {
	return (
		<div className={cn("min-h-0 space-y-5", className)}>
			{section === "basic" ? (
				<SettingSection id="agent-config-basic" title="基本信息">
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
						<AgentTagEditor tags={draft.tags} onChange={(tags) => onChange({ ...draft, tags })} />
					</div>
				</SettingSection>
			) : null}

			{section === "runtime" ? (
				<SettingSection id="agent-config-runtime" title="模型与运行">
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
			) : null}

			{section === "tools" ? (
				<SettingSection id="agent-config-tools" title="工具权限">
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
			) : null}

			{section === "skills" ? (
				<SettingSection id="agent-config-skills" title="Skill">
				<div className="grid gap-2">
					<div className="flex items-center justify-between gap-3">
						<p className="text-xs text-muted-foreground">不选择时沿用项目可用 Skill；选择后只加载勾选项。</p>
						<span className="shrink-0 text-xs text-muted-foreground">
							{draft.skills.length ? `已选择 ${draft.skills.length}/${skillOptions.length}` : "沿用项目配置"}
						</span>
					</div>
					{skillOptions.length ? (
						<div className="grid gap-2 rounded-lg border border-border/70 p-3">
							{skillOptions.map((skill) => (
								<label key={skill.name} className="flex items-start gap-2 text-sm">
									<input
										className="mt-0.5"
										type="checkbox"
										checked={draft.skills.includes(skill.name)}
										onChange={(event) =>
											onChange({
											...draft,
											skills: event.target.checked
												? [...draft.skills, skill.name]
												: draft.skills.filter((candidate) => candidate !== skill.name),
										})
										}
									/>
									<span className="min-w-0">
										<span className="block font-medium">{skill.name}</span>
										<span className="block truncate text-xs text-muted-foreground">{skill.description}</span>
									</span>
								</label>
							))}
						</div>
					) : (
						<div className="rounded-lg border border-dashed border-border px-3 py-4 text-xs text-muted-foreground">当前项目没有可选 Skill</div>
					)}
				</div>
				</SettingSection>
			) : null}
		</div>
	);
}

function NicknameLibrarySettings() {
	const [draft, setDraft] = useState(() => readRoomNicknamePool());
	const [input, setInput] = useState("");
	const [saved, setSaved] = useState(false);

	const addNickname = () => {
		const nickname = input.trim();
		if (!nickname || draft.includes(nickname)) return;
		setDraft((current) => [...current, nickname]);
		setInput("");
	};

	const save = () => {
		const nicknames = saveRoomNicknamePool(draft);
		setDraft(nicknames);
		setSaved(true);
		window.setTimeout(() => setSaved(false), 1800);
	};

	return (
		<SettingSection id="agent-nickname-pool" title="Room 协作昵称">
			<div className="grid gap-3">
				<p className="text-sm leading-6 text-muted-foreground">为 Room 成员准备可复用的昵称。Agent 加入 Room 后会从未占用的昵称中分配。</p>
				<div className="flex min-h-11 min-w-0 flex-wrap items-center gap-1.5 rounded-lg border border-input bg-background px-2 py-1.5 focus-within:ring-2 focus-within:ring-ring">
					{draft.map((nickname) => (
						<span className="inline-flex max-w-full items-center gap-1 rounded-full bg-muted px-2.5 py-1 text-sm" key={nickname}>
							<span className="max-w-48 truncate" title={nickname}>{nickname}</span>
							<button
								aria-label={`移除昵称 ${nickname}`}
								className="grid size-4 shrink-0 place-items-center rounded-full text-muted-foreground hover:bg-background hover:text-foreground"
								onClick={() => setDraft((current) => current.filter((candidate) => candidate !== nickname))}
								type="button"
							>
								<X className="size-3" aria-hidden="true" />
							</button>
						</span>
					))}
					<input
						aria-label="添加 Room 协作昵称"
						className="h-8 min-w-40 flex-1 bg-transparent px-1 text-sm outline-none placeholder:text-muted-foreground"
						placeholder="输入昵称后按 Enter 添加"
						value={input}
						onChange={(event) => setInput(event.target.value)}
						onKeyDown={(event) => {
							if (event.key === "Enter") {
								event.preventDefault();
								addNickname();
							}
						}}
					/>
				</div>
				<div className="flex flex-wrap items-center justify-between gap-3">
					<span className="text-xs text-muted-foreground">{draft.length} 个昵称 · 保存后对新加入的 Agent 生效</span>
					<div className="flex items-center gap-2">
						<Button size="sm" variant="ghost" onClick={() => setDraft([...DEFAULT_ROOM_NICKNAMES])}>恢复默认</Button>
						<Button size="sm" onClick={save}>{saved ? "已保存" : "保存昵称库"}</Button>
					</div>
				</div>
			</div>
		</SettingSection>
	);
}

type AgentEditorSection = "basic" | "runtime" | "tools" | "skills" | "content";

const AGENT_EDITOR_SECTIONS: Array<{ id: AgentEditorSection; label: string; icon: typeof UserRound }> = [
	{ id: "basic", label: "基本信息", icon: UserRound },
	{ id: "runtime", label: "模型与运行", icon: BrainCircuit },
	{ id: "tools", label: "工具权限", icon: Wrench },
	{ id: "skills", label: "Skill", icon: Layers3 },
	{ id: "content", label: "智能体正文", icon: FileText },
];

function AgentEditorSidebar({
	draft,
	activeSection,
	onNavigate,
	onIconChange,
}: {
	draft: AgentDraft;
	activeSection: AgentEditorSection;
	onNavigate: (section: AgentEditorSection) => void;
	onIconChange: (icon: string) => void;
}) {
	return (
		<aside className="min-h-0 overflow-y-auto border-r border-border/60 pr-5">
			<div className="rounded-xl border border-border/70 bg-muted/20 p-4">
				<div className="flex items-start gap-3">
					<AgentIconPicker value={draft.icon} onChange={onIconChange} />
					<div className="min-w-0">
						<p className="truncate font-semibold">{draft.name || "未命名智能体"}</p>
						<p className="mt-1 line-clamp-3 text-xs leading-5 text-muted-foreground">
							{draft.description || "填写描述，说明该智能体负责的任务。"}
						</p>
					</div>
				</div>
				<AgentTagList className="mt-3" tags={draft.tags} />
			</div>
			<nav className="mt-4 grid gap-1" aria-label="智能体配置分区" role="tablist" aria-orientation="vertical">
				{AGENT_EDITOR_SECTIONS.map(({ id, label, icon: Icon }) => (
					<Button
						aria-selected={activeSection === id}
						className={cn("justify-start gap-2 px-3 text-sm", activeSection === id && "bg-muted text-foreground")}
						key={id}
						onClick={() => onNavigate(id)}
						role="tab"
						variant="ghost"
					>
						<Icon className="size-4 text-muted-foreground" aria-hidden="true" />
						{label}
					</Button>
				))}
			</nav>
		</aside>
	);
}

function AgentMarkdownPanel({
	className,
	id,
	draft,
	disabled,
	onChange,
	onSave,
	theme,
}: {
	className?: string;
	id?: string;
	draft: AgentDraft;
	disabled: boolean;
	onChange: (content: string) => void;
	onSave: () => void;
	theme: WorkbenchState["theme"];
}) {
	return (
		<div id={id} className={cn("min-w-0", className)}>
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
	skills: string[];
	tags: string[];
	icon: string;
	content: string;
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
		skills: config?.skills ?? [],
		tags: config?.tags ?? [],
		icon: config?.icon ?? "general",
		content: config?.content ?? "",
	};
}

export function SubagentSettings({ state, actions }: { state: WorkbenchState; actions: WorkbenchActions }) {
	const [draft, setDraft] = useState<AgentDraft>();
	const [editorSection, setEditorSection] = useState<AgentEditorSection>("basic");
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
	const skillOptions = state.skills.filter((skill) => skill.eligible && skill.enabled);

	const openDraft = (config?: SubagentConfig) => {
		setDraft(draftFor(config));
		setEditorSection("basic");
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
			...(draft.icon ? { icon: draft.icon } : {}),
			...(draft.tools.length > 0 ? { tools: draft.tools } : {}),
			...(draft.skills.length > 0 ? { skills: draft.skills } : {}),
			...(draft.tags.length > 0 ? { tags: draft.tags } : {}),
			content: draft.content,
			...(draft.source?.contentHash ? { expectedHash: draft.source.contentHash } : {}),
		});
		if (saved) setDraft(undefined);
	};

	const remove = async (config: SubagentConfig) => {
		if (!window.confirm(`确定删除 ${config.name} 配置吗？`)) return;
		await actions.deleteSubagentConfig(config);
	};

	return (
		<div className="space-y-5">
			<NicknameLibrarySettings />
			<div className="flex flex-wrap items-center justify-between gap-3">
				<p className="text-sm text-muted-foreground">智能体配置文件是唯一配置源。名称、描述、标签和运行参数会用于识别与启动 Agent。</p>
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
									<div className="flex min-w-0 items-center gap-2">
										<AgentIdentityIcon iconKey={config.icon} className="size-4 shrink-0 object-contain text-muted-foreground" />
										<h3 className="min-w-0 truncate font-semibold">{config.name}</h3>
									</div>
									<p className="mt-2 line-clamp-3 text-sm leading-6 text-muted-foreground">{config.description}</p>
									<AgentTagList className="mt-3" tags={config.tags} />
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
										编辑
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
						<DialogDescription>配置名称、擅长标签、运行模型、工具权限和智能体正文。</DialogDescription>
					</DialogHeader>
					{draft ? (
						<div className="min-h-0 flex-1 overflow-hidden px-4 py-4 sm:px-6 sm:py-5">
							<Tabs
								className="flex h-full min-h-0 gap-3 lg:hidden"
								value={editorSection}
							onValueChange={(value) => setEditorSection(value as AgentEditorSection)}
							>
								<TabsList className="w-full justify-start overflow-x-auto" variant="line">
									{AGENT_EDITOR_SECTIONS.map(({ id, label, icon: Icon }) => (
										<TabsTrigger className="min-w-max px-3" key={id} value={id}>
											<Icon className="size-4" aria-hidden="true" />
											{label}
										</TabsTrigger>
									))}
								</TabsList>
								{AGENT_EDITOR_SECTIONS.map(({ id }) => (
									<TabsContent className="min-h-0 overflow-y-auto pr-1" key={id} value={id}>
										{id === "content" ? (
											<AgentMarkdownPanel
												draft={draft}
												disabled={state.subagentConfigsSaving}
												onChange={(content) => setDraft((current) => current ? { ...current, content } : current)}
												onSave={() => void save()}
												theme={state.theme}
											/>
										) : (
											<AgentConfigurationFields
												section={id}
												draft={draft}
												providers={providers}
												availableModels={availableModels}
												thinkingLevels={thinkingLevels}
												toolOptions={toolOptions}
												skillOptions={skillOptions}
												onChange={setDraft}
											/>
										)}
									</TabsContent>
								))}
							</Tabs>

							<div className="hidden h-full min-h-0 gap-0 lg:grid lg:grid-cols-[280px_minmax(0,1fr)]">
								<AgentEditorSidebar
									activeSection={editorSection}
									draft={draft}
									onIconChange={(icon) => setDraft((current) => current ? { ...current, icon } : current)}
									onNavigate={setEditorSection}
								/>
								<div className="min-h-0 overflow-y-auto pl-6 pr-2">
									{editorSection === "content" ? (
										<AgentMarkdownPanel
											draft={draft}
											disabled={state.subagentConfigsSaving}
											onChange={(content) => setDraft((current) => current ? { ...current, content } : current)}
											onSave={() => void save()}
											theme={state.theme}
										/>
									) : (
										<AgentConfigurationFields
											section={editorSection}
											draft={draft}
											providers={providers}
											availableModels={availableModels}
											thinkingLevels={thinkingLevels}
											toolOptions={toolOptions}
											skillOptions={skillOptions}
											onChange={setDraft}
										/>
									)}
								</div>
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
