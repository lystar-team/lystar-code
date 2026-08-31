import type { ContentReference, JsonValue, TranscriptItem } from "@lystar/code-gui-protocol";

export interface TranscriptImageView {
	mimeType: string;
	data?: string;
	reference?: ContentReference;
}

export interface ToolResultView {
	entryId: string;
	isError: boolean;
	text: string;
	images: TranscriptImageView[];
	reference?: ContentReference;
	details?: JsonValue;
}

export interface ToolExecutionView {
	callId: string;
	callEntryId: string;
	name: string;
	arguments: Record<string, JsonValue>;
	result?: ToolResultView;
}

export interface ToolFileView {
	path: string;
	operation?: string;
	additions?: number;
	deletions?: number;
	diff?: string;
}

export type TranscriptViewRow =
	| { kind: "entry"; key: string; item: TranscriptItem; sourceEntryIds: string[] }
	| { kind: "tool"; key: string; execution: ToolExecutionView; sourceEntryIds: string[] }
	| { kind: "bash-group"; key: string; executions: ToolExecutionView[]; sourceEntryIds: string[] };

function object(value: unknown): Record<string, JsonValue> | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, JsonValue>)
		: undefined;
}

function message(item: TranscriptItem): Record<string, JsonValue> | undefined {
	return object(object(item.payload)?.message);
}

function contentReference(value: JsonValue | undefined): ContentReference | undefined {
	const candidate = object(value);
	if (
		candidate?.type !== "content_ref" ||
		typeof candidate.contentRef !== "string" ||
		typeof candidate.previewHead !== "string" ||
		typeof candidate.previewTail !== "string" ||
		typeof candidate.byteLength !== "number" ||
		typeof candidate.lineCount !== "number" ||
		typeof candidate.mimeType !== "string"
	) {
		return undefined;
	}
	return candidate as unknown as ContentReference;
}

function messageContent(content: JsonValue | undefined): {
	text: string;
	images: TranscriptImageView[];
	reference?: ContentReference;
} {
	if (!Array.isArray(content)) return { text: "", images: [] };
	const text: string[] = [];
	const images: TranscriptImageView[] = [];
	let reference: ContentReference | undefined;
	for (const blockValue of content) {
		const block = object(blockValue);
		if (block?.type === "text") {
			if (typeof block.text === "string") text.push(block.text);
			else reference ??= contentReference(block.text);
		} else if (block?.type === "image" && typeof block.mimeType === "string") {
			if (typeof block.data === "string") images.push({ mimeType: block.mimeType, data: block.data });
			else {
				const imageReference = contentReference(block.data);
				if (imageReference) images.push({ mimeType: block.mimeType, reference: imageReference });
			}
		}
	}
	return { text: text.join(""), images, reference };
}

function toolCalls(item: TranscriptItem): ToolExecutionView[] {
	const value = message(item);
	if (value?.role !== "assistant" || !Array.isArray(value.content)) return [];
	return value.content.flatMap((content): ToolExecutionView[] => {
		const call = object(content);
		if (call?.type !== "toolCall" || typeof call.id !== "string" || typeof call.name !== "string") return [];
		return [
			{
				callId: call.id,
				callEntryId: item.entryId,
				name: call.name,
				arguments: object(call.arguments) ?? {},
			},
		];
	});
}

function toolResult(item: TranscriptItem): { callId: string; result: ToolResultView } | undefined {
	const value = message(item);
	if (value?.role !== "toolResult" || typeof value.toolCallId !== "string") return undefined;
	const content = messageContent(value.content);
	return {
		callId: value.toolCallId,
		result: {
			entryId: item.entryId,
			isError: value.isError === true,
			text: content.text,
			images: content.images,
			reference: content.reference,
			details: value.details,
		},
	};
}

function bashExecution(item: TranscriptItem): ToolExecutionView | undefined {
	const value = message(item);
	if (value?.role !== "bashExecution" || typeof value.command !== "string") return undefined;
	return {
		callId: `bash-execution:${item.entryId}`,
		callEntryId: item.entryId,
		name: "bash",
		arguments: { command: value.command },
		result: {
			entryId: item.entryId,
			isError: value.cancelled === true || (typeof value.exitCode === "number" && value.exitCode !== 0),
			text: typeof value.output === "string" ? value.output : "",
			images: [],
		},
	};
}

function assistantHasVisibleText(item: TranscriptItem): boolean {
	const value = message(item);
	const content = messageContent(value?.content);
	return value?.role !== "assistant" || content.text.length > 0 || content.images.length > 0;
}

export function transcriptImages(item: TranscriptItem): TranscriptImageView[] {
	return messageContent(message(item)?.content).images;
}

function sourceEntryIds(execution: ToolExecutionView): string[] {
	return execution.result ? [execution.callEntryId, execution.result.entryId] : [execution.callEntryId];
}

export function buildTranscriptRows(items: readonly TranscriptItem[]): TranscriptViewRow[] {
	const uniqueItems: TranscriptItem[] = [];
	const seenEntryIds = new Set<string>();
	for (const item of items) {
		if (seenEntryIds.has(item.entryId)) continue;
		seenEntryIds.add(item.entryId);
		uniqueItems.push(item);
	}

	const results = new Map<string, ToolResultView>();
	for (const item of uniqueItems) {
		const parsed = toolResult(item);
		if (parsed) results.set(parsed.callId, parsed.result);
	}

	const matchedResults = new Set<string>();
	const rows: TranscriptViewRow[] = [];
	for (const item of uniqueItems) {
		const standaloneBash = bashExecution(item);
		if (standaloneBash) {
			const previous = rows.at(-1);
			if (previous?.kind === "bash-group") {
				previous.executions.push(standaloneBash);
				previous.sourceEntryIds.push(item.entryId);
			} else {
				rows.push({
					kind: "bash-group",
					key: `bash:after:${previous?.key ?? "start"}`,
					executions: [standaloneBash],
					sourceEntryIds: [item.entryId],
				});
			}
			continue;
		}

		const calls = toolCalls(item).map((call) => {
			const result = results.get(call.callId);
			if (result) matchedResults.add(result.entryId);
			return { ...call, result };
		});

		if (calls.length > 0) {
			if (assistantHasVisibleText(item)) {
				rows.push({ kind: "entry", key: item.entryId, item, sourceEntryIds: [item.entryId] });
			}
			for (const execution of calls) {
				const previous = rows.at(-1);
				if (execution.name === "bash" && previous?.kind === "bash-group") {
					previous.executions.push(execution);
					previous.sourceEntryIds.push(...sourceEntryIds(execution));
				} else if (execution.name === "bash") {
					rows.push({
						kind: "bash-group",
						key: `bash:after:${previous?.key ?? "start"}`,
						executions: [execution],
						sourceEntryIds: sourceEntryIds(execution),
					});
				} else {
					rows.push({
						kind: "tool",
						key: `tool:${execution.callId}`,
						execution,
						sourceEntryIds: sourceEntryIds(execution),
					});
				}
			}
			continue;
		}

		if (matchedResults.has(item.entryId)) continue;
		rows.push({ kind: "entry", key: item.entryId, item, sourceEntryIds: [item.entryId] });
	}
	return rows;
}

function number(value: JsonValue | undefined): number | undefined {
	return typeof value === "number" ? value : undefined;
}

export function toolFiles(execution: ToolExecutionView): ToolFileView[] {
	const details = object(execution.result?.details);
	if (execution.name === "apply_patch" && Array.isArray(details?.files)) {
		return details.files.flatMap((value): ToolFileView[] => {
			const file = object(value);
			if (typeof file?.path !== "string") return [];
			return [
				{
					path: file.path,
					operation: typeof file.operation === "string" ? file.operation : undefined,
					additions: number(file.additions),
					deletions: number(file.deletions),
					diff: typeof file.diff === "string" ? file.diff : undefined,
				},
			];
		});
	}

	if (!["edit", "write"].includes(execution.name) || typeof execution.arguments.path !== "string") return [];
	return [
		{
			path: execution.arguments.path,
			operation: typeof details?.operation === "string" ? details.operation : execution.name,
			additions: number(details?.additions),
			deletions: number(details?.deletions),
			diff: typeof details?.diff === "string" ? details.diff : undefined,
		},
	];
}

export function readLineRange(execution: ToolExecutionView): string | undefined {
	if (execution.name !== "read") return undefined;
	const offset = typeof execution.arguments.offset === "number" ? execution.arguments.offset : 1;
	const limit = typeof execution.arguments.limit === "number" ? execution.arguments.limit : undefined;
	if (execution.arguments.offset === undefined && limit === undefined) return undefined;
	return limit === undefined ? `${offset}+` : `${offset}-${offset + limit - 1}`;
}
