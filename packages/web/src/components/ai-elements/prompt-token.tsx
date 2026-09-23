import { FileText, Sparkles } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { webApi } from "../../adapters/host-protocol/api.ts";
import { cn } from "../../lib/utils";
import type { WebCompletionResult } from "../../types.ts";

export const PROMPT_TOKEN_PATTERN =
	/\$\[[a-z0-9][a-z0-9-]*\]|@\[[a-z0-9][a-z0-9-]*\]|\/skill:[a-z0-9][a-z0-9-]*|@"(?:[^"\\]|\\.)*"|@[^\s,，。；;!?！？、()\[\]{}<>]+/giu;

export type PromptTokenKind = "file" | "skill";
export type PromptTokenPart = { text: string; start: number; end: number; kind?: PromptTokenKind };
export type PromptTokenRange = { start: number; end: number };

type PromptTokenAttributes = Record<string, string | number | undefined>;
const EMPTY_PROMPT_TOKEN_SET: ReadonlySet<string> = new Set();
const promptTokenValidationCache = new Map<string, Promise<boolean>>();

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

function hasPromptTokenBoundary(text: string, start: number): boolean {
	const previous = text[start - 1];
	return !previous || !/[\p{L}\p{N}_$@]/u.test(previous);
}

export function promptTokenDisplayOffset(value: string, kind: PromptTokenKind, offset: number, displayLength: number): number {
	const prefixLength =
		kind === "file" ? (value.startsWith('@"') ? 2 : 1) : value.startsWith("/skill:") ? "/skill:".length : 2;
	return Math.max(0, Math.min(displayLength, offset - prefixLength));
}

export function promptTokenCandidates(text: string): string[] {
	return [...text.matchAll(PROMPT_TOKEN_PATTERN)]
		.filter((match) => hasPromptTokenBoundary(text, match.index ?? 0))
		.map((match) => match[0]);
}

export function promptTokenRanges(text: string, validTokens: ReadonlySet<string> = EMPTY_PROMPT_TOKEN_SET): PromptTokenRange[] {
	return [...text.matchAll(PROMPT_TOKEN_PATTERN)].flatMap((match) => {
		const start = match.index ?? 0;
		return hasPromptTokenBoundary(text, start) && validTokens.has(match[0])
			? [{ start, end: start + match[0].length }]
			: [];
	});
}

export function promptTokenParts(
	text: string,
	validTokens: ReadonlySet<string> = EMPTY_PROMPT_TOKEN_SET,
): PromptTokenPart[] {
	const parts: PromptTokenPart[] = [];
	let lastIndex = 0;
	for (const match of text.matchAll(PROMPT_TOKEN_PATTERN)) {
		const start = match.index ?? 0;
		if (!hasPromptTokenBoundary(text, start)) continue;
		const value = match[0];
		const kind = validTokens.has(value) ? promptTokenKind(value) : undefined;
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

export function hasPromptTokenCandidates(text: string): boolean {
	return promptTokenCandidates(text).length > 0;
}

export function hasPromptTokens(text: string, validTokens: ReadonlySet<string> = EMPTY_PROMPT_TOKEN_SET): boolean {
	return promptTokenParts(text, validTokens).some((part) => part.kind !== undefined);
}

function validationQuery(value: string): string {
	return value.startsWith("$[") || value.startsWith("@[") ? value.slice(0, -1) : value;
}

export type PromptCompletionLookup = (text: string, cursor: number) => Promise<WebCompletionResult>;

function validatePromptToken(
	projectId: string,
	sessionId: string | undefined,
	value: string,
	getCompletions?: PromptCompletionLookup,
): Promise<boolean> {
	const key = `${projectId}\u0000${sessionId ?? ""}\u0000${value}`;
	const cached = promptTokenValidationCache.get(key);
	if (cached) return cached;

	const query = validationQuery(value);
	const request = (getCompletions
		? getCompletions(query, query.length)
		: webApi.completions(projectId, query, query.length, sessionId))
		.then((result) => result.items.some((item) => item.value.trimEnd() === value))
		.catch(() => false);
	promptTokenValidationCache.set(key, request);
	return request;
}

export function usePromptTokenValidation(
	text: string,
	projectId?: string,
	sessionId?: string,
	getCompletions?: PromptCompletionLookup,
): { validTokens: ReadonlySet<string>; markValidToken: (value: string) => void } {
	const candidates = useMemo(() => [...new Set(promptTokenCandidates(text))], [text]);
	const candidateKey = candidates.join("\u0001");
	const [validatedTokens, setValidatedTokens] = useState<ReadonlySet<string>>(EMPTY_PROMPT_TOKEN_SET);
	const [acceptedTokens, setAcceptedTokens] = useState<ReadonlySet<string>>(EMPTY_PROMPT_TOKEN_SET);

	useEffect(() => {
		setAcceptedTokens(EMPTY_PROMPT_TOKEN_SET);
	}, [projectId, sessionId]);

	useEffect(() => {
		if (!projectId || candidates.length === 0) {
			setValidatedTokens(EMPTY_PROMPT_TOKEN_SET);
			return;
		}
		let cancelled = false;
		void Promise.all(
			candidates.map(async (value) =>
				(await validatePromptToken(projectId, sessionId, value, getCompletions)) ? value : undefined,
			),
		).then(
			(values) => {
				if (cancelled) return;
				setValidatedTokens(new Set(values.filter((value): value is string => value !== undefined)));
			},
		);
		return () => {
			cancelled = true;
		};
	}, [candidateKey, candidates, getCompletions, projectId, sessionId]);

	const markValidToken = useCallback((value: string) => {
		if (!promptTokenKind(value)) return;
		setAcceptedTokens((current) => (current.has(value) ? current : new Set([...current, value])));
	}, []);
	const validTokens = useMemo(
		() => new Set([...acceptedTokens, ...validatedTokens]),
		[acceptedTokens, validatedTokens],
	);
	return { markValidToken, validTokens };
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

export function PromptTokenContent({
	text,
	className,
	projectId,
	sessionId,
	validTokens,
}: {
	text: string;
	className?: string;
	projectId?: string;
	sessionId?: string;
	validTokens?: ReadonlySet<string>;
}): ReactNode {
	const validation = usePromptTokenValidation(text, projectId, sessionId);
	const tokens = validTokens ?? validation.validTokens;
	return (
		<span className={cn("whitespace-pre-wrap", className)}>
			{promptTokenParts(text, tokens).map((part, index) => (
				<PromptTokenPartView key={`${part.start}:${part.end}:${index}`} part={part} index={index} />
			))}
		</span>
	);
}
