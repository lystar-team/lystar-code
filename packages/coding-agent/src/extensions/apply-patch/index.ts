import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { type Component, Container, Spacer, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import type { ExtensionAPI, ToolDefinition } from "../../core/extensions/types.ts";
import {
	applyEditsToNormalizedContent,
	detectLineEnding,
	type Edit,
	generateDiffString,
	normalizeToLF,
	restoreLineEndings,
	stripBom,
} from "../../core/tools/edit-diff.ts";
import { withFileMutationQueue } from "../../core/tools/file-mutation-queue.ts";
import { resolveToCwd } from "../../core/tools/path-utils.ts";
import { linkPath, shortenPath } from "../../core/tools/render-utils.ts";
import { t } from "../../locales/zh-CN.ts";
import { renderDiff } from "../../modes/interactive/components/diff.ts";
import { formatToolSummary, getToolSummary } from "../../modes/interactive/components/tool-summary.ts";
import { theme } from "../../modes/interactive/theme/theme.ts";
import { toUiGlyph, uiGlyphs } from "../../modes/interactive/ui-glyphs.ts";

const applyPatchSchema = Type.Object({
	input: Type.String({ description: "Patch text in the *** Begin Patch format." }),
});

type ApplyPatchInput = Static<typeof applyPatchSchema>;

type PatchOperation =
	| { kind: "add"; path: string; content: string }
	| { kind: "update"; path: string; edits: Edit[] }
	| { kind: "delete"; path: string };

type StagedPatchFile = {
	operation: PatchOperation;
	absolutePath: string;
	originalContent?: string;
	content?: string;
	additions: number;
	deletions: number;
	diff: string;
};

export interface ApplyPatchDetails {
	files: Array<{
		path: string;
		operation: "add" | "update" | "delete";
		additions: number;
		deletions: number;
		diff: string;
	}>;
}

type ApplyPatchFileDetails = ApplyPatchDetails["files"][number];

function formatCounts(additions: number, deletions: number): string {
	return `+${additions} -${deletions}`;
}

function operationIcon(operation: ApplyPatchFileDetails["operation"] | undefined): string {
	if (operation === "add") return "+";
	if (operation === "delete") return "-";
	return uiGlyphs.edit;
}

class ApplyPatchFileRow implements Component {
	private readonly file: Partial<ApplyPatchFileDetails> & Pick<ApplyPatchFileDetails, "path">;
	private readonly cwd: string;

	constructor(file: Partial<ApplyPatchFileDetails> & Pick<ApplyPatchFileDetails, "path">, cwd: string) {
		this.file = file;
		this.cwd = cwd;
	}

	render(width: number): string[] {
		const icon = theme.fg("accent", toUiGlyph(operationIcon(this.file.operation)));
		const counts = theme.fg("muted", formatCounts(this.file.additions ?? 0, this.file.deletions ?? 0));
		const prefix = `${icon} `;
		const suffix = `  ${counts}`;
		const pathWidth = Math.max(1, width - visibleWidth(prefix) - visibleWidth(suffix));
		const fullDisplayPath = shortenPath(this.file.path);
		const compactPath = `…/${basename(fullDisplayPath)}`;
		const displayPath = truncateToWidth(
			visibleWidth(fullDisplayPath) <= pathWidth ? fullDisplayPath : compactPath,
			pathWidth,
			"…",
		);
		const linkedPath = linkPath(theme.fg("accent", displayPath), this.file.path, this.cwd);
		return [truncateToWidth(`${prefix}${linkedPath}${suffix}`, Math.max(1, width), "")];
	}

	invalidate(): void {}
}

function getTextResult(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter((item) => item.type === "text")
		.map((item) => item.text ?? "")
		.filter(Boolean)
		.join("\n");
}

export interface ApplyPatchOperations {
	readFile: (path: string) => Promise<Buffer>;
	writeFile: (path: string, content: string) => Promise<void>;
	mkdir: (path: string) => Promise<void>;
	unlink: (path: string) => Promise<void>;
}

const defaultOperations: ApplyPatchOperations = {
	readFile,
	writeFile: (path, content) => writeFile(path, content, "utf-8"),
	mkdir: (path) => mkdir(path, { recursive: true }).then(() => {}),
	unlink,
};

function patchError(message: string): Error {
	return new Error(`Invalid apply_patch input: ${message}`);
}

function parsePath(header: string, prefix: string): string {
	const path = header.slice(prefix.length).trim();
	if (!path) throw patchError(`${prefix.trim()} requires a path.`);
	return path;
}

function parseAddFile(lines: string[], start: number, path: string): { operation: PatchOperation; next: number } {
	const content: string[] = [];
	let index = start;
	while (index < lines.length && !lines[index].startsWith("*** ")) {
		const line = lines[index];
		if (!line.startsWith("+")) throw patchError(`Add File ${path} contains a line without a + prefix.`);
		content.push(line.slice(1));
		index++;
	}
	return { operation: { kind: "add", path, content: content.join("\n") }, next: index };
}

function parseUpdateFile(lines: string[], start: number, path: string): { operation: PatchOperation; next: number } {
	const edits: Edit[] = [];
	let index = start;
	while (index < lines.length && !lines[index].startsWith("*** ")) {
		if (!lines[index].startsWith("@@")) throw patchError(`Update File ${path} must use @@ sections.`);
		index++;
		const oldText: string[] = [];
		const newText: string[] = [];
		while (index < lines.length && !lines[index].startsWith("@@") && !lines[index].startsWith("*** ")) {
			const line = lines[index];
			if (line.startsWith("\\ No newline at end of file")) {
				index++;
				continue;
			}
			if (!/^[ +-]/.test(line)) {
				throw patchError(`Update File ${path} contains a line without a space, +, or - prefix.`);
			}
			const text = line.slice(1);
			if (line[0] !== "+") oldText.push(text);
			if (line[0] !== "-") newText.push(text);
			index++;
		}
		if (oldText.length === 0) throw patchError(`Update File ${path} has a section without original text.`);
		edits.push({ oldText: oldText.join("\n"), newText: newText.join("\n") });
	}
	if (edits.length === 0) throw patchError(`Update File ${path} has no @@ sections.`);
	return { operation: { kind: "update", path, edits }, next: index };
}

export function parseApplyPatch(input: string): PatchOperation[] {
	const lines = normalizeToLF(input).split("\n");
	if (lines[0] !== "*** Begin Patch") throw patchError('expected "*** Begin Patch" as the first line.');

	const operations: PatchOperation[] = [];
	let index = 1;
	let ended = false;
	while (index < lines.length) {
		const header = lines[index];
		if (header === "*** End Patch") {
			ended = true;
			index++;
			break;
		}
		if (header.startsWith("*** Add File:")) {
			const result = parseAddFile(lines, index + 1, parsePath(header, "*** Add File:"));
			operations.push(result.operation);
			index = result.next;
			continue;
		}
		if (header.startsWith("*** Update File:")) {
			const result = parseUpdateFile(lines, index + 1, parsePath(header, "*** Update File:"));
			operations.push(result.operation);
			index = result.next;
			continue;
		}
		if (header.startsWith("*** Delete File:")) {
			operations.push({ kind: "delete", path: parsePath(header, "*** Delete File:") });
			index++;
			continue;
		}
		if (/^\*\*\* (?:Move|Rename)/.test(header)) {
			throw patchError("rename and move operations are not supported.");
		}
		throw patchError(`unrecognized patch header: ${header || "(empty line)"}.`);
	}
	if (!ended) throw patchError('missing "*** End Patch".');
	if (lines.slice(index).some((line) => line.length > 0)) throw patchError("unexpected content after *** End Patch.");
	if (operations.length === 0) throw patchError("patch contains no file operations.");
	return operations;
}

export function prepareApplyPatchArguments(args: unknown): ApplyPatchInput {
	if (typeof args === "string") return { input: args };
	if (args && typeof args === "object") {
		const input = args as Record<string, unknown>;
		if (typeof input.input === "string") return { input: input.input };
		if (typeof input.patch === "string") return { input: input.patch };
	}
	return args as ApplyPatchInput;
}

async function withMutationQueues<T>(paths: string[], fn: () => Promise<T>): Promise<T> {
	const run = async (index: number): Promise<T> => {
		if (index === paths.length) return fn();
		return withFileMutationQueue(paths[index], () => run(index + 1));
	};
	return run(0);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw new Error("Operation aborted");
}

async function stageFiles(
	operations: PatchOperation[],
	cwd: string,
	ops: ApplyPatchOperations,
	signal: AbortSignal | undefined,
): Promise<StagedPatchFile[]> {
	const staged: StagedPatchFile[] = [];
	for (const operation of operations) {
		throwIfAborted(signal);
		const absolutePath = resolveToCwd(operation.path, cwd);
		if (operation.kind === "add") {
			try {
				await ops.readFile(absolutePath);
				throw new Error(`Cannot add file ${operation.path}: it already exists.`);
			} catch (error) {
				if (error instanceof Error && !/ENOENT|ENOTDIR/.test(String((error as NodeJS.ErrnoException).code))) {
					throw error;
				}
			}
			const stats = generateDiffString("", operation.content);
			staged.push({
				operation,
				absolutePath,
				content: operation.content,
				additions: stats.additions,
				deletions: stats.deletions,
				diff: stats.diff,
			});
			continue;
		}

		const originalContent = (await ops.readFile(absolutePath)).toString("utf-8");
		if (operation.kind === "delete") {
			const { text } = stripBom(originalContent);
			const stats = generateDiffString(normalizeToLF(text), "");
			staged.push({
				operation,
				absolutePath,
				originalContent,
				additions: stats.additions,
				deletions: stats.deletions,
				diff: stats.diff,
			});
			continue;
		}

		const { bom, text } = stripBom(originalContent);
		const originalEnding = detectLineEnding(text);
		const { baseContent, newContent } = applyEditsToNormalizedContent(
			normalizeToLF(text),
			operation.edits,
			operation.path,
		);
		const stats = generateDiffString(baseContent, newContent);
		staged.push({
			operation,
			absolutePath,
			originalContent,
			content: bom + restoreLineEndings(newContent, originalEnding),
			additions: stats.additions,
			deletions: stats.deletions,
			diff: stats.diff,
		});
	}
	return staged;
}

async function rollback(staged: StagedPatchFile[], ops: ApplyPatchOperations): Promise<void> {
	for (const file of [...staged].reverse()) {
		try {
			if (file.operation.kind === "add") {
				await ops.unlink(file.absolutePath);
			} else if (file.originalContent !== undefined) {
				await ops.writeFile(file.absolutePath, file.originalContent);
			}
		} catch {}
	}
}

async function applyStagedFiles(
	staged: StagedPatchFile[],
	ops: ApplyPatchOperations,
	signal: AbortSignal | undefined,
): Promise<void> {
	const touched: StagedPatchFile[] = [];
	try {
		for (const file of staged) {
			throwIfAborted(signal);
			touched.push(file);
			if (file.operation.kind === "add") {
				await ops.mkdir(dirname(file.absolutePath));
				await ops.writeFile(file.absolutePath, file.content!);
			} else if (file.operation.kind === "delete") {
				await ops.unlink(file.absolutePath);
			} else {
				await ops.writeFile(file.absolutePath, file.content!);
			}
			throwIfAborted(signal);
		}
	} catch (error) {
		await rollback(touched, ops);
		throw new Error(
			`Could not apply patch: ${error instanceof Error ? error.message : String(error)}. Changes were rolled back.`,
		);
	}
}

export function createApplyPatchToolDefinition(options?: {
	operations?: ApplyPatchOperations;
}): ToolDefinition<typeof applyPatchSchema, ApplyPatchDetails> {
	const ops = options?.operations ?? defaultOperations;
	return {
		name: "apply_patch",
		label: "apply_patch",
		description: "Apply a patch that adds, updates, or deletes files.",
		promptSnippet: "Apply a *** Begin Patch block to add, update, or delete one or more files.",
		promptGuidelines: [
			"Use apply_patch only with the *** Begin Patch format; use edit for exact oldText/newText replacements.",
		],
		parameters: applyPatchSchema,
		prepareArguments: prepareApplyPatchArguments,
		async execute(_toolCallId, { input }, signal, _onUpdate, ctx) {
			const operations = parseApplyPatch(input);
			const files = operations
				.map((operation) => ({ operation, absolutePath: resolveToCwd(operation.path, ctx.cwd) }))
				.sort((left, right) => left.absolutePath.localeCompare(right.absolutePath));
			for (let index = 1; index < files.length; index++) {
				if (files[index - 1].absolutePath === files[index].absolutePath) {
					throw new Error(`Invalid apply_patch input: ${files[index].operation.path} is modified more than once.`);
				}
			}

			return withMutationQueues(
				files.map((file) => file.absolutePath),
				async () => {
					const staged = await stageFiles(
						files.map((file) => file.operation),
						ctx.cwd,
						ops,
						signal,
					);
					await applyStagedFiles(staged, ops, signal);
					return {
						content: [{ type: "text", text: `Applied patch to ${staged.length} file(s).` }],
						details: {
							files: staged.map((file) => ({
								path: file.operation.path,
								operation: file.operation.kind,
								additions: file.additions,
								deletions: file.deletions,
								diff: file.diff,
							})),
						},
					};
				},
			);
		},
		renderCall(_args, _theme, context) {
			const details = context.resultDetails as ApplyPatchDetails | undefined;
			const additions = details?.files.reduce((total, file) => total + file.additions, 0) ?? 0;
			const deletions = details?.files.reduce((total, file) => total + file.deletions, 0) ?? 0;
			const summary = getToolSummary(context.lastComponent);
			summary.setText(
				formatToolSummary({
					icon: uiGlyphs.edit,
					subject: details ? `${details.files.length} 个文件` : "",
					isPartial: context.isPartial,
					isError: context.isError,
					labels: {
						running: t("tool.applyPatch.running"),
						success: t("tool.applyPatch.success"),
						error: t("tool.applyPatch.error"),
					},
					detail: details ? formatCounts(additions, deletions) : undefined,
				}),
			);
			return summary;
		},
		renderResult(result, _options, theme, context) {
			const component = (context.lastComponent as Container | undefined) ?? new Container();
			component.clear();
			if (context.isError) {
				const message = getTextResult(result);
				if (message) component.addChild(new Text(theme.fg("error", message), 0, 0));
				return component;
			}

			const details = result.details as
				| { files?: Array<Partial<ApplyPatchFileDetails> & Pick<ApplyPatchFileDetails, "path">> }
				| undefined;
			for (const file of details?.files ?? []) {
				component.addChild(new ApplyPatchFileRow(file, context.cwd));
				if (context.expanded && file.diff) {
					component.addChild(new Spacer(1));
					component.addChild(new Text(renderDiff(file.diff, { filePath: file.path }), 1, 0));
				}
			}
			return component;
		},
	};
}

export default function applyPatchExtension(pi: ExtensionAPI): void {
	pi.registerTool(createApplyPatchToolDefinition());
}
