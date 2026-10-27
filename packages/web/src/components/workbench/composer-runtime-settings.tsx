import { Check, ChevronDown } from "lucide-react";
import { type KeyboardEvent, useEffect, useRef } from "react";
import {
	ModelSelector,
	ModelSelectorContent,
	ModelSelectorEmpty,
	ModelSelectorGroup,
	ModelSelectorInput,
	ModelSelectorItem,
	ModelSelectorList,
	ModelSelectorName,
	ModelSelectorTrigger,
} from "../ai-elements/model-selector";
import { PromptInputButton } from "../ai-elements/prompt-input";
import type { WorkbenchState } from "../../state/use-workbench";
import { Tabs } from "../ui/tabs";
import { THINKING_LEVEL_LABELS } from "./constants";
import { formatModelDisplayName } from "./model-utils";
import { WorkbenchTabBar } from "./workbench-tab-bar";

type ComposerModelOption = WorkbenchState["modelOptions"][number];

type ComposerRuntimeSettingsProps = {
	disabled: boolean;
	modelLabel: string;
	modelsByProvider: Array<[string, ComposerModelOption[]]>;
	open: boolean;
	search: string;
	selectedModel?: { provider: string; id: string } | null;
	thinkingLabel?: string;
	thinkingLevel: string;
	thinkingLevels: string[];
	onOpenChange: (open: boolean) => void;
	onSearchChange: (value: string) => void;
	onSelectModel: (provider: string, id: string) => void;
	onSelectThinking: (level: string) => void;
};

// 档位是 cmdk 根节点里的 Tabs：这些键交给 Radix Tabs 自己处理，不能再冒泡给 cmdk。
const COMMAND_NAVIGATION_KEYS = new Set(["Enter", " ", "Home", "End", "ArrowUp", "ArrowDown"]);

function thinkingLevelText(level: string): string {
	return (THINKING_LEVEL_LABELS[level] ?? level).replace(/\s*\([^)]*\)\s*$/u, "").trim();
}

export function ComposerRuntimeSettings({
	disabled,
	modelLabel,
	modelsByProvider,
	open,
	search,
	selectedModel,
	thinkingLabel,
	thinkingLevel,
	thinkingLevels,
	onOpenChange,
	onSearchChange,
	onSelectModel,
	onSelectThinking,
}: ComposerRuntimeSettingsProps) {
	const contentRef = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (!open) return;
		const frame = requestAnimationFrame(() => {
			contentRef.current?.querySelector<HTMLInputElement>('[data-slot="command-input"]')?.focus();
		});
		return () => cancelAnimationFrame(frame);
	}, [open]);
	const selectModel = (provider: string, id: string) => {
		onSelectModel(provider, id);
		onOpenChange(false);
	};
	const selectThinking = (level: string) => {
		onSelectThinking(level);
		onOpenChange(false);
	};
	return (
		<ModelSelector open={open} onOpenChange={onOpenChange}>
			<ModelSelectorTrigger asChild>
				<PromptInputButton
					aria-label={thinkingLabel ? `模型与思考强度：${modelLabel}，${thinkingLabel}` : `模型：${modelLabel}`}
					className="min-w-7 shrink gap-1 px-1 has-[>svg]:px-1 data-[state=open]:bg-accent md:px-1.5 md:has-[>svg]:px-1.5"
					disabled={disabled}
				>
					<span className="min-w-0 max-w-24 truncate md:max-w-40">{modelLabel}</span>
					{thinkingLabel ? <span className="shrink-0 text-muted-foreground">{thinkingLabel}</span> : null}
					<ChevronDown className="size-3" />
				</PromptInputButton>
			</ModelSelectorTrigger>
			<ModelSelectorContent
				className="w-80 **:data-[slot=command]:w-full [&_[data-slot=command-input-wrapper]]:mx-2 [&_[data-slot=command-input-wrapper]]:mt-2 [&_[data-slot=command-input-wrapper]]:mb-1 [&_[data-slot=command-input-wrapper]]:h-8 [&_[data-slot=command-input-wrapper]]:gap-1.5 [&_[data-slot=command-input-wrapper]]:rounded-lg [&_[data-slot=command-input-wrapper]]:border-0 [&_[data-slot=command-input-wrapper]]:bg-muted [&_[data-slot=command-input-wrapper]]:px-2 [&_[data-slot=command-input-wrapper]_svg]:size-3.5"
				title="模型与思考强度"
			>
				<div className="flex min-h-0 flex-col" ref={contentRef}>
					<ModelSelectorInput className="h-8 py-0 text-xs" placeholder="搜索模型…" value={search} onValueChange={onSearchChange} />
					<ModelSelectorList className="max-h-60 [mask-image:linear-gradient(to_bottom,black_calc(100%-14px),transparent)]">
						<ModelSelectorEmpty>没有找到模型</ModelSelectorEmpty>
						{modelsByProvider.map(([provider, models]) => (
							<ModelSelectorGroup heading={provider} key={provider}>
								{models.map((model) => (
									<ModelSelectorItem
										className="rounded-md"
										key={`${model.provider}/${model.id}`}
										onSelect={() => selectModel(model.provider, model.id)}
										value={`${model.provider} ${model.name} ${model.id}`}
									>
										<ModelSelectorName>{formatModelDisplayName(model)}</ModelSelectorName>
										{selectedModel?.provider === model.provider && selectedModel.id === model.id ? (
											<Check className="size-4" />
										) : null}
									</ModelSelectorItem>
								))}
							</ModelSelectorGroup>
						))}
					</ModelSelectorList>
					{thinkingLabel ? (
						<div
							className="border-t border-border p-2"
							onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
								if (COMMAND_NAVIGATION_KEYS.has(event.key)) event.stopPropagation();
							}}
						>
							<div className="pb-1.5 text-xs text-muted-foreground">思考强度</div>
							<Tabs activationMode="manual" onValueChange={selectThinking} value={thinkingLevel}>
								<WorkbenchTabBar
									activeId={thinkingLevel}
									className="!w-full [&_[role=tab]]:!min-w-0"
									label="思考强度"
									tabs={thinkingLevels.map((level) => ({ label: thinkingLevelText(level), value: level }))}
									trackClassName="!min-h-7 gap-0.5 rounded-full border border-border bg-card/90 p-0.5 shadow-[0_2px_8px_rgb(0_0_0/0.06)] backdrop-blur-none"
								/>
							</Tabs>
						</div>
					) : null}
				</div>
			</ModelSelectorContent>
		</ModelSelector>
	);
}
