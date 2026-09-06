import { ArrowUp, Check, ChevronDown, Plus, Square } from "lucide-react";
import { useMemo, useState } from "react";
import type { WorkbenchState } from "../../state/use-workbench";
import { Attachment, AttachmentInfo, AttachmentPreview, AttachmentRemove, Attachments } from "../ai-elements/attachments";
import { ModelSelector, ModelSelectorContent, ModelSelectorEmpty, ModelSelectorGroup, ModelSelectorInput, ModelSelectorItem, ModelSelectorList, ModelSelectorName, ModelSelectorTrigger } from "../ai-elements/model-selector";
import { PromptCompletionMenu, PromptCompletionProvider, PromptCompletionTextarea } from "../ai-elements/prompt-completion-menu";
import { PromptInput, PromptInputBody, PromptInputButton, PromptInputFooter, PromptInputHeader, PromptInputProvider, PromptInputSelect, PromptInputSelectContent, PromptInputSelectItem, PromptInputSelectTrigger, PromptInputSelectValue, PromptInputSubmit, PromptInputTools, usePromptInputAttachments } from "../ai-elements/prompt-input";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "../ui/hover-card";
import { ACTIVE_OPERATION_STATUSES, THINKING_LEVEL_LABELS } from "./constants";
import { formatModelDisplayName } from "./model-utils";
import type { WorkbenchActions } from "./types";

export function Composer({ state, actions }: { state: WorkbenchState; actions: WorkbenchActions }) {
	const [modelSelectorOpen, setModelSelectorOpen] = useState(false);
	const disabled = !state.sessionId || state.readOnly || !state.connected;
	const active = Boolean(
		state.session?.activity === "running" ||
			state.session?.activity === "waiting_for_input" ||
			(state.currentOperation && ACTIVE_OPERATION_STATUSES.has(state.currentOperation.status)),
	);
	const stopping = active;
	const selectedModel = state.models.find(
		(model) => model.provider === state.session?.model?.provider && model.id === state.session?.model?.id,
	);
	const contextWindow = state.session?.contextWindow ?? selectedModel?.contextWindow ?? 0;
	const contextTokens = state.session?.contextTokens ?? 0;
	const thinkingLevels = (
		selectedModel?.supportedThinkingLevels.length ? selectedModel.supportedThinkingLevels : ["off"]
	).filter((level) => level !== "minimal");
	const modelsByProvider = useMemo(() => {
		const groups = new Map<string, typeof state.models>();
		for (const model of state.models) {
			if (state.hiddenModelProviders.includes(model.provider)) continue;
			groups.set(model.provider, [...(groups.get(model.provider) ?? []), model]);
		}
		return [...groups.entries()].sort(([left], [right]) => {
			const leftProvider = state.providers.find((provider) => provider.id === left);
			const rightProvider = state.providers.find((provider) => provider.id === right);
			if (leftProvider?.builtIn !== rightProvider?.builtIn) return leftProvider?.builtIn ? 1 : -1;
			return (leftProvider?.name ?? left).localeCompare(rightProvider?.name ?? right, "zh-CN");
		});
	}, [state.hiddenModelProviders, state.models, state.providers]);

	return (
		<div className="shrink-0 bg-background px-4 pt-3 pb-[max(16px,env(safe-area-inset-bottom))] sm:px-8">
			<div className="mx-auto w-full max-w-[var(--conversation-width)]">
				<PromptInputProvider>
					<PromptCompletionProvider
						disabled={disabled}
						onError={(error) => actions.showToast(error instanceof Error ? error.message : String(error))}
						projectId={state.currentProjectId}
						sessionId={state.sessionId}
					>
						<div className="relative">
							<PromptCompletionMenu />
							<PromptInput
								className="prompt-input-shell [&_[data-slot=input-group]]:rounded-[48px] [&_[data-slot=input-group]]:bg-background [&_[data-slot=input-group]]:shadow-[0_2px_12px_rgb(0_0_0/0.05)]"
								accept="image/*"
								globalDrop
								multiple
								maxFiles={8}
								maxFileSize={8 * 1024 * 1024}
								onError={(error) => {
									if (error.code === "max_files") actions.showToast("最多添加 8 个附件");
									else if (error.code === "max_file_size") actions.showToast("单个附件不能超过 8 MB");
									else if (error.code === "accept") actions.showToast("只能上传图片");
									else actions.showToast("附件类型不受支持");
								}}
								onSubmit={async ({ text, files, submitMode }) => {
									if (!text.trim() || disabled) return;
									const mode = stopping
										? submitMode === "steer"
											? "steer"
											: "follow-up"
										: state.composerMode;
									await actions.sendMessage(
										text,
										mode,
										files.map((file) => ({
											data: file.url ?? "",
											mimeType: file.mediaType || "application/octet-stream",
										})),
									);
								}}
							>
								<PromptInputHeader className="empty:hidden">
									<ComposerAttachments />
								</PromptInputHeader>
								<PromptInputBody>
									<PromptCompletionTextarea
										className="!pt-4 !pb-2 !pl-5 text-left"
										placeholder={disabled ? "当前会话不可写" : "描述你想完成的工作…"}
										disabled={disabled}
									/>
								</PromptInputBody>
								<PromptInputFooter className="items-center !pb-2">
									<PromptInputTools className="shrink-0">
										<ImageUploadButton disabled={disabled} />
									</PromptInputTools>
									<PromptInputTools className="min-w-0 flex-1 justify-end gap-1">
										<ContextRing contextWindow={contextWindow} usedTokens={contextTokens} />
										<ModelSelector open={modelSelectorOpen} onOpenChange={setModelSelectorOpen}>
											<ModelSelectorTrigger asChild>
												<PromptInputButton
													className="data-[state=open]:bg-accent"
													disabled={!state.sessionId}
												>
													<span className="max-w-40 truncate">
														{formatModelDisplayName(
															selectedModel ??
																(state.session?.model ? { id: state.session.model.id } : undefined),
														)}
													</span>
													<ChevronDown className="size-3" />
												</PromptInputButton>
											</ModelSelectorTrigger>
											<ModelSelectorContent title="选择模型">
												<ModelSelectorInput placeholder="搜索模型…" />
												<ModelSelectorList>
													<ModelSelectorEmpty>没有找到模型</ModelSelectorEmpty>
													{modelsByProvider.map(([provider, models]) => (
														<ModelSelectorGroup heading={provider} key={provider}>
															{models.map((model) => (
																<ModelSelectorItem
																	key={`${model.provider}/${model.id}`}
																	value={`${model.provider} ${model.name} ${model.id}`}
																	onSelect={() => {
																		void actions.updateModel(model.provider, model.id);
																		setModelSelectorOpen(false);
																	}}
																>
																	<ModelSelectorName>
																		{formatModelDisplayName(model)}
																	</ModelSelectorName>
																	{state.session?.model?.provider === model.provider &&
																	state.session.model.id === model.id ? (
																		<Check className="size-4" />
																	) : null}
																</ModelSelectorItem>
															))}
														</ModelSelectorGroup>
													))}
												</ModelSelectorList>
											</ModelSelectorContent>
										</ModelSelector>
										{selectedModel?.reasoning ? (
											<PromptInputSelect
												value={
													state.session?.thinkingLevel === "minimal"
														? "low"
														: (state.session?.thinkingLevel ?? "off")
												}
												onValueChange={actions.updateThinking}
											>
												<PromptInputSelectTrigger
													className="hidden h-8 w-auto border-0 px-2 text-xs shadow-none focus-visible:ring-0 sm:flex"
													aria-label="思考强度"
												>
													<PromptInputSelectValue />
												</PromptInputSelectTrigger>
												<PromptInputSelectContent>
													{thinkingLevels.map((level) => (
														<PromptInputSelectItem key={level} value={level}>
															{THINKING_LEVEL_LABELS[level] ?? level}
														</PromptInputSelectItem>
													))}
												</PromptInputSelectContent>
											</PromptInputSelect>
										) : null}
										<PromptInputSubmit
											className="size-10 rounded-full bg-foreground text-background hover:bg-foreground/90"
											status={stopping ? "streaming" : "ready"}
											onStop={stopping ? () => void actions.abort() : undefined}
											disabled={disabled || (!stopping && !state.sessionId)}
											aria-label={stopping ? "停止" : "发送"}
										>
											{stopping ? (
												<Square className="size-4 fill-current" />
											) : (
												<ArrowUp className="size-5" />
											)}
										</PromptInputSubmit>
									</PromptInputTools>
								</PromptInputFooter>
							</PromptInput>
						</div>
					</PromptCompletionProvider>
				</PromptInputProvider>
			</div>
		</div>
	);
}

function ImageUploadButton({ disabled }: { disabled: boolean }) {
	const attachments = usePromptInputAttachments();
	return (
		<PromptInputButton
			className="size-9"
			disabled={disabled}
			onClick={attachments.openFileDialog}
			aria-label="上传图片"
		>
			<Plus className="size-5" />
		</PromptInputButton>
	);
}

function formatContextTokens(tokens: number): string {
	if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, "")}m`;
	if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`;
	return `${tokens}`;
}

function ContextRing({ contextWindow, usedTokens }: { contextWindow: number; usedTokens: number }) {
	const radius = 8;
	const circumference = 2 * Math.PI * radius;
	const usage = contextWindow > 0 ? Math.min(1, Math.max(0, usedTokens / contextWindow)) : 0;
	const percent = Math.round(usage * 100);

	return (
		<HoverCard openDelay={0} closeDelay={0}>
			<HoverCardTrigger asChild>
				<button
					type="button"
					className="inline-flex size-8 cursor-pointer items-center justify-center rounded-full text-muted-foreground outline-none"
					aria-label={`上下文使用率 ${percent}%`}
				>
					<svg
						className="size-5"
						viewBox="0 0 24 24"
						role="img"
						aria-label={`上下文使用率 ${percent}%`}
					>
						<circle cx="12" cy="12" r={radius} fill="none" stroke="currentColor" strokeWidth="2" opacity="0.25" />
						<circle
							cx="12"
							cy="12"
							r={radius}
							fill="none"
							stroke="currentColor"
							strokeDasharray={`${circumference} ${circumference}`}
							strokeDashoffset={circumference * (1 - usage)}
							strokeLinecap="round"
							strokeWidth="2"
							style={{ transform: "rotate(-90deg)", transformOrigin: "center" }}
						/>
					</svg>
				</button>
			</HoverCardTrigger>
			<HoverCardContent
				side="top"
				align="center"
				sideOffset={4}
				className="w-max max-w-[calc(100vw-1rem)] rounded-xl border-border bg-background px-4 py-3 text-center text-sm shadow-[0_2px_8px_rgb(0_0_0/0.05)]"
			>
				<div className="grid gap-2 whitespace-nowrap">
					<div className="text-muted-foreground">背景信息窗口：</div>
					<div className="text-muted-foreground">{percent}% 已用</div>
					<div className="font-medium text-foreground">
						已用 {formatContextTokens(usedTokens)} 标记，共 {formatContextTokens(contextWindow)}
					</div>
				</div>
			</HoverCardContent>
		</HoverCard>
	);
}

function ComposerAttachments() {
	const attachments = usePromptInputAttachments();
	if (!attachments.files.length) return null;
	return (
		<Attachments variant="inline">
			{attachments.files.map((file) => (
				<Attachment key={file.id} data={file} onRemove={() => attachments.remove(file.id)}>
					<AttachmentPreview />
					<AttachmentInfo />
					<AttachmentRemove label="移除附件" />
				</Attachment>
			))}
		</Attachments>
	);
}
