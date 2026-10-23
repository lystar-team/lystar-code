import { ArrowLeft, Check, ChevronDown, ChevronRight } from "lucide-react";
import { type KeyboardEvent, useEffect, useRef } from "react";
import { ModelSelector, ModelSelectorContent, ModelSelectorEmpty, ModelSelectorGroup, ModelSelectorInput, ModelSelectorItem, ModelSelectorList, ModelSelectorName, ModelSelectorTrigger } from "../ai-elements/model-selector";
import { PromptInputButton } from "../ai-elements/prompt-input";
import type { WorkbenchState } from "../../state/use-workbench";
import { THINKING_LEVEL_LABELS } from "./constants";
import { formatModelDisplayName } from "./model-utils";

export type ComposerSettingsView = "entries" | "model" | "thinking";

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
	view: ComposerSettingsView;
	onOpenChange: (open: boolean) => void;
	onSearchChange: (value: string) => void;
	onSelectModel: (provider: string, id: string) => void;
	onSelectThinking: (level: string) => void;
	onViewChange: (view: ComposerSettingsView) => void;
};

function SettingsEntryRow({ label, value, onClick }: { label: string; value: string; onClick: () => void }) {
	return (
		<button
			className="flex h-11 items-center gap-3 rounded-lg px-2 text-left text-sm hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
			onClick={onClick}
			type="button"
		>
			<span className="shrink-0">{label}</span>
			<span className="ml-auto min-w-0 truncate text-muted-foreground">{value}</span>
			<ChevronRight className="size-4 shrink-0 text-muted-foreground" />
		</button>
	);
}

const THINKING_LEVEL_KEYS = ["ArrowDown", "ArrowUp", "Home", "End"];

function ThinkingLevelList({ levels, selected, onSelect }: { levels: string[]; selected: string; onSelect: (level: string) => void }) {
	const selectedIndex = levels.indexOf(selected);
	const focusableIndex = selectedIndex === -1 ? 0 : selectedIndex;
	const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		if (!THINKING_LEVEL_KEYS.includes(event.key)) return;
		const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("[role=radio]")];
		if (!items.length) return;
		event.preventDefault();
		const current = items.indexOf(document.activeElement as HTMLButtonElement);
		const base = current === -1 ? focusableIndex : current;
		const index =
			event.key === "Home" ? 0
				: event.key === "End" ? items.length - 1
					: event.key === "ArrowDown" ? (base + 1) % items.length
						: (base - 1 + items.length) % items.length;
		items[index]?.focus();
	};
	return (
		<div aria-label="思考强度" className="grid w-80 gap-1 p-1" onKeyDown={handleKeyDown} role="radiogroup">
			{levels.map((level, index) => (
				<button
					aria-checked={level === selected}
					className="flex h-8 items-center gap-2 rounded-sm px-2 text-left text-sm hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
					key={level}
					onClick={() => onSelect(level)}
					role="radio"
					tabIndex={index === focusableIndex ? 0 : -1}
					type="button"
				>
					<span className="min-w-0 flex-1 truncate">{THINKING_LEVEL_LABELS[level] ?? level}</span>
					{level === selected ? <Check className="size-4 shrink-0" /> : null}
				</button>
			))}
		</div>
	);
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
	view,
	onOpenChange,
	onSearchChange,
	onSelectModel,
	onSelectThinking,
	onViewChange,
}: ComposerRuntimeSettingsProps) {
	const listViewRef = useRef<HTMLDivElement>(null);
	const backButtonRef = useRef<HTMLButtonElement>(null);
	useEffect(() => {
		// 切换视图后把焦点留在浮层内，避免焦点因为入口行卸载而落到 body。
		if (view === "entries") return;
		if (view === "model") listViewRef.current?.querySelector<HTMLInputElement>("input[cmdk-input]")?.focus();
		else backButtonRef.current?.focus();
	}, [view]);
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
			<ModelSelectorContent title="模型与思考强度">
				{view === "entries" ? (
					<div aria-label="模型与思考强度" className="grid w-80 gap-0 p-1" role="group">
						<SettingsEntryRow label="模型" onClick={() => onViewChange("model")} value={modelLabel} />
						{thinkingLabel ? <div className="h-px bg-border" /> : null}
						{thinkingLabel ? (
							<SettingsEntryRow label="思考强度" onClick={() => onViewChange("thinking")} value={thinkingLabel} />
						) : null}
					</div>
				) : (
					<>
						<div className="flex h-11 items-center gap-1 border-b border-border px-1.5">
							<button
								aria-label="返回设置列表"
								className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:bg-accent focus-visible:outline-none"
								onClick={() => onViewChange("entries")}
								ref={backButtonRef}
								type="button"
							>
								<ArrowLeft className="size-4" />
							</button>
							<span className="text-sm">{view === "model" ? "模型" : "思考强度"}</span>
						</div>
						{view === "model" ? (
							<div ref={listViewRef}>
								<ModelSelectorInput placeholder="搜索模型…" value={search} onValueChange={onSearchChange} />
								<ModelSelectorList>
									<ModelSelectorEmpty>没有找到模型</ModelSelectorEmpty>
									{modelsByProvider.map(([provider, models]) => (
										<ModelSelectorGroup heading={provider} key={provider}>
											{models.map((model) => (
												<ModelSelectorItem
													key={`${model.provider}/${model.id}`}
													onSelect={() => onSelectModel(model.provider, model.id)}
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
							</div>
						) : (
							<ThinkingLevelList levels={thinkingLevels} onSelect={onSelectThinking} selected={thinkingLevel} />
						)}
					</>
				)}
			</ModelSelectorContent>
		</ModelSelector>
	);
}
