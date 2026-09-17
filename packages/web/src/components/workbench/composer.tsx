import { ArrowUp, ArrowUpToLine, Check, ChevronDown, Clock3, Pencil, Plus, Square, Trash2, X } from "lucide-react";
import { gsap } from "gsap";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { webApi } from "../../adapters/host-protocol/api";
import { runGsapMotion } from "../../lib/gsap-motion";
import { type CommandDialogRequest, executeComposerCommand, resolveComposerCommand } from "../../state/composer-commands";
import { canSendPrompt, hasActiveSessionWork } from "../../state/chat-lifecycle";
import { CommandDialog } from "./command-dialog";
import type { WorkbenchState } from "../../state/use-workbench";
import { Attachment, AttachmentInfo, AttachmentPreview, AttachmentRemove, Attachments } from "../ai-elements/attachments";
import { ModelSelector, ModelSelectorContent, ModelSelectorEmpty, ModelSelectorGroup, ModelSelectorInput, ModelSelectorItem, ModelSelectorList, ModelSelectorName, ModelSelectorTrigger } from "../ai-elements/model-selector";
import { ResourceImageViewer } from "../ai-elements/resource-preview";
import { PromptCompletionMenu, PromptCompletionProvider, PromptCompletionTextarea } from "../ai-elements/prompt-completion-menu";
import { PromptInput, PromptInputBody, PromptInputButton, PromptInputFooter, PromptInputHeader, PromptInputProvider, PromptInputSelect, PromptInputSelectContent, PromptInputSelectItem, PromptInputSelectTrigger, PromptInputSelectValue, PromptInputSubmit, PromptInputTools, usePromptInputAttachments, usePromptInputController } from "../ai-elements/prompt-input";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "../ui/hover-card";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { Button } from "../ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";
import { GsapReveal } from "../ui/gsap-reveal";
import {
	THINKING_LEVEL_LABELS,
	selectedVisibleThinkingLevel,
	visibleThinkingLevels,
} from "./constants";
import { formatModelDisplayName } from "./model-utils";
import type { PromptEditRequest, WorkbenchActions } from "./types";

function base64FromDataUrl(url: string): string {
	const separator = url.indexOf(",");
	if (!url.startsWith("data:") || separator < 0) throw new Error("附件读取失败，请重新选择文件");
	return url.slice(separator + 1);
}

function internalFileReference(path: string, filename: string | undefined, mimeType: string, index: number): string {
	const displayName = filename || `附件 ${index + 1}`;
	return `<file name="${path}" filename="${xmlAttribute(displayName)}" mimeType="${xmlAttribute(mimeType)}"></file>`;
}

function xmlAttribute(value: string): string {
	return value.replace(/"/gu, "&quot;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");
}

function thinkingLevelDisplayLabel(level: string): string {
	return (THINKING_LEVEL_LABELS[level] ?? level).replace(/\s*\([^)]*\)\s*$/u, "").trim();
}

type EditAttachmentStatus = {
	requestKey: string;
	state: "loading" | "ready" | "error";
	message?: string;
};

async function transcriptAttachmentFile(
	sessionId: string,
	attachment: PromptEditRequest["attachments"][number],
): Promise<File> {
	const image = await webApi.readImageContent(sessionId, attachment.id);
	const binary = atob(image.data);
	const buffer = new ArrayBuffer(binary.length);
	const bytes = new Uint8Array(buffer);
	for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
	return new File([buffer], attachment.filename || "图片", { type: image.mimeType });
}

type ComposerProps = {
	state: WorkbenchState;
	actions: WorkbenchActions;
	editRequest?: PromptEditRequest;
	onCancelEdit: () => void;
	onEditComplete: () => void;
};

export function composerStateEqual(previous: WorkbenchState, next: WorkbenchState): boolean {
	return (
		previous.composerMode === next.composerMode &&
		previous.connected === next.connected &&
		previous.currentOperation === next.currentOperation &&
		previous.currentProjectId === next.currentProjectId &&
		previous.hiddenModelProviders === next.hiddenModelProviders &&
		previous.liveCompaction === next.liveCompaction &&
		previous.liveTools === next.liveTools &&
		previous.liveTurnActive === next.liveTurnActive &&
		previous.models === next.models &&
		previous.providers === next.providers &&
		previous.queuedUserPrompts === next.queuedUserPrompts &&
		previous.readOnly === next.readOnly &&
		previous.session === next.session &&
		previous.sessionId === next.sessionId &&
		previous.sessionReady === next.sessionReady
	);
}

function composerPropsEqual(previous: ComposerProps, next: ComposerProps): boolean {
	return (
		composerStateEqual(previous.state, next.state) &&
		previous.editRequest === next.editRequest &&
		previous.onCancelEdit === next.onCancelEdit &&
		previous.onEditComplete === next.onEditComplete
	);
}

export const Composer = memo(function Composer({
	state,
	actions,
	editRequest,
	onCancelEdit,
	onEditComplete,
}: ComposerProps) {
	const [modelSelectorOpen, setModelSelectorOpen] = useState(false);
	const [modelSearch, setModelSearch] = useState("");
	const [commandDialog, setCommandDialog] = useState<CommandDialogRequest & { sessionId?: string }>();
	const [queueActionId, setQueueActionId] = useState<string>();
	const [editAttachmentStatus, setEditAttachmentStatus] = useState<EditAttachmentStatus>();
	const activeEditRequest = editRequest?.sessionId === state.sessionId ? editRequest : undefined;
	const editRequestRef = useRef(activeEditRequest);
	editRequestRef.current = activeEditRequest;
	const submittingSessionIdsRef = useRef(new Set<string>());
	const draftBySessionRef = useRef(new Map<string, string>());
	const promptAnimationScopeRef = useRef<HTMLDivElement>(null);
	const promptAnimationCleanupRef = useRef<(() => void) | undefined>(undefined);
	const sessionIdRef = useRef(state.sessionId);
	sessionIdRef.current = state.sessionId;
	const playPromptSubmitFeedback = useCallback((submitMode: "prompt" | "steer") => {
		const scope = promptAnimationScopeRef.current;
		if (!scope) return;
		const preferredSelector =
			submitMode === "steer"
				? '[data-prompt-submit-button][data-prompt-submit-mode="steer"]'
				: '[data-prompt-submit-button][data-prompt-submit-mode="follow-up"], [data-prompt-submit-button]:not([data-prompt-submit-mode])';
		const submitButton =
			scope.querySelector<HTMLButtonElement>(preferredSelector) ??
			scope.querySelector<HTMLButtonElement>("[data-prompt-submit-button]");
		const inputGroup = scope.querySelector<HTMLElement>('[data-slot="input-group"]');
		if (!submitButton || !inputGroup) return;
		promptAnimationCleanupRef.current?.();
		promptAnimationCleanupRef.current = runGsapMotion(scope, (reducedMotion) => {
			gsap.killTweensOf([submitButton, inputGroup]);
			if (reducedMotion) {
				gsap.set([submitButton, inputGroup], { clearProps: "transform" });
				return;
			}
			gsap
				.timeline({ defaults: { overwrite: "auto" } })
				.to(submitButton, { scale: 0.9, duration: 0.08, ease: "power2.out" }, 0)
				.to(inputGroup, { scale: 0.992, y: 1, duration: 0.08, ease: "power2.out" }, 0)
				.to(
					submitButton,
					{ scale: 1, duration: 0.3, ease: "back.out(1.7)", clearProps: "transform" },
					0.08,
				)
				.to(
					inputGroup,
					{ scale: 1, y: 0, duration: 0.22, ease: "power3.out", clearProps: "transform" },
					0.08,
				);
		});
	}, []);
	useEffect(() => {
		return () => {
			promptAnimationCleanupRef.current?.();
		};
	}, []);
	const inputSessionId = state.sessionId;
	const handleInputChange = useCallback(
		(value: string) => {
			if (!inputSessionId || activeEditRequest) return;
			if (value) draftBySessionRef.current.set(inputSessionId, value);
			else draftBySessionRef.current.delete(inputSessionId);
		},
		[activeEditRequest, inputSessionId],
	);
	const initialInput = activeEditRequest
		? activeEditRequest.text
		: inputSessionId
			? (draftBySessionRef.current.get(inputSessionId) ?? "")
			: "";
	const editRequestKey = activeEditRequest ? `${activeEditRequest.sessionId}:${activeEditRequest.entryId}` : undefined;
	const matchingEditAttachmentStatus =
		editAttachmentStatus?.requestKey === editRequestKey ? editAttachmentStatus : undefined;
	const editAttachmentState = activeEditRequest?.attachments.length
		? (matchingEditAttachmentStatus?.state ?? "loading")
		: "ready";
	const editAttachmentError =
		matchingEditAttachmentStatus?.state === "error" ? matchingEditAttachmentStatus.message : undefined;
	const handleEditAttachmentStatus = useCallback((status: EditAttachmentStatus) => {
		setEditAttachmentStatus(status);
	}, []);
	useEffect(() => {
		promptAnimationCleanupRef.current?.();
		setCommandDialog(undefined);
		setModelSelectorOpen(false);
		setQueueActionId(undefined);
	}, [editRequestKey, state.sessionId]);
	const disabled = !canSendPrompt(state);
	const stopping = !disabled && hasActiveSessionWork(state);
	const handleQueueAction = async (queueId: string, action: "remove" | "steer") => {
		setQueueActionId(queueId);
		try {
			await actions.queueAction(queueId, action);
		} catch (error) {
			actions.showToast(error instanceof Error ? error.message : String(error));
		} finally {
			setQueueActionId(undefined);
		}
	};
	const queuedFollowUpPrompts = useMemo(
		() => state.queuedUserPrompts.filter((prompt) => prompt.delivery === "follow-up"),
		[state.queuedUserPrompts],
	);
	const selectedModel = state.modelOptions.find(
		(model) => model.provider === state.session?.model?.provider && model.id === state.session?.model?.id,
	);
	const contextWindow = state.session?.contextWindow ?? selectedModel?.contextWindow ?? 0;
	const contextTokens = state.session?.contextTokens ?? 0;
	const thinkingLevels = visibleThinkingLevels(
		selectedModel?.supportedThinkingLevels.length ? selectedModel.supportedThinkingLevels : ["off"],
	);
	const modelsByProvider = useMemo(() => {
		const groups = new Map<string, typeof state.modelOptions>();
		for (const model of state.modelOptions) {
			if (state.hiddenModelProviders.includes(model.provider)) continue;
			groups.set(model.provider, [...(groups.get(model.provider) ?? []), model]);
		}
		return [...groups.entries()].sort(([left], [right]) => {
			const leftProvider = state.modelOptionProviders.find((provider) => provider.id === left);
			const rightProvider = state.modelOptionProviders.find((provider) => provider.id === right);
			if (leftProvider?.builtIn !== rightProvider?.builtIn) return leftProvider?.builtIn ? 1 : -1;
			return (leftProvider?.name ?? left).localeCompare(rightProvider?.name ?? right, "zh-CN");
		});
	}, [state.hiddenModelProviders, state.modelOptionProviders, state.modelOptions]);

	return (
		<div className="shrink-0 bg-background px-4 pt-3 pb-[max(16px,env(safe-area-inset-bottom))] sm:px-8">
			<div className="mx-auto w-full max-w-[var(--conversation-width)]">
				<PromptInputProvider
					key={`${inputSessionId ?? "no-session"}:${editRequestKey ?? "draft"}`}
					initialInput={initialInput}
					onInputChange={handleInputChange}
				>
					<PromptCompletionProvider
						disabled={disabled}
						onError={(error) => actions.showToast(error instanceof Error ? error.message : String(error))}
						projectId={state.currentProjectId}
						sessionId={state.sessionId}
					>
						<div className="relative" ref={promptAnimationScopeRef}>
							{queuedFollowUpPrompts.length ? (
								<GsapReveal
									animationKey={queuedFollowUpPrompts.at(-1)?.id ?? "queue"}
									className="w-full"
									distance={10}
									duration={0.24}
								>
									<QueuedPromptList
										prompts={queuedFollowUpPrompts}
										busyId={queueActionId}
										onAction={handleQueueAction}
									/>
								</GsapReveal>
							) : null}
							{activeEditRequest ? (
								<div
									className="mb-2 flex min-h-9 items-center gap-2 rounded-xl border border-border/70 bg-muted/25 px-3 py-1.5 text-xs text-muted-foreground"
									role="status"
									aria-live="polite"
								>
									<Pencil className="size-3.5 shrink-0" />
									<span className="min-w-0 flex-1 truncate">
										{editAttachmentError
											? `原消息附件读取失败：${editAttachmentError}`
											: editAttachmentState === "loading"
												? "正在加载原消息附件"
												: "正在修改已发送的 Prompt"}
									</span>
									<Button type="button" variant="ghost" size="sm" className="h-7 shrink-0 px-2" onClick={onCancelEdit}>
										<X className="size-3.5" />
										取消
									</Button>
								</div>
							) : null}
							<PromptCompletionMenu />
							<PromptInput
								className="prompt-input-shell [&_[data-slot=input-group]]:rounded-[48px] [&_[data-slot=input-group]]:bg-background [&_[data-slot=input-group]]:shadow-[0_2px_12px_rgb(0_0_0/0.05)]"
								globalDrop
								multiple
								maxFiles={8}
								maxFileSize={8 * 1024 * 1024}
								onError={(error) => {
									if (error.code === "max_files") actions.showToast("最多添加 8 个附件");
									else if (error.code === "max_file_size") actions.showToast("单个附件不能超过 8 MB");
									else if (error.code === "accept") actions.showToast("不支持的文件类型");
									else actions.showToast("附件类型不受支持");
								}}
								onSubmit={async ({ text, files, submitMode }) => {
									const submissionSessionId = state.sessionId;
									const submissionEditRequest = activeEditRequest;
									const submissionEditKey = editRequestKey;
									if ((!text.trim() && files.length === 0) || disabled || !submissionSessionId) return;
									if (submissionEditRequest && editAttachmentState !== "ready") return;
									if (submittingSessionIdsRef.current.has(submissionSessionId)) throw new Error("正在提交，请稍候");
									submittingSessionIdsRef.current.add(submissionSessionId);
									playPromptSubmitFeedback(submitMode ?? "prompt");
									try {
										const command = submissionEditRequest
											? undefined
											: await resolveComposerCommand(text, (token, cursor) => {
													if (!state.currentProjectId) throw new Error("请先选择项目");
													return webApi.completions(state.currentProjectId, token, cursor, submissionSessionId);
												});
										if (sessionIdRef.current !== submissionSessionId) throw new Error("会话已切换，请确认后重新提交");
										if (command) {
											if (files.length) throw new Error("内置命令不接受附件，请移除附件后执行");
											await executeComposerCommand(command, state, actions, (request) => {
												actions.closeInspector();
												if (request.kind === "model") {
													setModelSearch(request.value ?? "");
													setModelSelectorOpen(true);
												} else setCommandDialog({ ...request, sessionId: submissionSessionId });
											});
											return;
										}
										const mode = submissionEditRequest
											? "prompt"
											: stopping
												? submitMode === "steer"
													? "steer"
													: "follow-up"
												: state.composerMode;
										if (sessionIdRef.current !== submissionSessionId) throw new Error("会话已切换，请确认后重新提交");
										const uploadedFiles = await Promise.all(
											files.map((file) =>
												webApi.uploadFile({
													data: base64FromDataUrl(file.url ?? ""),
													filename: file.filename || "attachment",
													mimeType: file.mediaType || "application/octet-stream",
												}),
											),
										);
										if (sessionIdRef.current !== submissionSessionId) throw new Error("会话已切换，请确认后重新提交");
										const promptText = uploadedFiles.length
											? `${text}\n\n${uploadedFiles.map((file, index) => internalFileReference(file.path, files[index]?.filename, files[index]?.mediaType || file.mimeType, index)).join("\n")}`
											: text;
										const attachmentPreviews = uploadedFiles.map((image, index) => ({
											id: image.path,
											filename: files[index]?.filename ?? `附件 ${index + 1}`,
											mediaType: image.mimeType,
											url: files[index]?.url ?? "",
										}));
										if (submissionEditRequest) {
											if (
												editRequestRef.current?.entryId !== submissionEditRequest.entryId ||
												editRequestRef.current.sessionId !== submissionSessionId ||
												submissionEditKey !== `${submissionSessionId}:${submissionEditRequest.entryId}`
											)
												throw new Error("编辑目标已变更，请重新提交");
											await actions.navigateTree(submissionEditRequest.entryId);
											if (sessionIdRef.current !== submissionSessionId) throw new Error("会话已切换，请确认后重新提交");
										}
										await actions.sendMessage(
											promptText,
											mode,
											uploadedFiles.map(({ path, mimeType }) => ({ path, mimeType })),
											attachmentPreviews,
											text.trim() || `附件：${files.map((file) => file.filename || "未命名文件").join("、")}`,
										);
										if (submissionEditRequest) onEditComplete();
									} catch (error) {
										actions.showToast(error instanceof Error ? error.message : String(error));
										throw error;
									} finally {
										submittingSessionIdsRef.current.delete(submissionSessionId);
									}
								}}
							>
								{activeEditRequest && editRequestKey ? (
									<ComposerEditAttachmentLoader
										request={activeEditRequest}
										requestKey={editRequestKey}
										onStatus={handleEditAttachmentStatus}
									/>
								) : null}
								<PromptInputHeader className="empty:hidden">
									<ComposerAttachments />
								</PromptInputHeader>
								<PromptInputBody>
									<PromptCompletionTextarea
										autoFocus={Boolean(activeEditRequest)}
										placeholder={
											state.sessionId && !state.sessionReady
												? "正在同步会话"
												: disabled
													? "当前会话不可写"
													: "描述你想完成的工作…"
										}
										disabled={disabled}
									/>
								</PromptInputBody>
								<PromptInputFooter className="items-center !pb-2">
									<PromptInputTools className="shrink-0">
										<FileUploadButton disabled={disabled || editAttachmentState === "loading"} />
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
												<ModelSelectorInput placeholder="搜索模型…" value={modelSearch} onValueChange={setModelSearch} />
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
												value={selectedVisibleThinkingLevel(
													state.session?.thinkingLevel ?? "off",
													thinkingLevels,
												)}
												onValueChange={actions.updateThinking}
											>
												<PromptInputSelectTrigger
													className="flex h-8 w-auto min-w-0 max-w-[7rem] shrink border-0 px-2 text-xs shadow-none focus-visible:ring-0 sm:max-w-none"
													aria-label="思考强度"
												>
													<PromptInputSelectValue>
														{thinkingLevelDisplayLabel(state.session?.thinkingLevel ?? "off")}
													</PromptInputSelectValue>
												</PromptInputSelectTrigger>
												<PromptInputSelectContent
													position="popper"
													className="!max-h-none !overflow-y-visible"
												>
													{thinkingLevels.map((level) => (
														<PromptInputSelectItem key={level} value={level}>
															{THINKING_LEVEL_LABELS[level] ?? level}
														</PromptInputSelectItem>
													))}
												</PromptInputSelectContent>
											</PromptInputSelect>
										) : null}
										<ComposerSubmitActions
											disabled={disabled}
											onAbort={() => void actions.abort()}
											stopping={stopping}
											submitDisabled={
												disabled ||
												!state.sessionId ||
												(Boolean(activeEditRequest) && editAttachmentState !== "ready")
											}
										/>
									</PromptInputTools>
								</PromptInputFooter>
							</PromptInput>
						</div>
					</PromptCompletionProvider>
				</PromptInputProvider>
				{commandDialog && commandDialog.sessionId === state.sessionId ? (
					<CommandDialog request={commandDialog} state={state} actions={actions} onClose={() => setCommandDialog(undefined)} />
				) : null}
			</div>
		</div>
	);
}, composerPropsEqual);

type ComposerSubmitActionsProps = {
	disabled: boolean;
	onAbort: () => void;
	stopping: boolean;
	submitDisabled: boolean;
};

function ComposerSubmitActions({ disabled, onAbort, stopping, submitDisabled }: ComposerSubmitActionsProps) {
	const { textInput } = usePromptInputController();
	const [modeOpen, setModeOpen] = useState(false);
	const containerRef = useRef<HTMLDivElement>(null);
	const popoverRef = useRef<HTMLDivElement>(null);
	const actionInitializedRef = useRef(false);
	const popoverOpenedRef = useRef(false);
	const hasText = Boolean(textInput.value.trim());
	const mode = !stopping ? "send" : hasText ? "choice" : "stop";

	useEffect(() => {
		if (!stopping || !hasText || submitDisabled) setModeOpen(false);
	}, [hasText, stopping, submitDisabled]);

	const submitActiveMode = useCallback(
		(mode: "steer" | "follow-up") => {
			if (submitDisabled) return;
			const form = containerRef.current?.closest("form");
			if (!form) return;
			if (mode === "steer") {
				const steerSubmit = form.querySelector<HTMLButtonElement>('button[data-prompt-submit-mode="steer"]');
				if (!steerSubmit) return;
				form.requestSubmit(steerSubmit);
			} else {
				form.requestSubmit();
			}
			setModeOpen(false);
		},
		[submitDisabled],
	);

	useLayoutEffect(() => {
		const action = containerRef.current?.querySelector<HTMLElement>("[data-active-prompt-anchor]");
		if (!action) return;
		if (!actionInitializedRef.current) {
			actionInitializedRef.current = true;
			return;
		}
		return runGsapMotion(action, (reducedMotion) => {
			gsap.killTweensOf(action);
			if (reducedMotion) {
				gsap.set(action, { clearProps: "opacity,transform,visibility" });
				return;
			}
			gsap.fromTo(
				action,
				{ autoAlpha: 0, scale: 0.92, y: 2 },
				{
					autoAlpha: 1,
					clearProps: "opacity,transform,visibility",
					duration: 0.18,
					ease: "power3.out",
					scale: 1,
					y: 0,
				},
			);
		});
	}, [mode]);

	useLayoutEffect(() => {
		const popover = popoverRef.current;
		if (!popover) return;
		const trigger = containerRef.current?.querySelector<HTMLElement>("[data-active-prompt-anchor]");
		const options = [...popover.querySelectorAll<HTMLElement>("[data-active-prompt-option]")];
		return runGsapMotion(popover, (reducedMotion) => {
			gsap.killTweensOf(popover);
			gsap.killTweensOf(options);
			if (trigger) gsap.killTweensOf(trigger);
			if (reducedMotion) {
				gsap.set(popover, modeOpen ? { autoAlpha: 1, clearProps: "transform" } : { autoAlpha: 0, y: 8 });
				gsap.set(options, modeOpen ? { autoAlpha: 1, clearProps: "transform" } : { autoAlpha: 0, y: 6 });
				if (trigger) gsap.set(trigger, { clearProps: "transform" });
				return;
			}
			if (!modeOpen && !popoverOpenedRef.current) {
				gsap.set(popover, { autoAlpha: 0, y: 8 });
				gsap.set(options, { autoAlpha: 0, y: 6 });
				return;
			}
			if (modeOpen) {
				popoverOpenedRef.current = true;
				const timeline = gsap.timeline({ defaults: { overwrite: "auto" } });
				if (trigger) {
					timeline.fromTo(
						trigger,
						{ scale: 0.94 },
						{ clearProps: "transform", duration: 0.2, ease: "power3.out", scale: 1 },
						0,
					);
				}
				timeline
					.fromTo(
						popover,
						{ autoAlpha: 0, y: 8 },
						{
							autoAlpha: 1,
							clearProps: "opacity,transform,visibility",
							duration: 0.24,
							ease: "power3.out",
							y: 0,
						},
						0,
					)
					.fromTo(
						options,
						{ autoAlpha: 0, y: 6 },
						{
							autoAlpha: 1,
							clearProps: "opacity,transform,visibility",
							duration: 0.2,
							ease: "power3.out",
							stagger: { each: 0.045, from: "end" },
							y: 0,
						},
						0.035,
					);
				return;
			}
			gsap
				.timeline({ defaults: { overwrite: "auto" } })
				.to(options, {
					autoAlpha: 0,
					duration: 0.12,
					ease: "power2.in",
					stagger: { each: 0.025, from: "start" },
					y: 4,
				})
				.to(popover, { autoAlpha: 0, duration: 0.16, ease: "power2.inOut", y: 8 }, 0.025);
		});
	}, [mode, modeOpen]);

	const controls =
		mode === "send" ? (
			<PromptInputSubmit
				className="size-10 rounded-full bg-foreground text-background hover:bg-foreground/90 hover:text-background"
				status="ready"
				disabled={submitDisabled}
				data-active-prompt-anchor
				data-prompt-submit-button
				aria-label="发送"
			>
				<ArrowUp className="size-5" />
			</PromptInputSubmit>
		) : mode === "stop" ? (
			<PromptInputButton
				className="size-10 rounded-full border border-border"
				data-active-prompt-anchor
				disabled={disabled}
				onClick={onAbort}
				tooltip="停止当前任务"
				aria-label="停止"
			>
				<Square className="size-4 fill-current" />
			</PromptInputButton>
		) : (
			<Popover open={modeOpen} onOpenChange={setModeOpen}>
				<PopoverTrigger asChild>
					<PromptInputButton
						className="size-10 rounded-full bg-foreground text-background hover:bg-foreground/90 hover:text-background"
						data-active-prompt-anchor
						data-prompt-submit-button
						disabled={submitDisabled}
						title="选择发送方式"
						aria-expanded={modeOpen}
						aria-label="选择发送方式"
					>
						<ArrowUp className="size-5" />
					</PromptInputButton>
				</PopoverTrigger>
				<PopoverContent
					align="end"
					aria-hidden={!modeOpen}
					className="!animate-none z-[80] w-auto border-0 bg-transparent p-0 shadow-none"
					forceMount
					ref={popoverRef}
					side="top"
					sideOffset={10}
					style={{ pointerEvents: modeOpen ? "auto" : "none" }}
				>
					<div className="flex flex-col items-end gap-2" role="group" aria-label="选择发送方式">
						<Button
							className="h-11 w-36 justify-start gap-2.5 rounded-full bg-foreground px-4 text-sm text-background shadow-lg hover:bg-foreground/90 hover:text-background"
							data-active-prompt-option
							disabled={submitDisabled || !modeOpen}
							onClick={() => submitActiveMode("steer")}
							tabIndex={modeOpen ? 0 : -1}
							type="button"
							aria-label="调整方向：立即调整当前任务"
						>
							<ArrowUpToLine className="size-[18px] shrink-0" />
							调整方向
						</Button>
						<Button
							className="h-11 w-36 justify-start gap-2.5 rounded-full border-border bg-background px-4 text-sm text-foreground shadow-lg hover:bg-accent"
							data-active-prompt-option
							disabled={submitDisabled || !modeOpen}
							onClick={() => submitActiveMode("follow-up")}
							tabIndex={modeOpen ? 0 : -1}
							type="button"
							variant="outline"
							aria-label="完成后发送：当前任务结束后发送"
						>
							<Clock3 className="size-[18px] shrink-0" />
							完成后发送
						</Button>
					</div>
				</PopoverContent>
			</Popover>
		);

	return (
		<div className="inline-flex size-10 shrink-0" ref={containerRef}>
			<div className="flex size-10 items-center justify-center" key={mode}>
				{controls}
			</div>
		</div>
	);
}

function ComposerEditAttachmentLoader({
	request,
	requestKey,
	onStatus,
}: {
	request: PromptEditRequest;
	requestKey: string;
	onStatus: (status: EditAttachmentStatus) => void;
}) {
	const attachments = usePromptInputAttachments();
	const addAttachmentsRef = useRef(attachments.add);
	addAttachmentsRef.current = attachments.add;

	useEffect(() => {
		let cancelled = false;
		if (!request.attachments.length) {
			onStatus({ requestKey, state: "ready" });
			return;
		}
		onStatus({ requestKey, state: "loading" });
		void Promise.all(
			request.attachments.map((attachment) => transcriptAttachmentFile(request.sessionId, attachment)),
		).then(
			(files) => {
				if (cancelled) return;
				addAttachmentsRef.current(files);
				onStatus({ requestKey, state: "ready" });
			},
			(error: unknown) => {
				if (cancelled) return;
				onStatus({
					requestKey,
					state: "error",
					message: error instanceof Error ? error.message : String(error),
				});
			},
		);
		return () => {
			cancelled = true;
		};
	}, [onStatus, request, requestKey]);

	return null;
}

function QueuedPromptList({
	prompts,
	busyId,
	onAction,
}: {
	prompts: WorkbenchState["queuedUserPrompts"];
	busyId?: string;
	onAction: (queueId: string, action: "remove" | "steer") => void;
}) {
	return (
		<section
			aria-label="排队消息"
			aria-live="polite"
			className="mb-2 overflow-hidden rounded-2xl border border-border/70 bg-muted/20 shadow-sm"
		>
			<div className="flex items-center justify-between px-3 py-2 text-xs text-muted-foreground">
				<span className="font-medium text-foreground">排队消息</span>
				<span>{prompts.length} 条</span>
			</div>
			<div className="max-h-56 divide-y divide-border/60 overflow-y-auto">
				{prompts.map((prompt) => {
					const steering = prompt.delivery === "steer";
					return (
						<div className="flex min-w-0 items-start gap-3 px-3 py-2.5" key={prompt.id}>
							<div className="min-w-0 flex-1">
								<p className="whitespace-pre-wrap break-words text-sm leading-5 text-foreground">{prompt.displayText}</p>
								<p className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
									{steering ? <ArrowUpToLine className="size-3.5 shrink-0" /> : <Clock3 className="size-3.5 shrink-0" />}
									<span>{steering ? "调整方向 · 等待当前步骤结束" : "完成后发送 · 等待当前任务结束"}</span>
								</p>
								{prompt.attachments.length ? (
									<p className="mt-1 truncate text-xs text-muted-foreground">
										附件：{prompt.attachments.map((attachment) => attachment.filename).join("、")}
									</p>
								) : null}
							</div>
							<div className="flex shrink-0 items-center gap-0.5">
								{steering ? null : (
									<Tooltip>
										<TooltipTrigger asChild>
											<Button
												type="button"
												variant="ghost"
												size="icon-sm"
												aria-label="调整方向"
												disabled={busyId !== undefined}
												onClick={() => onAction(prompt.id, "steer")}
											>
												<ArrowUpToLine className="size-4" />
											</Button>
										</TooltipTrigger>
										<TooltipContent side="top">调整方向（立即插队）</TooltipContent>
									</Tooltip>
								)}
								<Tooltip>
									<TooltipTrigger asChild>
										<Button
											type="button"
											variant="ghost"
											size="icon-sm"
											aria-label="删除排队消息"
											disabled={busyId !== undefined}
											onClick={() => onAction(prompt.id, "remove")}
										>
											<Trash2 className="size-4" />
										</Button>
									</TooltipTrigger>
									<TooltipContent side="top">删除，不发送</TooltipContent>
								</Tooltip>
							</div>
						</div>
					);
				})}
			</div>
		</section>
	);
}
function FileUploadButton({ disabled }: { disabled: boolean }) {
	const attachments = usePromptInputAttachments();
	return (
		<PromptInputButton
			className="size-9"
			disabled={disabled}
			onClick={attachments.openFileDialog}
			aria-label="上传文件"
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
	const [previewIndex, setPreviewIndex] = useState<number>();
	if (!attachments.files.length) return null;

	const previewItems = attachments.files.flatMap((file) =>
		file.mediaType?.startsWith("image/") && file.url
			? [{ id: file.id, src: file.url, alt: file.filename ?? "图片" }]
			: [],
	);

	return (
		<>
			<Attachments variant="inline">
				{attachments.files.map((file) => {
					const imageIndex = previewItems.findIndex((item) => item.id === file.id);
					const previewable = imageIndex >= 0;
					return (
						<Attachment
							key={file.id}
							data={file}
							onRemove={() => attachments.remove(file.id)}
							onClick={previewable ? () => setPreviewIndex(imageIndex) : undefined}
							onKeyDown={
								previewable
									? (event) => {
										if (event.key === "Enter" || event.key === " ") {
											event.preventDefault();
											setPreviewIndex(imageIndex);
										}
									}
									: undefined
							}
							role={previewable ? "button" : undefined}
							tabIndex={previewable ? 0 : undefined}
							aria-label={previewable ? `预览 ${file.filename ?? "图片"}` : undefined}
							className={previewable ? "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" : undefined}
						>
							<AttachmentPreview />
							<AttachmentInfo showMediaType={!previewable} />
							<AttachmentRemove label="移除附件" />
						</Attachment>
					);
				})}
			</Attachments>
			<ResourceImageViewer
				items={previewItems}
				open={previewIndex !== undefined}
				initialIndex={previewIndex ?? 0}
				onOpenChange={(open) => {
					if (!open) setPreviewIndex(undefined);
				}}
			/>
		</>
	);
}
