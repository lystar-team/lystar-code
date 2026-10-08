import { createHash } from "node:crypto";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { ToolExecutionError, type ToolRecoveryReplacementResult } from "@earendil-works/pi-agent-core";
import { constants } from "fs";
import { access as fsAccess, readFile as fsReadFile, writeFile as fsWriteFile } from "fs/promises";
import { type Static, Type } from "typebox";
import { splitBom } from "../../utils/text.ts";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.ts";
import { registerBuiltInRecoveryError } from "../tool-recovery/registry.ts";
import { generateDiffString, generateUnifiedPatch, normalizeToLF } from "./edit-diff.ts";
import { truncateEditEvidence } from "./edit-recovery.ts";
import { formatFileSnapshot, getFileEditState } from "./file-edit-context.ts";
import {
	type FileEditState,
	type PreparedSnapshotEdit,
	SnapshotEditError,
	type SnapshotEditIssue,
	type SnapshotRangeEdit,
} from "./file-edit-state.ts";
import { getMutationQueueKey, withFileMutationQueue } from "./file-mutation-queue.ts";
import { resolveToCwd } from "./path-utils.ts";
import { type EditRenderState, editRenderers } from "./renderers/edit.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

const rangeEditSchema = Type.Object({
	startLine: Type.Integer({ minimum: 1, description: "First source line in the read snapshot (1-based, inclusive)." }),
	endLine: Type.Integer({
		minimum: 0,
		description: "Last source line, inclusive. For insertion use endLine = startLine - 1.",
	}),
	newText: Type.String({ description: "New source text without line-number prefixes. Empty text deletes the range." }),
	index: Type.Optional(
		Type.Integer({ minimum: 0, description: "Original edit index to correct when resuming a retained plan." }),
	),
	snapshot: Type.Optional(
		Type.String({ description: "Read snapshot for this corrected item; otherwise use the call's snapshot." }),
	),
});
const editSchema = Type.Object({
	path: Type.String({ description: "Path to the file to edit (relative or absolute). Emit this argument first." }),
	snapshot: Type.Optional(
		Type.String({
			description:
				"Snapshot reference returned by read. Required for a new plan. Ranges refer to this immutable snapshot.",
		}),
	),
	edits: Type.Optional(
		Type.Array(rangeEditSchema, {
			description:
				"Disjoint ranges from read. A new plan requires at least one item. When resuming, send only corrected items with their original index; omit to revalidate the retained plan.",
		}),
	),
	plan: Type.Optional(
		Type.String({
			description:
				"Retained plan reference returned by a failed edit. Other items remain pending until the entire plan validates.",
		}),
	),
	dropIndexes: Type.Optional(
		Type.Array(Type.Integer({ minimum: 0 }), {
			description: "Original edit indexes explicitly removed from a retained plan.",
		}),
	),
});

export const editToolSystemPromptContribution = {
	snippet:
		"Edit read snapshots using explicit line ranges; retain and repair batches without repeating old source text",
	guidelines: [
		"Read the target first. Use its snapshot reference and numbered source ranges with edit; do not generate oldText.",
		"Emit path first in edit and write calls, including inside codemode, so the target is visible while arguments stream.",
		"Batch disjoint ranges from the same file. All ranges refer to their read snapshots, not to earlier items in the batch.",
		"Replace inclusive startLine/endLine ranges; newText is source text without numbered prefixes. Empty newText deletes. Insert using endLine = startLine - 1.",
		"After a rejected batch, use the returned plan and correct only failed items by index and current snapshot. Use dropIndexes to remove an unwanted pending item. No partial changes were written.",
		"Successful edits return per-item status and a current source snapshot. Repeated completed operations are verified from tool receipts; do not repeat a deletion against a new unrelated range.",
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
	plan?: string;
	snapshot?: string;
	sourceRevision?: string;
	resultRevision?: string;
	applied?: number;
	alreadyApplied?: number;
	edits?: PreparedSnapshotEdit["edits"];
	issues?: readonly SnapshotEditIssue[];
	attempt?: number;
	recoveryAllowed?: boolean;
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
	/** 单独使用 SDK 工具时可显式共用 read/edit 状态。 */
	fileEditState?: FileEditState;
}

function isRangeEdit(value: unknown): value is SnapshotRangeEdit {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const entry = value as Record<string, unknown>;
	return typeof entry.startLine === "number" && typeof entry.endLine === "number" && typeof entry.newText === "string";
}

function prepareEditArguments(input: unknown): EditToolInput {
	if (!input || typeof input !== "object" || Array.isArray(input)) return input as EditToolInput;
	const args = { ...(input as Record<string, unknown>) };
	if (typeof args.edits === "string") {
		try {
			const parsed: unknown = JSON.parse(args.edits);
			if (Array.isArray(parsed)) args.edits = parsed;
			else if (isRangeEdit(parsed)) args.edits = [parsed];
		} catch {
			// 非法 JSON 交给参数校验报告，不改写模型原始调用。
		}
	} else if (isRangeEdit(args.edits)) args.edits = [args.edits];
	return args as EditToolInput;
}

const editRecoveryHandlerSymbol = Symbol.for("pi.toolRecoveryHandler");

function hashFileContent(content: Buffer): string {
	return createHash("sha256").update(content).digest("hex");
}

function currentEditEvidence(
	state: FileEditState,
	path: string,
	rawContent: string,
	issues: readonly SnapshotEditIssue[],
): { text: string; snapshot?: string } {
	const lines = normalizeToLF(splitBom(rawContent).text).split("\n");
	const output: string[] = [];
	const visited = new Set<string>();
	let budget = 12 * 1024;
	let snapshotId: string | undefined;
	for (const issue of issues.slice(0, 6)) {
		const start = Math.max(1, Math.min(lines.length, (issue.startLine ?? 1) - 3));
		const wantedEnd = Math.min(lines.length, Math.max(start, issue.endLine ?? start) + 3);
		const end = Math.min(wantedEnd, start + 39);
		const key = `${start}:${end}`;
		if (visited.has(key)) continue;
		visited.add(key);
		const visible: string[] = [];
		let available = Math.min(budget - 200, 4096);
		for (let line = start; line <= end; line++) {
			const text = lines[line - 1];
			const bytes = Buffer.byteLength(text) + String(line).length + 3;
			if (bytes > available) break;
			visible.push(text);
			available -= bytes;
		}
		if (visible.length === 0) {
			output.push(
				`edits[${issue.editIndex}] 请用 read offset=${start} limit=${Math.max(1, wantedEnd - start + 1)} 补读目标。`,
			);
			continue;
		}
		const snapshot = state.capture(path, rawContent, start, start + visible.length - 1);
		snapshotId ??= snapshot.id;
		const text = `edits[${issue.editIndex}] 当前内容：\n${formatFileSnapshot(state, snapshot, visible)}`;
		budget -= Buffer.byteLength(text) + 2;
		output.push(text);
		if (snapshot.endLine < wantedEnd)
			output.push(`其余目标请用 read offset=${snapshot.endLine + 1} limit=${wantedEnd - snapshot.endLine} 补读。`);
		if (budget < 400) break;
	}
	return { text: output.join("\n\n"), ...(snapshotId ? { snapshot: snapshotId } : {}) };
}

function snapshotFailure(
	error: SnapshotEditError,
	path: string,
	canonicalPath: string,
	rawContent: string,
	state: FileEditState,
	durationMs: number,
): ToolExecutionError {
	const evidence = error.recoveryAllowed
		? currentEditEvidence(state, canonicalPath, rawContent, error.issues)
		: { text: "" };
	const guidance = error.recoveryAllowed
		? error.plan
			? `本批次保留为 plan=${error.plan}。只提交需要更正的 edits，并填写原 index 和当前 snapshot；其他项无需重发。可用 dropIndexes 明确移除待提交项。`
			: "请先 read 目标范围，再使用返回的 snapshot 和行范围提交。"
		: "同一文件版本的恢复预算已用完。已保留待提交计划；请停止重复提交，核对读取范围与修改目标后再提交正确参数。";
	const message = `${truncateEditEvidence(error.issues.map((issue) => `${issue.code}: ${issue.message}`).join("\n"), 2048)}\nNo changes were written.\n${guidance}${evidence.text ? `\n\n${evidence.text}` : ""}`;
	const details: EditToolDetails = {
		path,
		diff: "",
		patch: "",
		additions: 0,
		deletions: 0,
		status: "conflict",
		operation: "conflict",
		writeState: "not_written",
		...(error.plan ? { plan: error.plan } : {}),
		...(evidence.snapshot ? { snapshot: evidence.snapshot } : {}),
		issues: error.issues,
		sourceRevision: error.revision,
		attempt: error.attempt,
		recoveryAllowed: error.recoveryAllowed,
		durationMs,
	};
	const failure = new ToolExecutionError(message, {
		code: error.code,
		category:
			error.code === "SOURCE_CHANGED" || error.code === "SNAPSHOT_NOT_FOUND" || error.code === "PLAN_NOT_FOUND"
				? "stale_state"
				: error.code.endsWith("_CAPACITY")
					? "resource"
					: error.code.startsWith("INVALID_") ||
							error.code.endsWith("_REQUIRED") ||
							error.code === "DUPLICATE_INDEX"
						? "arguments"
						: "precondition",
		retryable: false,
		terminate: !error.recoveryAllowed,
		details: { ...details },
		// 数组下标、片段大小和新引用不改变同一文件实际版本的失败身份。
		fingerprintConstraint: { kind: "edit_snapshot", revision: error.revision },
	});
	registerBuiltInRecoveryError("edit", failure);
	Object.defineProperty(failure, editRecoveryHandlerSymbol, {
		value: ({ signal }: { signal?: AbortSignal }) => {
			const replacementResult: ToolRecoveryReplacementResult = {
				content: [{ type: "text", text: message }],
				...(!error.recoveryAllowed ? { terminate: true } : {}),
				details: {
					...details,
					recovery: {
						code: error.code,
						issues: error.issues,
						attempt: error.attempt,
						plan: error.plan,
						snapshotHash: error.revision,
						recoveryAllowed: error.recoveryAllowed,
					},
				},
			};
			return signal?.aborted
				? { type: "stop", reason: "cancelled" }
				: error.recoveryAllowed
					? { type: "ask_model_to_rebuild", guidance, replacementResult }
					: { type: "stop", reason: "edit recovery budget exhausted", replacementResult };
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
			"Edit a file using a snapshot returned by read and explicit inclusive line ranges. Emit path first. Do not send oldText. Use empty newText to delete; use endLine=startLine-1 to insert. All ranges are checked against their actual read snapshots before one write. Failures return a retained plan; correct only failed items by index and current snapshot, or explicitly dropIndexes. Confirmed repeated operations are reported as already_applied.",
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
			const path = input.path;
			const effectiveCwd = ctx?.cwd || cwd;
			const absolutePath = resolveToCwd(path, effectiveCwd);
			const state = getFileEditState(effectiveCwd, ctx, options?.fileEditState);
			const startedAt = performance.now();
			let rawContent = "";
			let canonicalPath = absolutePath;
			let prepared: PreparedSnapshotEdit | undefined;
			const writeOutcome: { state: "not_written" | "unknown" | "written" } = { state: "not_written" };
			try {
				return await withFileMutationQueue(absolutePath, async () => {
					const throwIfAborted = (): void => {
						if (signal?.aborted) throw new Error("Operation aborted");
					};
					// 文件操作完成前保持队列占用，取消不能提前释放写锁。
					throwIfAborted();
					await ops.access(absolutePath);
					throwIfAborted();
					canonicalPath = await getMutationQueueKey(absolutePath);
					const original = await ops.readFile(absolutePath);
					rawContent = original.toString("utf8");
					throwIfAborted();
					prepared = state.prepare(canonicalPath, rawContent, input);
					const diffResult = generateDiffString(prepared.baseContent, prepared.newContent);
					const patch = generateUnifiedPatch(path, prepared.baseContent, prepared.newContent);
					const validationMs = performance.now() - startedAt;
					const validatedDetails: EditToolDetails = {
						path,
						diff: diffResult.diff,
						patch,
						firstChangedLine: diffResult.firstChangedLine,
						additions: diffResult.additions,
						deletions: diffResult.deletions,
						status: "validated",
						operation: "edit",
						plan: prepared.plan,
						sourceRevision: prepared.sourceRevision,
						resultRevision: prepared.resultRevision,
						applied: prepared.applied,
						alreadyApplied: prepared.alreadyApplied,
						edits: prepared.edits,
						writeState: "not_written",
						validationMs,
					};
					onUpdate?.({
						content: [
							{
								type: "text",
								text: `已校验 ${prepared.edits.length} 项；待写入 ${prepared.applied} 项，已完成 ${prepared.alreadyApplied} 项。`,
							},
						],
						details: validatedDetails,
					});
					throwIfAborted();
					const writeStartedAt = performance.now();
					if (prepared.finalContent !== rawContent) {
						const current = await ops.readFile(absolutePath);
						throwIfAborted();
						if (hashFileContent(current) !== hashFileContent(original)) {
							rawContent = current.toString("utf8");
							// 重新定位只用于产生当前版本诊断，不在旧校验结果上继续写。
							state.prepare(canonicalPath, rawContent, { ...input, plan: prepared.plan, edits: undefined });
							throw new ToolExecutionError(
								"WRITE_CONFLICT: Target changed before write. No changes were written; revalidate the retained plan.",
								{
									code: "WRITE_CONFLICT",
									category: "stale_state",
									retryable: false,
									details: { path, plan: prepared.plan, writeState: "not_written" },
									fingerprintConstraint: { kind: "edit_snapshot", revision: hashFileContent(current) },
								},
							);
						}
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
									details: { path, plan: prepared.plan, writeState: "written" },
								},
							);
						}
					}
					state.commit(prepared);
					throwIfAborted();
					const writeMs = performance.now() - writeStartedAt;
					const currentLines = normalizeToLF(splitBom(prepared.finalContent).text).split("\n");
					const firstLine = Math.max(
						1,
						Math.min(currentLines.length, (diffResult.firstChangedLine ?? prepared.edits[0]?.startLine ?? 1) - 3),
					);
					const sourceLines: string[] = [];
					let sourceBudget = 4096;
					for (let line = firstLine; line <= Math.min(currentLines.length, firstLine + 23); line++) {
						const text = currentLines[line - 1];
						const bytes = Buffer.byteLength(text) + String(line).length + 3;
						if (bytes > sourceBudget) break;
						sourceLines.push(text);
						sourceBudget -= bytes;
					}
					const snapshot = sourceLines.length
						? state.capture(canonicalPath, prepared.finalContent, firstLine, firstLine + sourceLines.length - 1)
						: undefined;
					const outcome =
						prepared.finalContent === rawContent
							? `No changes needed for ${path}; ${prepared.alreadyApplied} operation(s) already applied.`
							: `Successfully edited ${path}: applied ${prepared.applied}, already applied ${prepared.alreadyApplied}.`;
					return {
						content: [
							{
								type: "text",
								text: outcome + (snapshot ? `\n\n${formatFileSnapshot(state, snapshot, sourceLines)}` : ""),
							},
						],
						details: {
							...validatedDetails,
							status: prepared.finalContent === rawContent ? "unchanged" : "written",
							...(snapshot ? { snapshot: snapshot.id } : {}),
							writeState: writeOutcome.state,
							writeMs,
							durationMs: performance.now() - startedAt,
						} as EditToolDetails,
					};
				});
			} catch (error) {
				if (writeOutcome.state === "not_written" && error instanceof SnapshotEditError) {
					throw snapshotFailure(error, path, canonicalPath, rawContent, state, performance.now() - startedAt);
				}
				const failure = normalizeEditFailure(error, path);
				if (writeOutcome.state !== "not_written") {
					throw new ToolExecutionError(
						`${failure.message}\n${writeOutcome.state === "written" ? "File was written before this error." : "Write outcome is unknown."} Read the current file before retrying.`,
						{
							code: failure.code,
							category: failure.category,
							retryable: false,
							details: {
								...failure.details,
								path,
								plan: prepared?.plan,
								writeState: writeOutcome.state,
								durationMs: performance.now() - startedAt,
							},
						},
					);
				}
				throw failure;
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
