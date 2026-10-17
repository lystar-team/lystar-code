import { Layers3, Wrench } from "lucide-react";
import { useState } from "react";
import type { SubagentBatchChanges, SubagentBatchResult } from "../../../state/workbench-settings-actions";
import type { WorkbenchState } from "../../../state/workbench-types";
import type { SubagentConfig, WebSessionWorkspaceMode, WebThinkingLevel } from "../../../types";
import { Button } from "../../ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../ui/dialog";
import { Spinner } from "../../ui/spinner";
import { Tabs, TabsContent } from "../../ui/tabs";
import { WORKSPACE_MODE_DESCRIPTIONS, WORKSPACE_MODE_LABELS } from "../session-workspaces";
import type { WorkbenchActions } from "../types";
import { WorkbenchTabBar } from "../workbench-tab-bar";
import { AgentToolPermissions, type AgentToolSelection } from "./agent-tool-permissions";
import { AGENT_THINKING_LEVELS } from "./subagent-model-selection";

export function SubagentBatchDialog({
	configs,
	state,
	actions,
	onSaved,
	onClose,
}: {
	configs: readonly SubagentConfig[];
	state: Pick<WorkbenchState, "modelOptions" | "modelOptionProviders" | "subagentTools" | "subagentConfigsSaving">;
	actions: Pick<WorkbenchActions, "saveSubagentConfigs">;
	onSaved: (keys: readonly string[]) => void;
	onClose: () => void;
}) {
	const [section, setSection] = useState("runtime");
	const [workspaceMode, setWorkspaceMode] = useState<WebSessionWorkspaceMode | "">("");
	const [modelChoice, setModelChoice] = useState("");
	const [thinkingChoice, setThinkingChoice] = useState<WebThinkingLevel | "" | "inherit">("");
	const [toolChange, setToolChange] = useState<"keep" | "default" | "custom">("keep");
	const [toolDraft, setToolDraft] = useState<AgentToolSelection>({ toolMode: "allow", tools: [], excludeTools: [] });
	const [failures, setFailures] = useState<SubagentBatchResult["failures"]>([]);
	const [savedCount, setSavedCount] = useState(0);
	const saving = state.subagentConfigsSaving;
	const selectedModel = state.modelOptions.find((model) => JSON.stringify([model.provider, model.id]) === modelChoice);
	const targetModels = selectedModel ? [selectedModel] : modelChoice === "inherit" ? [] : configs.flatMap((config) => {
		const model = state.modelOptions.find((candidate) => candidate.provider === config.provider && candidate.id === config.model);
		return model ? [model] : [];
	});
	const thinkingLevels = AGENT_THINKING_LEVELS.filter((level) => targetModels.every((model) => model.supportedThinkingLevels.includes(level)));
	const invalidThinking = thinkingChoice !== "" && thinkingChoice !== "inherit" && !thinkingLevels.includes(thinkingChoice);
	const incompatibleExistingThinking = thinkingChoice === "" && selectedModel && configs.some((config) => config.thinkingLevel && !selectedModel.supportedThinkingLevels.includes(config.thinkingLevel));
	const providers = new Map(state.modelOptionProviders.map((provider) => [provider.id, provider.name]));
	for (const model of state.modelOptions) if (!providers.has(model.provider)) providers.set(model.provider, model.provider);
	const hasChanges = Boolean(workspaceMode || modelChoice || thinkingChoice || toolChange !== "keep");

	const save = async () => {
		const changes: SubagentBatchChanges = {
			...(workspaceMode ? { workspaceMode } : {}),
			...(modelChoice === "inherit" ? { model: null } : selectedModel ? { model: { provider: selectedModel.provider, model: selectedModel.id } } : {}),
			...(thinkingChoice === "inherit" ? { thinkingLevel: null } : thinkingChoice ? { thinkingLevel: thinkingChoice } : {}),
			...(toolChange === "default" || (toolChange === "custom" && toolDraft.toolMode === "default") ? { tools: null } : toolChange === "custom" && toolDraft.toolMode !== "default" ? { tools: { mode: toolDraft.toolMode, names: toolDraft.toolMode === "allow" ? toolDraft.tools : toolDraft.excludeTools } } : {}),
		};
		const result = await actions.saveSubagentConfigs(configs, changes);
		setSavedCount((count) => count + result.saved.length);
		setFailures(result.failures);
		onSaved(result.saved);
		if (!result.failures.length) onClose();
	};

	return (
		<Dialog open onOpenChange={(open) => { if (!open && !saving) onClose(); }}>
			<DialogContent className="flex max-h-[90dvh] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl" showCloseButton={!saving}>
				<DialogHeader className="shrink-0 border-b border-border/60 px-5 py-4 pr-12 text-left">
					<DialogTitle>批量设置智能体</DialogTitle>
					<DialogDescription>已选择 {configs.length} 个智能体。仅覆盖本次设置的字段；工具配置修改后将替换原有允许或禁用列表。</DialogDescription>
					<ul aria-label="本次修改的智能体" className="flex max-h-20 flex-wrap gap-x-4 gap-y-1 overflow-y-auto text-sm">
						{configs.map((config) => <li className="min-w-0 break-words" key={`${config.scope}:${config.id}`}>{config.name}<span className="ml-1 text-xs text-muted-foreground">{config.scope === "user" ? "个人" : "项目"}</span></li>)}
					</ul>
				</DialogHeader>
				<div className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain px-5 py-4" data-slot="subagent-batch-scroll">
					<fieldset className="min-w-0" disabled={saving}>
					<Tabs value={section} onValueChange={setSection} className="gap-4">
						<WorkbenchTabBar activeId={section} label="批量配置分区" tabs={[
							{ icon: Layers3, label: "运行配置", value: "runtime" },
							{ icon: Wrench, label: "工具权限", value: "tools" },
						]} />
						<TabsContent value="runtime" className="grid min-w-0 gap-4">
							<label className="grid min-w-0 gap-2 text-sm font-medium">
								工作区模式
								<select className="h-9 w-full min-w-0 rounded-md border border-input bg-background px-3 text-sm focus-visible:ring-2 focus-visible:ring-ring" value={workspaceMode} onChange={(event) => setWorkspaceMode(event.target.value as WebSessionWorkspaceMode | "")}>
									<option value="">保持不变</option>
									{Object.entries(WORKSPACE_MODE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
								</select>
								{workspaceMode ? <span className="text-xs font-normal leading-5 text-muted-foreground">{WORKSPACE_MODE_DESCRIPTIONS[workspaceMode]}</span> : null}
							</label>
							<label className="grid min-w-0 gap-2 text-sm font-medium">
								调用模型
								<select className="h-9 w-full min-w-0 rounded-md border border-input bg-background px-3 text-sm focus-visible:ring-2 focus-visible:ring-ring" value={modelChoice} onChange={(event) => setModelChoice(event.target.value)}>
									<option value="">保持不变</option>
									<option value="inherit">继承当前会话</option>
									{[...providers].map(([provider, name]) => <optgroup key={provider} label={name}>
										{state.modelOptions.filter((model) => model.provider === provider).map((model) => <option key={model.id} value={JSON.stringify([provider, model.id])}>{model.name === model.id ? model.id : `${model.name}（${model.id}）`}</option>)}
									</optgroup>)}
								</select>
							</label>
							<label className="grid min-w-0 gap-2 text-sm font-medium">
								思考强度
								<select className="h-9 w-full min-w-0 rounded-md border border-input bg-background px-3 text-sm focus-visible:ring-2 focus-visible:ring-ring" value={thinkingChoice} onChange={(event) => setThinkingChoice(event.target.value as typeof thinkingChoice)}>
									<option value="">保持不变</option>
									<option value="inherit">继承模型设置</option>
									{invalidThinking ? <option disabled value={thinkingChoice}>{thinkingChoice}（所选模型不支持）</option> : null}
									{thinkingLevels.map((level) => <option key={level} value={level}>{level}</option>)}
								</select>
								{!thinkingLevels.length ? <span className="text-xs font-normal leading-5 text-muted-foreground">所选模型没有共同支持的思考强度，可保持不变或继承模型设置。</span> : null}
							</label>
							{invalidThinking || incompatibleExistingThinking ? <p role="alert" className="text-sm text-destructive">部分智能体的思考强度不适用于所选模型，请选择兼容强度或继承模型设置。</p> : null}
						</TabsContent>
						<TabsContent value="tools" className="grid gap-4">
							<label className="grid gap-2 text-sm font-medium">
								工具配置
								<select className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:ring-2 focus-visible:ring-ring" value={toolChange} onChange={(event) => setToolChange(event.target.value as typeof toolChange)}>
									<option value="keep">保持不变</option>
									<option value="default">恢复默认工具</option>
									<option value="custom">指定允许或禁用工具</option>
								</select>
							</label>
							{toolChange === "custom" ? <AgentToolPermissions draft={toolDraft} toolOptions={state.subagentTools} onChange={setToolDraft} /> : null}
						</TabsContent>
					</Tabs>
					</fieldset>
				</div>
				{failures.length ? <div className="max-h-40 shrink-0 overflow-y-auto px-5 pb-4 text-sm" role="alert">
					<p>已保存 {savedCount} 个，{failures.length} 个未保存。重试只处理未保存的智能体。</p>
					<ul className="mt-2 space-y-1 text-destructive">{failures.map((failure) => <li className="break-words" key={failure.key}>{failure.name}：{failure.message}</li>)}</ul>
				</div> : null}
				<DialogFooter className="shrink-0 border-t border-border/60 px-5 py-4">
					<Button disabled={saving} onClick={onClose} variant="outline">{failures.length ? "关闭" : "取消"}</Button>
					<Button disabled={saving || !configs.length || !hasChanges || invalidThinking || Boolean(incompatibleExistingThinking)} onClick={() => void save()}>
						{saving ? <Spinner className="size-4" /> : null}
						{saving ? "正在保存" : failures.length ? "重试未保存项" : `应用到 ${configs.length} 个智能体`}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
