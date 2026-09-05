import { FileText, Folder, Puzzle, Sparkles, Terminal } from "lucide-react";
import type { KeyboardEvent, ReactNode, RefObject, SyntheticEvent } from "react";
import { createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { webApi } from "../../adapters/host-protocol/api.ts";
import { cn } from "../../lib/utils";
import type { WebCompletionResult } from "../../types.ts";
import { Spinner } from "../ui/spinner";
import { PromptInputTextarea, type PromptInputTextareaProps, usePromptInputController } from "./prompt-input.tsx";

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
	textareaRef: RefObject<HTMLTextAreaElement | null>;
	handleKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
	setCursor: (cursor: number) => void;
	trigger: "@" | "$" | "/" | undefined;
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

const PROMPT_TOKEN_PATTERN =
	/\$\[[a-z0-9][a-z0-9-]*\]|@\[[a-z0-9][a-z0-9-]*\]|\/skill:[a-z0-9][a-z0-9-]*|@"(?:[^"\\]|\\.)*"|@[^\s,，。；;!?！？]+/giu;
type PromptTokenKind = "file" | "skill";
type PromptToken = { text: string; start: number; end: number; kind?: PromptTokenKind };
type PromptTokenPart = { text: string; start: number; end: number; kind?: PromptTokenKind };

function promptTokenKind(value: string): PromptTokenKind | undefined {
	if (value.startsWith("$[") || value.startsWith("@[") || value.startsWith("/skill:")) return "skill";
	if (value.startsWith("@")) return "file";
	return undefined;
}

function promptTokenDisplayText(value: string, kind: PromptTokenKind): string {
	if (kind === "file") {
		if (value.startsWith('@"') && value.endsWith('"')) return value.slice(2, -1);
		return value.slice(1);
	}
	if (value.startsWith("$[") || value.startsWith("@[")) return value.slice(2, -1);
	return value.slice("/skill:".length);
}

function promptTokenDisplayOffset(value: string, kind: PromptTokenKind, offset: number, displayLength: number): number {
	const prefixLength =
		kind === "file" ? (value.startsWith('@"') ? 2 : 1) : value.startsWith("/skill:") ? "/skill:".length : 2;
	return Math.max(0, Math.min(displayLength, offset - prefixLength));
}

function promptTokenRanges(text: string): PromptToken[] {
	return [...text.matchAll(PROMPT_TOKEN_PATTERN)].map((match) => {
		const start = match.index ?? 0;
		return { text: match[0], start, end: start + match[0].length, kind: promptTokenKind(match[0]) };
	});
}

function promptTokenParts(text: string): PromptTokenPart[] {
	const parts: PromptTokenPart[] = [];
	let lastIndex = 0;
	for (const token of promptTokenRanges(text)) {
		if (token.start > lastIndex) {
			parts.push({ text: text.slice(lastIndex, token.start), start: lastIndex, end: token.start });
		}
		parts.push({
			text: token.kind ? promptTokenDisplayText(token.text, token.kind) : token.text,
			start: token.start,
			end: token.end,
			kind: token.kind,
		});
		lastIndex = token.end;
	}
	if (lastIndex < text.length) parts.push({ text: text.slice(lastIndex), start: lastIndex, end: text.length });
	if (parts.length === 0) parts.push({ text: "", start: 0, end: 0 });
	return parts;
}

function deletePromptToken(
	text: string,
	selectionStart: number,
	selectionEnd: number,
	key: "Backspace" | "Delete",
): { text: string; cursor: number } | undefined {
	const ranges = promptTokenRanges(text);
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

function PromptTokenOverlay({
	text,
	className,
	overlayRef,
}: {
	text: string;
	className?: string;
	overlayRef: RefObject<HTMLDivElement | null>;
}) {
	return (
		<div
			aria-hidden="true"
			className={cn(
				"pointer-events-none absolute inset-0 z-0 overflow-hidden whitespace-pre-wrap break-words text-left text-base md:text-sm",
				className,
			)}
			ref={overlayRef}
		>
			{promptTokenParts(text).map((part, index) => {
				const partAttributes = {
					"data-prompt-part-start": part.start,
					"data-prompt-part-end": part.end,
				};
				if (!part.kind) {
					return (
						<span key={`${part.text}:${index}`} {...partAttributes}>
							{part.text}
						</span>
					);
				}
				const Icon = part.kind === "skill" ? Sparkles : FileText;
				return (
					<span
						className={cn(
							"inline-flex items-center gap-1 align-baseline font-medium text-blue-600 dark:text-blue-400",
							index > 0 && "ml-1",
						)}
						key={`${part.text}:${index}`}
						{...partAttributes}
					>
						<Icon className="size-3 shrink-0" />
						<span data-prompt-text="true">{part.text}</span>
					</span>
				);
			})}
		</div>
	);
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
	const [cursor, setCursorState] = useState(text.length);
	const [result, setResult] = useState<CompletionResult>();
	const [loading, setLoading] = useState(false);
	const [selectedIndex, setSelectedIndex] = useState(0);
	const requestVersion = useRef(0);
	const cursorRef = useRef(text.length);
	const onErrorRef = useRef(onError);
	const textareaRef = useRef<HTMLTextAreaElement | null>(null);
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
					setResult(nextResult);
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
			suppressAutoOpenRef.current = true;
			controller.textInput.setInput(nextText);
			setCursor(nextCursor);
			close();
			window.requestAnimationFrame(() => {
				const textarea = textareaRef.current;
				textarea?.focus();
				textarea?.setSelectionRange(nextCursor, nextCursor);
			});
		},
		[close, controller.textInput, result, setCursor, text],
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
		(event: KeyboardEvent<HTMLTextAreaElement>) => {
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
			textareaRef,
			trigger,
		}),
		[
			close,
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
		],
	);

	return <CompletionContext.Provider value={value}>{children}</CompletionContext.Provider>;
}

type PromptCaretPosition = { left: number; top: number; height: number };

function firstTextNode(element: Element): Text | undefined {
	return [...element.childNodes].find((node): node is Text => node.nodeType === Node.TEXT_NODE);
}

function promptCaretPosition(
	overlay: HTMLDivElement,
	textarea: HTMLTextAreaElement,
	text: string,
): PromptCaretPosition {
	const overlayRect = overlay.getBoundingClientRect();
	const style = getComputedStyle(overlay);
	const fallbackHeight = Number.parseFloat(style.lineHeight) || Number.parseFloat(style.fontSize) || 16;
	const fallback = (): PromptCaretPosition => ({
		left: Number.parseFloat(style.paddingLeft) || 0,
		top: Number.parseFloat(style.paddingTop) || 0,
		height: fallbackHeight,
	});
	const cursor = Math.max(0, Math.min(textarea.selectionStart, text.length));
	const parts = promptTokenParts(text);
	const part =
		parts.find((candidate) => cursor > candidate.start && cursor < candidate.end) ??
		parts.find((candidate) => cursor === candidate.end) ??
		parts.find((candidate) => cursor === candidate.start);
	if (!part) return fallback();

	const partElement = overlay.querySelector<HTMLElement>(
		`[data-prompt-part-start="${part.start}"][data-prompt-part-end="${part.end}"]`,
	);
	const textElement = part.kind ? partElement?.querySelector<HTMLElement>('[data-prompt-text="true"]') : partElement;
	const textNode = textElement ? firstTextNode(textElement) : undefined;
	if (!textNode) return fallback();

	const rawValue = text.slice(part.start, part.end);
	const rawOffset = cursor - part.start;
	const offset = part.kind
		? promptTokenDisplayOffset(rawValue, part.kind, rawOffset, part.text.length)
		: Math.max(0, Math.min(part.text.length, rawOffset));
	const range = document.createRange();
	range.setStart(textNode, Math.min(offset, textNode.length));
	range.collapse(true);
	const rect = range.getBoundingClientRect();
	if (!rect.height) return fallback();
	return { left: rect.left - overlayRect.left, top: rect.top - overlayRect.top, height: rect.height };
}

export function PromptCompletionTextarea({
	className,
	onChange,
	onKeyDown,
	onSelect,
	onScroll,
	onFocus,
	onBlur,
	...props
}: PromptInputTextareaProps) {
	const context = useCompletionContext();
	const controller = usePromptInputController();
	const overlayRef = useRef<HTMLDivElement | null>(null);
	const [focused, setFocused] = useState(false);
	const [caret, setCaret] = useState<PromptCaretPosition | null>(null);
	const refreshVisualCaret = useCallback(() => {
		const overlay = overlayRef.current;
		const textarea = context.textareaRef.current;
		if (!focused || !overlay || !textarea) {
			setCaret(null);
			return;
		}
		setCaret(promptCaretPosition(overlay, textarea, controller.textInput.value));
	}, [context.textareaRef, controller.textInput.value, focused]);
	const updateCursor = useCallback(
		(event: SyntheticEvent<HTMLTextAreaElement>) => {
			context.setCursor(event.currentTarget.selectionStart);
			window.requestAnimationFrame(refreshVisualCaret);
		},
		[context, refreshVisualCaret],
	);

	useLayoutEffect(() => {
		if (!focused) {
			setCaret(null);
			return;
		}
		const frame = window.requestAnimationFrame(refreshVisualCaret);
		return () => window.cancelAnimationFrame(frame);
	}, [focused, refreshVisualCaret]);

	return (
		<div className="relative w-full min-w-0">
			<PromptTokenOverlay className={className} overlayRef={overlayRef} text={controller.textInput.value} />
			<PromptInputTextarea
				{...props}
				aria-activedescendant={context.open ? `${context.menuId}-item-${context.selectedIndex}` : undefined}
				aria-autocomplete="list"
				aria-controls={context.open ? context.menuId : undefined}
				aria-expanded={context.open}
				className={cn(
					className,
					"relative z-10 bg-transparent text-transparent caret-transparent placeholder:text-muted-foreground selection:bg-blue-100 selection:text-transparent dark:selection:bg-blue-500/20",
				)}
				onChange={(event) => {
					context.resumeAutoOpen();
					updateCursor(event);
					onChange?.(event);
				}}
				onClick={(event) => {
					context.resumeAutoOpen();
					updateCursor(event);
					props.onClick?.(event);
				}}
				onKeyDown={(event) => {
					context.handleKeyDown(event);
					if (!event.defaultPrevented && (event.key === "Backspace" || event.key === "Delete")) {
						const deletion = deletePromptToken(
							controller.textInput.value,
							event.currentTarget.selectionStart,
							event.currentTarget.selectionEnd,
							event.key,
						);
						if (deletion) {
							event.preventDefault();
							context.resumeAutoOpen();
							controller.textInput.setInput(deletion.text);
							context.setCursor(deletion.cursor);
							window.requestAnimationFrame(() => {
								const textarea = context.textareaRef.current;
								textarea?.focus();
								textarea?.setSelectionRange(deletion.cursor, deletion.cursor);
								refreshVisualCaret();
							});
						}
					}
					onKeyDown?.(event);
				}}
				onFocus={(event) => {
					setFocused(true);
					onFocus?.(event);
					window.requestAnimationFrame(refreshVisualCaret);
				}}
				onBlur={(event) => {
					setFocused(false);
					onBlur?.(event);
				}}
				onScroll={(event) => {
					overlayRef.current?.scrollTo(event.currentTarget.scrollLeft, event.currentTarget.scrollTop);
					window.requestAnimationFrame(refreshVisualCaret);
					onScroll?.(event);
				}}
				onSelect={(event) => {
					context.resumeAutoOpen();
					updateCursor(event);
					onSelect?.(event);
				}}
				ref={context.textareaRef}
				value={controller.textInput.value}
			/>
			{focused && caret ? (
				<span
					aria-hidden="true"
					className="pointer-events-none absolute z-20 w-px animate-pulse bg-foreground"
					style={{ left: caret.left, top: caret.top, height: caret.height }}
				/>
			) : null}
		</div>
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
