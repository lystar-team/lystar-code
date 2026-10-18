import { createHash } from "node:crypto";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { ToolExecutionError, type ToolRecoveryReplacementResult } from "@earendil-works/pi-agent-core";
import { constants } from "fs";
import { access as fsAccess, readFile as fsReadFile, writeFile as fsWriteFile } from "fs/promises";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.ts";
import { registerBuiltInRecoveryError } from "../tool-recovery/registry.ts";
import {
	applyEditsToContent,
	type Edit,
	type EditIssue,
	EditMatchError,
	generateDiffString,
	generateUnifiedPatch,
	type TextEditResult,
} from "./edit-diff.ts";
import { createEditRecoveryEvidence, truncateEditEvidence } from "./edit-recovery.ts";
import { getMutationQueueKey, withFileMutationQueue } from "./file-mutation-queue.ts";
import { resolveToCwd } from "./path-utils.ts";
import { type EditRenderState, editRenderers } from "./renderers/edit.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

const editSchema = Type.Object(
	{
		path: Type.String({ description: "Path to the file to edit (relative or absolute). Emit this argument first." }),
		edits: Type.Array(
			Type.Object(
				{
					oldText: Type.String({
						minLength: 1,
						description:
							"Exact source text from read, including indentation and punctuation. Add unchanged context until it matches exactly once. Do not include displayed line-number prefixes.",
					}),
					newText: Type.String({
						description:
							"Replacement text. Empty text deletes oldText; retain the anchor in newText when inserting beside it.",
					}),
				},
				{ additionalProperties: false },
			),
			{
				minItems: 1,
				description:
					"Disjoint replacements, all matched against the same current file before one write. Resubmit the complete batch after correcting a failed item.",
			},
		),
	},
	{ additionalProperties: false },
);

export const editToolSystemPromptContribution = {
	snippet: "Edit files with exact source-text replacements, including multiple disjoint edits in one call",
	guidelines: [
		"Read the target first. Copy oldText exactly, including indentation and punctuation, without displayed line-number prefixes. Include only enough unchanged context to identify one occurrence.",
		"Emit path first in edit and write calls, including inside codemode, so the target is visible while arguments stream.",
		"Batch disjoint changes to the same file. Every oldText is matched against the same current file, not after earlier replacements. Merge overlapping changes into one edit.",
		"Empty newText deletes oldText. To insert, replace a unique existing anchor with that anchor plus the inserted text; oldText must not be empty.",
		"A rejected batch writes nothing. Use the returned current evidence to correct oldText or add context, then resubmit the complete edits array. Do not repeat an unchanged failed call or infer success from missing oldText.",
	],
} as const;

export type EditToolInput = Static<typeof editSchema>;

export interface EditToolDetails {
	path?: string;
	diff: string;
	patch: string;
	firstChangedLine?: number;
	additions?: number;
	deletions?: number;
	status?: "validated" | "written" | "unchanged" | "conflict";
	operation?: string;
	sourceRevision?: string;
	resultRevision?: string;
	applied?: number;
	/** 历史结果的展示字段；当前工具不根据旧文本消失推断已完成。 */
	alreadyApplied?: number;
	edits?: TextEditResult["edits"];
	issues?: readonly EditIssue[];
	issueCount?: number;
	writeState?: "not_written" | "unknown" | "written";
	validationMs?: number;
	writeMs?: number;
	durationMs?: number;
}

export interface EditOperations {
	readFile: (absolutePath: string) => Promise<Buffer>;
	writeFile: (absolutePath: string, content: string) => Promise<void>;
	access: (absolutePath: string) => Promise<void>;
}

const defaultEditOperations: EditOperations = {
	readFile: (path) => fsReadFile(path),
	writeFile: (path, content) => fsWriteFile(path, content, "utf-8"),
	access: (path) => fsAccess(path, constants.R_OK | constants.W_OK),
};

export interface EditToolOptions {
	operations?: EditOperations;
}

function isTextEdit(value: unknown): value is Edit {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const entry = value as Record<string, unknown>;
	return typeof entry.oldText === "string" && typeof entry.newText === "string";
}

function prepareEditArguments(input: unknown): EditToolInput {
	if (!input || typeof input !== "object" || Array.isArray(input)) return input as EditToolInput;
	const args = { ...(input as Record<string, unknown>) };
	if (typeof args.edits === "string") {
		try {
			const parsed: unknown = JSON.parse(args.edits);
			if (Array.isArray(parsed)) args.edits = parsed;
			else if (isTextEdit(parsed)) args.edits = [parsed];
		} catch {
			// 非法 JSON 交给参数校验报告，不改写模型原始调用。
		}
	} else if (isTextEdit(args.edits)) args.edits = [args.edits];
	return args as EditToolInput;
}

const editRecoveryHandlerSymbol = Symbol.for("pi.toolRecoveryHandler");

function hashContent(content: Buffer | string): string {
	return createHash("sha256").update(content).digest("hex");
}

function matchFailure(
	error: EditMatchError,
	path: string,
	rawContent: string,
	edits: readonly Edit[],
	durationMs: number,
): ToolExecutionError {
	const sourceRevision = hashContent(rawContent);
	const evidence = createEditRecoveryEvidence(
		rawContent.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n"),
		edits,
		error.issues,
		10 * 1024,
	);
	const guidance =
		"整批未写入。按当前证据修正 oldText，保留原始缩进和标点；有多个候选时补充上下文。随后重发完整 edits 数组，不要原样重试。";
	const message = `${error.issues[0].code}: ${truncateEditEvidence(error.message, 2048)}\n${guidance}${evidence.text ? `\n\n${evidence.text}` : ""}`;
	const details: EditToolDetails = {
		path,
		diff: "",
		patch: "",
		additions: 0,
		deletions: 0,
		status: "conflict",
		operation: "conflict",
		writeState: "not_written",
		issues: error.issues,
		issueCount: error.issueCount,
		sourceRevision,
		durationMs,
	};
	const failure = new ToolExecutionError(message, {
		code: error.issues[0].code,
		category: error.issues[0].code === "EMPTY_OLD_TEXT" ? "arguments" : "precondition",
		retryable: false,
		details: { ...details },
		fingerprintConstraint: {
			kind: "edit_content",
			revision: sourceRevision,
			edits: hashContent(JSON.stringify(edits)),
		},
	});
	registerBuiltInRecoveryError("edit", failure);
	Object.defineProperty(failure, editRecoveryHandlerSymbol, {
		value: ({ signal }: { signal?: AbortSignal }) => {
			const replacementResult: ToolRecoveryReplacementResult = {
				content: [{ type: "text", text: message }],
				details: { ...details, recovery: { code: failure.code, issues: error.issues, sourceRevision } },
			};
			return signal?.aborted
				? { type: "stop", reason: "cancelled" }
				: { type: "ask_model_to_rebuild", guidance, replacementResult };
		},
	});
	return failure;
}

function normalizeEditFailure(error: unknown, path: string): ToolExecutionError {
	if (error instanceof ToolExecutionError) return error;
	const message = error instanceof Error ? error.message : String(error);
	const errorCode = error && typeof error === "object" && "code" in error ? error.code : undefined;
	const code = /^Operation aborted/.test(message)
		? "CANCELLED"
		: errorCode === "ENOENT" || errorCode === "ENOTDIR"
			? "TARGET_NOT_FOUND"
			: errorCode === "EACCES" || errorCode === "EPERM"
				? "PERMISSION_DENIED"
				: "UNCLASSIFIED";
	return new ToolExecutionError(message, {
		code,
		category:
			code === "CANCELLED"
				? "cancelled"
				: code === "PERMISSION_DENIED"
					? "permission"
					: code === "TARGET_NOT_FOUND"
						? "precondition"
						: "unknown",
		retryable: false,
		details: { path, writeState: "not_written" },
	});
}

export function createEditToolDefinition(
	cwd: string,
	options?: EditToolOptions,
): ToolDefinition<typeof editSchema, EditToolDetails | undefined, EditRenderState> {
	const ops = options?.operations ?? defaultEditOperations;
	return {
		name: "edit",
		label: "edit",
		description:
			"Edit a file with exact oldText/newText replacements. Emit path first. Read the target and copy oldText without line-number prefixes, preserving indentation and punctuation. Include enough context to match exactly once. Empty newText deletes; retain an existing anchor to insert. All edits are checked against the same current file before one write. A failed batch writes nothing and returns current evidence; correct it and resubmit the complete batch. No snapshot or plan is required.",
		promptSnippet: editToolSystemPromptContribution.snippet,
		promptGuidelines: [...editToolSystemPromptContribution.guidelines],
		parameters: editSchema,
		getExecutionKeys: async (args, ctx) => {
			if (!args || typeof args !== "object") return [];
			const path = (args as { path?: unknown }).path;
			return typeof path === "string" ? [await getMutationQueueKey(resolveToCwd(path, ctx?.cwd || cwd))] : [];
		},
		constrainedSampling: { type: "json_schema", strict: "prefer" },
		renderShell: "self",
		prepareArguments: prepareEditArguments,
		async execute(_toolCallId, input: EditToolInput, signal?: AbortSignal, onUpdate?, ctx?: ExtensionContext) {
			if (!Value.Check(editSchema, input)) {
				throw new ToolExecutionError(
					"INVALID_ARGUMENTS: Use { path, edits: [{ oldText, newText }] }; oldText must be nonempty. Snapshot and plan fields are not supported.",
					{
						code: "INVALID_ARGUMENTS",
						category: "arguments",
						retryable: false,
						details: { writeState: "not_written" },
					},
				);
			}
			const path = input.path;
			const absolutePath = resolveToCwd(path, ctx?.cwd || cwd);
			const startedAt = performance.now();
			let rawContent = "";
			let prepared: TextEditResult | undefined;
			const writeOutcome: { state: "not_written" | "unknown" | "written" } = { state: "not_written" };
			try {
				return await withFileMutationQueue(absolutePath, async () => {
					const throwIfAborted = (): void => {
						if (signal?.aborted) throw new Error("Operation aborted");
					};
					throwIfAborted();
					await ops.access(absolutePath);
					throwIfAborted();
					let original = await ops.readFile(absolutePath);
					let revalidations = 0;
					for (;;) {
						rawContent = original.toString("utf8");
						throwIfAborted();
						prepared = applyEditsToContent(rawContent, input.edits, path);
						const diffResult = generateDiffString(prepared.baseContent, prepared.newContent);
						const patch = generateUnifiedPatch(path, prepared.baseContent, prepared.newContent);
						const validationMs = performance.now() - startedAt;
						const details: EditToolDetails = {
							path,
							...diffResult,
							patch,
							status: "validated",
							operation: "edit",
							writeState: "not_written",
							sourceRevision: hashContent(original),
							resultRevision: hashContent(prepared.finalContent),
							applied: prepared.applied,
							edits: prepared.edits,
							validationMs,
						};
						onUpdate?.({
							content: [
								{ type: "text", text: `已校验 ${input.edits.length} 项；待写入 ${prepared.applied} 项。` },
							],
							details,
						});
						throwIfAborted();
						const writeStartedAt = performance.now();
						const current = await ops.readFile(absolutePath);
						throwIfAborted();
						if (!current.equals(original)) {
							// 外部写入者不一定遵守本工具的锁；只在最新原文上重新校验一次。
							if (revalidations++ === 0) {
								original = current;
								continue;
							}
							throw new ToolExecutionError(
								"WRITE_CONFLICT: File kept changing before write. No changes were written. Read the current target and retry the complete batch.",
								{
									code: "WRITE_CONFLICT",
									category: "stale_state",
									retryable: false,
									details: { path, writeState: "not_written" },
									fingerprintConstraint: { kind: "edit_content", revision: hashContent(current) },
								},
							);
						}
						if (prepared.finalContent !== rawContent) {
							// 取消不能释放仍在执行写入的锁；写入抛错时结果可能已经落盘。
							writeOutcome.state = "unknown";
							await ops.writeFile(absolutePath, prepared.finalContent);
							writeOutcome.state = "written";
							const verified = await ops.readFile(absolutePath);
							if (verified.toString("utf8") !== prepared.finalContent) {
								throw new ToolExecutionError(
									"WRITE_VERIFICATION_FAILED: File contents did not match the completed write. Read the current file before retrying.",
									{
										code: "WRITE_VERIFICATION_FAILED",
										category: "execution",
										retryable: false,
										details: { path, writeState: "written" },
									},
								);
							}
						}
						throwIfAborted();
						const unchanged = prepared.finalContent === rawContent;
						return {
							content: [
								{
									type: "text" as const,
									text: unchanged
										? `No changes needed for ${path}.`
										: `Successfully edited ${path}: applied ${prepared.applied} replacement(s).`,
								},
							],
							details: {
								...details,
								status: unchanged ? ("unchanged" as const) : ("written" as const),
								writeState: unchanged ? ("not_written" as const) : ("written" as const),
								writeMs: performance.now() - writeStartedAt,
								durationMs: performance.now() - startedAt,
							},
						};
					}
				});
			} catch (error) {
				if (writeOutcome.state === "not_written" && error instanceof EditMatchError) {
					throw matchFailure(error, path, rawContent, input.edits, performance.now() - startedAt);
				}
				const failure = normalizeEditFailure(error, path);
				if (writeOutcome.state === "not_written") throw failure;
				throw new ToolExecutionError(
					`${failure.message}\n${writeOutcome.state === "written" ? "File was written before the failure." : "Write outcome is unknown; the file may have changed."} Read the file before retrying.`,
					{
						code: failure.code,
						category: failure.category,
						retryable: false,
						details: {
							...failure.details,
							path,
							writeState: writeOutcome.state,
							resultRevision: prepared ? hashContent(prepared.finalContent) : undefined,
							durationMs: performance.now() - startedAt,
						},
					},
				);
			}
		},
		...editRenderers,
	};
}

export function createEditTool(
	cwd: string,
	options?: EditToolOptions,
): AgentTool<typeof editSchema, EditToolDetails | undefined> {
	return wrapToolDefinition(createEditToolDefinition(cwd, options));
}
