"use client";

import { useMemo, useState } from "react";
import type { BundledLanguage } from "shiki";
import { Button } from "../ui/button";
import { CodeBlock, CodeBlockCopyButton } from "./code-block";

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
type OutputSegment = { kind: "text"; value: string } | { kind: "json"; value: JsonValue };
type ResultItem = { index: number; status?: string; value: JsonValue };

const CODEMODE_OUTPUT_HEADER = /^Script (?:completed|failed)\nWall time [\d.]+ seconds\nOutput:\n/;

function stripOutputHeader(output: string): string {
	return output.replace(CODEMODE_OUTPUT_HEADER, "");
}

function isJsonContainerStart(value: string, index: number): boolean {
	if (value[index] !== "{" && value[index] !== "[") return false;
	const previous = value[index - 1];
	return index === 0 || previous === undefined || /[\s:=}\]]/u.test(previous);
}

function findJsonEnd(value: string, start: number): number | undefined {
	const stack: string[] = [];
	let quoted = false;
	let escaped = false;
	for (let index = start; index < value.length; index++) {
		const character = value[index];
		if (quoted) {
			if (escaped) escaped = false;
			else if (character === "\\") escaped = true;
			else if (character === '"') quoted = false;
			continue;
		}
		if (character === '"') {
			quoted = true;
			continue;
		}
		if (character === "{" || character === "[") stack.push(character === "{" ? "}" : "]");
		else if (character === "}" || character === "]") {
			if (stack.pop() !== character) return undefined;
			if (stack.length === 0) return index + 1;
		}
	}
	return undefined;
}

function decodeNestedJson(value: unknown, depth = 0): unknown {
	if (depth < 2 && typeof value === "string") {
		const trimmed = value.trim();
		if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
			try {
				return decodeNestedJson(JSON.parse(trimmed), depth + 1);
			} catch {
				return value;
			}
		}
		return value;
	}
	if (Array.isArray(value)) return value.map((item) => decodeNestedJson(item, depth));
	if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, decodeNestedJson(item, depth)]));
	return value;
}

function asJsonValue(value: unknown): JsonValue | undefined {
	if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") return value;
	if (Array.isArray(value)) {
		const items = value.map(asJsonValue);
		return items.every((item) => item !== undefined) ? (items as JsonValue[]) : undefined;
	}
	if (typeof value === "object") {
		const entries = Object.entries(value).map(([key, item]) => [key, asJsonValue(item)] as const);
		return entries.some(([, item]) => item === undefined) ? undefined : (Object.fromEntries(entries) as { [key: string]: JsonValue });
	}
	return undefined;
}

function parseJsonCandidate(value: string, start: number): { end: number; value: JsonValue } | undefined {
	const end = findJsonEnd(value, start);
	if (end === undefined) return undefined;
	try {
		const parsed = asJsonValue(decodeNestedJson(JSON.parse(value.slice(start, end))));
		return parsed === undefined ? undefined : { end, value: parsed };
	} catch {
		return undefined;
	}
}

function unwrapEncodedOutput(output: string): string {
	let current = output.trim();
	for (let depth = 0; depth < 2; depth++) {
		if (!current.startsWith('"') || !current.endsWith('"')) return current;
		try {
			const decoded: unknown = JSON.parse(current);
			if (typeof decoded !== "string") return current;
			current = decoded.trim();
		} catch {
			return current;
		}
	}
	return current;
}

function parseOutput(output: string): { body: string; segments: OutputSegment[]; hasJson: boolean } {
	const body = unwrapEncodedOutput(stripOutputHeader(output));
	const segments: OutputSegment[] = [];
	let textStart = 0;
	let quoted = false;
	let escaped = false;
	for (let index = 0; index < body.length; index++) {
		const character = body[index];
		if (quoted) {
			if (escaped) escaped = false;
			else if (character === "\\") escaped = true;
			else if (character === '"') quoted = false;
			continue;
		}
		if (character === '"') {
			quoted = true;
			continue;
		}
		if (!isJsonContainerStart(body, index)) continue;
		const candidate = parseJsonCandidate(body, index);
		if (!candidate) continue;
		if (index > textStart) segments.push({ kind: "text", value: body.slice(textStart, index) });
		segments.push({ kind: "json", value: candidate.value });
		index = candidate.end - 1;
		textStart = candidate.end;
	}
	if (textStart < body.length || segments.length === 0) segments.push({ kind: "text", value: body.slice(textStart) });
	return { body, segments, hasJson: segments.some((segment) => segment.kind === "json") };
}

function isRecord(value: JsonValue): value is { [key: string]: JsonValue } {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeResult(value: JsonValue, fallbackIndex: number): ResultItem {
	let current = value;
	let index = fallbackIndex;
	let status: string | undefined;
	for (let depth = 0; depth < 4 && isRecord(current); depth++) {
		if (typeof current.i === "number") index = current.i;
		if (typeof current.index === "number") index = current.index;
		if (typeof current.status === "string") status = current.status;
		if (isRecord(current.result)) {
			current = current.result;
			continue;
		}
		if ("value" in current && Object.keys(current).every((key) => key === "i" || key === "index" || key === "status" || key === "value" || key === "reason")) {
			current = current.value ?? current.reason ?? null;
			continue;
		}
		break;
	}
	return { index, status, value: current };
}

function statusLabel(status: string | undefined): string {
	if (status === "fulfilled") return "已完成";
	if (status === "rejected") return "失败";
	if (status === "pending") return "等待中";
	return "已返回";
}

function decodeEscapedText(value: string): string {
	return value
		.replaceAll("\\r\\n", "\n")
		.replaceAll("\\n", "\n")
		.replaceAll("\\r", "\r")
		.replaceAll("\\t", "\t")
		.replaceAll('\\"', '"')
		.replaceAll("\\\\", "\\");
}

function ResultValue({ value, depth = 0 }: { value: JsonValue; depth?: number }) {
	if (typeof value === "string") {
		const text = decodeEscapedText(value);
		return text.trim() ? <pre className="m-0 whitespace-pre-wrap break-words text-xs leading-5 text-foreground">{text}</pre> : <span className="text-xs text-muted-foreground">无内容</span>;
	}
	if (value === null) return <span className="text-xs text-muted-foreground">无内容</span>;
	if (typeof value === "number" || typeof value === "boolean") return <span className="text-xs text-foreground">{String(value)}</span>;
	if (Array.isArray(value)) {
		if (value.length === 0) return <span className="text-xs text-muted-foreground">无结果</span>;
		return (
			<div className="grid min-w-0 gap-2 text-xs leading-5">
				{value.map((item, index) => (
					<div className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-2" key={`${depth}-${index}`}>
						<span className="shrink-0 text-muted-foreground">{index + 1}.</span>
						<ResultValue value={item} depth={depth + 1} />
					</div>
				))}
			</div>
		);
	}
	return (
		<div className="grid min-w-0 gap-1.5 text-xs leading-5">
			{Object.entries(value).map(([key, item]) => (
				<div className="flex min-w-0 items-start gap-2" key={key}>
					<span className="shrink-0 break-words text-muted-foreground">{key}</span>
					<div className="min-w-0 flex-1"><ResultValue value={item} depth={depth + 1} /></div>
				</div>
			))}
		</div>
	);
}

function ResultCard({ value, index }: { value: JsonValue; index: number }) {
	const result = normalizeResult(value, index);
	return (
		<article className="min-w-0 rounded-md border border-border/60 bg-background/45 px-3 py-2">
			<header className="mb-1.5 flex items-center justify-between gap-2 text-xs">
				<span className="font-medium text-foreground">结果 {result.index + 1}</span>
				<span className={result.status === "rejected" ? "text-destructive" : "text-muted-foreground"}>{statusLabel(result.status)}</span>
			</header>
			<ResultValue value={result.value} />
		</article>
	);
}

function StructuredOutput({ segments }: { segments: OutputSegment[] }) {
	return (
		<div className="max-h-80 min-w-0 overflow-auto p-2 text-xs leading-5">
			{segments.map((segment, index) => segment.kind === "json" ? <ResultCard key={`result-${index}`} value={segment.value} index={index} /> : segment.value ? <pre className="m-0 whitespace-pre-wrap break-words px-1 py-1 text-xs leading-5 text-foreground" key={`text-${index}`}>{decodeEscapedText(segment.value)}</pre> : null)}
		</div>
	);
}

export function CodemodeOutput({ output }: { output: string }) {
	const [raw, setRaw] = useState(false);
	const { body, segments, hasJson } = useMemo(() => parseOutput(output), [output]);
	return (
		<div className="my-0 min-w-0 overflow-hidden rounded-md border border-border/60 bg-muted/25">
			<div className="flex min-h-9 items-center justify-between gap-2 border-b border-border/50 px-3 py-1.5">
				<span className="text-xs font-medium text-foreground">返回结果</span>
				<div className="flex shrink-0 items-center gap-1">
					{hasJson ? <Button aria-pressed={raw} className="h-6 px-2" onClick={() => setRaw(!raw)} size="xs" type="button" variant="ghost">{raw ? "整理后" : "原始"}</Button> : null}
					<CodeBlockCopyButton aria-label="复制返回结果" code={output} size="icon-xs" />
				</div>
			</div>
			{raw ? <CodeBlock code={output} language={"text" as BundledLanguage} plainText wrap /> : <StructuredOutput segments={segments} />}
			{!body.trim() && <p className="px-3 py-3 text-xs text-muted-foreground">脚本没有返回内容。</p>}
		</div>
	);
}

export { parseOutput };
