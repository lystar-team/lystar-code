"use client";

import { ChevronDownIcon } from "lucide-react";
import { useMemo, useState } from "react";
import type { BundledLanguage } from "shiki";
import { Button } from "../ui/button";
import { Collapsible, CollapsibleTrigger } from "../ui/collapsible";
import { GsapCollapsibleContent } from "../ui/gsap-collapsible-content";
import { CodeBlock, CodeBlockCopyButton } from "./code-block";
import { ToolOutputBlock } from "./tool-output-block";

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
type OutputSegment = { kind: "text"; value: string; start: number } | { kind: "json"; value: JsonValue; start: number };
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
	let current = output;
	for (let depth = 0; depth < 2; depth++) {
		const encoded = current.trim();
		if (!encoded.startsWith('"') || !encoded.endsWith('"')) return current;
		try {
			const decoded: unknown = JSON.parse(encoded);
			if (typeof decoded !== "string") return current;
			current = decoded;
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
		if (index > textStart) segments.push({ kind: "text", value: body.slice(textStart, index), start: textStart });
		segments.push({ kind: "json", value: candidate.value, start: index });
		index = candidate.end - 1;
		textStart = candidate.end;
	}
	if (textStart < body.length || segments.length === 0) segments.push({ kind: "text", value: body.slice(textStart), start: textStart });
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

function ResultValue({ value }: { value: JsonValue }) {
	if (typeof value === "string") {
		return value.trim() ? <ToolOutputBlock className="my-0 border-0 bg-transparent" code={value} fallback={<pre className="m-0 whitespace-pre-wrap break-words text-xs leading-5 text-foreground">{value}</pre>} /> : <span className="text-xs text-muted-foreground">无内容</span>;
	}
	return <ToolOutputBlock className="my-0 border-0 bg-transparent" code={JSON.stringify(value)} />;
}

function ResultCard({ value, index }: { value: JsonValue; index: number }) {
	const [open, setOpen] = useState(false);
	const result = normalizeResult(value, index);
	const title = `结果 ${result.index + 1}`;
	return (
		<Collapsible collapseOnContentClick open={open} onOpenChange={setOpen} className="min-w-0 rounded-md border border-border/60 bg-background/45">
			<CollapsibleTrigger asChild>
				<button
					data-transcript-resize-anchor
					aria-label={`${title}，${open ? "收起" : "展开"}`}
					className="flex w-full min-w-0 items-center gap-2 rounded-md px-3 py-2 text-left text-xs hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
					type="button"
				>
					<span className="flex-1 font-medium text-foreground">{title}</span>
					<span className={result.status === "rejected" ? "text-destructive" : "text-muted-foreground"}>{statusLabel(result.status)}</span>
					<ChevronDownIcon aria-hidden="true" className={`size-3.5 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`} />
				</button>
			</CollapsibleTrigger>
			<GsapCollapsibleContent open={open} className="min-w-0 px-3 pb-2">
				<ResultValue value={result.value} />
			</GsapCollapsibleContent>
		</Collapsible>
	);
}

function StructuredOutput({ segments }: { segments: OutputSegment[] }) {
	return (
		<div className="max-h-80 min-w-0 overflow-auto p-2 text-xs leading-5">
			{segments.map((segment, index) => segment.kind === "json" ? <ResultCard key={`json-${segment.start}`} value={segment.value} index={index} /> : segment.value ? <pre className="m-0 whitespace-pre-wrap break-words px-1 py-1 text-xs leading-5 text-foreground" key={`text-${segment.start}`}>{segment.value}</pre> : null)}
		</div>
	);
}

export function CodemodeOutput({ output }: { output: string }) {
	const [open, setOpen] = useState(false);
	const [raw, setRaw] = useState(false);
	const { body, segments, hasJson } = useMemo(() => parseOutput(output), [output]);
	return (
		<Collapsible collapseOnContentClick open={open} onOpenChange={setOpen} className="my-0 min-w-0 overflow-hidden rounded-md border border-border/60 bg-muted/25">
			<div className="flex min-h-9 items-center justify-between gap-2 px-3 py-1.5">
				<CollapsibleTrigger asChild>
					<Button data-transcript-resize-anchor aria-label={`返回结果，${open ? "收起" : "展开"}`} className="h-6 min-w-0 justify-start gap-1.5 px-0 text-xs font-medium" size="xs" type="button" variant="ghost">
						<ChevronDownIcon aria-hidden="true" className={`size-3.5 shrink-0 transition-transform ${open ? "rotate-180" : ""}`} />
						返回结果
					</Button>
				</CollapsibleTrigger>
				<div className="flex shrink-0 items-center gap-1">
					{hasJson ? <Button aria-pressed={raw} className="h-6 px-2" onClick={() => setRaw(!raw)} size="xs" type="button" variant="ghost">{raw ? "整理后" : "原始"}</Button> : null}
					<CodeBlockCopyButton aria-label="复制返回结果" code={output} size="icon-xs" />
				</div>
			</div>
			<GsapCollapsibleContent open={open} className="min-w-0 border-t border-border/50">
				{raw ? <CodeBlock className="[&>div:last-child]:max-h-80 [&>div:last-child]:overflow-auto" code={output} language={"text" as BundledLanguage} plainText wrap /> : <StructuredOutput segments={segments} />}
				{!body.trim() && <p className="px-3 py-3 text-xs text-muted-foreground">脚本没有返回内容。</p>}
			</GsapCollapsibleContent>
		</Collapsible>
	);
}

export { parseOutput };
