import Type, { type Static } from "typebox";
import { Check } from "typebox/value";

export const GUI_PROTOCOL_VERSION = 1 as const;
export const MAX_TRANSCRIPT_PAGE_SIZE = 200;
export const MAX_TRANSCRIPT_SEARCH_LIMIT = 100;

const Id = Type.String({ minLength: 1, maxLength: 4096 });
const WorkspaceText = Type.String({ maxLength: 1024 * 1024 });
const StrictObject = <const T extends Parameters<typeof Type.Object>[0]>(properties: T) =>
	Type.Object(properties, { additionalProperties: false });

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
const JsonValueRecursiveSchema = Type.Cyclic(
	{
		JsonValue: Type.Union([
			Type.Null(),
			Type.Boolean(),
			Type.Number(),
			Type.String(),
			Type.Array(Type.Ref("JsonValue")),
			Type.Record(Type.String(), Type.Ref("JsonValue")),
		]),
	},
	"JsonValue",
);
export const JsonValueSchema = Type.Unsafe<JsonValue>(JsonValueRecursiveSchema);

const DiagnosticToolCodeCountSchema = StrictObject({
	tool: Type.String({ minLength: 1 }),
	code: Type.String({ minLength: 1 }),
	count: Type.Integer({ minimum: 0 }),
});
const DiagnosticToolActionCountSchema = StrictObject({
	tool: Type.String({ minLength: 1 }),
	action: Type.String({ minLength: 1 }),
	count: Type.Integer({ minimum: 0 }),
});
const DiagnosticLessonCountSchema = StrictObject({ lesson: Id, count: Type.Integer({ minimum: 0 }) });
const DiagnosticToolCountSchema = StrictObject({
	tool: Type.String({ minLength: 1 }),
	count: Type.Integer({ minimum: 0 }),
});

export const ToolRecoveryDiagnosticsSchema = StrictObject({
	sessionActive: Type.Boolean(),
	mode: Type.Optional(Type.Union([Type.Literal("observe"), Type.Literal("assist")])),
	activeCircuits: Type.Integer({ minimum: 0 }),
	metrics: StrictObject({
		toolFailureTotal: Type.Optional(Type.Array(DiagnosticToolCodeCountSchema)),
		toolRecoveryAttemptTotal: Type.Optional(Type.Array(DiagnosticToolActionCountSchema)),
		toolRecoverySuccessTotal: Type.Optional(Type.Array(DiagnosticToolActionCountSchema)),
		toolRepeatBlockedTotal: Type.Optional(Type.Array(DiagnosticToolCodeCountSchema)),
		toolUnsafeRetryBlockedTotal: Type.Optional(Type.Array(DiagnosticToolCountSchema)),
		lessonMatchTotal: Type.Optional(Type.Array(DiagnosticLessonCountSchema)),
		lessonRecoverySuccessTotal: Type.Optional(Type.Array(DiagnosticLessonCountSchema)),
		lessonSuspendedTotal: Type.Optional(Type.Array(DiagnosticLessonCountSchema)),
		duration: Type.Optional(
			StrictObject({
				count: Type.Integer({ minimum: 0 }),
				totalMs: Type.Number({ minimum: 0 }),
				maxMs: Type.Number({ minimum: 0 }),
			}),
		),
	}),
});
export type ToolRecoveryDiagnostics = Static<typeof ToolRecoveryDiagnosticsSchema>;

export const DiagnosticsSchema = StrictObject({
	checks: Type.Optional(
		Type.Array(
			StrictObject({
				id: Type.String({ minLength: 1 }),
				status: Type.String({ minLength: 1 }),
				message: Type.String(),
			}),
		),
	),
	product: Type.Optional(
		StrictObject({ name: Type.String({ minLength: 1 }), version: Type.String({ minLength: 1 }) }),
	),
	frontend: Type.Optional(
		StrictObject({
			implementation: Type.String({ minLength: 1 }),
			modes: Type.Array(Type.String({ minLength: 1 })),
			rust: StrictObject({ b0Status: Type.String({ minLength: 1 }), integration: Type.String({ minLength: 1 }) }),
		}),
	),
	nodeVersion: Type.Optional(Type.String({ minLength: 1 })),
	guiProtocolVersion: Type.Optional(Type.Integer({ minimum: 0 })),
	cwd: Type.Optional(Type.String({ minLength: 1 })),
	agentDir: Type.Optional(Type.String({ minLength: 1 })),
	platform: Type.Optional(Type.String({ minLength: 1 })),
	arch: Type.Optional(Type.String({ minLength: 1 })),
	recovery: Type.Optional(ToolRecoveryDiagnosticsSchema),
	lessons: Type.Optional(
		StrictObject({
			available: Type.Boolean(),
			counts: StrictObject({
				candidate: Type.Integer({ minimum: 0 }),
				verified: Type.Integer({ minimum: 0 }),
				active: Type.Integer({ minimum: 0 }),
				disabled: Type.Integer({ minimum: 0 }),
				expired: Type.Integer({ minimum: 0 }),
			}),
			error: Type.Optional(StrictObject({ code: Type.String({ minLength: 1 }) })),
		}),
	),
	recentConnectionErrors: Type.Optional(
		StrictObject({ available: Type.Boolean(), reason: Type.Optional(Type.String({ minLength: 1 })) }),
	),
	terminalRepairHistory: Type.Optional(
		StrictObject({ available: Type.Boolean(), reason: Type.Optional(Type.String({ minLength: 1 })) }),
	),
});
export type Diagnostics = Static<typeof DiagnosticsSchema>;

export function isDiagnostics(value: unknown): value is Diagnostics {
	return Check(DiagnosticsSchema, value);
}

export const CapabilitySchema = Type.Union([
	Type.Literal("session-paging"),
	Type.Literal("session-control"),
	Type.Literal("operation-journal"),
	Type.Literal("project-trust-ui"),
	Type.Literal("models"),
	Type.Literal("models-auth"),
	Type.Literal("skills"),
	Type.Literal("git-inspector"),
	Type.Literal("content-ref"),
	Type.Literal("remote-detach"),
	Type.Literal("about"),
	Type.Literal("diagnostics"),
	Type.Literal("connections"),
	Type.Literal("updates"),
	Type.Literal("session-observation"),
	Type.Literal("project-instructions"),
	Type.Literal("host-instructions"),
	Type.Literal("completion"),
	Type.Literal("project-resources"),
	Type.Literal("directory-browser"),
	Type.Literal("external-resources"),
	Type.Literal("workspace-api"),
	Type.Literal("rust-extension-ui"),
]);
export type Capability = Static<typeof CapabilitySchema>;

export const ThinkingLevelSchema = Type.Union([
	Type.Literal("off"),
	Type.Literal("minimal"),
	Type.Literal("low"),
	Type.Literal("medium"),
	Type.Literal("high"),
	Type.Literal("xhigh"),
	Type.Literal("max"),
]);
export type ThinkingLevel = Static<typeof ThinkingLevelSchema>;

export const ModelRefSchema = StrictObject({ provider: Id, id: Id });
export type ModelRef = Static<typeof ModelRefSchema>;

export const AuthTypeSchema = Type.Union([Type.Literal("api_key"), Type.Literal("oauth")]);
export type AuthType = Static<typeof AuthTypeSchema>;

export const ModelInputSchema = Type.Union([Type.Literal("text"), Type.Literal("image")]);

const ModelCostSchema = StrictObject({
	input: Type.Number({ minimum: 0 }),
	output: Type.Number({ minimum: 0 }),
	cacheRead: Type.Number({ minimum: 0 }),
	cacheWrite: Type.Number({ minimum: 0 }),
});
export const ModelSummarySchema = StrictObject({
	provider: Id,
	id: Id,
	name: Type.String({ minLength: 1, maxLength: 4096 }),
	api: Type.String({ minLength: 1, maxLength: 4096 }),
	reasoning: Type.Boolean(),
	input: Type.Array(ModelInputSchema, { minItems: 1, maxItems: 8 }),
	contextWindow: Type.Integer({ minimum: 1 }),
	maxTokens: Type.Integer({ minimum: 1 }),
	cost: ModelCostSchema,
	supportedThinkingLevels: Type.Array(ThinkingLevelSchema, { maxItems: 7 }),
	authenticated: Type.Boolean(),
	authMethods: Type.Array(AuthTypeSchema, { maxItems: 2 }),
	authSource: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
});
export type ModelSummary = Static<typeof ModelSummarySchema>;

export const ModelProviderSummarySchema = StrictObject({
	id: Id,
	name: Type.String({ minLength: 1, maxLength: 4096 }),
	authenticated: Type.Boolean(),
	authMethods: Type.Array(AuthTypeSchema, { maxItems: 2 }),
	authSource: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
	modelCount: Type.Integer({ minimum: 0 }),
	builtIn: Type.Boolean(),
	custom: Type.Boolean(),
});
export type ModelProviderSummary = Static<typeof ModelProviderSummarySchema>;

export const SessionPhaseSchema = Type.Union([
	Type.Literal("idle"),
	Type.Literal("turn"),
	Type.Literal("compaction"),
	Type.Literal("branch_summary"),
	Type.Literal("retry"),
	Type.Literal("waiting_for_input"),
	Type.Literal("interrupted"),
]);
export type SessionPhase = Static<typeof SessionPhaseSchema>;

export const SessionActivitySchema = Type.Union([
	Type.Literal("idle"),
	Type.Literal("running"),
	Type.Literal("waiting_for_input"),
	Type.Literal("completed"),
	Type.Literal("failed"),
	Type.Literal("aborted"),
	Type.Literal("interrupted"),
]);
export type SessionActivity = Static<typeof SessionActivitySchema>;

export const UsageProgressSchema = StrictObject({
	inputTokens: Type.Optional(Type.Integer({ minimum: 0 })),
	outputTokens: Type.Optional(Type.Integer({ minimum: 0 })),
	cacheReadTokens: Type.Optional(Type.Integer({ minimum: 0 })),
	cacheWriteTokens: Type.Optional(Type.Integer({ minimum: 0 })),
	elapsedMs: Type.Optional(Type.Integer({ minimum: 0 })),
});
export type UsageProgress = Static<typeof UsageProgressSchema>;

const ProgressTextSchema = Type.String({ maxLength: 16 * 1024 });
const ToolDiffFileSchema = StrictObject({
	path: Type.Optional(Type.String({ minLength: 1, maxLength: 16 * 1024 })),
	operation: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
	additions: Type.Optional(Type.Integer({ minimum: 0 })),
	deletions: Type.Optional(Type.Integer({ minimum: 0 })),
	diff: Type.Optional(ProgressTextSchema),
	truncated: Type.Optional(Type.Boolean()),
});
export type ToolDiffFile = Static<typeof ToolDiffFileSchema>;
const ToolDiffSchema = StrictObject({ files: Type.Array(ToolDiffFileSchema, { minItems: 1, maxItems: 128 }) });
export type ToolDiff = Static<typeof ToolDiffSchema>;
export const SessionProgressSchema = Type.Union([
	StrictObject({ type: Type.Literal("assistant_delta"), text: ProgressTextSchema }),
	StrictObject({ type: Type.Literal("thinking_delta"), text: ProgressTextSchema }),
	StrictObject({
		type: Type.Literal("tool_start"),
		toolCallId: Id,
		name: Type.String({ minLength: 1, maxLength: 256 }),
		summary: Type.Optional(ProgressTextSchema),
		diff: Type.Optional(ToolDiffSchema),
	}),
	StrictObject({
		type: Type.Literal("tool_update"),
		toolCallId: Id,
		name: Type.String({ minLength: 1, maxLength: 256 }),
		summary: ProgressTextSchema,
		diff: Type.Optional(ToolDiffSchema),
	}),
	StrictObject({
		type: Type.Literal("tool_end"),
		toolCallId: Id,
		name: Type.String({ minLength: 1, maxLength: 256 }),
		status: Type.Union([Type.Literal("success"), Type.Literal("error")]),
		summary: ProgressTextSchema,
		diff: Type.Optional(ToolDiffSchema),
	}),
	StrictObject({
		type: Type.Literal("queue_update"),
		steeringCount: Type.Integer({ minimum: 0 }),
		followUpCount: Type.Integer({ minimum: 0 }),
	}),
	StrictObject({ type: Type.Literal("phase"), phase: SessionPhaseSchema }),
	StrictObject({
		type: Type.Literal("compaction"),
		status: Type.Union([
			Type.Literal("running"),
			Type.Literal("completed"),
			Type.Literal("cancelled"),
			Type.Literal("failed"),
			Type.Literal("waiting_retry"),
		]),
		reason: Type.Union([Type.Literal("manual"), Type.Literal("threshold"), Type.Literal("overflow")]),
		error: Type.Optional(Type.String({ maxLength: 1024 })),
	}),
	StrictObject({
		type: Type.Literal("retry"),
		status: Type.Union([
			Type.Literal("waiting"),
			Type.Literal("running"),
			Type.Literal("completed"),
			Type.Literal("failed"),
		]),
		kind: Type.Union([
			Type.Literal("model"),
			Type.Literal("summarization"),
			Type.Literal("compaction"),
			Type.Literal("branch_summary"),
		]),
		attempt: Type.Optional(Type.Integer({ minimum: 1 })),
		maxAttempts: Type.Optional(Type.Integer({ minimum: 1 })),
		delayMs: Type.Optional(Type.Integer({ minimum: 0 })),
		error: Type.Optional(Type.String({ maxLength: 1024 })),
	}),
	StrictObject({
		type: Type.Literal("status"),
		status: Type.String({ minLength: 1, maxLength: 1024 }),
		truncated: Type.Optional(Type.Boolean()),
	}),
	StrictObject({ type: Type.Literal("usage"), usage: UsageProgressSchema }),
]);
export type SessionProgress = Static<typeof SessionProgressSchema>;

export function isSessionProgress(value: unknown): value is SessionProgress {
	return Check(SessionProgressSchema, value);
}

export const WriteAccessSchema = Type.Union([
	Type.Literal("available"),
	Type.Literal("owned"),
	Type.Literal("controlled_elsewhere"),
	Type.Literal("locked_externally"),
]);

export const SessionStateSnapshotSchema = StrictObject({
	id: Id,
	path: Type.String({ minLength: 1 }),
	name: Type.Optional(Type.String()),
	cwd: Type.String(),
	createdAt: Type.Integer({ minimum: 0 }),
	updatedAt: Type.Integer({ minimum: 0 }),
	phase: SessionPhaseSchema,
	activity: SessionActivitySchema,
	model: Type.Optional(ModelRefSchema),
	thinkingLevel: ThinkingLevelSchema,
	attached: Type.Boolean(),
	writeAccess: WriteAccessSchema,
	revision: Type.Integer({ minimum: 0 }),
	leafId: Type.Union([Id, Type.Null()]),
	queuedSteerCount: Type.Integer({ minimum: 0 }),
	queuedFollowUpCount: Type.Integer({ minimum: 0 }),
	transcriptGeneration: Id,
	transcriptRevision: Type.Integer({ minimum: 0 }),
});
export type SessionStateSnapshot = Static<typeof SessionStateSnapshotSchema>;

export const SessionSummarySchema = StrictObject({
	path: Type.String({ minLength: 1 }),
	id: Id,
	cwd: Type.String({ minLength: 1 }),
	name: Type.Optional(Type.String()),
	createdAt: Type.Integer({ minimum: 0 }),
	updatedAt: Type.Integer({ minimum: 0 }),
	messageCount: Type.Integer({ minimum: 0 }),
	firstMessage: Type.String(),
	activity: SessionActivitySchema,
	writeAccess: WriteAccessSchema,
	operationUpdatedAt: Type.Optional(Type.Integer({ minimum: 0 })),
});
export type SessionSummary = Static<typeof SessionSummarySchema>;

const TranscriptViewTextSchema = Type.String({ maxLength: 16 * 1024 });
const TranscriptImageSchema = StrictObject({
	contentRef: Id,
	mimeType: Type.String({ minLength: 1, maxLength: 256 }),
	byteLength: Type.Integer({ minimum: 0 }),
	alt: Type.Optional(Type.String({ maxLength: 4096 })),
});
export type TranscriptImage = Static<typeof TranscriptImageSchema>;
const TranscriptToolCallSchema = StrictObject({
	id: Id,
	name: Type.String({ minLength: 1, maxLength: 256 }),
	summary: TranscriptViewTextSchema,
	href: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
});

// Host 投影是 Rust 终端的唯一 transcript 输入；payload 仅保留给既有 GUI 兼容路径。
export const TranscriptViewItemSchema = Type.Union([
	StrictObject({
		type: Type.Literal("user"),
		text: TranscriptViewTextSchema,
		images: Type.Optional(Type.Array(TranscriptImageSchema, { maxItems: 32 })),
	}),
	StrictObject({
		type: Type.Literal("assistant"),
		text: TranscriptViewTextSchema,
		images: Type.Optional(Type.Array(TranscriptImageSchema, { maxItems: 32 })),
	}),
	StrictObject({ type: Type.Literal("thinking"), text: TranscriptViewTextSchema }),
	StrictObject({ type: Type.Literal("tool_call"), calls: Type.Array(TranscriptToolCallSchema, { maxItems: 32 }) }),
	StrictObject({
		type: Type.Literal("tool_result"),
		callId: Id,
		name: Type.String({ minLength: 1, maxLength: 256 }),
		status: Type.Union([Type.Literal("success"), Type.Literal("error")]),
		summary: TranscriptViewTextSchema,
		detail: Type.Optional(TranscriptViewTextSchema),
		contentRef: Type.Optional(Id),
		diff: Type.Optional(ToolDiffSchema),
		images: Type.Optional(Type.Array(TranscriptImageSchema, { maxItems: 32 })),
	}),
	StrictObject({ type: Type.Literal("bash"), text: TranscriptViewTextSchema }),
	StrictObject({ type: Type.Literal("custom"), text: TranscriptViewTextSchema }),
	StrictObject({ type: Type.Literal("summary"), title: TranscriptViewTextSchema, text: TranscriptViewTextSchema }),
	StrictObject({ type: Type.Literal("system"), text: TranscriptViewTextSchema }),
]);
export type TranscriptViewItem = Static<typeof TranscriptViewItemSchema>;

export const TranscriptRequestContextSchema = StrictObject({
	generation: Type.Optional(Id),
	revision: Type.Optional(Type.Integer({ minimum: 0 })),
	cursor: Type.Optional(Id),
});
export type TranscriptRequestContext = Static<typeof TranscriptRequestContextSchema>;

export const TranscriptItemSchema = StrictObject({
	entryId: Id,
	parentId: Type.Union([Id, Type.Null()]),
	timestamp: Type.String(),
	kind: Type.String({ minLength: 1 }),
	payload: JsonValueSchema,
	view: Type.Optional(TranscriptViewItemSchema),
});
export type TranscriptItem = Static<typeof TranscriptItemSchema>;

export const ContentReferenceSchema = StrictObject({
	type: Type.Literal("content_ref"),
	contentRef: Id,
	previewHead: Type.String(),
	previewTail: Type.String(),
	byteLength: Type.Integer({ minimum: 0 }),
	lineCount: Type.Integer({ minimum: 0 }),
	mimeType: Type.String({ minLength: 1 }),
});
export type ContentReference = Static<typeof ContentReferenceSchema>;

export const ContentChunkSchema = StrictObject({
	contentRef: Id,
	offset: Type.Integer({ minimum: 0 }),
	nextOffset: Type.Integer({ minimum: 0 }),
	byteLength: Type.Integer({ minimum: 0 }),
	data: Type.String(),
	encoding: Type.Literal("base64"),
	done: Type.Boolean(),
});
export type ContentChunk = Static<typeof ContentChunkSchema>;

export const TranscriptPageSchema = StrictObject({
	items: Type.Array(TranscriptItemSchema),
	previousCursor: Type.Optional(Id),
	hasMorePrevious: Type.Boolean(),
	leafId: Type.Union([Id, Type.Null()]),
	transcriptGeneration: Id,
	transcriptRevision: Type.Integer({ minimum: 0 }),
	complete: Type.Boolean(),
	requestContext: Type.Optional(TranscriptRequestContextSchema),
});
export type TranscriptPage = Static<typeof TranscriptPageSchema>;

export const TranscriptSearchMatchSchema = StrictObject({
	start: Type.Integer({ minimum: 0 }),
	end: Type.Integer({ minimum: 0 }),
});
export type TranscriptSearchMatch = Static<typeof TranscriptSearchMatchSchema>;

export const TranscriptSearchHitSchema = StrictObject({
	entryId: Id,
	kind: Type.String({ minLength: 1 }),
	timestamp: Type.String(),
	snippet: Type.String(),
	matches: Type.Array(TranscriptSearchMatchSchema),
});
export type TranscriptSearchHit = Static<typeof TranscriptSearchHitSchema>;

export const TranscriptSearchResultSchema = StrictObject({
	generation: Id,
	transcriptRevision: Type.Integer({ minimum: 0 }),
	complete: Type.Boolean(),
	hits: Type.Array(TranscriptSearchHitSchema),
	nextCursor: Type.Optional(Id),
});
export type TranscriptSearchResult = Static<typeof TranscriptSearchResultSchema>;

export const OperationStatusSchema = Type.Union([
	Type.Literal("accepted"),
	Type.Literal("running"),
	Type.Literal("waiting_for_input"),
	Type.Literal("completed"),
	Type.Literal("failed"),
	Type.Literal("aborted"),
	Type.Literal("interrupted"),
]);
export type OperationStatus = Static<typeof OperationStatusSchema>;

export const OperationSnapshotSchema = StrictObject({
	operationId: Id,
	clientInstanceId: Id,
	clientRequestId: Id,
	sessionPath: Type.String({ minLength: 1 }),
	type: Type.String({ minLength: 1 }),
	status: OperationStatusSchema,
	acceptedAt: Type.Integer({ minimum: 0 }),
	updatedAt: Type.Integer({ minimum: 0 }),
	payloadHash: Id,
	progress: Type.Optional(JsonValueSchema),
	result: Type.Optional(JsonValueSchema),
	error: Type.Optional(Type.String()),
});
export type OperationSnapshot = Static<typeof OperationSnapshotSchema>;

export function isOperationSnapshot(value: unknown): value is OperationSnapshot {
	return Check(OperationSnapshotSchema, value);
}

export const SkillScopeSchema = Type.Union([Type.Literal("user"), Type.Literal("project"), Type.Literal("temporary")]);
export const SkillSummarySchema = StrictObject({
	name: Type.String({ minLength: 1, maxLength: 4096 }),
	description: Type.String({ maxLength: 16 * 1024 }),
	path: Type.String({ minLength: 1, maxLength: 4096 }),
	baseDir: Type.String({ minLength: 1, maxLength: 4096 }),
	source: Type.String({ minLength: 1, maxLength: 4096 }),
	scope: SkillScopeSchema,
	origin: Type.Union([Type.Literal("package"), Type.Literal("top-level")]),
	enabled: Type.Boolean(),
	disableModelInvocation: Type.Boolean(),
	eligible: Type.Boolean(),
});
export type SkillSummary = Static<typeof SkillSummarySchema>;

export const GitFileStatusSchema = StrictObject({
	path: Type.String({ minLength: 1 }),
	originalPath: Type.Optional(Type.String({ minLength: 1 })),
	indexStatus: Type.String({ minLength: 1, maxLength: 1 }),
	worktreeStatus: Type.String({ minLength: 1, maxLength: 1 }),
	staged: Type.Boolean(),
	unstaged: Type.Boolean(),
	untracked: Type.Boolean(),
	conflicted: Type.Boolean(),
});
export type GitFileStatus = Static<typeof GitFileStatusSchema>;

export const GitStatusSchema = StrictObject({
	root: Type.String({ minLength: 1 }),
	branch: Type.Optional(Type.String({ minLength: 1 })),
	upstream: Type.Optional(Type.String({ minLength: 1 })),
	ahead: Type.Integer({ minimum: 0 }),
	behind: Type.Integer({ minimum: 0 }),
	files: Type.Array(GitFileStatusSchema),
});
export type GitStatus = Static<typeof GitStatusSchema>;

export const GitDiffSchema = StrictObject({
	path: Type.Optional(Type.String({ minLength: 1 })),
	staged: Type.Boolean(),
	diff: Type.String(),
	additions: Type.Integer({ minimum: 0 }),
	deletions: Type.Integer({ minimum: 0 }),
});
export type GitDiff = Static<typeof GitDiffSchema>;

export const ProjectInstructionSchema = StrictObject({
	path: Type.String({ minLength: 1 }),
	fileName: Type.String({ minLength: 1 }),
	exists: Type.Boolean(),
	active: Type.Boolean(),
	editable: Type.Boolean(),
	content: Type.Optional(Type.String()),
	contentHash: Type.Optional(Id),
});
export type ProjectInstruction = Static<typeof ProjectInstructionSchema>;

export const HostDirectoryEntrySchema = StrictObject({
	name: Type.String({ minLength: 1 }),
	path: Type.String({ minLength: 1 }),
	hidden: Type.Boolean(),
});
export type HostDirectoryEntry = Static<typeof HostDirectoryEntrySchema>;

export const HostDirectoryListingSchema = StrictObject({
	path: Type.String({ minLength: 1 }),
	home: Type.String({ minLength: 1 }),
	parent: Type.Optional(Type.String({ minLength: 1 })),
	entries: Type.Array(HostDirectoryEntrySchema),
});
export type HostDirectoryListing = Static<typeof HostDirectoryListingSchema>;

export const CompletionItemSchema = StrictObject({
	value: Type.String({ minLength: 1 }),
	label: Type.String({ minLength: 1 }),
	description: Type.Optional(Type.String()),
	kind: Type.Union([
		Type.Literal("file"),
		Type.Literal("directory"),
		Type.Literal("skill"),
		Type.Literal("prompt"),
		Type.Literal("extension"),
		Type.Literal("command"),
	]),
});
export type CompletionItem = Static<typeof CompletionItemSchema>;

export const CompletionResultSchema = StrictObject({
	prefixStart: Type.Integer({ minimum: 0 }),
	prefixEnd: Type.Integer({ minimum: 0 }),
	items: Type.Array(CompletionItemSchema),
});
export type CompletionResult = Static<typeof CompletionResultSchema>;

export const ProjectResourceSchema = StrictObject({
	path: Type.String({ minLength: 1 }),
	displayPath: Type.String({ minLength: 1 }),
	kind: Type.Union([Type.Literal("text"), Type.Literal("image")]),
	mimeType: Type.String({ minLength: 1 }),
	byteLength: Type.Integer({ minimum: 0 }),
	line: Type.Optional(Type.Integer({ minimum: 1 })),
	column: Type.Optional(Type.Integer({ minimum: 1 })),
	accessToken: Type.Optional(Id),
});
export type ProjectResource = Static<typeof ProjectResourceSchema>;

export const SettingKindSchema = Type.Union([
	Type.Literal("boolean"),
	Type.Literal("enum"),
	Type.Literal("integer"),
	Type.Literal("string"),
]);
export const SettingValueSchema = Type.Union([Type.Boolean(), Type.Integer(), Type.String()]);
export const SettingSummarySchema = StrictObject({
	id: Id,
	label: Type.String({ minLength: 1, maxLength: 4096 }),
	description: Type.Optional(Type.String({ maxLength: 16 * 1024 })),
	kind: SettingKindSchema,
	value: SettingValueSchema,
	displayValue: Type.String({ minLength: 1, maxLength: 4096 }),
	options: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 4096 }), { maxItems: 1000 })),
	optionLabels: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 4096 }), { maxItems: 1000 })),
	minimum: Type.Optional(Type.Integer()),
	maximum: Type.Optional(Type.Integer()),
	scope: Type.Union([Type.Literal("global"), Type.Literal("project")]),
	readOnly: Type.Boolean(),
	restartRequired: Type.Boolean(),
});
export type SettingSummary = Static<typeof SettingSummarySchema>;

export const ProjectTrustSchema = StrictObject({
	cwd: Type.String({ minLength: 1, maxLength: 4096 }),
	trusted: Type.Union([Type.Boolean(), Type.Null()]),
	reason: Type.String({ minLength: 1, maxLength: 16 * 1024 }),
	resourceRisk: Type.Boolean(),
});
export type ProjectTrust = Static<typeof ProjectTrustSchema>;

export const PackageScopeSchema = Type.Union([Type.Literal("user"), Type.Literal("project")]);
export const PackageSummarySchema = StrictObject({
	source: Type.String({ minLength: 1, maxLength: 4096 }),
	scope: PackageScopeSchema,
	filtered: Type.Boolean(),
	installedPath: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
});
export type PackageSummary = Static<typeof PackageSummarySchema>;

export const SessionTreeNodeSchema = StrictObject({
	id: Id,
	parentId: Type.Union([Id, Type.Null()]),
	kind: Type.String({ minLength: 1, maxLength: 256 }),
	label: Type.Optional(Type.String({ maxLength: 16 * 1024 })),
	timestamp: Type.String({ minLength: 1, maxLength: 4096 }),
	preview: Type.String({ maxLength: 4096 }),
	isLeaf: Type.Boolean(),
	depth: Type.Integer({ minimum: 0 }),
});
export type SessionTreeNode = Static<typeof SessionTreeNodeSchema>;

export const SubagentSnapshotSchema = StrictObject({
	runId: Id,
	agentId: Id,
	agent: Type.String({ minLength: 1, maxLength: 4096 }),
	agentSource: Type.Union([
		Type.Literal("builtin"),
		Type.Literal("user"),
		Type.Literal("project"),
		Type.Literal("unknown"),
	]),
	task: WorkspaceText,
	state: Type.Union([
		Type.Literal("queued"),
		Type.Literal("running"),
		Type.Literal("waiting"),
		Type.Literal("succeeded"),
		Type.Literal("failed"),
		Type.Literal("cancelled"),
	]),
	currentAction: Type.Optional(Type.String({ maxLength: 16 * 1024 })),
	startedAt: Type.Integer({ minimum: 0 }),
	updatedAt: Type.Integer({ minimum: 0 }),
	elapsedMs: Type.Integer({ minimum: 0 }),
	controllable: Type.Boolean(),
	session: Type.Optional(
		StrictObject({
			version: Type.Literal(1),
			sessionId: Id,
			sessionFile: Type.String({ minLength: 1, maxLength: 4096 }),
			parentSessionFile: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
			cwd: Type.String({ minLength: 1, maxLength: 4096 }),
			createdAt: Type.Integer({ minimum: 0 }),
		}),
	),
});
export type SubagentSnapshot = Static<typeof SubagentSnapshotSchema>;

export const AboutResultSchema = StrictObject({
	productName: Type.String({ minLength: 1 }),
	productVersion: Type.String({ minLength: 1 }),
	piVersion: Type.String({ minLength: 1 }),
	hostVersion: Type.String({ minLength: 1 }),
	protocolVersion: Type.Integer({ minimum: 0 }),
	releaseRepository: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
	agentDir: Type.String({ minLength: 1 }),
	sessionsDir: Type.String({ minLength: 1 }),
	configDirName: Type.String({ minLength: 1 }),
});

export const ListSkillsResultSchema = StrictObject({
	skills: Type.Array(SkillSummarySchema, { maxItems: 10_000 }),
	diagnostics: JsonValueSchema,
});
export const SetSkillEnabledResultSchema = StrictObject({
	skills: Type.Array(SkillSummarySchema, { maxItems: 10_000 }),
	diagnostics: JsonValueSchema,
	path: Type.String({ minLength: 1, maxLength: 4096 }),
	scope: Type.Union([Type.Literal("user"), Type.Literal("project")]),
	enabled: Type.Boolean(),
});
export const ListProjectInstructionsResultSchema = Type.Array(ProjectInstructionSchema, { maxItems: 32 });
export const SaveProjectInstructionResultSchema = ListProjectInstructionsResultSchema;
export const ListHostInstructionsResultSchema = Type.Array(ProjectInstructionSchema, { maxItems: 32 });
export const SaveHostInstructionResultSchema = ListHostInstructionsResultSchema;
export const UpdateStatusSchema = StrictObject({
	currentVersion: Type.String({ minLength: 1, maxLength: 4096 }),
	checkedAt: Type.Integer({ minimum: 0 }),
	repository: Type.Union([Type.String({ minLength: 1, maxLength: 4096 }), Type.Null()]),
	installEnabled: Type.Boolean(),
	installBlockedReason: Type.String({ minLength: 1, maxLength: 16 * 1024 }),
	status: Type.Union([
		Type.Literal("available"),
		Type.Literal("current"),
		Type.Literal("unavailable"),
		Type.Literal("offline"),
	]),
	latestVersion: Type.Union([Type.String({ minLength: 1, maxLength: 4096 }), Type.Null()]),
	packageName: Type.Optional(Type.Union([Type.String({ minLength: 1, maxLength: 4096 }), Type.Null()])),
	note: Type.Optional(Type.Union([Type.String({ maxLength: 16 * 1024 }), Type.Null()])),
	url: Type.Optional(Type.Union([Type.String({ minLength: 1, maxLength: 4096 }), Type.Null()])),
});
export const GetGitStatusResultSchema = GitStatusSchema;
export const GetGitDiffResultSchema = GitDiffSchema;
export const CheckForUpdatesResultSchema = UpdateStatusSchema;
export const GetCompletionsResultSchema = CompletionResultSchema;
export const ListSettingsResultSchema = Type.Array(SettingSummarySchema, { maxItems: 1000 });
export const SetSettingResultSchema = StrictObject({ setting: SettingSummarySchema, requiresRestart: Type.Boolean() });
export const ListModelsResultSchema = Type.Array(ModelSummarySchema, { maxItems: 10_000 });
export const ListModelProvidersResultSchema = Type.Array(ModelProviderSummarySchema, { maxItems: 1_000 });
export const SetSessionModelResultSchema = SessionStateSnapshotSchema;
export const SetSessionThinkingResultSchema = SessionStateSnapshotSchema;
export const CycleSessionModelResultSchema = StrictObject({
	snapshot: SessionStateSnapshotSchema,
	changed: Type.Boolean(),
	isScoped: Type.Boolean(),
});
export const CycleSessionThinkingResultSchema = StrictObject({
	snapshot: SessionStateSnapshotSchema,
	changed: Type.Boolean(),
	supported: Type.Boolean(),
});
export const ReloadResourcesResultSchema = SessionStateSnapshotSchema;
const SessionInfoCountSchema = Type.Integer({ minimum: 0 });
export const SessionInfoResultSchema = StrictObject({
	name: Type.Union([Type.String({ maxLength: 16 * 1024 }), Type.Null()]),
	sessionFile: Type.Union([Type.String({ minLength: 1, maxLength: 4096 }), Type.Null()]),
	sessionId: Id,
	messages: StrictObject({
		total: SessionInfoCountSchema,
		user: SessionInfoCountSchema,
		agent: SessionInfoCountSchema,
		toolCalls: SessionInfoCountSchema,
		toolResults: SessionInfoCountSchema,
	}),
	tokens: StrictObject({
		input: SessionInfoCountSchema,
		output: SessionInfoCountSchema,
		cacheRead: SessionInfoCountSchema,
		cacheWrite: SessionInfoCountSchema,
		total: SessionInfoCountSchema,
	}),
	cost: Type.Number({ minimum: 0 }),
	usageBreakdown: Type.Array(
		StrictObject({
			key: Type.String({ minLength: 1, maxLength: 4096 }),
			cost: Type.Number({ minimum: 0 }),
			tokens: SessionInfoCountSchema,
		}),
		{ maxItems: 10_000 },
	),
	cacheWaste: StrictObject({
		missedTokens: SessionInfoCountSchema,
		missedCost: Type.Number({ minimum: 0 }),
		missCount: SessionInfoCountSchema,
	}),
});
export type SessionInfoResult = Static<typeof SessionInfoResultSchema>;
export const ForkMessageSchema = StrictObject({
	entryId: Id,
	text: WorkspaceText,
});
export const ListForkMessagesResultSchema = Type.Array(ForkMessageSchema, { maxItems: 10_000 });
export const ForkSessionResultSchema = StrictObject({
	lease: StrictObject({
		leaseId: Id,
		leaseGeneration: Type.Integer({ minimum: 1 }),
		sessionPath: Type.String({ minLength: 1 }),
		clientInstanceId: Id,
		createdAt: Type.Integer({ minimum: 0 }),
		updatedAt: Type.Integer({ minimum: 0 }),
	}),
	snapshot: SessionStateSnapshotSchema,
	selectedText: Type.Optional(WorkspaceText),
});
export const LoginModelProviderResultSchema = ListModelsResultSchema;
export const LogoutModelProviderResultSchema = ListModelsResultSchema;
export const GetProjectTrustResultSchema = ProjectTrustSchema;
export const SetProjectTrustResultSchema = ProjectTrustSchema;
export const ListPackagesResultSchema = Type.Array(PackageSummarySchema, { maxItems: 1000 });
export const PackageMutationResultSchema = StrictObject({
	changed: Type.Boolean(),
	message: Type.String({ minLength: 1, maxLength: 16 * 1024 }),
	source: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
	scope: Type.Optional(PackageScopeSchema),
	packages: Type.Array(PackageSummarySchema, { maxItems: 1000 }),
});
export const SessionTreeResultSchema = Type.Array(SessionTreeNodeSchema, { maxItems: 10_000 });
export const SetEntryLabelResultSchema = StrictObject({ changed: Type.Boolean() });
export const NavigateSessionTreeResultSchema = StrictObject({
	editorText: Type.Optional(WorkspaceText),
	cancelled: Type.Boolean(),
	newLeafId: Type.Optional(Id),
});
export const ListSubagentsResultSchema = Type.Array(SubagentSnapshotSchema, { maxItems: 1000 });
export const ReadSubagentResultSchema = StrictObject({
	transcript: Type.Optional(SubagentSnapshotSchema),
	live: Type.Optional(SubagentSnapshotSchema),
});
export const SubagentMutationResultSchema = StrictObject({
	changed: Type.Boolean(),
	message: Type.String({ minLength: 1, maxLength: 16 * 1024 }),
});
export const ClipboardReadResultSchema = StrictObject({
	capability: Type.Boolean(),
	text: Type.Optional(WorkspaceText),
});
export const ClipboardWriteResultSchema = StrictObject({ capability: Type.Boolean(), changed: Type.Boolean() });
export const CopyLastAssistantMessageResultSchema = StrictObject({
	capability: Type.Boolean(),
	copied: Type.Boolean(),
});
export const ExportSessionResultSchema = StrictObject({
	path: Type.String({ minLength: 1, maxLength: 16 * 1024 }),
});

export const RichTextMessageTypeSchema = Type.Union([
	Type.Literal("user"),
	Type.Literal("assistant"),
	Type.Literal("custom"),
	Type.Literal("summary"),
]);
export type RichTextMessageType = Static<typeof RichTextMessageTypeSchema>;

export const RenderRichTextResultSchema = StrictObject({
	lines: Type.Array(Type.String({ maxLength: 1024 * 1024 }), { maxItems: 5000 }),
	contentHash: Id,
});
export type RenderRichTextResult = Static<typeof RenderRichTextResultSchema>;

export const ChangelogResultSchema = StrictObject({
	lines: Type.Array(Type.String({ maxLength: 1024 * 1024 }), { maxItems: 15_000 }),
	contentHash: Id,
});
export type ChangelogResult = Static<typeof ChangelogResultSchema>;

export const ReadImageContentResultSchema = StrictObject({
	contentRef: Id,
	mimeType: Type.String({ minLength: 1, maxLength: 256 }),
	byteLength: Type.Integer({ minimum: 0, maximum: 4 * 1024 * 1024 }),
	data: Type.String({ maxLength: 6 * 1024 * 1024 }),
});
export type ReadImageContentResult = Static<typeof ReadImageContentResultSchema>;

export const ReadProjectImageResultSchema = StrictObject({
	mimeType: Type.Union([
		Type.Literal("image/png"),
		Type.Literal("image/jpeg"),
		Type.Literal("image/webp"),
		Type.Literal("image/gif"),
	]),
	base64: Type.String({ maxLength: 6 * 1024 * 1024 }),
	byteLength: Type.Integer({ minimum: 0, maximum: 4 * 1024 * 1024 }),
	contentHash: Id,
});
export type ReadProjectImageResult = Static<typeof ReadProjectImageResultSchema>;

export const ClipboardImageReadResultSchema = StrictObject({
	capability: Type.Boolean(),
	available: Type.Boolean(),
	mimeType: Type.Optional(
		Type.Union([
			Type.Literal("image/png"),
			Type.Literal("image/jpeg"),
			Type.Literal("image/webp"),
			Type.Literal("image/gif"),
		]),
	),
	data: Type.Optional(Type.String({ maxLength: 6 * 1024 * 1024 })),
	byteLength: Type.Optional(Type.Integer({ minimum: 0, maximum: 4 * 1024 * 1024 })),
	contentHash: Type.Optional(Id),
});
export type ClipboardImageReadResult = Static<typeof ClipboardImageReadResultSchema>;

const ExtensionUiStatusSchema = StrictObject({
	key: Id,
	text: Type.String({ maxLength: 4096 }),
});
const ExtensionUiWidgetSchema = StrictObject({
	key: Id,
	placement: Type.Union([Type.Literal("above"), Type.Literal("below")]),
	lines: Type.Array(Type.String({ maxLength: 4096 }), { maxItems: 32 }),
});
const ExtensionWorkingIndicatorSchema = StrictObject({
	frames: Type.Array(Type.String({ maxLength: 256 }), { maxItems: 32 }),
	intervalMs: Type.Integer({ minimum: 16, maximum: 60_000 }),
});
const ExtensionUiStateSchema = StrictObject({
	revision: Type.Integer({ minimum: 0 }),
	statuses: Type.Array(ExtensionUiStatusSchema, { maxItems: 128 }),
	widgets: Type.Array(ExtensionUiWidgetSchema, { maxItems: 64 }),
	workingMessage: Type.Union([Type.String({ maxLength: 4096 }), Type.Null()]),
	workingVisible: Type.Boolean(),
	workingIndicator: ExtensionWorkingIndicatorSchema,
	hiddenThinkingLabel: Type.Union([Type.String({ maxLength: 4096 }), Type.Null()]),
	title: Type.Union([Type.String({ maxLength: 4096 }), Type.Null()]),
	terminalInputListenerCount: Type.Integer({ minimum: 0, maximum: 128 }),
});
export type ExtensionUiState = Static<typeof ExtensionUiStateSchema>;

export const ExtensionComponentPlacementSchema = Type.Union([
	Type.Literal("widget_above"),
	Type.Literal("widget_below"),
	Type.Literal("header"),
	Type.Literal("footer"),
	Type.Literal("custom_overlay"),
	Type.Literal("editor"),
]);
export type ExtensionComponentPlacement = Static<typeof ExtensionComponentPlacementSchema>;
const ExtensionComponentCursorSchema = StrictObject({
	row: Type.Integer({ minimum: 0, maximum: 500 }),
	column: Type.Integer({ minimum: 0, maximum: 10_000 }),
});
const ExtensionComponentHitRegionSchema = StrictObject({
	kind: Type.Literal("component"),
	row: Type.Integer({ minimum: 0, maximum: 500 }),
	column: Type.Integer({ minimum: 0, maximum: 10_000 }),
	width: Type.Integer({ minimum: 0, maximum: 10_000 }),
});
export const ExtensionComponentFrameSchema = StrictObject({
	componentId: Id,
	revision: Type.Integer({ minimum: 0 }),
	width: Type.Integer({ minimum: 1, maximum: 500 }),
	height: Type.Integer({ minimum: 1, maximum: 500 }),
	lines: Type.Array(Type.String({ maxLength: 512 * 1024 }), { maxItems: 500 }),
	cursor: Type.Optional(ExtensionComponentCursorSchema),
	hitRegions: Type.Array(ExtensionComponentHitRegionSchema, { maxItems: 500 }),
	desiredSize: Type.Optional(
		StrictObject({
			width: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
			height: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
		}),
	),
});
export type ExtensionComponentFrame = Static<typeof ExtensionComponentFrameSchema>;
const ExtensionComponentOverlayOptionsSchema = StrictObject({
	width: Type.Optional(Type.Union([Type.Integer({ minimum: 1, maximum: 500 }), Type.String({ maxLength: 16 })])),
	maxHeight: Type.Optional(Type.Union([Type.Integer({ minimum: 1, maximum: 500 }), Type.String({ maxLength: 16 })])),
	anchor: Type.Optional(Type.String({ maxLength: 32 })),
	row: Type.Optional(Type.Union([Type.Integer({ minimum: 0, maximum: 500 }), Type.String({ maxLength: 16 })])),
	col: Type.Optional(Type.Union([Type.Integer({ minimum: 0, maximum: 500 }), Type.String({ maxLength: 16 })])),
	overlay: Type.Optional(Type.Boolean()),
});
const ExtensionComponentUnmountReasonSchema = Type.Union([
	Type.Literal("replace"),
	Type.Literal("clear"),
	Type.Literal("dispose"),
	Type.Literal("error"),
	Type.Literal("done"),
	Type.Literal("cancel"),
]);
const ExtensionComponentResultSchema = StrictObject({
	accepted: Type.Boolean(),
	appAction: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
});
const ExtensionUiDeltaSchema = StrictObject({
	revision: Type.Integer({ minimum: 0 }),
	statuses: Type.Optional(Type.Array(ExtensionUiStatusSchema, { maxItems: 128 })),
	widgets: Type.Optional(Type.Array(ExtensionUiWidgetSchema, { maxItems: 64 })),
	workingMessage: Type.Optional(Type.Union([Type.String({ maxLength: 4096 }), Type.Null()])),
	workingVisible: Type.Optional(Type.Boolean()),
	workingIndicator: Type.Optional(ExtensionWorkingIndicatorSchema),
	hiddenThinkingLabel: Type.Optional(Type.Union([Type.String({ maxLength: 4096 }), Type.Null()])),
	title: Type.Optional(Type.Union([Type.String({ maxLength: 4096 }), Type.Null()])),
	terminalInputListenerCount: Type.Optional(Type.Integer({ minimum: 0, maximum: 128 })),
});
const ExtensionEditorActionSchema = StrictObject({
	action: Type.Union([Type.Literal("paste"), Type.Literal("set")]),
	text: Type.String({ maxLength: 64 * 1024 }),
	revision: Type.Integer({ minimum: 0 }),
});
const ExtensionEditorSubmitSchema = StrictObject({
	text: Type.String({ maxLength: 64 * 1024 }),
	revision: Type.Integer({ minimum: 0 }),
});
const ExtensionEditorAppActionSchema = StrictObject({
	action: Type.String({ minLength: 1, maxLength: 128 }),
	data: Type.Optional(Type.String({ maxLength: 256 })),
	revision: Type.Integer({ minimum: 0 }),
});
const ExtensionTerminalInputResultSchema = StrictObject({
	consume: Type.Boolean(),
	data: Type.Optional(Type.String({ maxLength: 256 })),
});
export type ExtensionTerminalInputResult = Static<typeof ExtensionTerminalInputResultSchema>;

export const WorkspaceCommandResultSchemas = {
	list_skills: ListSkillsResultSchema,
	set_skill_enabled: SetSkillEnabledResultSchema,
	list_project_instructions: ListProjectInstructionsResultSchema,
	save_project_instruction: SaveProjectInstructionResultSchema,
	list_host_instructions: ListHostInstructionsResultSchema,
	save_host_instruction: SaveHostInstructionResultSchema,
	get_git_status: GetGitStatusResultSchema,
	get_git_diff: GetGitDiffResultSchema,
	get_completions: GetCompletionsResultSchema,
	check_for_updates: CheckForUpdatesResultSchema,
	list_settings: ListSettingsResultSchema,
	set_setting: SetSettingResultSchema,
	list_models: ListModelsResultSchema,
	list_model_providers: ListModelProvidersResultSchema,
	set_session_model: SetSessionModelResultSchema,
	set_session_thinking: SetSessionThinkingResultSchema,
	cycle_session_model: CycleSessionModelResultSchema,
	cycle_session_thinking: CycleSessionThinkingResultSchema,
	reload_resources: ReloadResourcesResultSchema,
	get_session_info: SessionInfoResultSchema,
	list_fork_messages: ListForkMessagesResultSchema,
	fork_session: ForkSessionResultSchema,
	login_model_provider: LoginModelProviderResultSchema,
	logout_model_provider: LogoutModelProviderResultSchema,
	get_project_trust: GetProjectTrustResultSchema,
	set_project_trust: SetProjectTrustResultSchema,
	list_packages: ListPackagesResultSchema,
	install_package: PackageMutationResultSchema,
	remove_package: PackageMutationResultSchema,
	update_packages: PackageMutationResultSchema,
	get_session_tree: SessionTreeResultSchema,
	set_entry_label: SetEntryLabelResultSchema,
	navigate_session_tree: NavigateSessionTreeResultSchema,
	list_subagents: ListSubagentsResultSchema,
	read_subagent: ReadSubagentResultSchema,
	abort_subagent: SubagentMutationResultSchema,
	continue_subagent: SubagentMutationResultSchema,
	read_clipboard_text: ClipboardReadResultSchema,
	read_clipboard_image: ClipboardImageReadResultSchema,
	read_project_image: ReadProjectImageResultSchema,
	write_clipboard_text: ClipboardWriteResultSchema,
	copy_last_assistant_message: CopyLastAssistantMessageResultSchema,
	export_session: ExportSessionResultSchema,
	get_changelog: ChangelogResultSchema,
	render_rich_text: RenderRichTextResultSchema,
	read_image_content: ReadImageContentResultSchema,
	get_about: AboutResultSchema,
	get_diagnostics: DiagnosticsSchema,
	extension_editor_state: StrictObject({ revision: Type.Integer({ minimum: 0 }) }),
	extension_terminal_input: ExtensionTerminalInputResultSchema,
	extension_component_input: ExtensionComponentResultSchema,
	extension_component_resize: ExtensionComponentResultSchema,
	extension_component_dispose: ExtensionComponentResultSchema,
	extension_component_custom_result: ExtensionComponentResultSchema,
	extension_component_custom_cancel: ExtensionComponentResultSchema,
} as const;

export function assertWorkspaceCommandResult(
	command: keyof typeof WorkspaceCommandResultSchemas,
	value: unknown,
): void {
	if (!Check(WorkspaceCommandResultSchemas[command], value)) {
		throw Object.assign(new Error(`命令 ${command} 返回了不符合协议的结果`), { code: "invalid_command_result" });
	}
}

const ImageInputSchema = StrictObject({ data: Type.String(), mimeType: Type.String({ minLength: 1 }) });

const ExtensionInputSchema = Type.String({ minLength: 1, maxLength: 64 * 1024 });

export const CommandSchema = Type.Union([
	StrictObject({ command: Type.Literal("get_snapshot") }),
	StrictObject({
		command: Type.Literal("list_sessions"),
		cwd: Type.String({ minLength: 1 }),
		query: Type.Optional(Type.String()),
	}),
	StrictObject({
		command: Type.Literal("read_transcript"),
		sessionPath: Type.String({ minLength: 1 }),
		cursor: Type.Optional(Id),
		limit: Type.Integer({ minimum: 1, maximum: MAX_TRANSCRIPT_PAGE_SIZE }),
		context: Type.Optional(TranscriptRequestContextSchema),
	}),
	StrictObject({
		command: Type.Literal("search_transcript"),
		sessionPath: Type.String({ minLength: 1 }),
		query: Type.String({ minLength: 1 }),
		cursor: Type.Optional(Id),
		limit: Type.Integer({ minimum: 1, maximum: MAX_TRANSCRIPT_SEARCH_LIMIT }),
	}),
	StrictObject({
		command: Type.Literal("create_session"),
		cwd: Type.String({ minLength: 1 }),
		clientInstanceId: Id,
		clientRequestId: Id,
	}),
	StrictObject({
		command: Type.Literal("acquire_session"),
		sessionPath: Type.String({ minLength: 1 }),
		clientInstanceId: Id,
	}),
	StrictObject({ command: Type.Literal("inspect_session"), sessionPath: Type.String({ minLength: 1 }) }),
	StrictObject({
		command: Type.Literal("release_session"),
		sessionPath: Type.String({ minLength: 1 }),
		leaseId: Id,
	}),
	StrictObject({
		command: Type.Literal("prompt"),
		sessionPath: Type.String({ minLength: 1 }),
		leaseId: Id,
		clientInstanceId: Id,
		clientRequestId: Id,
		text: Type.String(),
		images: Type.Optional(Type.Array(ImageInputSchema)),
	}),
	StrictObject({
		command: Type.Literal("steer"),
		sessionPath: Type.String({ minLength: 1 }),
		leaseId: Id,
		clientInstanceId: Id,
		clientRequestId: Id,
		text: Type.String(),
		images: Type.Optional(Type.Array(ImageInputSchema)),
	}),
	StrictObject({
		command: Type.Literal("follow_up"),
		sessionPath: Type.String({ minLength: 1 }),
		leaseId: Id,
		clientInstanceId: Id,
		clientRequestId: Id,
		text: Type.String(),
		images: Type.Optional(Type.Array(ImageInputSchema)),
	}),
	StrictObject({
		command: Type.Literal("clear_queue"),
		sessionPath: Type.String({ minLength: 1 }),
		leaseId: Id,
		clientInstanceId: Id,
		clientRequestId: Id,
	}),
	StrictObject({
		command: Type.Literal("compact"),
		sessionPath: Type.String({ minLength: 1 }),
		leaseId: Id,
		clientInstanceId: Id,
		clientRequestId: Id,
		customInstructions: Type.Optional(Type.String({ maxLength: 64 * 1024 })),
	}),
	StrictObject({
		command: Type.Literal("export_session"),
		sessionPath: Type.String({ minLength: 1 }),
		leaseId: Id,
		clientInstanceId: Id,
		clientRequestId: Id,
		outputPath: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
	}),
	StrictObject({
		command: Type.Literal("import_session"),
		sessionPath: Type.String({ minLength: 1 }),
		leaseId: Id,
		clientInstanceId: Id,
		clientRequestId: Id,
		inputPath: Type.String({ minLength: 1, maxLength: 4096 }),
		cwdOverride: Type.Optional(Type.String({ minLength: 1, maxLength: 16 * 1024 })),
	}),
	StrictObject({
		command: Type.Literal("share_session"),
		sessionPath: Type.String({ minLength: 1 }),
		leaseId: Id,
		clientInstanceId: Id,
		clientRequestId: Id,
	}),
	StrictObject({
		command: Type.Literal("run_bash"),
		sessionPath: Type.String({ minLength: 1 }),
		leaseId: Id,
		clientInstanceId: Id,
		clientRequestId: Id,
		commandText: Type.String({ minLength: 1 }),
	}),
	StrictObject({ command: Type.Literal("abort_operation"), operationId: Id, leaseId: Id }),
	StrictObject({ command: Type.Literal("get_operation"), operationId: Id }),
	StrictObject({
		command: Type.Literal("list_operations"),
		sessionPath: Type.Optional(Type.String({ minLength: 1 })),
	}),
	StrictObject({ command: Type.Literal("list_models") }),
	StrictObject({ command: Type.Literal("list_model_providers") }),
	StrictObject({
		command: Type.Literal("add_model_provider"),
		provider: Id,
		name: Type.Optional(Type.String({ minLength: 1 })),
		baseUrl: Type.String({ minLength: 1 }),
		api: Type.String({ minLength: 1 }),
		clientInstanceId: Id,
		clientRequestId: Id,
	}),
	StrictObject({
		command: Type.Literal("add_provider_model"),
		provider: Id,
		id: Id,
		name: Type.Optional(Type.String({ minLength: 1 })),
		api: Type.Optional(Type.String({ minLength: 1 })),
		baseUrl: Type.Optional(Type.String({ minLength: 1 })),
		reasoning: Type.Boolean(),
		input: Type.Array(ModelInputSchema, { minItems: 1 }),
		contextWindow: Type.Optional(Type.Integer({ minimum: 1 })),
		maxTokens: Type.Optional(Type.Integer({ minimum: 1 })),
		clientInstanceId: Id,
		clientRequestId: Id,
	}),
	StrictObject({
		command: Type.Literal("login_model_provider"),
		provider: Id,
		authType: AuthTypeSchema,
		clientInstanceId: Id,
		clientRequestId: Id,
	}),
	StrictObject({
		command: Type.Literal("logout_model_provider"),
		provider: Id,
		clientInstanceId: Id,
		clientRequestId: Id,
	}),
	StrictObject({
		command: Type.Literal("rename_session"),
		sessionPath: Type.String({ minLength: 1 }),
		leaseId: Id,
		name: Type.String(),
		clientInstanceId: Id,
		clientRequestId: Id,
	}),
	StrictObject({
		command: Type.Literal("set_session_model"),
		sessionPath: Type.String({ minLength: 1 }),
		leaseId: Id,
		model: ModelRefSchema,
		clientInstanceId: Id,
		clientRequestId: Id,
	}),
	StrictObject({
		command: Type.Literal("set_session_thinking"),
		sessionPath: Type.String({ minLength: 1 }),
		leaseId: Id,
		level: ThinkingLevelSchema,
		clientInstanceId: Id,
		clientRequestId: Id,
	}),
	StrictObject({
		command: Type.Literal("cycle_session_model"),
		sessionPath: Type.String({ minLength: 1 }),
		leaseId: Id,
		direction: Type.Union([Type.Literal("forward"), Type.Literal("backward")]),
		clientInstanceId: Id,
		clientRequestId: Id,
	}),
	StrictObject({
		command: Type.Literal("cycle_session_thinking"),
		sessionPath: Type.String({ minLength: 1 }),
		leaseId: Id,
		clientInstanceId: Id,
		clientRequestId: Id,
	}),
	StrictObject({
		command: Type.Literal("reload_resources"),
		sessionPath: Type.String({ minLength: 1 }),
		leaseId: Id,
		clientInstanceId: Id,
		clientRequestId: Id,
	}),
	StrictObject({
		command: Type.Literal("fork_session"),
		sessionPath: Type.String({ minLength: 1 }),
		leaseId: Id,
		entryId: Id,
		position: Type.Optional(Type.Union([Type.Literal("before"), Type.Literal("at")])),
		clientInstanceId: Id,
		clientRequestId: Id,
	}),
	StrictObject({
		command: Type.Literal("delete_session"),
		cwd: Type.String({ minLength: 1 }),
		sessionPath: Type.String({ minLength: 1 }),
		clientInstanceId: Id,
		clientRequestId: Id,
	}),
	StrictObject({ command: Type.Literal("list_skills"), cwd: Type.String({ minLength: 1 }) }),
	StrictObject({
		command: Type.Literal("set_skill_enabled"),
		sessionPath: Type.Optional(Type.String({ minLength: 1 })),
		leaseId: Type.Optional(Id),
		cwd: Type.String({ minLength: 1 }),
		path: Type.String({ minLength: 1 }),
		scope: Type.Union([Type.Literal("user"), Type.Literal("project")]),
		enabled: Type.Boolean(),
		clientInstanceId: Id,
		clientRequestId: Id,
	}),
	StrictObject({ command: Type.Literal("list_project_instructions"), cwd: Type.String({ minLength: 1 }) }),
	StrictObject({
		command: Type.Literal("save_project_instruction"),
		sessionPath: Type.Optional(Type.String({ minLength: 1 })),
		leaseId: Type.Optional(Id),
		cwd: Type.String({ minLength: 1 }),
		fileName: Type.Union([Type.Literal("AGENTS.md"), Type.Literal("AGENTS.override.md")]),
		content: Type.String(),
		expectedHash: Type.Optional(Id),
		clientInstanceId: Id,
		clientRequestId: Id,
	}),
	StrictObject({ command: Type.Literal("list_host_instructions") }),
	StrictObject({
		command: Type.Literal("save_host_instruction"),
		sessionPath: Type.Optional(Type.String({ minLength: 1 })),
		leaseId: Type.Optional(Id),
		fileName: Type.Union([Type.Literal("AGENTS.md"), Type.Literal("AGENTS.override.md")]),
		content: Type.String(),
		expectedHash: Type.Optional(Id),
		clientInstanceId: Id,
		clientRequestId: Id,
	}),
	StrictObject({ command: Type.Literal("list_directories"), path: Type.Optional(Type.String({ minLength: 1 })) }),
	StrictObject({
		command: Type.Literal("get_completions"),
		cwd: Type.String({ minLength: 1 }),
		sessionPath: Type.Optional(Type.String({ minLength: 1 })),
		text: Type.String(),
		cursor: Type.Integer({ minimum: 0 }),
	}),
	StrictObject({ command: Type.Literal("get_about") }),
	StrictObject({
		command: Type.Literal("get_changelog"),
		sessionPath: Type.String({ minLength: 1 }),
		width: Type.Integer({ minimum: 1, maximum: 500 }),
	}),
	StrictObject({ command: Type.Literal("get_diagnostics"), cwd: Type.Optional(Type.String({ minLength: 1 })) }),
	StrictObject({ command: Type.Literal("get_connection_status") }),
	StrictObject({ command: Type.Literal("get_git_status"), cwd: Type.String({ minLength: 1 }) }),
	StrictObject({
		command: Type.Literal("get_git_diff"),
		cwd: Type.String({ minLength: 1 }),
		path: Type.Optional(Type.String({ minLength: 1 })),
		staged: Type.Boolean(),
	}),
	StrictObject({ command: Type.Literal("check_for_updates") }),
	StrictObject({
		command: Type.Literal("resolve_project_resource"),
		cwd: Type.String({ minLength: 1 }),
		target: Type.String({ minLength: 1 }),
		line: Type.Optional(Type.Integer({ minimum: 1 })),
		column: Type.Optional(Type.Integer({ minimum: 1 })),
	}),
	StrictObject({
		command: Type.Literal("resolve_external_resource"),
		target: Type.String({ minLength: 1 }),
		line: Type.Optional(Type.Integer({ minimum: 1 })),
		column: Type.Optional(Type.Integer({ minimum: 1 })),
	}),
	StrictObject({
		command: Type.Literal("read_project_resource"),
		cwd: Type.String({ minLength: 1 }),
		path: Type.String({ minLength: 1 }),
		offset: Type.Integer({ minimum: 0 }),
		limit: Type.Integer({ minimum: 1, maximum: 1024 * 1024 }),
	}),
	StrictObject({
		command: Type.Literal("read_external_resource"),
		path: Type.String({ minLength: 1 }),
		accessToken: Id,
		offset: Type.Integer({ minimum: 0 }),
		limit: Type.Integer({ minimum: 1, maximum: 1024 * 1024 }),
	}),
	StrictObject({
		command: Type.Literal("read_content"),
		sessionPath: Type.String({ minLength: 1 }),
		contentRef: Id,
		offset: Type.Integer({ minimum: 0 }),
		limit: Type.Integer({ minimum: 1, maximum: 1024 * 1024 }),
	}),
	StrictObject({ command: Type.Literal("list_settings"), sessionPath: Type.String({ minLength: 1 }) }),
	StrictObject({
		command: Type.Literal("set_setting"),
		sessionPath: Type.String({ minLength: 1 }),
		leaseId: Id,
		clientInstanceId: Id,
		clientRequestId: Id,
		id: Id,
		value: SettingValueSchema,
	}),
	StrictObject({ command: Type.Literal("get_project_trust"), cwd: Type.String({ minLength: 1 }) }),
	StrictObject({
		command: Type.Literal("set_project_trust"),
		sessionPath: Type.String({ minLength: 1 }),
		leaseId: Id,
		cwd: Type.String({ minLength: 1 }),
		trusted: Type.Boolean(),
		clientInstanceId: Id,
		clientRequestId: Id,
	}),
	StrictObject({ command: Type.Literal("list_packages"), cwd: Type.String({ minLength: 1 }) }),
	StrictObject({
		command: Type.Literal("install_package"),
		sessionPath: Type.Optional(Type.String({ minLength: 1 })),
		leaseId: Type.Optional(Id),
		cwd: Type.String({ minLength: 1, maxLength: 4096 }),
		source: Type.String({ minLength: 1, maxLength: 4096 }),
		scope: PackageScopeSchema,
		clientInstanceId: Id,
		clientRequestId: Id,
	}),
	StrictObject({
		command: Type.Literal("remove_package"),
		sessionPath: Type.Optional(Type.String({ minLength: 1 })),
		leaseId: Type.Optional(Id),
		cwd: Type.String({ minLength: 1, maxLength: 4096 }),
		source: Type.String({ minLength: 1, maxLength: 4096 }),
		scope: PackageScopeSchema,
		clientInstanceId: Id,
		clientRequestId: Id,
	}),
	StrictObject({
		command: Type.Literal("update_packages"),
		sessionPath: Type.Optional(Type.String({ minLength: 1 })),
		leaseId: Type.Optional(Id),
		cwd: Type.String({ minLength: 1, maxLength: 4096 }),
		source: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
		clientInstanceId: Id,
		clientRequestId: Id,
	}),
	StrictObject({ command: Type.Literal("get_session_tree"), sessionPath: Type.String({ minLength: 1 }) }),
	StrictObject({
		command: Type.Literal("get_session_info"),
		sessionPath: Type.String({ minLength: 1 }),
		leaseId: Id,
	}),
	StrictObject({
		command: Type.Literal("list_fork_messages"),
		sessionPath: Type.String({ minLength: 1 }),
		leaseId: Id,
	}),
	StrictObject({
		command: Type.Literal("set_entry_label"),
		sessionPath: Type.String({ minLength: 1 }),
		leaseId: Id,
		entryId: Id,
		label: Type.Optional(Type.String({ maxLength: 1024 })),
		clientInstanceId: Id,
		clientRequestId: Id,
	}),
	StrictObject({
		command: Type.Literal("navigate_session_tree"),
		sessionPath: Type.String({ minLength: 1 }),
		leaseId: Id,
		entryId: Id,
		summarize: Type.Optional(Type.Boolean()),
		clientInstanceId: Id,
		clientRequestId: Id,
	}),
	StrictObject({ command: Type.Literal("list_subagents"), sessionPath: Type.String({ minLength: 1 }) }),
	StrictObject({ command: Type.Literal("read_subagent"), sessionPath: Type.String({ minLength: 1 }), agentId: Id }),
	StrictObject({
		command: Type.Literal("abort_subagent"),
		sessionPath: Type.String({ minLength: 1 }),
		leaseId: Id,
		agentId: Id,
		clientInstanceId: Id,
		clientRequestId: Id,
	}),
	StrictObject({
		command: Type.Literal("continue_subagent"),
		sessionPath: Type.String({ minLength: 1 }),
		leaseId: Id,
		agentId: Id,
		text: WorkspaceText,
		clientInstanceId: Id,
		clientRequestId: Id,
	}),
	StrictObject({
		command: Type.Literal("render_rich_text"),
		text: Type.String({ maxLength: 256 * 1024 }),
		width: Type.Integer({ minimum: 1, maximum: 500 }),
		messageType: RichTextMessageTypeSchema,
		isStreaming: Type.Boolean(),
		sessionPath: Type.Optional(Type.String({ minLength: 1 })),
	}),
	StrictObject({
		command: Type.Literal("read_image_content"),
		sessionPath: Type.String({ minLength: 1 }),
		contentRef: Id,
	}),
	StrictObject({ command: Type.Literal("read_clipboard_text") }),
	StrictObject({ command: Type.Literal("read_clipboard_image") }),
	StrictObject({
		command: Type.Literal("read_project_image"),
		cwd: Type.String({ minLength: 1 }),
		path: Type.String({ minLength: 1 }),
	}),
	StrictObject({
		command: Type.Literal("write_clipboard_text"),
		text: WorkspaceText,
		clientInstanceId: Id,
		clientRequestId: Id,
	}),
	StrictObject({
		command: Type.Literal("copy_last_assistant_message"),
		sessionPath: Type.String({ minLength: 1 }),
		clientInstanceId: Id,
		clientRequestId: Id,
	}),
	StrictObject({
		command: Type.Literal("extension_editor_state"),
		sessionPath: Type.String({ minLength: 1 }),
		leaseId: Id,
		clientInstanceId: Id,
		clientRequestId: Id,
		text: Type.String({ maxLength: 4 * 1024 * 1024 }),
		cursor: Type.Integer({ minimum: 0, maximum: 4 * 1024 * 1024 }),
		revision: Type.Integer({ minimum: 0 }),
		ackRevision: Type.Optional(Type.Integer({ minimum: 0 })),
	}),
	StrictObject({
		command: Type.Literal("extension_terminal_input"),
		sessionPath: Type.String({ minLength: 1 }),
		leaseId: Id,
		clientInstanceId: Id,
		clientRequestId: Id,
		data: ExtensionInputSchema,
	}),
	StrictObject({
		command: Type.Literal("extension_component_input"),
		sessionPath: Type.String({ minLength: 1 }),
		leaseId: Id,
		clientInstanceId: Id,
		clientRequestId: Id,
		componentId: Id,
		generation: Type.Integer({ minimum: 0 }),
		data: ExtensionInputSchema,
	}),
	StrictObject({
		command: Type.Literal("extension_component_resize"),
		sessionPath: Type.String({ minLength: 1 }),
		leaseId: Id,
		clientInstanceId: Id,
		clientRequestId: Id,
		width: Type.Integer({ minimum: 1, maximum: 500 }),
		height: Type.Integer({ minimum: 1, maximum: 500 }),
	}),
	StrictObject({
		command: Type.Literal("extension_component_dispose"),
		sessionPath: Type.String({ minLength: 1 }),
		leaseId: Id,
		clientInstanceId: Id,
		clientRequestId: Id,
		componentId: Id,
		generation: Type.Integer({ minimum: 0 }),
	}),
	StrictObject({
		command: Type.Literal("extension_component_custom_result"),
		sessionPath: Type.String({ minLength: 1 }),
		leaseId: Id,
		clientInstanceId: Id,
		clientRequestId: Id,
		componentId: Id,
		generation: Type.Integer({ minimum: 0 }),
		value: Type.Optional(JsonValueSchema),
	}),
	StrictObject({
		command: Type.Literal("extension_component_custom_cancel"),
		sessionPath: Type.String({ minLength: 1 }),
		leaseId: Id,
		clientInstanceId: Id,
		clientRequestId: Id,
		componentId: Id,
		generation: Type.Integer({ minimum: 0 }),
	}),
]);
export type Command = Static<typeof CommandSchema>;

export const ClientHelloSchema = StrictObject({
	type: Type.Literal("hello"),
	version: Type.Integer({ minimum: 0 }),
	clientInstanceId: Id,
});
export const RequestEnvelopeSchema = StrictObject({ type: Type.Literal("request"), id: Id, request: CommandSchema });
export const UiResponseSchema = StrictObject({
	type: Type.Literal("ui_response"),
	id: Id,
	value: Type.Optional(JsonValueSchema),
	confirmed: Type.Optional(Type.Boolean()),
	cancelled: Type.Optional(Type.Boolean()),
});
export const ClientMessageSchema = Type.Union([ClientHelloSchema, RequestEnvelopeSchema, UiResponseSchema]);
export type ClientMessage = Static<typeof ClientMessageSchema>;

export const ProtocolErrorSchema = StrictObject({
	code: Type.String({ minLength: 1 }),
	message: Type.String(),
	retryable: Type.Optional(Type.Boolean()),
	details: Type.Optional(JsonValueSchema),
});
export type ProtocolError = Static<typeof ProtocolErrorSchema>;

export const ServerHelloSchema = StrictObject({
	type: Type.Literal("hello"),
	version: Type.Literal(GUI_PROTOCOL_VERSION),
	productVersion: Type.String({ minLength: 1 }),
	protocolVersion: Type.Literal(GUI_PROTOCOL_VERSION),
	serverInstanceId: Id,
	hostInstanceId: Id,
	hostStartedAt: Type.Integer({ minimum: 0 }),
	capabilities: Type.Array(CapabilitySchema),
});
export const ServerHelloErrorSchema = StrictObject({ type: Type.Literal("hello_error"), error: ProtocolErrorSchema });
export const ResponseEnvelopeSchema = Type.Union([
	StrictObject({ type: Type.Literal("response"), id: Id, ok: Type.Literal(true), result: JsonValueSchema }),
	StrictObject({ type: Type.Literal("response"), id: Id, ok: Type.Literal(false), error: ProtocolErrorSchema }),
]);

export const ServerEventSchema = Type.Union([
	StrictObject({ type: Type.Literal("session_snapshot"), snapshot: SessionStateSnapshotSchema }),
	StrictObject({ type: Type.Literal("session_removed"), sessionPath: Type.String({ minLength: 1 }) }),
	StrictObject({ type: Type.Literal("sessions_changed"), cwd: Type.String({ minLength: 1 }) }),
	StrictObject({ type: Type.Literal("transcript_changed"), sessionPath: Type.String({ minLength: 1 }) }),
	StrictObject({
		type: Type.Literal("session_progress"),
		sessionPath: Type.String({ minLength: 1 }),
		progress: SessionProgressSchema,
	}),
	StrictObject({
		type: Type.Literal("transcript_committed"),
		sessionPath: Type.String({ minLength: 1 }),
		transcriptGeneration: Id,
		fromRevision: Type.Integer({ minimum: 0 }),
		toRevision: Type.Integer({ minimum: 0 }),
		items: Type.Array(TranscriptItemSchema),
	}),
	StrictObject({ type: Type.Literal("operation_updated"), operation: OperationSnapshotSchema }),
	StrictObject({
		type: Type.Literal("ui_request"),
		id: Id,
		operationId: Id,
		kind: Type.String({ minLength: 1 }),
		title: Type.String(),
		payload: JsonValueSchema,
		timeoutMs: Type.Optional(Type.Integer({ minimum: 1 })),
	}),
	StrictObject({
		type: Type.Literal("extension_ui_snapshot"),
		sessionPath: Type.String({ minLength: 1 }),
		state: ExtensionUiStateSchema,
	}),
	StrictObject({
		type: Type.Literal("extension_ui_delta"),
		sessionPath: Type.String({ minLength: 1 }),
		delta: ExtensionUiDeltaSchema,
	}),
	StrictObject({
		type: Type.Literal("extension_editor_action"),
		sessionPath: Type.String({ minLength: 1 }),
		action: ExtensionEditorActionSchema,
	}),
	StrictObject({
		type: Type.Literal("extension_editor_submit"),
		sessionPath: Type.String({ minLength: 1 }),
		submit: ExtensionEditorSubmitSchema,
	}),
	StrictObject({
		type: Type.Literal("extension_editor_app_action"),
		sessionPath: Type.String({ minLength: 1 }),
		action: ExtensionEditorAppActionSchema,
	}),
	StrictObject({
		type: Type.Literal("extension_component_mount"),
		sessionPath: Type.String({ minLength: 1 }),
		componentId: Id,
		generation: Type.Integer({ minimum: 0 }),
		placement: ExtensionComponentPlacementSchema,
		visible: Type.Boolean(),
		overlayOptions: Type.Optional(ExtensionComponentOverlayOptionsSchema),
		frame: ExtensionComponentFrameSchema,
	}),
	StrictObject({
		type: Type.Literal("extension_component_frame"),
		sessionPath: Type.String({ minLength: 1 }),
		componentId: Id,
		generation: Type.Integer({ minimum: 0 }),
		frame: ExtensionComponentFrameSchema,
	}),
	StrictObject({
		type: Type.Literal("extension_component_invalidate"),
		sessionPath: Type.String({ minLength: 1 }),
		componentId: Id,
		generation: Type.Integer({ minimum: 0 }),
		visible: Type.Boolean(),
	}),
	StrictObject({
		type: Type.Literal("extension_component_unmount"),
		sessionPath: Type.String({ minLength: 1 }),
		componentId: Id,
		generation: Type.Integer({ minimum: 0 }),
		reason: ExtensionComponentUnmountReasonSchema,
	}),
]);
export type ServerEvent = Static<typeof ServerEventSchema>;
export const EventEnvelopeSchema = StrictObject({ type: Type.Literal("event"), event: ServerEventSchema });
export const ServerMessageSchema = Type.Union([
	ServerHelloSchema,
	ServerHelloErrorSchema,
	ResponseEnvelopeSchema,
	EventEnvelopeSchema,
]);
export type ServerMessage = Static<typeof ServerMessageSchema>;
export type ServerHello = Static<typeof ServerHelloSchema>;
