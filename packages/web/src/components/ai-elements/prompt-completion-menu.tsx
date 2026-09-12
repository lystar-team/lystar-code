import { FileText, Folder, Puzzle, Sparkles, Terminal } from "lucide-react";
import type { ClipboardEvent, ComponentProps, KeyboardEvent, ReactNode, RefObject } from "react";
import { createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { webApi } from "../../adapters/host-protocol/api.ts";
import { cn } from "../../lib/utils";
import { webCommandCompletions } from "../../state/composer-commands";
import type { WebCompletionResult } from "../../types.ts";
import { Spinner } from "../ui/spinner";
import { usePromptInputAttachments, usePromptInputController } from "./prompt-input.tsx";

type CompletionResult = WebCompletionResult;
type CompletionItem = CompletionResult["items"][number];

type CompletionContextValue = {
	open: boolean;
	loading: boolean;
	result?: CompletionResult;
	selectedIndex: number;
	menuId: string;
	selectItem: (index: number) => void;
	moveSelection: (direction: 1 | -1) => void;
	setSelectedIndex: (index: number) => void;
	close: () => void;
	cursor: number;
	editorRef: RefObject<HTMLDivElement>;
	handleKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
	setCursor: (cursor: number) => void;
	trigger: "@" | "$" | "/" | undefined;
	validTokens: ReadonlySet<string>;
	markValidToken: (value: string) => void;
	resumeAutoOpen: () => void;
};

const CompletionContext = createContext<CompletionContextValue | null>(null);

function useCompletionContext(): CompletionContextValue {
	const context = useContext(CompletionContext);
	if (!context) throw new Error("PromptCompletion 组件必须放在 PromptCompletionProvider 内");
	return context;
}

function completionTrigger(text: string, cursor: number): "@" | "$" | "/" | undefined {
	const before = text.slice(0, cursor);
	if (/^\/[^\n]*$/u.test(before)) return "/";
	const match = /(?:^|\s)([@$])[^\s]*$/u.exec(before);
	return match?.[1] as "@" | "$" | undefined;
}

function completionGroupLabel(kind: CompletionItem["kind"]): string {
	switch (kind) {
		case "file":
		case "directory":
			return "文件和文件夹";
		case "extension":
			return "插件";
		case "prompt":
			return "Prompt";
		case "skill":
			return "Skill";
		default:
			return "其它";
	}
}

function CompletionIcon({ kind }: { kind: CompletionItem["kind"] }) {
	switch (kind) {
		case "file":
			return <FileText className="size-3.5 shrink-0 text-muted-foreground" />;
		case "directory":
			return <Folder className="size-3.5 shrink-0 text-muted-foreground" />;
		case "skill":
			return <Sparkles className="size-4 shrink-0 text-muted-foreground" />;
		case "extension":
			return <Puzzle className="size-4 shrink-0 text-muted-foreground" />;
		case "prompt":
			return <FileText className="size-4 shrink-0 text-muted-foreground" />;
		case "command":
			return <Terminal className="size-4 shrink-0 text-muted-foreground" />;
	}
}

function isPathCompletionItem(item: CompletionItem): boolean {
	return item.kind === "file" || item.kind === "directory";
}

function completionItemLabel(item: CompletionItem, trigger: CompletionContextValue["trigger"]): string {
	if (isPathCompletionItem(item)) {
		const value = item.value.trim();
		const path = value.startsWith("@") ? value.slice(1) : value;
		return path.startsWith('"') && path.endsWith('"') ? path.slice(1, -1) : path;
	}
	if (
		trigger === "/" &&
		item.value.startsWith("/") &&
		["command", "extension", "prompt", "skill"].includes(item.kind)
	) {
		return `/${item.label}`;
	}
	return item.label;
}

import {
	PromptTokenPartView,
	promptTokenParts,
	promptTokenRanges,
	usePromptTokenValidation,
} from "./prompt-token.tsx";

function deletePromptToken(
	text: string,
	selectionStart: number,
	selectionEnd: number,
	key: "Backspace" | "Delete",
	validTokens: ReadonlySet<string>,
): { text: string; cursor: number } | undefined {
	const ranges = promptTokenRanges(text, validTokens);
	if (selectionStart !== selectionEnd) {
		const selectedTokens = ranges.filter((range) => range.start < selectionEnd && range.end > selectionStart);
		if (selectedTokens.length === 0) return undefined;
		const deleteStart = Math.min(selectionStart, ...selectedTokens.map((range) => range.start));
		const deleteEnd = Math.max(selectionEnd, ...selectedTokens.map((range) => range.end));
		return {
			text: `${text.slice(0, deleteStart)}${text.slice(deleteEnd)}`,
			cursor: deleteStart,
		};
	}

	const target =
		key === "Backspace"
			? ranges.find((range) => {
					if (range.end === selectionStart || (range.start < selectionStart && selectionStart < range.end))
						return true;
					return range.end < selectionStart && /^\s$/u.test(text.slice(range.end, selectionStart));
				})
			: ranges.find(
					(range) =>
						range.start === selectionStart || (range.start < selectionStart && selectionStart < range.end),
				);
	if (!target) return undefined;

	const deleteEnd = key === "Backspace" && target.end < selectionStart ? selectionStart : target.end;
	const nextText = `${text.slice(0, target.start)}${text.slice(deleteEnd)}`;
	return { text: nextText, cursor: target.start };
}

export interface PromptCompletionProviderProps {
	projectId?: string;
	sessionId?: string;
	disabled?: boolean;
	onError?: (error: unknown) => void;
	children: ReactNode;
}

export function PromptCompletionProvider({
	projectId,
	sessionId,
	disabled = false,
	onError,
	children,
}: PromptCompletionProviderProps) {
	const controller = usePromptInputController();
	const text = controller.textInput.value;
	const { validTokens, markValidToken } = usePromptTokenValidation(text, projectId, sessionId);
	const [cursor, setCursorState] = useState(text.length);
	const [result, setResult] = useState<CompletionResult>();
	const [loading, setLoading] = useState(false);
	const [selectedIndex, setSelectedIndex] = useState(0);
	const requestVersion = useRef(0);
	const cursorRef = useRef(text.length);
	const onErrorRef = useRef(onError);
	const editorRef = useRef<HTMLDivElement>(null);
	const suppressAutoOpenRef = useRef(false);
	const menuId = `prompt-completions-${useId().replaceAll(":", "")}`;
	const trigger = completionTrigger(text, cursor);
	const active = Boolean(projectId && !disabled && trigger);
	const open = active && (loading || result !== undefined);

	useEffect(() => {
		onErrorRef.current = onError;
	}, [onError]);

	const setCursor = useCallback((nextCursor: number) => {
		cursorRef.current = nextCursor;
		setCursorState(nextCursor);
	}, []);

	const close = useCallback(() => {
		setResult(undefined);
		setLoading(false);
		setSelectedIndex(0);
		requestVersion.current += 1;
	}, []);

	const resumeAutoOpen = useCallback(() => {
		suppressAutoOpenRef.current = false;
	}, []);

	useEffect(() => {
		const nextCursor = Math.min(cursorRef.current, text.length);
		if (nextCursor !== cursorRef.current) setCursor(nextCursor);
	}, [setCursor, text.length]);

	useEffect(() => {
		if (!active || !projectId) {
			close();
			return;
		}
		if (suppressAutoOpenRef.current) {
			setResult(undefined);
			setLoading(false);
			return;
		}

		const version = ++requestVersion.current;
		setLoading(true);
		setResult(undefined);
		setSelectedIndex(0);
		const timer = window.setTimeout(() => {
			void webApi
				.completions(projectId, text, cursor, sessionId)
				.then((nextResult) => {
					if (requestVersion.current !== version) return;
					setResult(webCommandCompletions(nextResult));
					setSelectedIndex(0);
				})
				.catch((error: unknown) => {
					if (requestVersion.current !== version) return;
					setResult(undefined);
					onErrorRef.current?.(error);
				})
				.finally(() => {
					if (requestVersion.current === version) setLoading(false);
				});
		}, 90);

		return () => window.clearTimeout(timer);
	}, [active, close, cursor, projectId, sessionId, text]);

	const selectItem = useCallback(
		(index: number) => {
			const item = result?.items[index];
			if (!item) return;
			const prefixStart = Math.max(0, Math.min(result.prefixStart, text.length));
			const prefixEnd = Math.max(prefixStart, Math.min(result.prefixEnd, text.length));
			const nextText = `${text.slice(0, prefixStart)}${item.value}${text.slice(prefixEnd)}`;
			const nextCursor = prefixStart + item.value.length;
			markValidToken(item.value.trimEnd());
			suppressAutoOpenRef.current = true;
			controller.textInput.setInput(nextText);
			setCursor(nextCursor);
			close();
			window.requestAnimationFrame(() => {
				setPromptEditorSelection(editorRef.current, nextCursor);
			});
		},
		[close, controller.textInput, markValidToken, result, setCursor, text],
	);

	const moveSelection = useCallback(
		(direction: 1 | -1) => {
			const count = result?.items.length ?? 0;
			if (!count) return;
			setSelectedIndex((current) => (current + direction + count) % count);
		},
		[result?.items.length],
	);

	const handleKeyDown = useCallback(
		(event: KeyboardEvent<HTMLDivElement>) => {
			if (!open || event.nativeEvent.isComposing) return;
			if (event.key === "ArrowDown") {
				event.preventDefault();
				moveSelection(1);
			} else if (event.key === "ArrowUp") {
				event.preventDefault();
				moveSelection(-1);
			} else if (event.key === "Enter" && !event.shiftKey && !event.ctrlKey && !event.metaKey) {
				event.preventDefault();
				selectItem(selectedIndex);
			} else if (event.key === "Tab") {
				event.preventDefault();
				selectItem(selectedIndex);
			} else if (event.key === "Escape") {
				event.preventDefault();
				close();
			}
		},
		[close, moveSelection, open, selectItem, selectedIndex],
	);

	const value = useMemo<CompletionContextValue>(
		() => ({
			close,
			cursor,
			editorRef,
			handleKeyDown,
			loading,
			menuId,
			moveSelection,
			open,
			result,
			resumeAutoOpen,
			selectedIndex,
			selectItem,
			setCursor,
			setSelectedIndex,
			trigger,
			validTokens,
			markValidToken,
		}),
		[
			close,
			cursor,
			handleKeyDown,
			loading,
			menuId,
			moveSelection,
			open,
			result,
			resumeAutoOpen,
			selectedIndex,
			selectItem,
			setCursor,
			trigger,
			validTokens,
			markValidToken,
		],
	);

	return <CompletionContext.Provider value={value}>{children}</CompletionContext.Provider>;
}

type PromptEditorSelection = { start: number; end: number };

function promptEditorNodeText(node: Node): string {
	if (node.nodeType === Node.TEXT_NODE) return (node.textContent ?? "").replaceAll("\u00a0", " ").replaceAll("\u200b", "");
	if (!(node instanceof HTMLElement)) return "";
	const tokenRaw = node.dataset.promptTokenRaw;
	if (tokenRaw !== undefined) return tokenRaw;
	if (node.tagName === "BR") return node.dataset.promptLineBreak === "true" ? "\n" : "";
	const text = [...node.childNodes].map(promptEditorNodeText).join("");
	return (node.tagName === "DIV" || node.tagName === "P") && node.nextSibling && !text.endsWith("\n")
		? `${text}\n`
		: text;
}

function promptEditorText(editor: HTMLDivElement): string {
	return [...editor.childNodes].map(promptEditorNodeText).join("");
}

function promptEditorRawOffset(editor: HTMLDivElement, target: Node, targetOffset: number): number | undefined {
	const targetElement = target instanceof Element ? target : target.parentElement;
	const containingToken = targetElement?.closest<HTMLElement>("[data-prompt-token-raw]");
	if (containingToken && containingToken !== target && editor.contains(containingToken)) {
		const tokenStart = promptEditorRawOffset(editor, containingToken, 0);
		if (tokenStart === undefined) return undefined;
		const displayLength = containingToken.textContent?.length ?? 0;
		return tokenStart + (targetOffset * 2 >= displayLength ? (containingToken.dataset.promptTokenRaw?.length ?? 0) : 0);
	}

	let rawOffset = 0;
	let result: number | undefined;
	const visit = (node: Node): void => {
		if (result !== undefined) return;
		if (node === target) {
			if (node.nodeType === Node.TEXT_NODE) {
				const value = node.textContent ?? "";
				const domOffset = Math.max(0, Math.min(targetOffset, value.length));
				result = rawOffset + value.slice(0, domOffset).replaceAll("\u00a0", " ").replaceAll("\u200b", "").length;
				return;
			}
			if (node instanceof HTMLElement && node.dataset.promptTokenRaw !== undefined) {
				result = rawOffset + (targetOffset > 0 ? node.dataset.promptTokenRaw.length : 0);
				return;
			}
			const children = [...node.childNodes];
			for (const child of children.slice(0, Math.max(0, Math.min(targetOffset, children.length)))) {
				rawOffset += promptEditorNodeText(child).length;
			}
			result = rawOffset;
			return;
		}
		if (node.nodeType === Node.TEXT_NODE) {
			rawOffset += promptEditorNodeText(node).length;
			return;
		}
		if (!(node instanceof HTMLElement)) return;
		if (node.dataset.promptTokenRaw !== undefined || node.tagName === "BR") {
			rawOffset += promptEditorNodeText(node).length;
			return;
		}
		for (const child of node.childNodes) visit(child);
		if ((node.tagName === "DIV" || node.tagName === "P") && node.nextSibling) rawOffset += 1;
	};
	visit(editor);
	return result;
}

function promptEditorSelection(editor: HTMLDivElement): PromptEditorSelection | undefined {
	const selection = window.getSelection();
	if (!selection?.anchorNode || !selection.focusNode) return undefined;
	if (!editor.contains(selection.anchorNode) || !editor.contains(selection.focusNode)) return undefined;
	const anchor = promptEditorRawOffset(editor, selection.anchorNode, selection.anchorOffset);
	const focus = promptEditorRawOffset(editor, selection.focusNode, selection.focusOffset);
	if (anchor === undefined || focus === undefined) return undefined;
	return { start: Math.min(anchor, focus), end: Math.max(anchor, focus) };
}

function setPromptEditorSelection(editor: HTMLDivElement | null, rawCursor: number): void {
	if (!editor) return;
	const cursor = Math.max(0, rawCursor);
	const parts = [...editor.querySelectorAll<HTMLElement>("[data-prompt-part-start][data-prompt-part-end]")];
	const range = document.createRange();
	let placed = false;
	for (const part of parts) {
		const start = Number(part.dataset.promptPartStart);
		const end = Number(part.dataset.promptPartEnd);
		if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
		const parent = part.parentNode;
		if (!parent) continue;
		const childIndex = [...parent.childNodes].indexOf(part);
		if (cursor <= start) {
			range.setStart(parent, childIndex);
			placed = true;
			break;
		}
		if (part.dataset.promptTokenRaw !== undefined && cursor <= end) {
			range.setStart(parent, childIndex + 1);
			placed = true;
			break;
		}
		if (part.dataset.promptTokenRaw === undefined && cursor <= end) {
			let remaining = Math.max(0, cursor - start);
			for (const child of part.childNodes) {
				if (child.nodeType === Node.TEXT_NODE) {
					const value = child.textContent ?? "";
					const length = promptEditorNodeText(child).length;
					if (remaining <= length) {
						let rawIndex = 0;
						let domOffset = value.length;
						for (let index = 0; index < value.length; index += 1) {
							if (value[index] === "\u200b") continue;
							if (rawIndex === remaining) {
								domOffset = index;
								break;
							}
							rawIndex += 1;
						}
						range.setStart(child, domOffset);
						placed = true;
						break;
					}
					remaining -= length;
					continue;
				}
				if (child instanceof HTMLElement && child.tagName === "BR") {
					const breakIndex = [...part.childNodes].indexOf(child);
					if (remaining === 0) {
						range.setStart(part, breakIndex);
						placed = true;
						break;
					}
					remaining -= 1;
				}
			}
			if (placed) break;
		}
	}
	if (!placed) range.setStart(editor, editor.childNodes.length);
	range.collapse(true);
	const selection = window.getSelection();
	selection?.removeAllRanges();
	selection?.addRange(range);
	editor.focus();
}

function mobilePromptEnterInsertsNewline(): boolean {
	return window.matchMedia("(max-width: 767px)").matches;
}

function submitPromptEditor(editor: HTMLDivElement, mode: "prompt" | "steer"): void {
	const form = editor.closest("form");
	if (!form) return;
	const visibleSubmit = form.querySelector<HTMLButtonElement>("[data-prompt-submit-button]");
	if (visibleSubmit?.disabled) return;
	if (mode === "steer") {
		const steerSubmit = form.querySelector<HTMLButtonElement>('button[data-prompt-submit-mode="steer"]');
		if (steerSubmit) form.requestSubmit(steerSubmit);
		else form.requestSubmit();
		return;
	}
	form.requestSubmit();
}

function promptEditorLineText(line: string): string {
	return line
		.replace(/^ +/u, (spaces) => "\u00a0".repeat(spaces.length))
		.replace(/ +$/u, (spaces) => "\u00a0".repeat(spaces.length));
}

function PromptEditorPlainPart({ text, start, end }: { text: string; start: number; end: number }): ReactNode {
	const children: ReactNode[] = [];
	const lines = text.split("\n");
	for (const [index, line] of lines.entries()) {
		const stableLine = promptEditorLineText(line);
		children.push(index === 0 ? stableLine : `\u200b${stableLine}`);
		if (index < lines.length - 1) children.push(<br data-prompt-line-break="true" key={`break-${start + index}`} />);
	}
	return (
		<span data-prompt-part-end={end} data-prompt-part-start={start}>
			{children}
		</span>
	);
}

function PromptEditorParts({ text, validTokens }: { text: string; validTokens: ReadonlySet<string> }): ReactNode {
	if (!text) return null;
	return promptTokenParts(text, validTokens).map((part, index) =>
		part.kind ? (
			<span
				contentEditable={false}
				data-prompt-part-end={part.end}
				data-prompt-part-start={part.start}
				data-prompt-token-raw={text.slice(part.start, part.end)}
				key={`${part.start}:${part.end}:${index}`}
			>
				<PromptTokenPartView part={part} index={index} />
			</span>
		) : (
			<PromptEditorPlainPart
				key={`${part.start}:${part.end}:${index}`}
				text={part.text}
				start={part.start}
				end={part.end}
			/>
		),
	);
}

export type PromptCompletionTextareaProps = Omit<
	ComponentProps<"div">,
	"children" | "contentEditable" | "onBeforeInput" | "onInput" | "onKeyDown" | "onPaste"
> & {
	disabled?: boolean;
	placeholder?: string;
};

export function PromptCompletionTextarea({
	className,
	disabled = false,
	placeholder = "What would you like to know?",
	...props
}: PromptCompletionTextareaProps) {
	const context = useCompletionContext();
	const controller = usePromptInputController();
	const attachments = usePromptInputAttachments();
	const pendingCursorRef = useRef<number>();
	const composingRef = useRef(false);
	const mirrorRef = useRef<HTMLDivElement>(null);
	const replaceSelectionRef = useRef<(editor: HTMLDivElement, replacement: string) => void>(() => undefined);
	const [focused, setFocused] = useState(false);
	const text = controller.textInput.value;

	const commitText = useCallback(
		(nextText: string, cursor: number) => {
			pendingCursorRef.current = cursor;
			context.resumeAutoOpen();
			context.setCursor(cursor);
			controller.textInput.setInput(nextText);
		},
		[context, controller.textInput],
	);

	const replaceSelection = useCallback(
		(editor: HTMLDivElement, replacement: string) => {
			const selection = promptEditorSelection(editor) ?? { start: text.length, end: text.length };
			commitText(`${text.slice(0, selection.start)}${replacement}${text.slice(selection.end)}`, selection.start + replacement.length);
		},
		[commitText, text],
	);
	replaceSelectionRef.current = replaceSelection;

	const syncCursor = useCallback(
		(editor: HTMLDivElement) => {
			const selection = promptEditorSelection(editor);
			if (selection) context.setCursor(selection.end);
		},
		[context],
	);

	useLayoutEffect(() => {
		const editor = context.editorRef.current;
		const mirror = mirrorRef.current;
		if (!editor || !mirror || composingRef.current) return;
		const nextMarkup = mirror.innerHTML;
		const markupChanged = editor.innerHTML !== nextMarkup;
		const pendingCursor = pendingCursorRef.current;
		if (!markupChanged && pendingCursor === undefined) return;
		const selection = focused ? promptEditorSelection(editor) : undefined;
		const cursor = pendingCursor ?? selection?.end ?? context.cursor;
		if (markupChanged) editor.innerHTML = nextMarkup;
		pendingCursorRef.current = undefined;
		if (focused) setPromptEditorSelection(editor, cursor);
	}, [context.cursor, context.editorRef, context.validTokens, focused, text]);

	useEffect(() => {
		if (!focused) return;
		const handleSelectionChange = () => {
			const editor = context.editorRef.current;
			if (editor) syncCursor(editor);
		};
		document.addEventListener("selectionchange", handleSelectionChange);
		return () => document.removeEventListener("selectionchange", handleSelectionChange);
	}, [context.editorRef, focused, syncCursor]);

	useLayoutEffect(() => {
		const editor = context.editorRef.current;
		if (!editor) return;
		const handleBeforeInput = (event: InputEvent) => {
			if (event.isComposing || composingRef.current) return;
			if (event.inputType === "insertParagraph" || event.inputType === "insertLineBreak") {
				event.preventDefault();
				replaceSelectionRef.current(editor, "\n");
			}
		};
		editor.addEventListener("beforeinput", handleBeforeInput);
		return () => editor.removeEventListener("beforeinput", handleBeforeInput);
	}, [context.editorRef]);

	return (
		<>
			<div aria-hidden="true" hidden ref={mirrorRef}>
				<PromptEditorParts text={text} validTokens={context.validTokens} />
			</div>
			<div
				{...props}
			aria-activedescendant={context.open ? `${context.menuId}-item-${context.selectedIndex}` : undefined}
			aria-autocomplete="list"
			aria-controls={context.open ? context.menuId : undefined}
			aria-disabled={disabled}
			aria-expanded={context.open}
			aria-multiline="true"
			className={cn(
				"box-border max-h-48 min-h-16 w-full min-w-0 flex-1 cursor-text overflow-y-auto whitespace-pre-wrap break-words bg-transparent !px-5 !pt-4 !pb-2 text-left text-base leading-6 outline-none empty:before:pointer-events-none empty:before:text-muted-foreground empty:before:content-[attr(data-placeholder)] md:text-sm md:leading-5",
				disabled && "cursor-not-allowed opacity-50",
				className,
			)}
			contentEditable={!disabled}
			data-placeholder={placeholder}
			data-slot="input-group-control"
			enterKeyHint="enter"
			onClick={(event) => {
				context.resumeAutoOpen();
				syncCursor(event.currentTarget);
				props.onClick?.(event);
			}}
			onFocus={(event) => {
				setFocused(true);
				context.resumeAutoOpen();
				syncCursor(event.currentTarget);
				props.onFocus?.(event);
			}}
			onCompositionStart={(event) => {
				composingRef.current = true;
				props.onCompositionStart?.(event);
			}}
			onCompositionEnd={(event) => {
				composingRef.current = false;
				const editor = event.currentTarget;
				const nextText = promptEditorText(editor);
				const selection = promptEditorSelection(editor);
				commitText(nextText, selection?.end ?? nextText.length);
				props.onCompositionEnd?.(event);
			}}
			onBlur={(event) => {
				setFocused(false);
				props.onBlur?.(event);
			}}
			onInput={(event) => {
				if (composingRef.current || (event.nativeEvent as InputEvent).isComposing) return;
				const editor = event.currentTarget;
				const nextText = promptEditorText(editor);
				const selection = promptEditorSelection(editor);
				const cursor = selection?.end ?? nextText.length;
				if (nextText === text) context.setCursor(cursor);
				else commitText(nextText, cursor);
			}}
			onKeyDown={(event) => {
				context.handleKeyDown(event);
				if (event.defaultPrevented || event.nativeEvent.isComposing) return;
				if (event.key === "Backspace" || event.key === "Delete") {
					const selection = promptEditorSelection(event.currentTarget);
					if (selection) {
						const deletion = deletePromptToken(text, selection.start, selection.end, event.key, context.validTokens);
						if (deletion) {
							event.preventDefault();
							commitText(deletion.text, deletion.cursor);
							return;
						}
					}
					if (event.key === "Backspace" && text === "" && attachments.files.length > 0) {
						event.preventDefault();
						const lastAttachment = attachments.files.at(-1);
						if (lastAttachment) attachments.remove(lastAttachment.id);
					}
					return;
				}
				if (event.key !== "Enter") return;
				event.preventDefault();
				if (event.ctrlKey || event.metaKey) {
					submitPromptEditor(event.currentTarget, "steer");
					return;
				}
				if (event.shiftKey || mobilePromptEnterInsertsNewline()) {
					replaceSelection(event.currentTarget, "\n");
					return;
				}
				submitPromptEditor(event.currentTarget, "prompt");
			}}
			onKeyUp={(event) => {
				syncCursor(event.currentTarget);
				props.onKeyUp?.(event);
			}}
			onPaste={(event: ClipboardEvent<HTMLDivElement>) => {
				const files = [...event.clipboardData.items]
					.filter((item) => item.kind === "file")
					.flatMap((item) => {
						const file = item.getAsFile();
						return file ? [file] : [];
					});
				if (files.length > 0) {
					event.preventDefault();
					attachments.add(files);
					return;
				}
				const pastedText = event.clipboardData.getData("text/plain");
				if (pastedText) {
					event.preventDefault();
					replaceSelection(event.currentTarget, pastedText);
				}
			}}
			onPointerUp={(event) => {
				syncCursor(event.currentTarget);
				props.onPointerUp?.(event);
			}}
			ref={context.editorRef}
			role="textbox"
			spellCheck
			suppressContentEditableWarning
				tabIndex={disabled ? undefined : (props.tabIndex ?? 0)}
			/>
		</>
	);
}

export function PromptCompletionMenu() {
	const context = useCompletionContext();
	const items = context.result?.items ?? [];
	const activeItemId = `${context.menuId}-item-${context.selectedIndex}`;

	useEffect(() => {
		if (!context.open || !items.length) return;
		document.getElementById(activeItemId)?.scrollIntoView({ block: "nearest" });
	}, [activeItemId, context.open, items.length]);

	if (!context.open) return null;

	return (
		<div
			aria-label="输入建议"
			className="absolute inset-x-0 bottom-[calc(100%+0.5rem)] z-40 max-h-[min(28rem,calc(100dvh-10rem))] overflow-y-auto rounded-2xl border border-border/80 bg-background/95 p-2 shadow-[0_14px_36px_rgb(0_0_0/0.12)] backdrop-blur-md"
			id={context.menuId}
			onMouseDown={(event) => event.preventDefault()}
			role="listbox"
		>
			{context.loading && !items.length ? (
				<div className="flex items-center gap-2 px-3 py-3 text-sm text-muted-foreground">
					<Spinner className="size-4" />
					正在读取建议
				</div>
			) : null}
			{!context.loading && !items.length ? (
				<div className="px-3 py-3 text-sm text-muted-foreground">没有匹配的建议</div>
			) : null}
			{			items.map((item, index) => {
				const previous = items[index - 1];
				const previousGroup = previous ? completionGroupLabel(previous.kind) : undefined;
				const currentGroup = completionGroupLabel(item.kind);
				const showGroup = index === 0 || previousGroup !== currentGroup;
				return (
					<div key={`${item.kind}:${item.label}:${index}`}>
						{showGroup ? (
							<div className="px-2 pt-1 pb-0.5 text-[10px] font-semibold tracking-wide text-muted-foreground">
								{currentGroup}
							</div>
						) : null}
						<button
							className={cn(
								"flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left outline-none transition-colors",
								context.selectedIndex === index ? "bg-accent text-foreground" : "hover:bg-accent/70",
							)}
							id={`${context.menuId}-item-${index}`}
							onClick={() => context.selectItem(index)}
							onMouseMove={() => context.setSelectedIndex(index)}
							type="button"
						>
							<CompletionIcon kind={item.kind} />
							<span className="min-w-0 flex-1">
								<span className="block truncate text-sm font-medium">
									{completionItemLabel(item, context.trigger)}
								</span>
								{item.description && !isPathCompletionItem(item) ? (
									<span className="mt-0.5 block truncate text-xs text-muted-foreground">
										{item.description}
									</span>
								) : null}
							</span>
						</button>
					</div>
				);
			})}
		</div>
	);
}
