import type {
	AgentStep,
	JsonValue,
	ToolDiff,
	TranscriptFile,
	TranscriptItem,
	TranscriptSubagentRef,
	TranscriptViewItem,
	TranscriptWebSearchSource,
} from "@lystar/code-web-protocol";
import { AGENT_STEP_CUSTOM_TYPE, AGENT_STEP_TOOL_NAMES } from "./agent-steps.ts";
import { toolProgressDiff } from "./tool-progress.ts";

const INTERNAL_FILE_REFERENCE_PATTERN = /<file\b[^>]*>[\s\S]*?<\/file>/gu;
const FILE_ATTRIBUTE_PATTERN = /\bname="([^"]*)"/u;
const FILENAME_ATTRIBUTE_PATTERN = /\bfilename="([^"]*)"/u;
const MIME_TYPE_ATTRIBUTE_PATTERN = /\bmimeType="([^"]*)"/u;
const INTERNAL_PROMPT_BLOCK_PATTERNS = [
	/<file\b[^>]*>[\s\S]*?<\/file>/gu,
	/<skill\b[^>]*\blocation="[^"]+"[^>]*>[\s\S]*?<\/skill>/gu,
	/<skill_references\b[^>]*>[\s\S]*?<\/skill_references>/gu,
] as const;

const FILE_MIME_TYPES: Record<string, string> = {
	".avif": "image/avif",
	".bmp": "image/bmp",
	".csv": "text/csv",
	".css": "text/css",
	".doc": "application/msword",
	".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	".html": "text/html",
	".js": "text/javascript",
	".json": "application/json",
	".md": "text/markdown",
	".pdf": "application/pdf",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".ppt": "application/vnd.ms-powerpoint",
	".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
	".svg": "image/svg+xml",
	".ts": "text/typescript",
	".txt": "text/plain",
	".webp": "image/webp",
	".xls": "application/vnd.ms-excel",
	".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	".yaml": "text/yaml",
	".yml": "text/yaml",
	".zip": "application/zip",
};

const HIDDEN_SESSION_ENTRY_TYPES = new Set([
	"session",
	"thinking_level_change",
	"model_change",
	"label",
	"session_info",
]);

export function stripInternalPromptContent(value: string): string {
	let projected = value;
	for (const pattern of INTERNAL_PROMPT_BLOCK_PATTERNS) projected = projected.replace(pattern, "");
	return projected
		.replace(/[ \t]+\n/gu, "\n")
		.replace(/\n{3,}/gu, "\n\n")
		.trim();
}

const TEXT_LIMIT = 16 * 1024;
const TOOL_CALL_LIMIT = 32;

type JsonRecord = Record<string, JsonValue>;

export interface TranscriptToolCallProjection {
	name: string;
	summary: string;
	stepId?: string;
	href?: string;
	diff?: ToolDiff;
	imageGeneration?: {
		prompt?: string;
		requestedModel?: string;
		profile?: string;
	};
}

export type TranscriptToolCallIndex = ReadonlyMap<string, TranscriptToolCallProjection>;

function record(value: JsonValue | undefined): JsonRecord | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}

function subagentReferences(details: JsonValue | undefined): TranscriptSubagentRef[] {
	const source = record(details);
	if (!Array.isArray(source?.results)) return [];
	const states = new Set<TranscriptSubagentRef["state"]>([
		"queued",
		"running",
		"waiting",
		"succeeded",
		"failed",
		"cancelled",
	]);
	return source.results.flatMap((value) => {
		const result = record(value);
		const runId = typeof result?.runId === "string" ? result.runId : undefined;
		const agentId = typeof result?.agentId === "string" ? result.agentId : undefined;
		const agent = typeof result?.agent === "string" ? result.agent : undefined;
		const task = typeof result?.task === "string" ? result.task : undefined;
		if (!runId || !agentId || !agent || !task) return [];
		const stateValue = result?.state;
		const state =
			typeof stateValue === "string" && states.has(stateValue as TranscriptSubagentRef["state"])
				? (stateValue as TranscriptSubagentRef["state"])
				: undefined;
		return [{ runId, agentId, agent, task, ...(state ? { state } : {}) }];
	});
}

function projectedAgentStep(payload: JsonRecord | undefined): AgentStep | undefined {
	if (payload?.type !== "custom" || payload.customType !== AGENT_STEP_CUSTOM_TYPE) return undefined;
	const data = record(payload.data);
	const step = record(data?.step);
	if (
		data?.version !== 1 ||
		typeof step?.id !== "string" ||
		typeof step.title !== "string" ||
		(step.status !== "running" &&
			step.status !== "completed" &&
			step.status !== "failed" &&
			step.status !== "interrupted") ||
		!Array.isArray(step.toolCallIds) ||
		!step.toolCallIds.every((id) => typeof id === "string") ||
		(step.messageEntryIds !== undefined &&
			(!Array.isArray(step.messageEntryIds) || !step.messageEntryIds.every((id) => typeof id === "string"))) ||
		typeof step.startedAt !== "number"
	) {
		return undefined;
	}
	return {
		id: step.id,
		title: step.title,
		status: step.status,
		toolCallIds: step.toolCallIds as string[],
		messageEntryIds: (step.messageEntryIds as string[] | undefined) ?? [],
		startedAt: step.startedAt,
		...(typeof step.endedAt === "number" ? { endedAt: step.endedAt } : {}),
		...(typeof step.summary === "string" ? { summary: step.summary } : {}),
	};
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
				.filter((part) => part.length > 0)
				.join(" "),
		);
	}
	if (value === undefined || value === null) return "";
	const item = record(value);
	if (item?.type === "content_ref")
		return typeof item.previewHead === "string" ? bounded(item.previewHead) : "内容引用";
	return bounded(JSON.stringify(value));
}

function promptText(value: JsonValue | undefined): string {
	if (!Array.isArray(value)) return text(value);
	return bounded(
		value
			.map((part) => {
				const item = record(part);
				if (!item) return typeof part === "string" ? part : "";
				if (item.type === "image") return "";
				if (typeof item.text === "string") return item.text;
				if (item.type === "content_ref")
					return typeof item.previewHead === "string" ? item.previewHead : "内容引用";
				return JSON.stringify(item);
			})
			.filter((part) => part.length > 0)
			.join(" "),
	);
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

function decodeXmlAttribute(value: string): string {
	return value
		.replace(/&quot;/gu, '"')
		.replace(/&apos;/gu, "'")
		.replace(/&lt;/gu, "<")
		.replace(/&gt;/gu, ">");
}

function fileMetadata(value: JsonValue | undefined): TranscriptFile[] {
	const source = text(value);
	const files: TranscriptFile[] = [];
	const seen = new Set<string>();
	for (const match of source.matchAll(INTERNAL_FILE_REFERENCE_PATTERN)) {
		const tag = match[0];
		const rawPath = tag.match(FILE_ATTRIBUTE_PATTERN)?.[1];
		if (!rawPath) continue;
		const path = decodeXmlAttribute(rawPath).trim();
		const rawFilename = tag.match(FILENAME_ATTRIBUTE_PATTERN)?.[1];
		const filename = decodeXmlAttribute(rawFilename ?? "").trim() || path.split(/[\\/]/u).at(-1)?.trim() || "附件";
		const rawMimeType = tag.match(MIME_TYPE_ATTRIBUTE_PATTERN)?.[1];
		const mimeType =
			decodeXmlAttribute(rawMimeType ?? "").trim() ||
			FILE_MIME_TYPES[filename.includes(".") ? `.${filename.split(".").at(-1)!.toLowerCase()}` : ""] ||
			"application/octet-stream";
		if (mimeType.startsWith("image/")) continue;
		const key = `${filename}\0${mimeType}`;
		if (seen.has(key)) continue;
		seen.add(key);
		files.push({ filename, mimeType });
		if (files.length >= 32) break;
	}
	return files;
}

export function promptDisplayText(value: string): string {
	const visible = stripInternalPromptContent(value);
	if (visible) return visible;
	const files = fileMetadata(value);
	return files.length > 0 ? `附件：${files.map((file) => file.filename).join("、")}` : "";
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

function mergeToolDiff(previous: ToolDiff | undefined, next: ToolDiff | undefined): ToolDiff | undefined {
	if (!next) return previous;
	if (!previous) return next;
	return {
		files: next.files.map((file, index) => {
			const previousFile = file.path
				? previous.files.find((candidate) => candidate.path === file.path)
				: previous.files[index];
			return {
				...(previousFile ?? {}),
				...file,
				...(file.path === undefined && previousFile?.path ? { path: previousFile.path } : {}),
			};
		}),
	};
}

function toolCallSummary(name: string, argumentsValue: JsonValue | undefined): string {
	const argumentsRecord = record(argumentsValue);
	if (name === "bash" && typeof argumentsRecord?.command === "string") return argumentsRecord.command;
	if (name === "read" || name === "edit" || name === "write" || name === "apply_patch") {
		for (const key of ["path", "file_path", "filename"]) {
			if (typeof argumentsRecord?.[key] === "string") return argumentsRecord[key];
		}
	}
	return text(argumentsValue);
}

function imageGenerationCallMetadata(
	name: string,
	argumentsValue: JsonValue | undefined,
): TranscriptToolCallProjection["imageGeneration"] {
	if (name !== "image_gen") return undefined;
	const argumentsRecord = record(argumentsValue);
	if (!argumentsRecord) return undefined;
	const prompt = typeof argumentsRecord.prompt === "string" ? bounded(argumentsRecord.prompt) : undefined;
	const requestedModel = typeof argumentsRecord.model === "string" ? bounded(argumentsRecord.model) : undefined;
	const profile = typeof argumentsRecord.profile === "string" ? bounded(argumentsRecord.profile) : undefined;
	if (!prompt && !requestedModel && !profile) return undefined;
	return {
		...(prompt ? { prompt } : {}),
		...(requestedModel ? { requestedModel } : {}),
		...(profile ? { profile } : {}),
	};
}

function generatedImageSummary(
	name: string,
	call: TranscriptToolCallProjection | undefined,
	details: JsonValue | undefined,
): string {
	if (name !== "image_gen") return call?.summary ?? name;
	const result = record(details);
	const model = typeof result?.model === "string" ? bounded(result.model) : undefined;
	const savedPath = typeof result?.savedPath === "string" ? result.savedPath : undefined;
	const filename = savedPath?.replaceAll("\\", "/").split("/").filter(Boolean).at(-1);
	const metadata = {
		...(call?.imageGeneration?.prompt ? { prompt: call.imageGeneration.prompt } : {}),
		...(model ? { model } : {}),
		...(call?.imageGeneration?.requestedModel ? { requestedModel: call.imageGeneration.requestedModel } : {}),
		...(call?.imageGeneration?.profile ? { profile: call.imageGeneration.profile } : {}),
		...(filename ? { filename: bounded(filename) } : {}),
	};
	return Object.keys(metadata).length > 0 ? bounded(JSON.stringify(metadata)) : (call?.summary ?? name);
}

function toolCallProjection(part: JsonRecord, stepId?: string): TranscriptToolCallProjection | undefined {
	if (part.type !== "toolCall" || typeof part.id !== "string") return undefined;
	const name = typeof part.name === "string" ? part.name : "Tool";
	if (AGENT_STEP_TOOL_NAMES.has(name)) return undefined;
	const argumentsValue = record(part.arguments);
	const href =
		typeof argumentsValue?.url === "string"
			? argumentsValue.url
			: typeof argumentsValue?.path === "string"
				? `file://${argumentsValue.path}`
				: typeof argumentsValue?.file_path === "string"
					? `file://${argumentsValue.file_path}`
					: undefined;
	const diff = toolProgressDiff(name, part.arguments);
	const imageGeneration = imageGenerationCallMetadata(name, part.arguments);
	return {
		name,
		summary: toolCallSummary(name, part.arguments),
		...(stepId ? { stepId } : {}),
		...(href ? { href } : {}),
		...(diff ? { diff } : {}),
		...(imageGeneration ? { imageGeneration } : {}),
	};
}

function toolCallView(part: JsonRecord, stepByToolCall: ReadonlyMap<string, string>): TranscriptViewItem | undefined {
	const projection = toolCallProjection(part, typeof part.id === "string" ? stepByToolCall.get(part.id) : undefined);
	if (!projection || typeof part.id !== "string") return undefined;
	return {
		type: "tool_call",
		calls: [
			{
				id: part.id,
				name: projection.name,
				...(projection.stepId ? { stepId: projection.stepId } : {}),
				summary: projection.summary,
				...(projection.href ? { href: projection.href } : {}),
			},
		],
	};
}

type TranscriptImageMetadata = ReturnType<typeof imageMetadata>;

function webSearchSource(value: string, title?: string): TranscriptWebSearchSource | undefined {
	try {
		const url = new URL(value);
		if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
		return { url: url.toString(), title: bounded(title?.trim() || url.hostname) };
	} catch {
		return undefined;
	}
}

function webSearchCitations(content: JsonValue | undefined): TranscriptWebSearchSource[] {
	if (!Array.isArray(content)) return [];
	const sources = new Map<string, TranscriptWebSearchSource>();
	for (const part of content) {
		const item = record(part);
		if (!item || !Array.isArray(item.annotations)) continue;
		for (const annotation of item.annotations) {
			const candidate = record(annotation);
			if (candidate?.type !== "url_citation" || typeof candidate.url !== "string") continue;
			const source = webSearchSource(
				candidate.url,
				typeof candidate.title === "string" ? candidate.title : undefined,
			);
			if (source && !sources.has(source.url)) sources.set(source.url, source);
		}
	}
	return [...sources.values()];
}

function webSearchView(
	part: JsonRecord,
	citations: readonly TranscriptWebSearchSource[],
): Extract<TranscriptViewItem, { type: "web_search" }> | undefined {
	if (part.type !== "webSearchCall" || typeof part.id !== "string") return undefined;
	const status = part.status;
	if (status !== "in_progress" && status !== "searching" && status !== "completed" && status !== "failed")
		return undefined;

	const action = record(part.action);
	const citationTitles = new Map(citations.map((citation) => [citation.url, citation.title]));
	const sourceValues = action?.type === "search" && Array.isArray(action.sources) ? action.sources : [];
	const sourceUrls = sourceValues.flatMap((value) => {
		const source = record(value);
		return typeof source?.url === "string" ? [source.url] : [];
	});
	if (action?.type === "open_page" || action?.type === "find_in_page") {
		if (typeof action.url === "string") sourceUrls.push(action.url);
	}
	const sources = new Map<string, TranscriptWebSearchSource>();
	for (const url of sourceUrls) {
		const source = webSearchSource(url, citationTitles.get(url));
		if (source && !sources.has(source.url)) sources.set(source.url, source);
	}
	if (sources.size === 0) {
		for (const citation of citations) sources.set(citation.url, citation);
	}
	const query =
		action?.type === "search"
			? typeof action.query === "string"
				? action.query
				: Array.isArray(action.queries)
					? action.queries.find((value): value is string => typeof value === "string" && value.trim().length > 0)
					: undefined
			: undefined;
	return {
		type: "web_search",
		id: part.id,
		status,
		...(query ? { query: bounded(query) } : {}),
		sources: [...sources.values()].slice(0, 32),
	};
}

function assistantViews(
	content: JsonValue | undefined,
	images: TranscriptImageMetadata,
	stepByToolCall: ReadonlyMap<string, string>,
): TranscriptViewItem[] {
	if (!Array.isArray(content)) {
		return [{ type: "assistant", text: text(content), ...(images.length > 0 ? { images } : {}) }];
	}

	const views: TranscriptViewItem[] = [];
	const citations = webSearchCitations(content);
	let thinkingParts: string[] = [];
	let textParts: string[] = [];
	let toolCalls: JsonRecord[] = [];
	let projectedToolCallCount = 0;

	const flushThinking = () => {
		if (thinkingParts.length > 0) {
			views.push({ type: "thinking", text: bounded(thinkingParts.join("\n\n")) });
			thinkingParts = [];
		}
	};
	const flushText = () => {
		if (textParts.length > 0) {
			views.push({ type: "assistant", text: bounded(textParts.join("\n")) });
			textParts = [];
		}
	};
	const flushToolCalls = () => {
		if (toolCalls.length > 0) {
			const remaining = TOOL_CALL_LIMIT - projectedToolCallCount;
			const calls = toolCalls.slice(0, Math.max(0, remaining)).flatMap((part) => {
				const view = toolCallView(part, stepByToolCall);
				return view?.type === "tool_call" ? view.calls : [];
			});
			if (calls.length > 0) {
				views.push({ type: "tool_call", calls });
				projectedToolCallCount += calls.length;
			}
			toolCalls = [];
		}
	};

	for (const part of content) {
		const item = record(part);
		if (!item) continue;
		if (item.type === "thinking" && typeof item.thinking === "string") {
			flushText();
			flushToolCalls();
			if (item.thinking.trim()) thinkingParts.push(item.thinking);
			continue;
		}
		if (item.type === "text" && typeof item.text === "string") {
			flushThinking();
			flushToolCalls();
			if (item.text.trim()) textParts.push(item.text);
			continue;
		}
		if (item.type === "toolCall" && typeof item.id === "string") {
			if (typeof item.name === "string" && AGENT_STEP_TOOL_NAMES.has(item.name)) continue;
			flushThinking();
			flushText();
			toolCalls.push(item);
			continue;
		}
		if (item.type === "webSearchCall" && typeof item.id === "string") {
			flushThinking();
			flushText();
			flushToolCalls();
			const view = webSearchView(item, citations);
			if (view) views.push(view);
			continue;
		}
		if (item.type === "image") continue;
		flushThinking();
		flushText();
		flushToolCalls();
		views.push({ type: "assistant", text: text(item) });
	}
	flushThinking();
	flushText();
	flushToolCalls();

	const assistantIndex = views.findIndex((view) => view.type === "assistant");
	if (images.length > 0 && assistantIndex >= 0) {
		const view = views[assistantIndex];
		if (view?.type === "assistant") views[assistantIndex] = { ...view, images };
	} else if (images.length > 0) {
		views.push({ type: "assistant", text: "", images });
	}
	return views.length > 0 ? views : [{ type: "assistant", text: "", ...(images.length > 0 ? { images } : {}) }];
}

function message(item: TranscriptItem): JsonRecord | undefined {
	return record(record(item.payload)?.message);
}

function projectTranscriptViews(
	item: TranscriptItem,
	toolCalls: TranscriptToolCallIndex = new Map(),
	stepByToolCall: ReadonlyMap<string, string> = new Map(),
	latestStepEntryIds?: ReadonlySet<string>,
): TranscriptViewItem[] {
	const payload = record(item.payload);
	if (
		HIDDEN_SESSION_ENTRY_TYPES.has(item.kind) ||
		(typeof payload?.type === "string" && HIDDEN_SESSION_ENTRY_TYPES.has(payload.type))
	) {
		return [];
	}
	const entryMessage = message(item);
	const role = entryMessage?.role;
	const content = entryMessage?.content ?? payload?.text;
	const images = imageMetadata(content);
	const files = fileMetadata(content);
	if (role === "user") {
		return [
			{
				type: "user",
				text: stripInternalPromptContent(promptText(content)),
				...(images.length > 0 ? { images } : {}),
				...(files.length > 0 ? { files } : {}),
			},
		];
	}
	if (role === "thinking") return [{ type: "thinking", text: text(content) }];
	if (role === "bashExecution" && entryMessage) {
		const lines = [`$ ${typeof entryMessage.command === "string" ? entryMessage.command : ""}`];
		if (typeof entryMessage.output === "string" && entryMessage.output) lines.push(entryMessage.output);
		if (entryMessage.cancelled === true) lines.push("已取消");
		else if (typeof entryMessage.exitCode === "number" && entryMessage.exitCode !== 0)
			lines.push(`退出码 ${entryMessage.exitCode}`);
		if (entryMessage.truncated === true) lines.push("输出已截断");
		return [{ type: "bash", text: bounded(lines.join("\n")) }];
	}
	if (role === "toolResult" && entryMessage) {
		if (typeof entryMessage.toolName === "string" && AGENT_STEP_TOOL_NAMES.has(entryMessage.toolName)) return [];
		const isError = entryMessage?.isError === true;
		const callId = typeof entryMessage.toolCallId === "string" ? entryMessage.toolCallId : item.entryId;
		const call = toolCalls.get(callId);
		const name = call?.name ?? (typeof entryMessage.toolName === "string" ? entryMessage.toolName : "Tool");
		const detail = text(content);
		const resultDiff = toolDiff(
			typeof entryMessage.toolName === "string" ? entryMessage.toolName : name,
			entryMessage.details,
		);
		const diff = isError ? resultDiff : mergeToolDiff(call?.diff, resultDiff);
		const summary = generatedImageSummary(name, call, entryMessage.details);
		const subagents = name === "subagent" ? subagentReferences(entryMessage.details) : [];
		return [
			{
				type: "tool_result",
				callId,
				name,
				...(stepByToolCall.get(callId) ? { stepId: stepByToolCall.get(callId) } : {}),
				status: isError ? "error" : "success",
				summary,
				...(detail ? { detail } : {}),
				...(contentRef(content) ? { contentRef: contentRef(content) } : {}),
				...(diff ? { diff } : {}),
				...(images.length > 0 ? { images } : {}),
				...(subagents.length > 0 ? { subagents } : {}),
			},
		];
	}
	if (role === "assistant" && entryMessage) {
		const views = assistantViews(content, images, stepByToolCall);
		const stopReason = entryMessage.stopReason;
		if (stopReason !== "error" && stopReason !== "aborted") return views;
		const errorMessage = typeof entryMessage.errorMessage === "string" ? entryMessage.errorMessage.trim() : "";
		const failureText =
			stopReason === "aborted"
				? errorMessage
					? `请求已取消：${bounded(errorMessage)}`
					: "请求已取消"
				: errorMessage
					? `请求失败：${bounded(errorMessage)}`
					: "模型响应失败";
		const visibleViews = views.filter((view) => {
			if (view.type !== "assistant") return true;
			return Boolean(view.text.trim() || view.images?.length);
		});
		return [...visibleViews, { type: "system", text: failureText }];
	}
	if (item.kind === "compaction") {
		const source = record(payload);
		const summary = typeof source?.summary === "string" ? bounded(source.summary) : "";
		const tokensBefore = number(source?.tokensBefore);
		return [
			{
				type: "summary",
				variant: "compaction",
				title: "上下文压缩",
				text: summary,
				...(tokensBefore === undefined ? {} : { tokensBefore }),
			},
		];
	}
	if (item.kind === "branch_summary") {
		const source = record(payload);
		return [
			{
				type: "summary",
				variant: "branch_summary",
				title: "分支摘要",
				text: typeof source?.summary === "string" ? bounded(source.summary) : text(payload),
			},
		];
	}
	if (item.kind === "custom" || item.kind === "custom_message") {
		const step = projectedAgentStep(payload);
		if (step) {
			return !latestStepEntryIds || latestStepEntryIds.has(item.entryId) ? [{ type: "agent_step", step }] : [];
		}
		const name = typeof payload?.customType === "string" ? payload.customType : "";
		return [name === "bash" ? { type: "bash", text: text(payload) } : { type: "custom", text: text(payload) }];
	}
	return [{ type: "system", text: text(payload) }];
}

export function projectTranscriptItems(
	item: TranscriptItem,
	toolCalls: TranscriptToolCallIndex = new Map(),
): TranscriptItem[] {
	return projectTranscriptViews(item, toolCalls).map((view) => ({ ...item, view }));
}

export function projectTranscriptBatch(items: readonly TranscriptItem[]): TranscriptItem[] {
	const stepByToolCall = new Map<string, string>();
	const latestStepEntryIdsByStep = new Map<string, string>();
	for (const item of items) {
		const step = projectedAgentStep(record(item.payload));
		if (!step) continue;
		latestStepEntryIdsByStep.set(step.id, item.entryId);
		for (const toolCallId of step.toolCallIds) stepByToolCall.set(toolCallId, step.id);
	}
	const toolCalls = new Map<string, TranscriptToolCallProjection>();
	for (const item of items) {
		const payload = record(item.payload);
		const entryMessage = record(payload?.message);
		if (entryMessage?.role !== "assistant" || !Array.isArray(entryMessage.content)) continue;
		for (const part of entryMessage.content) {
			const candidate = record(part);
			const projection =
				candidate && typeof candidate.id === "string"
					? toolCallProjection(candidate, stepByToolCall.get(candidate.id))
					: undefined;
			if (candidate && typeof candidate.id === "string" && projection) toolCalls.set(candidate.id, projection);
		}
	}
	const latestStepEntryIds = new Set(latestStepEntryIdsByStep.values());
	return items.flatMap((item) =>
		projectTranscriptViews(item, toolCalls, stepByToolCall, latestStepEntryIds).map((view) => ({ ...item, view })),
	);
}

export function projectTranscriptItem(item: TranscriptItem): TranscriptViewItem {
	return projectTranscriptViews(item)[0] ?? { type: "system", text: "" };
}
