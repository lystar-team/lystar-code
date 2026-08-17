import type { JsonValue, TranscriptItem, TranscriptViewItem } from "@lystar/code-gui-protocol";

const TEXT_LIMIT = 16 * 1024;
const TOOL_CALL_LIMIT = 32;

type JsonRecord = Record<string, JsonValue>;

function record(value: JsonValue | undefined): JsonRecord | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}

function bounded(value: string): string {
	return value.length <= TEXT_LIMIT ? value : `${value.slice(0, TEXT_LIMIT - 1)}…`;
}

function text(value: JsonValue | undefined): string {
	if (typeof value === "string") return bounded(value);
	if (Array.isArray(value)) {
		return bounded(
			value
				.map((part) => {
					const item = record(part);
					if (!item) return typeof part === "string" ? part : "";
					if (item.type === "image") return typeof item.alt === "string" ? item.alt : "";
					if (typeof item.text === "string") return item.text;
					if (item.type === "content_ref")
						return typeof item.previewHead === "string" ? item.previewHead : "内容引用";
					return JSON.stringify(item);
				})
				.join(" "),
		);
	}
	if (value === undefined || value === null) return "";
	const item = record(value);
	if (item?.type === "content_ref")
		return typeof item.previewHead === "string" ? bounded(item.previewHead) : "内容引用";
	return bounded(JSON.stringify(value));
}

function contentRef(value: JsonValue | undefined): string | undefined {
	if (Array.isArray(value)) {
		for (const part of value) {
			const reference = contentRef(part);
			if (reference) return reference;
		}
		return undefined;
	}
	const item = record(value);
	if (!item) return undefined;
	if (item.type === "content_ref" && typeof item.contentRef === "string") return item.contentRef;
	for (const nested of Object.values(item)) {
		const reference = contentRef(nested);
		if (reference) return reference;
	}
	return undefined;
}

function imageMetadata(value: JsonValue | undefined): Array<{
	contentRef: string;
	mimeType: string;
	byteLength: number;
	alt?: string;
}> {
	if (!Array.isArray(value)) return [];
	const images: Array<{ contentRef: string; mimeType: string; byteLength: number; alt?: string }> = [];
	for (const part of value) {
		const item = record(part);
		if (item?.type !== "image") continue;
		const reference = record(item.data);
		if (reference?.type !== "content_ref" || typeof reference.contentRef !== "string") continue;
		const mimeType =
			typeof item.mimeType === "string"
				? item.mimeType
				: typeof reference.mimeType === "string"
					? reference.mimeType
					: undefined;
		const byteLength = reference.byteLength;
		if (!mimeType || typeof byteLength !== "number" || !Number.isSafeInteger(byteLength) || byteLength < 0) continue;
		images.push({
			contentRef: reference.contentRef,
			mimeType,
			byteLength,
			...(typeof item.alt === "string" ? { alt: item.alt } : {}),
		});
	}
	return images;
}

function diffValue(value: JsonValue | undefined): { diff?: string; truncated?: boolean } {
	if (typeof value === "string") {
		const diff = bounded(value);
		return { diff, ...(diff.length < value.length ? { truncated: true } : {}) };
	}
	return {};
}

function number(value: JsonValue | undefined): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function toolDiff(name: string, details: JsonValue | undefined) {
	const source = record(details);
	if (!source || (name !== "edit" && name !== "write" && name !== "apply_patch")) return undefined;
	if (name === "apply_patch") {
		if (!Array.isArray(source.files)) return undefined;
		const files = source.files.flatMap((value) => {
			const file = record(value);
			if (!file) return [];
			const path = typeof file.path === "string" ? file.path : undefined;
			const additions = number(file.additions);
			const deletions = number(file.deletions);
			const operation = typeof file.operation === "string" ? file.operation : undefined;
			const result = diffValue(file.diff);
			if (!path && additions === undefined && deletions === undefined && !operation && !result.diff) {
				return [];
			}
			return [
				{
					...(path ? { path } : {}),
					...(operation ? { operation } : {}),
					...(additions === undefined ? {} : { additions }),
					...(deletions === undefined ? {} : { deletions }),
					...(result.diff === undefined ? {} : { diff: result.diff }),
					...(result.truncated ? { truncated: true } : {}),
				},
			];
		});
		return files.length > 0 ? { files } : undefined;
	}
	const additions = number(source.additions);
	const deletions = number(source.deletions);
	const operation = typeof source.operation === "string" ? source.operation : undefined;
	const result = diffValue(source.diff);
	if (additions === undefined && deletions === undefined && !operation && !result.diff) return undefined;
	return {
		files: [
			{
				...(operation ? { operation } : {}),
				...(additions === undefined ? {} : { additions }),
				...(deletions === undefined ? {} : { deletions }),
				...(result.diff === undefined ? {} : { diff: result.diff }),
				...(result.truncated ? { truncated: true } : {}),
			},
		],
	};
}

function toolCallSummary(name: string, argumentsValue: JsonValue | undefined): string {
	const argumentsRecord = record(argumentsValue);
	if ((name === "edit" || name === "write") && typeof argumentsRecord?.path === "string") {
		return argumentsRecord.path;
	}
	return text(argumentsValue);
}

function message(item: TranscriptItem): JsonRecord | undefined {
	return record(record(item.payload)?.message);
}

export function projectTranscriptItem(item: TranscriptItem): TranscriptViewItem {
	const payload = record(item.payload);
	const entryMessage = message(item);
	const role = entryMessage?.role;
	const content = entryMessage?.content ?? payload?.text;
	const images = imageMetadata(content);
	if (role === "user") {
		return { type: "user", text: text(content), ...(images.length > 0 ? { images } : {}) };
	}
	if (role === "thinking") return { type: "thinking", text: text(content) };
	if (role === "toolResult" && entryMessage) {
		const isError = entryMessage?.isError === true;
		const diff = toolDiff(
			typeof entryMessage.toolName === "string" ? entryMessage.toolName : "",
			entryMessage.details,
		);
		return {
			type: "tool_result",
			callId: typeof entryMessage.toolCallId === "string" ? entryMessage.toolCallId : item.entryId,
			name: typeof entryMessage.toolName === "string" ? entryMessage.toolName : "Tool",
			status: isError ? "error" : "success",
			summary: text(content),
			...(text(content) ? { detail: text(content) } : {}),
			...(contentRef(content) ? { contentRef: contentRef(content) } : {}),
			...(diff ? { diff } : {}),
			...(images.length > 0 ? { images } : {}),
		};
	}
	if (role === "assistant") {
		const calls = Array.isArray(content)
			? content
					.map(record)
					.filter((part): part is JsonRecord => part?.type === "toolCall" && typeof part.id === "string")
					.slice(0, TOOL_CALL_LIMIT)
					.map((part) => {
						const argumentsValue = record(part.arguments);
						const href =
							typeof argumentsValue?.url === "string"
								? argumentsValue.url
								: typeof argumentsValue?.path === "string"
									? `file://${argumentsValue.path}`
									: undefined;
						return {
							id: part.id as string,
							name: typeof part.name === "string" ? part.name : "Tool",
							summary: toolCallSummary(typeof part.name === "string" ? part.name : "Tool", part.arguments),
							...(href ? { href } : {}),
						};
					})
			: [];
		if (calls.length > 0) return { type: "tool_call", calls };
		return { type: "assistant", text: text(content), ...(images.length > 0 ? { images } : {}) };
	}
	if (item.kind === "compaction") return { type: "summary", title: "上下文压缩", text: text(payload) };
	if (item.kind === "branch_summary") return { type: "summary", title: "分支摘要", text: text(payload) };
	if (item.kind === "custom" || item.kind === "custom_message") {
		const name = typeof payload?.customType === "string" ? payload.customType : "";
		return name === "bash" ? { type: "bash", text: text(payload) } : { type: "custom", text: text(payload) };
	}
	return { type: "system", text: text(payload) };
}
