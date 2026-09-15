"use client";

import { CheckIcon, Code2Icon, CopyIcon, DownloadIcon } from "lucide-react";
import type { ComponentProps, CSSProperties, HTMLAttributes } from "react";
import { createContext, memo, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { BundledLanguage, ThemedToken } from "shiki";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { highlightCode, shouldHighlightCode, subscribeToCodeHighlight, type TokenizedCode } from "@/lib/code-highlighter";
import { cn } from "@/lib/utils";

export { highlightCode };

// Shiki uses bitflags for font styles: 1=italic, 2=bold, 4=underline
// oxlint-disable-next-line eslint(no-bitwise)
const isItalic = (fontStyle: number | undefined) => fontStyle && fontStyle & 1;
// oxlint-disable-next-line eslint(no-bitwise)
const isBold = (fontStyle: number | undefined) => fontStyle && fontStyle & 2;
const isUnderline = (fontStyle: number | undefined) =>
	// oxlint-disable-next-line eslint(no-bitwise)
	fontStyle && fontStyle & 4;

type DiffLineKind = "added" | "removed" | "context" | "metadata" | "neutral";

// Transform tokens to include pre-computed keys to avoid noArrayIndexKey lint
interface KeyedToken {
	token: ThemedToken;
	key: string;
}
interface KeyedLine {
	tokens: KeyedToken[];
	key: string;
	diffKind?: DiffLineKind;
}

const addKeysToTokens = (lines: ThemedToken[][], diffLineKinds?: readonly DiffLineKind[]): KeyedLine[] =>
	lines.map((line, lineIdx) => ({
		key: `line-${lineIdx}`,
		tokens: line.map((token, tokenIdx) => ({
			key: `line-${lineIdx}-${tokenIdx}`,
			token,
		})),
		...(diffLineKinds?.[lineIdx] ? { diffKind: diffLineKinds[lineIdx] } : {}),
	}));

// Token rendering component
const TokenSpan = ({ token }: { token: ThemedToken }) => (
	<span
		className="code-block-token dark:!bg-[var(--shiki-dark-bg)] dark:!text-[var(--shiki-dark)]"
		style={
			{
				backgroundColor: token.bgColor,
				color: token.color,
				fontStyle: isItalic(token.fontStyle) ? "italic" : undefined,
				fontWeight: isBold(token.fontStyle) ? "bold" : undefined,
				textDecoration: isUnderline(token.fontStyle) ? "underline" : undefined,
				...token.htmlStyle,
			} as CSSProperties
		}
	>
		{token.content}
	</span>
);

// Line number styles using CSS counters
const LINE_NUMBER_CLASSES = cn(
	"block",
	"before:content-[counter(line)]",
	"before:inline-block",
	"before:[counter-increment:line]",
	"before:w-8",
	"before:mr-4",
	"before:text-right",
	"before:text-muted-foreground/50",
	"before:font-mono",
	"before:select-none",
);

// Line rendering component
const LineSpan = ({
	keyedLine,
	showLineNumbers,
}: {
	keyedLine: KeyedLine;
	showLineNumbers: boolean;
}) => (
	<span
		className={cn("code-block-line", showLineNumbers ? LINE_NUMBER_CLASSES : "block")}
		data-diff-line={keyedLine.diffKind === "neutral" ? undefined : keyedLine.diffKind}
	>
		{keyedLine.tokens.length === 0
			? "\n"
			: keyedLine.tokens.map(({ token, key }) => <TokenSpan key={key} token={token} />)}
	</span>
);

// Types
type CodeBlockProps = HTMLAttributes<HTMLDivElement> & {
	code: string;
	language: BundledLanguage;
	showLineNumbers?: boolean;
	plainText?: boolean;
	transparent?: boolean;
	wrap?: boolean;
	diffLanguage?: BundledLanguage;
};

interface CodeBlockContextType {
	code: string;
}

const CodeBlockContext = createContext<CodeBlockContextType>({
	code: "",
});

// Create raw tokens for immediate display while highlighting loads
const createRawTokens = (code: string): TokenizedCode => ({
	bg: "transparent",
	fg: "inherit",
	tokens: code.split("\n").map((line) =>
		line === ""
			? []
			: [
					{
						color: "inherit",
						content: line,
					} as ThemedToken,
				],
	),
});

type DiffLine = {
	prefix?: "+" | "-" | " ";
	lineNumber?: string;
	content: string;
	kind: DiffLineKind;
	metadata: boolean;
};

type DiffTokenKind = "added" | "removed" | "context" | "line-number" | "metadata";

export const MAX_DIFF_HIGHLIGHT_BYTES = 32 * 1024;
export const MAX_DIFF_HIGHLIGHT_LINES = 600;

export function shouldHighlightDiffCode(code: string): boolean {
	let bytes = 0;
	let lines = 1;
	for (let index = 0; index < code.length; index++) {
		const value = code.charCodeAt(index);
		if (value === 10) {
			lines += 1;
			if (lines > MAX_DIFF_HIGHLIGHT_LINES) return false;
		}
		if (value < 0x80) bytes += 1;
		else if (value < 0x800) bytes += 2;
		else if (value >= 0xd800 && value <= 0xdbff && index + 1 < code.length) {
			const next = code.charCodeAt(index + 1);
			if (next >= 0xdc00 && next <= 0xdfff) {
				bytes += 4;
				index += 1;
			} else bytes += 3;
		} else bytes += 3;
		if (bytes > MAX_DIFF_HIGHLIGHT_BYTES) return false;
	}
	return true;
}

const DIFF_TOKEN_STYLES: Record<DiffTokenKind, readonly [string, string]> = {
	added: ["#22863a", "#85e89d"],
	removed: ["#b31d28", "#fdaeb7"],
	context: ["#586069", "#959da5"],
	"line-number": ["#6a737d", "#959da5"],
	metadata: ["#6f42c1", "#b392f0"],
};

function isDiffMetadata(line: string): boolean {
	return (
		line.startsWith("diff ") ||
		line.startsWith("index ") ||
		line.startsWith("--- ") ||
		line.startsWith("+++ ") ||
		line.startsWith("@@") ||
		line.startsWith("\\ No newline")
	);
}

function diffLineKind(prefix: "+" | "-" | " "): DiffLineKind {
	if (prefix === "+") return "added";
	if (prefix === "-") return "removed";
	return "context";
}

function parseDiffLine(line: string): DiffLine {
	if (isDiffMetadata(line)) return { content: line, kind: "metadata", metadata: true };
	const displayMatch = line.match(/^([-+ ])(\s*\d*)\s(.*)$/u);
	if (displayMatch) {
		const prefix = displayMatch[1] as "+" | "-" | " ";
		return {
			prefix,
			lineNumber: displayMatch[2],
			content: displayMatch[3] ?? "",
			kind: diffLineKind(prefix),
			metadata: false,
		};
	}
	if (line.startsWith("+") || line.startsWith("-") || line.startsWith(" ")) {
		const prefix = line[0] as "+" | "-" | " ";
		return { prefix, content: line.slice(1), kind: diffLineKind(prefix), metadata: false };
	}
	return { content: line, kind: "neutral", metadata: false };
}

function createDiffToken(content: string, kind: DiffTokenKind): ThemedToken {
	const [light, dark] = DIFF_TOKEN_STYLES[kind];
	return {
		offset: 0,
		content,
		htmlStyle: { color: light, "--shiki-dark": dark },
	} as ThemedToken;
}

function createDiffTokenLines(lines: DiffLine[], sourceTokens: ThemedToken[][]): ThemedToken[][] {
	return lines.map((line, lineIndex) => {
		if (line.metadata) return [createDiffToken(line.content, "metadata")];
		const tokens: ThemedToken[] = [];
		if (line.prefix) {
			const kind = line.prefix === "+" ? "added" : line.prefix === "-" ? "removed" : "context";
			tokens.push(createDiffToken(line.prefix, kind));
		}
		if (line.lineNumber !== undefined) {
			tokens.push(createDiffToken(line.lineNumber, "line-number"));
			tokens.push(createDiffToken(" ", "line-number"));
		}
		const highlighted = sourceTokens[lineIndex];
		if (highlighted?.length) {
			tokens.push(...highlighted);
		} else if (line.content) {
			tokens.push({ content: line.content } as ThemedToken);
		}
		return tokens;
	});
}

function useHighlightedCode(code: string, language: BundledLanguage, enabled = true): TokenizedCode {
	const rawTokens = useMemo(() => createRawTokens(code), [code]);
	const syncTokens = useMemo(
		() => (enabled ? (highlightCode(code, language) ?? rawTokens) : rawTokens),
		[code, enabled, language, rawTokens],
	);
	const [asyncTokens, setAsyncTokens] = useState<TokenizedCode | null>(null);
	const asyncKeyRef = useRef({ code, language, enabled });

	if (
		asyncKeyRef.current.code !== code ||
		asyncKeyRef.current.language !== language ||
		asyncKeyRef.current.enabled !== enabled
	) {
		asyncKeyRef.current = { code, language, enabled };
		setAsyncTokens(null);
	}

	useEffect(() => {
		if (!enabled) return;
		return subscribeToCodeHighlight(code, language, setAsyncTokens);
	}, [code, enabled, language]);

	return enabled ? (asyncTokens ?? syncTokens) : rawTokens;
}

function splitShikiThemeValue(
	value: string,
	darkVariable: "--shiki-dark" | "--shiki-dark-bg",
): { light: string; dark?: string } {
	const [light, ...declarations] = value.split(";");
	const darkDeclaration = declarations.find((declaration) => declaration.startsWith(`${darkVariable}:`));
	return {
		light,
		...(darkDeclaration ? { dark: darkDeclaration.slice(darkVariable.length + 1) } : {}),
	};
}

const CodeBlockBody = memo(
	({
		tokenized,
		showLineNumbers,
		transparent,
		wrap,
		className,
		diffLineKinds,
	}: {
		tokenized: TokenizedCode;
		showLineNumbers: boolean;
		transparent?: boolean;
		wrap?: boolean;
		className?: string;
		diffLineKinds?: readonly DiffLineKind[];
	}) => {
		const preStyle = useMemo(() => {
			const background = splitShikiThemeValue(tokenized.bg, "--shiki-dark-bg");
			const foreground = splitShikiThemeValue(tokenized.fg, "--shiki-dark");
			return {
				backgroundColor: transparent ? "transparent" : background.light,
				color: foreground.light,
				...(transparent ? {} : background.dark ? { "--shiki-dark-bg": background.dark } : {}),
				...(foreground.dark ? { "--shiki-dark": foreground.dark } : {}),
			} as CSSProperties;
		}, [tokenized.bg, tokenized.fg, transparent]);

		const keyedLines = useMemo(() => addKeysToTokens(tokenized.tokens, diffLineKinds), [diffLineKinds, tokenized.tokens]);

		return (
			<pre
				className={cn(
					"code-block-pre",
					transparent ? "bg-transparent dark:!bg-transparent" : "dark:!bg-[var(--shiki-dark-bg)]",
					"dark:!text-[var(--shiki-dark)] m-0 p-4 text-sm",
					wrap && "whitespace-pre-wrap break-words",
					className,
				)}
				data-code-background={transparent ? "transparent" : "themed"}
				data-diff={diffLineKinds ? "true" : undefined}
				style={preStyle}
			>
				<code
					className={cn("font-mono text-sm", showLineNumbers && "[counter-increment:line_0] [counter-reset:line]")}
				>
					{keyedLines.map((keyedLine) => (
						<LineSpan key={keyedLine.key} keyedLine={keyedLine} showLineNumbers={showLineNumbers} />
					))}
				</code>
			</pre>
		);
	},
	(prevProps, nextProps) =>
		prevProps.tokenized === nextProps.tokenized &&
		prevProps.showLineNumbers === nextProps.showLineNumbers &&
		prevProps.transparent === nextProps.transparent &&
		prevProps.wrap === nextProps.wrap &&
		prevProps.className === nextProps.className &&
		prevProps.diffLineKinds === nextProps.diffLineKinds,
);

CodeBlockBody.displayName = "CodeBlockBody";

export const CodeBlockContainer = ({
	className,
	language,
	style,
	...props
}: HTMLAttributes<HTMLDivElement> & { language: string }) => (
	<div
		className={cn("group relative w-full overflow-hidden rounded-md border bg-background text-foreground", className)}
		data-language={language}
		style={{
			containIntrinsicSize: "auto 200px",
			contentVisibility: "auto",
			...style,
		}}
		{...props}
	/>
);

export const CodeBlockHeader = ({ children, className, ...props }: HTMLAttributes<HTMLDivElement>) => (
	<div
		className={cn(
			"flex items-center justify-between border-b bg-muted/80 px-3 py-2 text-muted-foreground text-xs",
			className,
		)}
		{...props}
	>
		{children}
	</div>
);

export const CodeBlockTitle = ({ children, className, ...props }: HTMLAttributes<HTMLDivElement>) => (
	<div className={cn("flex items-center gap-2", className)} {...props}>
		{children}
	</div>
);

export const CodeBlockFilename = ({ children, className, ...props }: HTMLAttributes<HTMLSpanElement>) => (
	<span className={cn("font-mono", className)} {...props}>
		{children}
	</span>
);

export const CodeBlockActions = ({ children, className, ...props }: HTMLAttributes<HTMLDivElement>) => (
	<div className={cn("-my-1 -mr-1 flex items-center gap-2", className)} {...props}>
		{children}
	</div>
);

const PlainTextBody = ({ code }: { code: string }) => (
	<div className="relative overflow-hidden">
		<pre className="m-0 whitespace-pre-wrap break-words px-5 pb-4 pt-0 text-sm leading-6 text-foreground">
			<code className="font-mono text-sm">{code}</code>
		</pre>
	</div>
);

const HighlightedCodeBlockContent = ({
	code,
	language,
	showLineNumbers = false,
	transparent = false,
	wrap = false,
}: {
	code: string;
	language: BundledLanguage;
	showLineNumbers?: boolean;
	transparent?: boolean;
	wrap?: boolean;
}) => {
	const tokenized = useHighlightedCode(code, language);

	return (
		<div className={cn("relative overflow-auto", wrap && "overflow-x-hidden")}>
			<CodeBlockBody showLineNumbers={showLineNumbers} tokenized={tokenized} transparent={transparent} wrap={wrap} />
		</div>
	);
};

const HighlightedDiffCodeBlockContent = ({
	code,
	language,
	highlightSource = true,
	transparent = false,
	wrap = false,
}: {
	code: string;
	language: BundledLanguage;
	highlightSource?: boolean;
	transparent?: boolean;
	wrap?: boolean;
}) => {
	const lines = useMemo(() => code.split("\n").map(parseDiffLine), [code]);
	const lineKinds = useMemo(() => lines.map((line) => line.kind), [lines]);
	const sourceCode = useMemo(() => lines.map((line) => (line.metadata ? "" : line.content)).join("\n"), [lines]);
	const sourceTokens = useHighlightedCode(sourceCode, language, highlightSource);
	const tokenized = useMemo(
		() => ({
			bg: sourceTokens.bg,
			fg: sourceTokens.fg,
			tokens: createDiffTokenLines(lines, sourceTokens.tokens),
		}),
		[lines, sourceTokens],
	);

	return (
		<div className={cn("relative overflow-auto", wrap && "overflow-x-hidden")}>
			<CodeBlockBody
				diffLineKinds={lineKinds}
				tokenized={tokenized}
				showLineNumbers={false}
				transparent={transparent}
				wrap={wrap}
			/>
		</div>
	);
};

export const CodeBlockContent = ({
	code,
	language,
	diffLanguage,
	showLineNumbers = false,
	plainText = false,
	transparent = false,
	wrap = false,
}: {
	code: string;
	language: BundledLanguage;
	diffLanguage?: BundledLanguage;
	showLineNumbers?: boolean;
	plainText?: boolean;
	transparent?: boolean;
	wrap?: boolean;
}) =>
	diffLanguage ? (
		<HighlightedDiffCodeBlockContent
			code={code}
			language={diffLanguage}
			highlightSource={!plainText}
			transparent={transparent}
			wrap={wrap}
		/>
	) : plainText ? (
		<PlainTextBody code={code} />
	) : (
		<HighlightedCodeBlockContent
			code={code}
			language={language}
			showLineNumbers={showLineNumbers}
			transparent={transparent}
			wrap={wrap}
		/>
	);

export const CodeBlock = ({
	code,
	language,
	diffLanguage,
	showLineNumbers = false,
	plainText = false,
	transparent = false,
	wrap = false,
	className,
	children,
	...props
}: CodeBlockProps) => {
	const contextValue = useMemo(() => ({ code }), [code]);
	const renderPlainText = plainText || !(diffLanguage ? shouldHighlightDiffCode(code) : shouldHighlightCode(code));

	return (
		<CodeBlockContext.Provider value={contextValue}>
			<CodeBlockContainer
				className={cn(className, transparent && "!border-0 !bg-transparent")}
				language={language}
				{...props}
			>
				{children}
				<CodeBlockContent
					code={code}
					language={language}
					diffLanguage={diffLanguage}
					showLineNumbers={showLineNumbers}
					plainText={renderPlainText}
					transparent={transparent}
					wrap={wrap}
				/>
			</CodeBlockContainer>
		</CodeBlockContext.Provider>
	);
};

export type CodeBlockCopyButtonProps = ComponentProps<typeof Button> & {
	code?: string;
	onCopy?: () => void;
	onError?: (error: Error) => void;
	timeout?: number;
};

export const CodeBlockCopyButton = ({
	code: providedCode,
	onCopy,
	onError,
	timeout = 2000,
	children,
	className,
	...props
}: CodeBlockCopyButtonProps) => {
	const [isCopied, setIsCopied] = useState(false);
	const timeoutRef = useRef<number>(0);
	const { code: contextCode } = useContext(CodeBlockContext);
	const code = providedCode ?? contextCode;

	const copyToClipboard = useCallback(async () => {
		if (typeof window === "undefined" || !navigator?.clipboard?.writeText) {
			onError?.(new Error("Clipboard API not available"));
			return;
		}

		try {
			if (!isCopied) {
				await navigator.clipboard.writeText(code);
				setIsCopied(true);
				onCopy?.();
				timeoutRef.current = window.setTimeout(() => setIsCopied(false), timeout);
			}
		} catch (error) {
			onError?.(error as Error);
		}
	}, [code, onCopy, onError, timeout, isCopied]);

	useEffect(
		() => () => {
			window.clearTimeout(timeoutRef.current);
		},
		[],
	);

	const Icon = isCopied ? CheckIcon : CopyIcon;

	return (
		<Button className={cn("shrink-0", className)} onClick={copyToClipboard} size="icon" variant="ghost" {...props}>
			{children ?? <Icon size={14} />}
		</Button>
	);
};

export type CodeBlockDownloadButtonProps = ComponentProps<typeof Button> & {
	code?: string;
	filename?: string;
};

export const CodeBlockDownloadButton = ({
	code: providedCode,
	filename = "code.txt",
	children,
	className,
	...props
}: CodeBlockDownloadButtonProps) => {
	const { code: contextCode } = useContext(CodeBlockContext);
	const code = providedCode ?? contextCode;

	const download = useCallback(() => {
		const url = URL.createObjectURL(new Blob([code], { type: "text/plain;charset=utf-8" }));
		const link = document.createElement("a");
		link.href = url;
		link.download = filename;
		document.body.append(link);
		link.click();
		link.remove();
		URL.revokeObjectURL(url);
	}, [code, filename]);

	return (
		<Button className={cn("shrink-0", className)} onClick={download} size="icon" variant="ghost" {...props}>
			{children ?? <DownloadIcon size={16} />}
		</Button>
	);
};

export const PlainTextCodeBlock = ({ code }: { code: string }) => (
	<CodeBlock
		className="mt-4 mb-2 rounded-2xl border-border/70 bg-muted/35 shadow-sm dark:bg-muted/20"
		code={code}
		language={"text" as BundledLanguage}
		plainText
	>
		<CodeBlockHeader className="border-b-0 bg-transparent px-5 py-3 text-foreground">
			<CodeBlockTitle className="font-medium text-sm">
				<Code2Icon className="size-4" />
				<span>纯文本</span>
			</CodeBlockTitle>
			<CodeBlockActions className="-my-1 -mr-2">
				<CodeBlockDownloadButton aria-label="下载纯文本" filename="text.txt" />
				<CodeBlockCopyButton aria-label="复制纯文本" />
			</CodeBlockActions>
		</CodeBlockHeader>
	</CodeBlock>
);

export type CodeBlockLanguageSelectorProps = ComponentProps<typeof Select>;

export const CodeBlockLanguageSelector = (props: CodeBlockLanguageSelectorProps) => <Select {...props} />;

export type CodeBlockLanguageSelectorTriggerProps = ComponentProps<typeof SelectTrigger>;

export const CodeBlockLanguageSelectorTrigger = ({ className, ...props }: CodeBlockLanguageSelectorTriggerProps) => (
	<SelectTrigger
		className={cn("h-7 border-none bg-transparent px-2 text-xs shadow-none", className)}
		size="sm"
		{...props}
	/>
);

export type CodeBlockLanguageSelectorValueProps = ComponentProps<typeof SelectValue>;

export const CodeBlockLanguageSelectorValue = (props: CodeBlockLanguageSelectorValueProps) => (
	<SelectValue {...props} />
);

export type CodeBlockLanguageSelectorContentProps = ComponentProps<typeof SelectContent>;

export const CodeBlockLanguageSelectorContent = ({
	align = "end",
	...props
}: CodeBlockLanguageSelectorContentProps) => <SelectContent align={align} {...props} />;

export type CodeBlockLanguageSelectorItemProps = ComponentProps<typeof SelectItem>;

export const CodeBlockLanguageSelectorItem = (props: CodeBlockLanguageSelectorItemProps) => <SelectItem {...props} />;
