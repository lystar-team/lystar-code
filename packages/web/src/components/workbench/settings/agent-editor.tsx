import { ArrowLeft, FileText, Layers3, Settings2, Wrench } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { WorkbenchState } from "../../../state/use-workbench";
import type { SubagentConfig, WebSessionWorkspaceMode, WebThinkingLevel } from "../../../types";
import { Button } from "../../ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../ui/dialog";
import { Input } from "../../ui/input";
import { Spinner } from "../../ui/spinner";
import { Tabs, TabsContent } from "../../ui/tabs";
import { WORKSPACE_MODE_DESCRIPTIONS, WORKSPACE_MODE_LABELS } from "../session-workspaces";
import type { WorkbenchActions } from "../types";
import { WorkbenchTabBar } from "../workbench-tab-bar";
import { AgentCapabilityPicker } from "./agent-capability-picker";
import { AgentIconPicker, AgentTagEditor } from "./agent-identity-editor";
import { AgentToolPermissions, type AgentToolSelection } from "./agent-tool-permissions";
import { MonacoMarkdownEditor } from "./monaco-markdown-editor";
import { SettingSection } from "./shared";
import { AGENT_THINKING_LEVELS, thinkingLevelAfterModelChange } from "./subagent-model-selection";

export type AgentLeaveGuard = (leave: () => void) => void;

type AgentDraft = AgentToolSelection & {
	scope: "user" | "project";
	name: string;
	description: string;
	provider: string;
	model: string;
	thinkingLevel: WebThinkingLevel | "";
	workspaceMode: WebSessionWorkspaceMode;
	skills: string[];
	skillMode: "default" | "selected";
	tags: string[];
	icon: string;
	content: string;
};

const SECTIONS = [
	{ value: "identity", label: "职责与提示词", icon: FileText },
	{ value: "runtime", label: "运行配置", icon: Settings2 },
	{ value: "tools", label: "工具权限", icon: Wrench },
	{ value: "skills", label: "技能", icon: Layers3 },
];
const SELECT_CLASS =
	"h-10 w-full min-w-0 rounded-md border border-input bg-background px-3 text-sm focus-visible:ring-2 focus-visible:ring-ring";

export function AgentEditor({
	config,
	defaultScope = "user",
	state,
	actions,
	onClose,
	onLeaveGuardChange,
}: {
	config?: SubagentConfig;
	defaultScope?: SubagentConfig["scope"];
	state: WorkbenchState;
	actions: WorkbenchActions;
	onClose: () => void;
	onLeaveGuardChange: (guard: AgentLeaveGuard | undefined) => void;
}) {
	const [initial] = useState<AgentDraft>(() => ({
		scope: config?.scope ?? defaultScope,
		name: config?.name ?? "",
		description: config?.description ?? "",
		provider: config?.provider ?? "",
		model: config?.model ?? "",
		thinkingLevel: config?.thinkingLevel ?? "",
		workspaceMode: config?.workspaceMode ?? "direct",
		tools: config?.tools ?? [],
		excludeTools: config?.excludeTools ?? [],
		toolMode: config?.excludeTools?.length ? "deny" : config?.tools?.length ? "allow" : "default",
		skills: config?.skills ?? [],
		skillMode: config?.skills?.length ? "selected" : "default",
		tags: config?.tags ?? [],
		icon: config?.icon ?? "general",
		content: config?.content ?? "",
	}));
	const [draft, setDraft] = useState(initial);
	const [section, setSection] = useState("identity");
	const [saveAttempted, setSaveAttempted] = useState(false);
	const [saveError, setSaveError] = useState<string>();
	const [leave, setLeave] = useState<() => void>();
	const submitting = useRef(false);
	const [saving, setSaving] = useState(false);
	const readOnly = Boolean(config && !config.editable);
	const busy = saving || state.subagentConfigsSaving;
	const dirty = JSON.stringify(draft) !== JSON.stringify(initial);
	const guard = useCallback<AgentLeaveGuard>(
		(next) => {
			if (submitting.current) return;
			if (dirty) setLeave(() => next);
			else next();
		},
		[dirty],
	);
	useEffect(() => {
		onLeaveGuardChange(guard);
		return () => onLeaveGuardChange(undefined);
	}, [guard, onLeaveGuardChange]);
	const providers = useMemo(() => {
		const names = new Map(state.modelOptionProviders.map((provider) => [provider.id, provider.name]));
		for (const model of state.modelOptions) if (!names.has(model.provider)) names.set(model.provider, model.provider);
		if (draft.provider && !names.has(draft.provider)) names.set(draft.provider, draft.provider);
		return [...names].map(([id, name]) => ({ id, name }));
	}, [draft.provider, state.modelOptionProviders, state.modelOptions]);
	const availableModels = state.modelOptions.filter((model) => model.provider === draft.provider);
	const selectedModel = availableModels.find((model) => model.id === draft.model);
	const thinkingLevels = selectedModel
		? AGENT_THINKING_LEVELS.filter((level) => selectedModel.supportedThinkingLevels.includes(level))
		: AGENT_THINKING_LEVELS;
	const invalidThinking = Boolean(
		draft.thinkingLevel && selectedModel && !thinkingLevels.includes(draft.thinkingLevel),
	);
	const errors = {
		name: !draft.name.trim() ? "请填写名称" : undefined,
		description: !draft.description.trim() ? "请填写描述" : undefined,
		model: draft.provider && !draft.model ? "请选择模型" : undefined,
	};
	const skillOptions = state.skills.filter((skill) => skill.eligible && skill.enabled);
	const save = async (afterSave = onClose) => {
		if (busy || submitting.current || readOnly) return;
		setSaveAttempted(true);
		if (errors.name || errors.description) {
			setSection("identity");
			return;
		}
		if (errors.model || invalidThinking) {
			setSection("runtime");
			return;
		}
		submitting.current = true;
		setSaving(true);
		setSaveError(undefined);
		try {
			const saved = await actions.saveSubagentConfig({
				scope: draft.scope,
				...(config ? { id: config.id } : {}),
				name: draft.name.trim(),
				description: draft.description.trim(),
				...(draft.provider ? { provider: draft.provider } : {}),
				...(draft.model ? { model: draft.model } : {}),
				...(draft.thinkingLevel ? { thinkingLevel: draft.thinkingLevel } : {}),
				workspaceMode: draft.workspaceMode,
				...(draft.icon ? { icon: draft.icon } : {}),
				...(draft.toolMode === "allow" && draft.tools.length ? { tools: draft.tools } : {}),
				...(draft.toolMode === "deny" && draft.excludeTools.length ? { excludeTools: draft.excludeTools } : {}),
				...(draft.skillMode === "selected" && draft.skills.length ? { skills: draft.skills } : {}),
				...(draft.tags.length ? { tags: draft.tags } : {}),
				content: draft.content,
				...(config?.contentHash ? { expectedHash: config.contentHash } : {}),
			});
			if (saved) afterSave();
		} catch (error) {
			setSaveError(error instanceof Error ? error.message : String(error));
		} finally {
			submitting.current = false;
			setSaving(false);
		}
	};
	return (
		<div className="@container/agent-editor flex h-full min-h-0 min-w-0 flex-col gap-5">
			<div className="shrink-0 space-y-4">
				<Button
					className="min-h-10 justify-start gap-2 px-0"
					variant="ghost"
					disabled={busy}
					onClick={() => guard(onClose)}
				>
					<ArrowLeft className="size-4" aria-hidden />
					返回智能体
				</Button>
				<div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
					<div className="flex min-w-0 items-center gap-3">
						<h1 className="min-w-0 break-words text-xl font-semibold">{config ? config.name : "新建智能体"}</h1>
						<span className="shrink-0 text-xs text-muted-foreground">
							{draft.scope === "user" ? "个人" : "项目"}
						</span>
					</div>
					<div className="flex items-center gap-2">
						<span className="text-xs text-muted-foreground" role="status">
							{readOnly ? "只读" : dirty ? "未保存" : config ? "已保存" : ""}
						</span>
						<Button variant="outline" disabled={busy} onClick={() => guard(onClose)}>
							{readOnly ? "返回" : "取消"}
						</Button>
						{!readOnly ? (
							<Button disabled={busy || Boolean(config && !dirty)} onClick={() => void save()}>
								{busy ? <Spinner className="size-4" /> : null}
								{busy ? "正在保存" : "保存"}
							</Button>
						) : null}
					</div>
				</div>
				{saveError || (saveAttempted && state.subagentConfigsError) ? (
					<p className="break-words text-sm text-destructive" role="alert">
						{saveError ?? state.subagentConfigsError}
					</p>
				) : null}
			</div>
			<Tabs value={section} onValueChange={setSection} className="flex min-h-0 flex-1 flex-col gap-5">
				<div className="shrink-0 overflow-x-auto border-b border-border pb-3">
					<WorkbenchTabBar
						activeId={section}
						tabs={SECTIONS}
						label="智能体配置分区"
						className="self-start"
						trackClassName="shadow-none"
					/>
				</div>
				<div className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain pr-1">
					<fieldset disabled={busy || readOnly} className="min-w-0 pb-4">
						<TabsContent
							value="identity"
							className="m-0 grid min-w-0 gap-5 @min-[900px]/agent-editor:grid-cols-[minmax(0,400px)_minmax(0,1fr)] @min-[900px]/agent-editor:items-start @min-[900px]/agent-editor:gap-8"
						>
							<div className="grid min-w-0 gap-5">
								<div className="grid min-w-0 items-end gap-4 sm:grid-cols-[44px_minmax(0,1fr)]">
									<AgentIconPicker value={draft.icon} onChange={(icon) => setDraft({ ...draft, icon })} />
									<label className="grid min-w-0 gap-2 text-sm font-medium">
										名称
										<Input
											className="h-10"
											value={draft.name}
											onChange={(event) => setDraft({ ...draft, name: event.target.value })}
											placeholder="例如：前端开发"
											aria-invalid={saveAttempted && Boolean(errors.name)}
										/>
										{saveAttempted && errors.name ? (
											<span className="text-xs text-destructive" role="alert">
												{errors.name}
											</span>
										) : null}
									</label>
								</div>
								<label className="grid min-w-0 gap-2 text-sm font-medium">
									描述
									<textarea
										className="min-h-16 w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm font-normal leading-6 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
										value={draft.description}
										onChange={(event) => setDraft({ ...draft, description: event.target.value })}
										placeholder="说明该智能体负责的任务"
										aria-invalid={saveAttempted && Boolean(errors.description)}
									/>
									{saveAttempted && errors.description ? (
										<span className="text-xs text-destructive" role="alert">
											{errors.description}
										</span>
									) : null}
								</label>
								<AgentTagEditor tags={draft.tags} onChange={(tags) => setDraft({ ...draft, tags })} />
							</div>
							<div className="grid min-w-0 gap-2">
								<h2 className="text-sm font-medium">提示词</h2>
								<MonacoMarkdownEditor
									className="h-[max(320px,calc(100dvh-600px))] md:h-[max(320px,calc(100dvh-560px))] @min-[900px]/agent-editor:h-[max(320px,calc(100dvh-280px))]"
									disabled={busy || readOnly}
									onChange={(content) => setDraft((current) => ({ ...current, content }))}
									onSave={() => void save()}
									theme={state.theme}
									value={draft.content}
									ariaLabel="智能体正文"
									fileName="PROMPT.md"
								/>
							</div>
						</TabsContent>
						<TabsContent value="runtime" className="m-0">
							<SettingSection id="agent-config-runtime" title="运行配置">
								<div className="grid min-w-0 max-w-2xl items-start gap-5 @min-[900px]/agent-editor:max-w-none @min-[900px]/agent-editor:grid-cols-2 @min-[900px]/agent-editor:gap-x-8">
									<label className="grid min-w-0 gap-2 text-sm font-medium">
										供应商
										<select
											className={SELECT_CLASS}
											value={draft.provider}
											onChange={(event) => setDraft({ ...draft, provider: event.target.value, model: "" })}
										>
											<option value="">继承当前会话</option>
											{providers.map((provider) => (
												<option key={provider.id} value={provider.id}>
													{provider.name}
												</option>
											))}
										</select>
									</label>
									<label className="grid min-w-0 gap-2 text-sm font-medium">
										基础模型
										<select
											className={SELECT_CLASS}
											value={draft.model}
											disabled={!draft.provider && !draft.model}
											aria-invalid={saveAttempted && Boolean(errors.model)}
											onChange={(event) => {
												const model = availableModels.find(
													(candidate) => candidate.id === event.target.value,
												);
												setDraft({
													...draft,
													model: event.target.value,
													thinkingLevel: thinkingLevelAfterModelChange(
														draft.thinkingLevel,
														model?.supportedThinkingLevels,
													),
												});
											}}
										>
											<option value="">继承当前会话</option>
											{draft.model && !selectedModel ? (
												<option value={draft.model}>{draft.model}（目录中不可用）</option>
											) : null}
											{availableModels.map((model) => (
												<option key={model.id} value={model.id}>
													{model.name === model.id ? model.id : `${model.name}（${model.id}）`}
												</option>
											))}
										</select>
										{saveAttempted && errors.model ? (
											<span className="text-xs text-destructive" role="alert">
												{errors.model}
											</span>
										) : null}
									</label>
									<label className="grid gap-2 text-sm font-medium">
										思考强度
										<select
											className={SELECT_CLASS}
											value={draft.thinkingLevel}
											onChange={(event) =>
												setDraft({
													...draft,
													thinkingLevel: event.target.value as AgentDraft["thinkingLevel"],
												})
											}
										>
											<option value="">继承模型设置</option>
											{invalidThinking ? (
												<option disabled value={draft.thinkingLevel}>
													{draft.thinkingLevel}（当前模型不支持）
												</option>
											) : null}
											{thinkingLevels.map((level) => (
												<option key={level} value={level}>
													{level}
												</option>
											))}
										</select>
										{invalidThinking ? (
											<span className="text-xs text-destructive" role="alert">
												请选择当前模型支持的思考强度，或继承模型设置。
											</span>
										) : null}
									</label>
									<label className="grid gap-2 text-sm font-medium">
										工作区模式
										<select
											className={SELECT_CLASS}
											value={draft.workspaceMode}
											onChange={(event) =>
												setDraft({ ...draft, workspaceMode: event.target.value as WebSessionWorkspaceMode })
											}
										>
											{Object.entries(WORKSPACE_MODE_LABELS).map(([value, label]) => (
												<option key={value} value={value}>
													{label}
												</option>
											))}
										</select>
										<span className="text-xs font-normal leading-5 text-muted-foreground">
											{WORKSPACE_MODE_DESCRIPTIONS[draft.workspaceMode]}
										</span>
									</label>
								</div>
							</SettingSection>
						</TabsContent>
						<TabsContent value="tools" className="m-0">
							<AgentToolPermissions
								draft={draft}
								toolOptions={state.subagentTools}
								onChange={(tools) => setDraft({ ...draft, ...tools })}
							/>
						</TabsContent>
						<TabsContent value="skills" className="m-0">
							<SettingSection id="agent-config-skills" title="技能">
								<div className="grid gap-5">
									<label className="grid min-w-0 gap-2 text-sm font-medium sm:grid-cols-[100px_minmax(0,280px)] sm:items-center">
										加载规则
										<select
											className={SELECT_CLASS}
											value={draft.skillMode}
											onChange={(event) =>
												setDraft({ ...draft, skillMode: event.target.value as AgentDraft["skillMode"] })
											}
										>
											<option value="default">沿用项目技能</option>
											<option value="selected">仅加载所选技能</option>
										</select>
									</label>
									<p className="text-xs leading-5 text-muted-foreground">
										{draft.skillMode === "default"
											? "沿用当前项目可用的技能。"
											: draft.skills.length
												? "只加载勾选的技能。"
												: "尚未选择技能，保存后沿用项目配置。"}
									</p>
									<AgentCapabilityPicker
										kind="技能"
										options={skillOptions}
										selected={draft.skillMode === "selected" ? draft.skills : []}
										disabled={draft.skillMode === "default"}
										selectedLabel="已选择"
										defaultLabel={
											draft.skillMode === "default" || !draft.skills.length ? "沿用项目配置" : "未选择"
										}
										onToggle={(name, checked) =>
											setDraft({
												...draft,
												skills: checked
													? [...draft.skills, name]
													: draft.skills.filter((item) => item !== name),
											})
										}
									/>
								</div>
							</SettingSection>
						</TabsContent>
					</fieldset>
				</div>
			</Tabs>
			<Dialog
				open={Boolean(leave)}
				onOpenChange={(open) => {
					if (!open && !busy) setLeave(undefined);
				}}
			>
				<DialogContent className="sm:max-w-md" showCloseButton={!busy}>
					<DialogHeader>
						<DialogTitle>保存智能体修改？</DialogTitle>
						<DialogDescription>当前修改尚未保存。</DialogDescription>
					</DialogHeader>
					<DialogFooter className="flex-wrap gap-2">
						<Button variant="outline" disabled={busy} onClick={() => setLeave(undefined)}>
							继续编辑
						</Button>
						<Button
							variant="ghost"
							disabled={busy}
							onClick={() => {
								const next = leave;
								setLeave(undefined);
								next?.();
							}}
						>
							放弃修改
						</Button>
						<Button
							disabled={busy}
							onClick={() => {
								const next = leave;
								setLeave(undefined);
								void save(() => {
									onClose();
									next?.();
								});
							}}
						>
							保存并离开
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</div>
	);
}
