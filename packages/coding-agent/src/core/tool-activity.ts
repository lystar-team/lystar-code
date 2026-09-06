import { randomUUID } from "node:crypto";
import type { AgentSessionEvent } from "./agent-session.ts";

const MAX_PROGRESS_TEXT_CHARS = 16 * 1024;

export type ToolActivityState = "preparing" | "queued" | "running" | "success" | "error" | "cancelled" | "interrupted";

export interface ToolActivityDiffFile {
	path?: string;
	operation?: string;
	additions?: number;
	deletions?: number;
	diff?: string;
	truncated?: boolean;
}

export interface ToolActivityDiff {
	files: ToolActivityDiffFile[];
}

export interface ToolActivitySnapshot {
	activityEpoch: string;
	revision: number;
	toolCallId: string;
	name: string;
	state: ToolActivityState;
	summary: string;
	inputPreview?: boolean;
	diff?: ToolActivityDiff;
	progress?: string;
	output?: string;
	error?: string;
	startedAt?: number;
	updatedAt: number;
	completedAt?: number;
}

export interface ToolActivityEvent {
	type: "tool_activity";
	activity: ToolActivitySnapshot;
}

export function toolRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

export function toolPath(value: unknown): string | undefined {
	const record = toolRecord(value);
	const path = record?.path ?? record?.file_path;
	return typeof path === "string" && path.length > 0 ? path : undefined;
}

export function isDiffTool(name: string): boolean {
	return name === "edit" || name === "write" || name === "apply_patch";
}

export function boundedText(value: string): string {
	if (value.length <= MAX_PROGRESS_TEXT_CHARS) return value;
	let end = MAX_PROGRESS_TEXT_CHARS - 1;
	if (
		end > 0 &&
		value.charCodeAt(end - 1) >= 0xd800 &&
		value.charCodeAt(end - 1) <= 0xdbff &&
		value.charCodeAt(end) >= 0xdc00 &&
		value.charCodeAt(end) <= 0xdfff
	) {
		end--;
	}
	return `${value.slice(0, end)}…`;
}

function boundedDiffText(value: string): { text: string; truncated?: boolean } {
	if (value.length <= MAX_PROGRESS_TEXT_CHARS) return { text: value };
	let end = MAX_PROGRESS_TEXT_CHARS;
	if (
		end > 0 &&
		value.charCodeAt(end - 1) >= 0xd800 &&
		value.charCodeAt(end - 1) <= 0xdbff &&
		value.charCodeAt(end) >= 0xdc00 &&
		value.charCodeAt(end) <= 0xdfff
	) {
		end--;
	}
	return { text: value.slice(0, end), truncated: true };
}

function countLines(value: string): number {
	if (!value) return 0;
	const normalized = value.replace(/\r\n?/g, "\n");
	return normalized.endsWith("\n") ? normalized.split("\n").length - 1 : normalized.split("\n").length;
}

function prefixLines(value: string, prefix: string): string {
	const normalized = value.replace(/\r\n?/g, "\n");
	const lines = normalized.split("\n");
	if (lines.at(-1) === "") lines.pop();
	return lines.map((line) => `${prefix}${line}`).join("\n");
}

function editEntries(value: Record<string, unknown> | undefined): Array<{ oldText: string; newText: string }> {
	if (!value) return [];
	const edits = value.edits;
	if (Array.isArray(edits)) {
		return edits.flatMap((entry) => {
			const item = toolRecord(entry);
			return typeof item?.oldText === "string" && typeof item.newText === "string"
				? [{ oldText: item.oldText, newText: item.newText }]
				: [];
		});
	}
	if (typeof edits === "string") {
		try {
			const parsed = JSON.parse(edits) as unknown;
			return Array.isArray(parsed) ? editEntries({ edits: parsed }) : editEntries({ edits: [parsed] });
		} catch {
			return [];
		}
	}
	return typeof value.oldText === "string" && typeof value.newText === "string"
		? [{ oldText: value.oldText, newText: value.newText }]
		: [];
}

function previewWriteDiff(path: string | undefined, args: Record<string, unknown>): ToolActivityDiff | undefined {
	const content = args.content;
	if (typeof content !== "string") return path ? { files: [{ path }] } : undefined;
	const preview = boundedDiffText(prefixLines(content, "+"));
	return {
		files: [
			{
				...(path ? { path } : {}),
				additions: countLines(content),
				deletions: 0,
				...(preview.text ? { diff: preview.text } : {}),
				...(preview.truncated ? { truncated: true } : {}),
			},
		],
	};
}

function previewEditDiff(path: string | undefined, args: Record<string, unknown>): ToolActivityDiff | undefined {
	const edits = editEntries(args);
	if (edits.length === 0) return path ? { files: [{ path }] } : undefined;

	let additions = 0;
	let deletions = 0;
	const lines: string[] = [];
	for (const edit of edits) {
		deletions += countLines(edit.oldText);
		additions += countLines(edit.newText);
		const removed = prefixLines(edit.oldText, "-");
		const added = prefixLines(edit.newText, "+");
		if (removed) lines.push(removed);
		if (added) lines.push(added);
	}
	const preview = boundedDiffText(lines.join("\n"));
	return {
		files: [
			{
				...(path ? { path } : {}),
				additions,
				deletions,
				...(preview.text ? { diff: preview.text } : {}),
				...(preview.truncated ? { truncated: true } : {}),
			},
		],
	};
}

function previewPatchDiff(args: Record<string, unknown>): ToolActivityDiff | undefined {
	if (typeof args.input !== "string") return undefined;
	const input = args.input.replace(/\r\n?/g, "\n");
	let additions = 0;
	let deletions = 0;
	for (const line of input.split("\n")) {
		if (line.startsWith("+++") || line.startsWith("---")) continue;
		if (line.startsWith("+")) additions++;
		if (line.startsWith("-")) deletions++;
	}
	const preview = boundedDiffText(input);
	return {
		files: [
			{
				additions,
				deletions,
				...(preview.text ? { diff: preview.text } : {}),
				...(preview.truncated ? { truncated: true } : {}),
			},
		],
	};
}

function toolNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

export function toolProgressDiff(name: string, args: unknown, result?: unknown): ToolActivityDiff | undefined {
	if (!isDiffTool(name)) return undefined;
	const details = toolRecord(toolRecord(result)?.details);
	if (!details) {
		const input = toolRecord(args);
		if (name === "write") return previewWriteDiff(toolPath(args), input ?? {});
		if (name === "edit") return previewEditDiff(toolPath(args), input ?? {});
		return previewPatchDiff(input ?? {});
	}

	if (name === "apply_patch") {
		if (!Array.isArray(details.files)) return undefined;
		const files = details.files.flatMap((value) => {
			const file = toolRecord(value);
			if (!file) return [];
			const preview = typeof file.diff === "string" ? boundedDiffText(file.diff) : undefined;
			const path = toolPath(file);
			const additions = toolNumber(file.additions);
			const deletions = toolNumber(file.deletions);
			const operation = typeof file.operation === "string" ? file.operation : undefined;
			if (!path && additions === undefined && deletions === undefined && !preview?.text) return [];
			return [
				{
					...(path ? { path } : {}),
					...(operation ? { operation } : {}),
					...(additions === undefined ? {} : { additions }),
					...(deletions === undefined ? {} : { deletions }),
					...(preview?.text === undefined ? {} : { diff: preview.text }),
					...(preview?.truncated ? { truncated: true } : {}),
				},
			];
		});
		return files.length > 0 ? { files } : undefined;
	}

	const path = toolPath(args);
	const additions = toolNumber(details.additions);
	const deletions = toolNumber(details.deletions);
	const operation = typeof details.operation === "string" ? details.operation : undefined;
	const preview = typeof details.diff === "string" ? boundedDiffText(details.diff) : undefined;
	if (!path && additions === undefined && deletions === undefined && !operation && !preview?.text) return undefined;
	return {
		files: [
			{
				...(path ? { path } : {}),
				...(operation ? { operation } : {}),
				...(additions === undefined ? {} : { additions }),
				...(deletions === undefined ? {} : { deletions }),
				...(preview?.text === undefined ? {} : { diff: preview.text }),
				...(preview?.truncated ? { truncated: true } : {}),
			},
		],
	};
}

function textFromResult(value: unknown): string | undefined {
	const result = toolRecord(value);
	if (!Array.isArray(result?.content)) return undefined;
	const text = result.content
		.map((part) => {
			const item = toolRecord(part);
			return item?.type === "text" && typeof item.text === "string" ? item.text : "";
		})
		.filter(Boolean)
		.join("\n");
	return text ? boundedText(text) : undefined;
}

function serializedText(value: unknown): string {
	if (typeof value === "string") return boundedText(value);
	if (value === undefined || value === null) return "";
	try {
		return boundedText(JSON.stringify(value));
	} catch {
		return boundedText(String(value));
	}
}

export function toolInputSummary(name: string, value: unknown): string {
	const input = toolRecord(value);
	if (name === "bash" && typeof input?.command === "string") return boundedText(input.command);
	if (isDiffTool(name)) return toolPath(value) ?? name;
	return serializedText(value);
}

export function toolOutputSummary(value: unknown): string {
	return textFromResult(value) ?? serializedText(value);
}

interface InternalToolActivity {
	toolCallId: string;
	name: string;
	state: ToolActivityState;
	args?: unknown;
	summary: string;
	diff?: ToolActivityDiff;
	progress?: string;
	output?: string;
	error?: string;
	startedAt?: number;
	updatedAt: number;
	completedAt?: number;
}

function isTerminal(state: ToolActivityState): boolean {
	return state === "success" || state === "error" || state === "cancelled" || state === "interrupted";
}

function isCancelledText(value: string | undefined): boolean {
	return Boolean(value?.match(/abort|cancel|取消/i));
}

function assistantToolCall(event: Extract<AgentSessionEvent, { type: "message_update" }>):
	| {
			id: string;
			name: string;
			arguments: unknown;
	  }
	| undefined {
	const stream = event.assistantMessageEvent;
	if (stream.type !== "toolcall_start" && stream.type !== "toolcall_delta" && stream.type !== "toolcall_end") {
		return undefined;
	}
	if (event.message.role !== "assistant") return undefined;
	const content = event.message.content[stream.contentIndex];
	return content?.type === "toolCall" ? content : undefined;
}

export class ToolActivityTracker {
	private activityEpoch = randomUUID();
	private activityRevision = 0;
	private readonly activities = new Map<string, InternalToolActivity>();

	get epoch(): string {
		return this.activityEpoch;
	}

	get revision(): number {
		return this.activityRevision;
	}

	getSnapshot(options: { activeOnly?: boolean } = {}): ToolActivitySnapshot[] {
		return [...this.activities.values()]
			.filter((activity) => !options.activeOnly || !isTerminal(activity.state))
			.map((activity) => this.toSnapshot(activity));
	}

	apply(event: AgentSessionEvent): ToolActivitySnapshot[] {
		if (event.type === "agent_start") {
			this.activityEpoch = randomUUID();
			this.activityRevision = 0;
			this.activities.clear();
			return [];
		}
		if (event.type === "tool_activity") return [];
		if (event.type === "message_update") {
			const toolCall = assistantToolCall(event);
			return toolCall ? [this.updatePreparing(toolCall.id, toolCall.name, toolCall.arguments)] : [];
		}
		if (event.type === "message_end" && event.message.role === "assistant") {
			const snapshots: ToolActivitySnapshot[] = [];
			for (const content of event.message.content) {
				if (content.type !== "toolCall") continue;
				const activity = this.getOrCreate(content.id, content.name, content.arguments);
				if (!isTerminal(activity.state)) {
					activity.state = "queued";
					activity.args = content.arguments;
					activity.summary = this.summary(content.name, content.arguments);
					activity.diff = toolProgressDiff(content.name, content.arguments) ?? activity.diff;
					snapshots.push(this.touch(activity));
				}
			}
			return snapshots;
		}
		if (event.type === "tool_execution_start") {
			const activity = this.getOrCreate(event.toolCallId, event.toolName, event.args);
			if (isTerminal(activity.state) && activity.state !== "interrupted") return [];
			activity.state = "running";
			activity.args = event.args;
			activity.summary = this.summary(event.toolName, event.args);
			activity.diff = toolProgressDiff(event.toolName, event.args) ?? activity.diff;
			activity.startedAt ??= Date.now();
			return [this.touch(activity)];
		}
		if (event.type === "tool_execution_update") {
			const activity = this.getOrCreate(event.toolCallId, event.toolName, event.args);
			if (isTerminal(activity.state) && activity.state !== "interrupted") return [];
			activity.state = "running";
			activity.args = event.args;
			activity.summary = this.summary(event.toolName, event.args);
			activity.progress = textFromResult(event.partialResult) ?? toolOutputSummary(event.partialResult);
			activity.diff = toolProgressDiff(event.toolName, event.args, event.partialResult) ?? activity.diff;
			activity.startedAt ??= Date.now();
			return [this.touch(activity)];
		}
		if (event.type === "tool_execution_end") {
			const activity = this.getOrCreate(event.toolCallId, event.toolName, undefined);
			const output = toolOutputSummary(event.result);
			const cancelled = event.isError && isCancelledText(output);
			activity.state = cancelled ? "cancelled" : event.isError ? "error" : "success";
			activity.summary = output || this.summary(event.toolName, activity.args);
			activity.output = output;
			activity.error = event.isError ? output || "工具调用失败" : undefined;
			activity.diff = toolProgressDiff(event.toolName, activity.args, event.result);
			activity.startedAt ??= Date.now();
			activity.completedAt = Date.now();
			return [this.touch(activity)];
		}
		if (event.type === "agent_end" || event.type === "agent_settled") {
			return this.interruptPending();
		}
		return [];
	}

	private updatePreparing(toolCallId: string, name: string, args: unknown): ToolActivitySnapshot {
		const activity = this.getOrCreate(toolCallId, name, args);
		if (!isTerminal(activity.state)) {
			activity.state = "preparing";
			activity.args = args;
			activity.summary = this.summary(name, args);
			activity.diff = toolProgressDiff(name, args) ?? activity.diff;
		}
		return this.touch(activity);
	}

	private interruptPending(): ToolActivitySnapshot[] {
		const snapshots: ToolActivitySnapshot[] = [];
		for (const activity of this.activities.values()) {
			if (isTerminal(activity.state)) continue;
			activity.state = "interrupted";
			activity.error = "工具调用未返回最终结果";
			activity.completedAt = Date.now();
			snapshots.push(this.touch(activity));
		}
		return snapshots;
	}

	private getOrCreate(toolCallId: string, name: string, args: unknown): InternalToolActivity {
		const existing = this.activities.get(toolCallId);
		if (existing) return existing;
		const activity: InternalToolActivity = {
			toolCallId,
			name,
			state: "preparing",
			args,
			summary: this.summary(name, args),
			updatedAt: Date.now(),
		};
		this.activities.set(toolCallId, activity);
		return activity;
	}

	private summary(name: string, args: unknown): string {
		return toolInputSummary(name, args) || name;
	}

	private touch(activity: InternalToolActivity): ToolActivitySnapshot {
		activity.updatedAt = Date.now();
		this.activityRevision++;
		return this.toSnapshot(activity);
	}

	private toSnapshot(activity: InternalToolActivity): ToolActivitySnapshot {
		return {
			activityEpoch: this.activityEpoch,
			revision: this.activityRevision,
			toolCallId: activity.toolCallId,
			name: activity.name,
			state: activity.state,
			summary: activity.summary,
			...(!isTerminal(activity.state) ? { inputPreview: true } : {}),
			...(activity.diff ? { diff: activity.diff } : {}),
			...(activity.progress ? { progress: activity.progress } : {}),
			...(activity.output ? { output: activity.output } : {}),
			...(activity.error ? { error: activity.error } : {}),
			...(activity.startedAt === undefined ? {} : { startedAt: activity.startedAt }),
			updatedAt: activity.updatedAt,
			...(activity.completedAt === undefined ? {} : { completedAt: activity.completedAt }),
		};
	}
}
