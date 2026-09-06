import { FileText, Sparkles } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../../lib/utils";

export const PROMPT_TOKEN_PATTERN =
	/\$\[[a-z0-9][a-z0-9-]*\]|@\[[a-z0-9][a-z0-9-]*\]|\/skill:[a-z0-9][a-z0-9-]*|@"(?:[^"\\]|\\.)*"|@[^\s,，。；;!?！？]+/giu;

export type PromptTokenKind = "file" | "skill";
export type PromptTokenPart = { text: string; start: number; end: number; kind?: PromptTokenKind };
export type PromptTokenRange = { start: number; end: number };

type PromptTokenAttributes = Record<string, string | number | undefined>;

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

export function promptTokenDisplayOffset(value: string, kind: PromptTokenKind, offset: number, displayLength: number): number {
	const prefixLength =
		kind === "file" ? (value.startsWith('@"') ? 2 : 1) : value.startsWith("/skill:") ? "/skill:".length : 2;
	return Math.max(0, Math.min(displayLength, offset - prefixLength));
}

export function promptTokenRanges(text: string): PromptTokenRange[] {
	return [...text.matchAll(PROMPT_TOKEN_PATTERN)].map((match) => {
		const start = match.index ?? 0;
		return { start, end: start + match[0].length };
	});
}

export function promptTokenParts(text: string): PromptTokenPart[] {
	const parts: PromptTokenPart[] = [];
	let lastIndex = 0;
	for (const match of text.matchAll(PROMPT_TOKEN_PATTERN)) {
		const start = match.index ?? 0;
		const value = match[0];
		const kind = promptTokenKind(value);
		if (start > lastIndex) parts.push({ text: text.slice(lastIndex, start), start: lastIndex, end: start });
		parts.push({
			text: kind ? promptTokenDisplayText(value, kind) : value,
			start,
			end: start + value.length,
			...(kind ? { kind } : {}),
		});
		lastIndex = start + value.length;
	}
	if (lastIndex < text.length) parts.push({ text: text.slice(lastIndex), start: lastIndex, end: text.length });
	if (parts.length === 0) parts.push({ text: "", start: 0, end: 0 });
	return parts;
}

export function hasPromptTokens(text: string): boolean {
	return promptTokenParts(text).some((part) => part.kind !== undefined);
}

export function PromptTokenPartView({
	part,
	index,
	attributes,
}: {
	part: PromptTokenPart;
	index: number;
	attributes?: PromptTokenAttributes;
}): ReactNode {
	if (!part.kind) return <span {...attributes}>{part.text}</span>;
	const Icon = part.kind === "skill" ? Sparkles : FileText;
	return (
		<span
			className={cn(
				"inline-flex items-center gap-1 align-baseline font-medium text-blue-600 dark:text-blue-400",
				index > 0 && "ml-1",
			)}
			{...attributes}
		>
			<Icon className="size-3 shrink-0" />
			<span data-prompt-text="true">{part.text}</span>
		</span>
	);
}

export function PromptTokenContent({ text, className }: { text: string; className?: string }): ReactNode {
	return (
		<span className={cn("whitespace-pre-wrap", className)}>
			{promptTokenParts(text).map((part, index) => (
				<PromptTokenPartView key={`${part.start}:${part.end}:${index}`} part={part} index={index} />
			))}
		</span>
	);
}
