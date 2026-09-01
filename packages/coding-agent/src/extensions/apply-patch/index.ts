import { createHash } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { ToolExecutionError, type ToolRecoveryReplacementResult } from "@earendil-works/pi-agent-core";
import { Container, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import type { ExtensionAPI, ToolDefinition } from "../../core/extensions/types.ts";
import { registerBuiltInRecoveryError } from "../../core/tool-recovery/registry.ts";
import {
	detectLineEnding,
	generateDiffString,
	normalizeForFuzzyMatch,
	normalizeToLF,
	restoreLineEndings,
	stripBom,
} from "../../core/tools/edit-diff.ts";
import { getMutationQueueKey, withFileMutationQueue } from "../../core/tools/file-mutation-queue.ts";
import { resolveToCwd } from "../../core/tools/path-utils.ts";
import { shortenPath } from "../../core/tools/render-utils.ts";
import { t } from "../../locales/zh-CN.ts";
import { renderDiff } from "../../modes/interactive/components/diff.ts";
import type { InteractiveCard, InteractiveCardAction } from "../../modes/interactive/components/interactive-card.ts";
import { renderCardHover } from "../../modes/interactive/components/tool-card-layout.ts";
import { configureToolSummary } from "../../modes/interactive/components/tool-summary.ts";
import { theme } from "../../modes/interactive/theme/theme.ts";
import { toUiGlyph, uiGlyphs } from "../../modes/interactive/ui-glyphs.ts";

const toolRecoveryHandlerSymbol = Symbol.for("pi.toolRecoveryHandler");

type ToolRecoveryHandler = (context: { signal?: AbortSignal }) => Promise<unknown> | unknown;

function attachRecoveryHandler(error: ToolExecutionError, handler: ToolRecoveryHandler): ToolExecutionError {
	registerBuiltInRecoveryError("apply_patch", error);
	Object.defineProperty(error, toolRecoveryHandlerSymbol, { value: handler });
	return error;
}

const applyPatchSchema = Type.Object({
	input: Type.String({ description: "Patch text in the *** Begin Patch format." }),
});

type ApplyPatchInput = Static<typeof applyPatchSchema>;

type PatchLine = { kind: "context" | "delete" | "add"; text: string };

type UpdateFileChunk = {
	context?: string;
	lines: PatchLine[];
	endOfFile: boolean;
};

type PatchOperation =
	| { kind: "add"; path: string; content: string }
	| { kind: "update"; path: string; chunks: UpdateFileChunk[] }
	| { kind: "delete"; path: string };

type LineReplacement = {
	chunkIndex: number;
	start: number;
	deleteCount: number;
	newLines: string[];
};

type StagedPatchFile = {
	operation: PatchOperation;
	absolutePath: string;
	originalContent?: string;
	snapshotHash?: string;
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

function renderCounts(additions: number, deletions: number): string {
	return `${theme.fg("success", `+${additions}`)} ${theme.fg("error", `-${deletions}`)}`;
}

function operationIcon(operation: ApplyPatchFileDetails["operation"] | undefined): string {
	if (operation === "add") return "+";
	if (operation === "delete") return "-";
	return uiGlyphs.edit;
}

class ApplyPatchFileCard implements InteractiveCard {
	private file: Partial<ApplyPatchFileDetails> & Pick<ApplyPatchFileDetails, "path">;
	private readonly stateKey: string;
	private expanded = false;
	private hovered = false;
	private lastRenderedLineCount = 0;
	private renderVersion = 0;
	private diffComponent?: Text;
	private diffSource?: string;
	private diffFilePath?: string;

	constructor(file: Partial<ApplyPatchFileDetails> & Pick<ApplyPatchFileDetails, "path">, toolCallId: string) {
		this.file = file;
		this.stateKey = `apply-patch-file:${toolCallId}:${file.path}`;
	}

	update(file: Partial<ApplyPatchFileDetails> & Pick<ApplyPatchFileDetails, "path">): void {
		if (this.file.diff !== file.diff || this.file.path !== file.path) {
			this.diffComponent = undefined;
			this.diffSource = undefined;
			this.diffFilePath = undefined;
		}
		this.file = file;
	}

	isExpanded(): boolean {
		return this.expanded;
	}

	setExpanded(expanded: boolean): void {
		const nextExpanded = Boolean(this.file.diff) && expanded;
		if (this.expanded === nextExpanded) return;
		this.expanded = nextExpanded;
		this.renderVersion++;
	}

	setHovered(hovered: boolean): void {
		if (this.hovered === hovered) return;
		this.hovered = hovered;
		this.renderVersion++;
	}

	getRenderVersion(): number {
		return this.renderVersion;
	}

	getCardStateKey(): string {
		return this.stateKey;
	}

	getCardClickActionAtRow(row: number): InteractiveCardAction | undefined {
		return this.file.diff && row >= 0 && row < this.lastRenderedLineCount
			? { type: "toggle", component: this }
			: undefined;
	}

	render(width: number): string[] {
		const icon = theme.fg("accent", toUiGlyph(operationIcon(this.file.operation)));
		const counts = renderCounts(this.file.additions ?? 0, this.file.deletions ?? 0);
		const indicator = this.file.diff ? theme.fg("dim", this.expanded ? uiGlyphs.expanded : uiGlyphs.collapsed) : "";
		const prefix = `${icon} `;
		const suffix = `  ${counts}${indicator ? `  ${indicator}` : ""}`;
		const pathWidth = Math.max(1, width - visibleWidth(prefix) - visibleWidth(suffix));
		const fullDisplayPath = shortenPath(this.file.path);
		const compactPath = `…/${basename(fullDisplayPath)}`;
		const displayPath = truncateToWidth(
			visibleWidth(fullDisplayPath) <= pathWidth ? fullDisplayPath : compactPath,
			pathWidth,
			"…",
		);
		const header = truncateToWidth(`${prefix}${theme.fg("accent", displayPath)}${suffix}`, Math.max(1, width), "");
		const lines = [renderCardHover([header], width, this.hovered)[0] ?? header];
		if (this.expanded && this.file.diff) {
			if (!this.diffComponent || this.diffSource !== this.file.diff || this.diffFilePath !== this.file.path) {
				this.diffSource = this.file.diff;
				this.diffFilePath = this.file.path;
				this.diffComponent = new Text(renderDiff(this.file.diff, { filePath: this.file.path }), 1, 0);
			}
			lines.push("");
			lines.push(...this.diffComponent.render(width));
		}
		this.lastRenderedLineCount = lines.length;
		return lines;
	}

	invalidate(): void {
		this.diffComponent = undefined;
		this.diffSource = undefined;
		this.diffFilePath = undefined;
	}
}

interface ApplyPatchFileRange {
	component: ApplyPatchFileCard;
	start: number;
	end: number;
}

class ApplyPatchResultComponent implements InteractiveCard {
	private readonly toolCallId: string;
	private readonly cards = new Map<string, ApplyPatchFileCard>();
	private orderedCards: ApplyPatchFileCard[] = [];
	private ranges: ApplyPatchFileRange[] = [];
	private visible = false;

	constructor(toolCallId: string) {
		this.toolCallId = toolCallId;
	}

	update(files: Array<Partial<ApplyPatchFileDetails> & Pick<ApplyPatchFileDetails, "path">>, visible: boolean): void {
		const nextCards = new Map<string, ApplyPatchFileCard>();
		this.orderedCards = files.map((file) => {
			const card = this.cards.get(file.path) ?? new ApplyPatchFileCard(file, this.toolCallId);
			card.update(file);
			nextCards.set(file.path, card);
			return card;
		});
		this.cards.clear();
		for (const [path, card] of nextCards) this.cards.set(path, card);
		this.visible = visible;
	}

	isExpanded(): boolean {
		return this.orderedCards.length > 0 && this.orderedCards.every((card) => card.isExpanded());
	}

	setExpanded(expanded: boolean): void {
		for (const card of this.orderedCards) card.setExpanded(expanded);
	}

	getCardStateKey(): string {
		return `apply-patch-result:${this.toolCallId}`;
	}

	getChildCards(): readonly InteractiveCard[] {
		return this.orderedCards;
	}

	getRenderVersion(): number {
		return this.orderedCards.reduce((version, card) => version + card.getRenderVersion(), 0);
	}

	getCardClickActionAtRow(row: number): InteractiveCardAction | undefined {
		const range = this.ranges.find((item) => row >= item.start && row < item.end);
		return range?.component.getCardClickActionAtRow(row - range.start);
	}

	render(width: number): string[] {
		const lines: string[] = [];
		this.ranges = [];
		if (!this.visible) return lines;
		for (const card of this.orderedCards) {
			const start = lines.length;
			lines.push(...card.render(width));
			this.ranges.push({ component: card, start, end: lines.length });
		}
		return lines;
	}

	invalidate(): void {
		for (const card of this.orderedCards) card.invalidate();
	}
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

function contentHash(content: string | Buffer): string {
	return createHash("sha256").update(content).digest("hex");
}

function hunkFingerprintConstraint(chunk: UpdateFileChunk): Record<string, string | undefined> {
	const context = chunk.lines.filter((line) => line.kind === "context").map((line) => line.text);
	const oldLines = chunk.lines.filter((line) => line.kind !== "add").map((line) => line.text);
	const newLines = chunk.lines.filter((line) => line.kind !== "delete").map((line) => line.text);
	return {
		headerHash: chunk.context ? contentHash(chunk.context) : undefined,
		contextHash: context.length > 0 ? contentHash(context.join("\n")) : undefined,
		oldHash: contentHash(oldLines.join("\n")),
		newHash: contentHash(newLines.join("\n")),
	};
}

function noChangePatchError(path: string, chunk: UpdateFileChunk, chunkIndex: number): ToolExecutionError {
	return patchExecutionError(
		"PATCH_NO_CHANGE",
		`Could not apply patch to ${path}: hunk ${chunkIndex + 1} does not change the file.\nNo changes were written. Re-read the target region and confirm whether the change already exists.`,
		{ targetPath: path, fingerprintConstraint: hunkFingerprintConstraint(chunk) },
	);
}

type PatchFailureOptions = {
	details?: Record<string, unknown>;
	fingerprintConstraint?: unknown;
	targetPath?: string;
};

function patchExecutionError(
	code:
		| "PATCH_PARSE_ERROR"
		| "PATCH_TARGET_NOT_FOUND"
		| "PATCH_MATCH_NOT_FOUND"
		| "PATCH_MATCH_AMBIGUOUS"
		| "PATCH_NO_CHANGE"
		| "PATCH_WRITE_CONFLICT"
		| "PATCH_WRITE_FAILED"
		| "PATCH_ROLLBACK_FAILED",
	message: string,
	options: PatchFailureOptions = {},
): ToolExecutionError {
	return new ToolExecutionError(message, {
		code,
		category:
			code === "PATCH_PARSE_ERROR"
				? "arguments"
				: code === "PATCH_WRITE_CONFLICT"
					? "stale_state"
					: code === "PATCH_WRITE_FAILED" || code === "PATCH_ROLLBACK_FAILED"
						? "execution"
						: "precondition",
		retryable: false,
		details: options.details,
		fingerprintConstraint: options.fingerprintConstraint,
		failureTargetHash: options.targetPath ? contentHash(options.targetPath) : undefined,
	});
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
	const chunks: UpdateFileChunk[] = [];
	let index = start;
	while (index < lines.length && !lines[index].startsWith("*** ")) {
		if (!lines[index].startsWith("@@")) throw patchError(`Update File ${path} must use @@ sections.`);
		const context = lines[index] === "@@" ? undefined : lines[index].slice(2).trim() || undefined;
		index++;
		const chunkLines: PatchLine[] = [];
		let endOfFile = false;
		while (index < lines.length && !lines[index].startsWith("@@") && !lines[index].startsWith("*** ")) {
			const line = lines[index];
			if (line.startsWith("\\ No newline at end of file")) {
				index++;
				continue;
			}
			if (!/^[ +-]/.test(line)) {
				throw patchError(`Update File ${path} contains a line without a space, +, or - prefix.`);
			}
			chunkLines.push({
				kind: line[0] === " " ? "context" : line[0] === "+" ? "add" : "delete",
				text: line.slice(1),
			});
			index++;
		}
		if (lines[index] === "*** End of File") {
			endOfFile = true;
			index++;
			while (lines[index] === "") index++;
		}
		if (chunkLines.length === 0 && !context) throw patchError(`Update File ${path} has an empty @@ section.`);
		chunks.push({ context, lines: chunkLines, endOfFile });
	}
	if (chunks.length === 0) throw patchError(`Update File ${path} has no @@ sections.`);
	return { operation: { kind: "update", path, chunks }, next: index };
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

type PatchMatchTier = "exact" | "trailing" | "trimmed" | "unicode";

function normalizePatchLine(line: string, tier: PatchMatchTier): string {
	if (tier === "exact") return line;
	if (tier === "trailing") return line.trimEnd();
	if (tier === "trimmed") return line.trim();
	return normalizeForFuzzyMatch(line).trim();
}

function findSequenceCandidates(
	lines: string[],
	pattern: string[],
	start: number,
	tier: PatchMatchTier,
	endOfFile: boolean,
): number[] {
	if (pattern.length === 0 || pattern.length > lines.length) return [];
	const lastStart = lines.length - pattern.length;
	const first = endOfFile ? lastStart : start;
	const last = endOfFile ? lastStart : lastStart;
	if (first < start || first < 0) return [];
	const matches: number[] = [];
	for (let index = first; index <= last; index++) {
		let matched = true;
		for (let patternIndex = 0; patternIndex < pattern.length; patternIndex++) {
			if (
				normalizePatchLine(lines[index + patternIndex], tier) !== normalizePatchLine(pattern[patternIndex], tier)
			) {
				matched = false;
				break;
			}
		}
		if (matched) matches.push(index);
	}
	return matches;
}

function findUniqueSequence(
	lines: string[],
	pattern: string[],
	start: number,
	path: string,
	label: string,
	endOfFile = false,
): number {
	for (const tier of ["exact", "trailing", "trimmed", "unicode"] as const) {
		const matches = findSequenceCandidates(lines, pattern, start, tier, endOfFile);
		if (matches.length === 1) return matches[0];
		if (matches.length > 1) {
			const displayedLines = matches.slice(0, 5).map((line) => line + 1);
			const remaining = matches.length - displayedLines.length;
			throw patchExecutionError(
				"PATCH_MATCH_AMBIGUOUS",
				`Could not apply patch to ${path}: ${label} matched ${matches.length} locations at lines ${displayedLines.join(", ")}${remaining > 0 ? ` +${remaining} more` : ""}.\nAdd stable context or an @@ function/class header, then retry.\nNo changes were written.`,
				{
					details: {
						candidateLines: displayedLines,
						candidateCount: matches.length,
						constraintHash: contentHash(pattern.join("\n")),
					},
					fingerprintConstraint: { constraintHash: contentHash(pattern.join("\n")) },
					targetPath: path,
				},
			);
		}
	}
	throw patchExecutionError(
		"PATCH_MATCH_NOT_FOUND",
		`Could not apply patch to ${path}: ${label} was not found starting at line ${start + 1}. Tried exact matching, whitespace-tolerant matching, and Unicode punctuation normalization.\nNo changes were written.`,
		{
			details: { startLine: start + 1, constraintHash: contentHash(pattern.join("\n")) },
			fingerprintConstraint: { constraintHash: contentHash(pattern.join("\n")) },
			targetPath: path,
		},
	);
}

function appendChunkReplacements(
	replacements: LineReplacement[],
	chunk: UpdateFileChunk,
	chunkIndex: number,
	matchStart: number,
): void {
	let sourceLine = matchStart;
	let pending: LineReplacement | undefined;
	const flush = (): void => {
		if (pending) replacements.push(pending);
		pending = undefined;
	};

	for (const line of chunk.lines) {
		if (line.kind === "context") {
			flush();
			sourceLine++;
			continue;
		}
		pending ??= { chunkIndex, start: sourceLine, deleteCount: 0, newLines: [] };
		if (line.kind === "delete") {
			pending.deleteCount++;
			sourceLine++;
		} else {
			pending.newLines.push(line.text);
		}
	}
	flush();
}

function chunkChangesContent(originalLines: string[], replacements: LineReplacement[], start: number): boolean {
	const chunkReplacements = replacements.slice(start);
	return chunkReplacements.some((replacement) => {
		const original = originalLines.slice(replacement.start, replacement.start + replacement.deleteCount);
		return (
			original.length !== replacement.newLines.length ||
			original.some((line, index) => line !== replacement.newLines[index])
		);
	});
}

function deriveUpdatedContent(content: string, chunks: UpdateFileChunk[], path: string): string {
	const hasFinalNewline = content.endsWith("\n");
	const originalLines = content.length === 0 ? [] : content.split("\n");
	if (hasFinalNewline) originalLines.pop();
	const replacements: LineReplacement[] = [];
	let lineIndex = 0;

	for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
		const chunk = chunks[chunkIndex];
		if (chunk.lines.length === 0 && chunk.context) {
			lineIndex =
				findUniqueSequence(originalLines, [chunk.context], lineIndex, path, `hunk ${chunkIndex + 1} context`) + 1;
			continue;
		}
		const oldChunkLines = chunk.lines.filter((line) => line.kind !== "add").map((line) => line.text);
		const newChunkLines = chunk.lines.filter((line) => line.kind !== "delete").map((line) => line.text);
		if (
			oldChunkLines.length === newChunkLines.length &&
			oldChunkLines.every((line, index) => line === newChunkLines[index])
		) {
			throw noChangePatchError(path, chunk, chunkIndex);
		}
		if (chunk.context) {
			lineIndex =
				findUniqueSequence(originalLines, [chunk.context], lineIndex, path, `hunk ${chunkIndex + 1} context`) + 1;
		}

		const oldLines = oldChunkLines;
		if (oldLines.length === 0) {
			if (!chunk.context && !chunk.endOfFile) {
				throw new Error(
					`Could not apply patch to ${path}: hunk ${chunkIndex + 1} only adds lines but has no @@ context or *** End of File marker.\nNo changes were written.`,
				);
			}
			const insertionLine = chunk.endOfFile ? originalLines.length : lineIndex;
			const replacementStart = replacements.length;
			appendChunkReplacements(replacements, chunk, chunkIndex, insertionLine);
			if (!chunkChangesContent(originalLines, replacements, replacementStart)) {
				throw noChangePatchError(path, chunk, chunkIndex);
			}
			lineIndex = insertionLine;
			continue;
		}

		const matchStart = findUniqueSequence(
			originalLines,
			oldLines,
			lineIndex,
			path,
			`hunk ${chunkIndex + 1}`,
			chunk.endOfFile,
		);
		const replacementStart = replacements.length;
		appendChunkReplacements(replacements, chunk, chunkIndex, matchStart);
		if (!chunkChangesContent(originalLines, replacements, replacementStart)) {
			throw noChangePatchError(path, chunk, chunkIndex);
		}
		lineIndex = matchStart + oldLines.length;
	}

	const ordered = [...replacements].sort(
		(left, right) => left.start - right.start || left.chunkIndex - right.chunkIndex,
	);
	for (let index = 1; index < ordered.length; index++) {
		const previous = ordered[index - 1];
		const current = ordered[index];
		if (
			previous.start + previous.deleteCount > current.start ||
			(previous.start === current.start && (previous.deleteCount === 0 || current.deleteCount === 0))
		) {
			throw new Error(
				`Could not apply patch to ${path}: hunks ${previous.chunkIndex + 1} and ${current.chunkIndex + 1} overlap.\nMerge the nearby changes into one hunk.\nNo changes were written.`,
			);
		}
	}

	const newLines = [...originalLines];
	for (let index = ordered.length - 1; index >= 0; index--) {
		const replacement = ordered[index];
		newLines.splice(replacement.start, replacement.deleteCount, ...replacement.newLines);
	}
	const newContent = newLines.length === 0 ? "" : newLines.join("\n") + (hasFinalNewline ? "\n" : "");
	if (newContent === content) {
		throw patchExecutionError(
			"PATCH_NO_CHANGE",
			`Could not apply patch to ${path}: the update produced identical content.\nNo changes were written. Re-read the target region and confirm whether the change already exists.`,
			{
				targetPath: path,
				fingerprintConstraint: { hunks: chunks.map(hunkFingerprintConstraint) },
			},
		);
	}
	return newContent;
}

function isMissingPathError(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOTDIR")
	);
}

type VerifiedPatchSnapshot = {
	absolutePath: string;
	kind: "content" | "missing";
	hash?: string;
};

function findUniquePatchSequence(
	lines: string[],
	pattern: string[],
	start: number,
	endOfFile: boolean,
): number | undefined {
	for (const tier of ["exact", "trailing", "trimmed", "unicode"] as const) {
		const matches = findSequenceCandidates(lines, pattern, start, tier, endOfFile);
		if (matches.length === 1) return matches[0];
		if (matches.length > 1) return undefined;
	}
	return undefined;
}

function verifiesUpdatePostImage(lines: string[], chunks: UpdateFileChunk[]): boolean {
	let nextStart = 0;
	for (const chunk of chunks) {
		let searchStart = nextStart;
		if (chunk.context) {
			const headerStart = findUniquePatchSequence(lines, [chunk.context], searchStart, false);
			if (headerStart === undefined) return false;
			searchStart = headerStart + 1;
		}
		const postLines = chunk.lines.filter((line) => line.kind !== "delete").map((line) => line.text);
		if (postLines.length === 0) return false;
		const postStart = findUniquePatchSequence(lines, postLines, searchStart, chunk.endOfFile);
		if (postStart === undefined || postStart < searchStart) return false;
		nextStart = postStart + postLines.length;
	}
	return true;
}

async function verifyPatchPostconditions(
	operations: PatchOperation[],
	cwd: string,
	ops: ApplyPatchOperations,
	signal: AbortSignal | undefined,
): Promise<{ verifiedFiles: number; evidence: string } | undefined> {
	const files = operations
		.map((operation) => ({ operation, absolutePath: resolveToCwd(operation.path, cwd) }))
		.sort((left, right) => left.absolutePath.localeCompare(right.absolutePath));
	const evidence: string[] = [];
	return await withMutationQueues(
		files.map((file) => file.absolutePath),
		async () => {
			const snapshots: VerifiedPatchSnapshot[] = [];
			for (const file of files) {
				throwIfAborted(signal);
				if (file.operation.kind === "delete") {
					try {
						await ops.readFile(file.absolutePath);
						return undefined;
					} catch (error) {
						if (!isMissingPathError(error)) return undefined;
						snapshots.push({ absolutePath: file.absolutePath, kind: "missing" });
						evidence.push(`${file.operation.path}: 已不存在`);
						continue;
					}
				}
				let content: string;
				try {
					content = (await ops.readFile(file.absolutePath)).toString("utf-8");
				} catch {
					return undefined;
				}
				if (file.operation.kind === "add") {
					if (content !== file.operation.content) return undefined;
					snapshots.push({ absolutePath: file.absolutePath, kind: "content", hash: contentHash(content) });
					evidence.push(`${file.operation.path}: 内容摘要 ${contentHash(content)}`);
					continue;
				}
				const lines = normalizeToLF(stripBom(content).text).split("\n");
				if (lines.at(-1) === "") lines.pop();
				if (!verifiesUpdatePostImage(lines, file.operation.chunks)) return undefined;
				snapshots.push({ absolutePath: file.absolutePath, kind: "content", hash: contentHash(content) });
				evidence.push(`${file.operation.path}: 所有 hunk 后置条件成立`);
			}

			for (const snapshot of snapshots) {
				throwIfAborted(signal);
				try {
					const current = await ops.readFile(snapshot.absolutePath);
					if (snapshot.kind !== "content" || contentHash(current) !== snapshot.hash) return undefined;
				} catch (error) {
					if (snapshot.kind !== "missing" || !isMissingPathError(error)) return undefined;
				}
			}
			return { verifiedFiles: files.length, evidence: evidence.join("\n") };
		},
	);
}

function getRecoveryTarget(operations: PatchOperation[], error: Error): PatchOperation | undefined {
	return operations.find((operation) => error.message.includes(operation.path)) ?? operations[0];
}

async function readPatchRecoveryEvidence(
	operations: PatchOperation[],
	cwd: string,
	ops: ApplyPatchOperations,
	error: Error,
	signal: AbortSignal | undefined,
): Promise<string> {
	const target = getRecoveryTarget(operations, error);
	if (!target || target.kind === "delete") return "未能读取可重建的目标区域。";
	const absolutePath = resolveToCwd(target.path, cwd);
	return await withFileMutationQueue(absolutePath, async () => {
		throwIfAborted(signal);
		try {
			const lines = normalizeToLF(stripBom((await ops.readFile(absolutePath)).toString("utf-8")).text).split("\n");
			const candidates =
				error instanceof ToolExecutionError && Array.isArray(error.details?.candidateLines)
					? error.details.candidateLines.filter((line): line is number => typeof line === "number")
					: [];
			const start = Math.max(0, (candidates[0] ?? 1) - 1 - 25);
			const excerpt = lines.slice(start, start + 200);
			return `最新 ${target.path} 第 ${start + 1}-${start + excerpt.length} 行：\n${excerpt
				.map((line, index) => `${start + index + 1}: ${line}`)
				.join("\n")}`;
		} catch (readError) {
			return `无法刷新 ${target.path}：${readError instanceof Error ? readError.message : String(readError)}`;
		}
	});
}

function normalizePatchFailure(error: unknown): ToolExecutionError {
	if (error instanceof ToolExecutionError) return error;
	const message = error instanceof Error ? error.message : String(error);
	if (message.startsWith("Invalid apply_patch input:")) return patchExecutionError("PATCH_PARSE_ERROR", message);
	if (/does not change the file|produced identical content/.test(message))
		return patchExecutionError("PATCH_NO_CHANGE", message);
	if (/matched \d+ locations/.test(message)) return patchExecutionError("PATCH_MATCH_AMBIGUOUS", message);
	if (/was not found starting at line/.test(message)) return patchExecutionError("PATCH_MATCH_NOT_FOUND", message);
	if (/ENOENT|ENOTDIR/.test(message)) return patchExecutionError("PATCH_TARGET_NOT_FOUND", message);
	return patchExecutionError("PATCH_WRITE_FAILED", message);
}

function attachApplyPatchRecovery(
	error: ToolExecutionError,
	operations: PatchOperation[],
	cwd: string,
	ops: ApplyPatchOperations,
): ToolExecutionError {
	return attachRecoveryHandler(error, async ({ signal }) => {
		if (signal?.aborted) return { type: "stop", reason: "cancelled" };
		if (error.code === "PATCH_NO_CHANGE") {
			const verified = await verifyPatchPostconditions(operations, cwd, ops, signal);
			if (verified) {
				const replacementResult: ToolRecoveryReplacementResult = {
					content: [
						{
							type: "text",
							text: `补丁目标状态已经存在，无需再次写入。\n已验证 ${verified.verifiedFiles} 个文件，原失败：PATCH_NO_CHANGE。`,
						},
					],
					details: { files: [], recovery: { verifiedFiles: verified.verifiedFiles, outcome: "already_applied" } },
				};
				return { type: "accept_as_success", verification: verified.evidence, replacementResult };
			}
		}
		if (
			error.code === "PATCH_MATCH_NOT_FOUND" ||
			error.code === "PATCH_MATCH_AMBIGUOUS" ||
			error.code === "PATCH_NO_CHANGE"
		) {
			const evidence = await readPatchRecoveryEvidence(operations, cwd, ops, error, signal);
			const replacementResult: ToolRecoveryReplacementResult = {
				content: [{ type: "text", text: `${error.message}\n\n${evidence}\n请基于最新内容重建 patch。` }],
				details: {
					files: [],
					recovery: { code: error.code, evidenceLines: Math.min(200, evidence.split("\n").length) },
				},
			};
			return { type: "ask_model_to_rebuild", guidance: "请基于最新内容重建 patch。", replacementResult };
		}
		if (error.code === "PATCH_ROLLBACK_FAILED") {
			return { type: "require_user", reason: "补丁写入后的回滚失败，需人工检查已触碰文件。" };
		}
		return undefined;
	});
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
		const snapshotHash = contentHash(originalContent);
		if (operation.kind === "delete") {
			const { text } = stripBom(originalContent);
			const stats = generateDiffString(normalizeToLF(text), "");
			staged.push({
				operation,
				absolutePath,
				originalContent,
				snapshotHash,
				additions: stats.additions,
				deletions: stats.deletions,
				diff: stats.diff,
			});
			continue;
		}

		const { bom, text } = stripBom(originalContent);
		const originalEnding = detectLineEnding(text);
		const baseContent = normalizeToLF(text);
		const newContent = deriveUpdatedContent(baseContent, operation.chunks, operation.path);
		const stats = generateDiffString(baseContent, newContent);
		staged.push({
			operation,
			absolutePath,
			originalContent,
			snapshotHash,
			content: bom + restoreLineEndings(newContent, originalEnding),
			additions: stats.additions,
			deletions: stats.deletions,
			diff: stats.diff,
		});
	}
	return staged;
}

type RollbackStatus = {
	path: string;
	operation: PatchOperation["kind"];
	status: "restored" | "removed" | "failed";
};

async function rollback(staged: StagedPatchFile[], ops: ApplyPatchOperations): Promise<RollbackStatus[]> {
	const statuses: RollbackStatus[] = [];
	for (const file of [...staged].reverse()) {
		const status: RollbackStatus = {
			path: file.operation.path,
			operation: file.operation.kind,
			status: file.operation.kind === "add" ? "removed" : "restored",
		};
		try {
			if (file.operation.kind === "add") {
				await ops.unlink(file.absolutePath);
			} else if (file.originalContent !== undefined) {
				await ops.writeFile(file.absolutePath, file.originalContent);
			}
		} catch {
			status.status = "failed";
		}
		statuses.push(status);
	}
	return statuses;
}

async function assertSnapshot(file: StagedPatchFile, ops: ApplyPatchOperations): Promise<void> {
	try {
		const current = await ops.readFile(file.absolutePath);
		if (file.operation.kind === "add" || contentHash(current) !== file.snapshotHash) {
			throw patchExecutionError("PATCH_WRITE_CONFLICT", "Could not apply patch: target changed before write.", {
				details: { operation: file.operation.kind },
				targetPath: file.operation.path,
			});
		}
	} catch (error) {
		if (file.operation.kind === "add" && isMissingPathError(error)) return;
		throw error;
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
			await assertSnapshot(file, ops);
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
		const rollbackStatuses = await rollback(touched, ops);
		const rollbackFailed = rollbackStatuses.some((status) => status.status === "failed");
		if (rollbackFailed) {
			const statusText = rollbackStatuses
				.map((status) =>
					status.status === "failed"
						? `- ${status.path}: 回滚失败，必须人工检查。`
						: `- ${status.path}: 已${status.status === "removed" ? "移除新增文件" : "恢复原内容"}。`,
				)
				.join("\n");
			throw patchExecutionError(
				"PATCH_ROLLBACK_FAILED",
				`Could not apply patch: ${error instanceof Error ? error.message : String(error)}. Rollback failed; manually inspect every touched file:\n${statusText}`,
				{
					details: {
						touchedFileCount: touched.length,
						rollbackStatuses: rollbackStatuses.map(({ operation, status }) => ({ operation, status })),
					},
				},
			);
		}
		const message = `Could not apply patch: ${error instanceof Error ? error.message : String(error)}. Changes were rolled back.`;
		if (error instanceof ToolExecutionError && error.code === "PATCH_WRITE_CONFLICT") throw error;
		throw patchExecutionError("PATCH_WRITE_FAILED", message, {
			details: {
				touchedFileCount: touched.length,
				rollbackStatuses: rollbackStatuses.map(({ operation, status }) => ({ operation, status })),
			},
		});
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
			"For update hunks, include 3 lines of unchanged context before and after each change when possible.",
			"Use an @@ function, class, or stable section header when repeated code makes the hunk ambiguous.",
			"Use separate hunks for distant changes, and re-read the target region before retrying a failed patch.",
			"In one assistant response, use only one mutation call per file; combine all changes for that file into one patch.",
		],
		parameters: applyPatchSchema,
		getExecutionKeys: async (args, ctx) => {
			if (!ctx || !args || typeof args !== "object") return [];
			const input = (args as { input?: unknown }).input;
			if (typeof input !== "string") return [];
			try {
				const operations = parseApplyPatch(input);
				return [
					...new Set(
						await Promise.all(
							operations.map((operation) => getMutationQueueKey(resolveToCwd(operation.path, ctx.cwd))),
						),
					),
				];
			} catch {
				return [];
			}
		},
		prepareArguments: prepareApplyPatchArguments,
		async execute(_toolCallId, { input }, signal, _onUpdate, ctx) {
			let operations: PatchOperation[] = [];
			try {
				operations = parseApplyPatch(input);
				const files = operations
					.map((operation) => ({ operation, absolutePath: resolveToCwd(operation.path, ctx.cwd) }))
					.sort((left, right) => left.absolutePath.localeCompare(right.absolutePath));
				for (let index = 1; index < files.length; index++) {
					if (files[index - 1].absolutePath === files[index].absolutePath) {
						throw patchError(`${files[index].operation.path} is modified more than once.`);
					}
				}

				return await withMutationQueues(
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
			} catch (error) {
				const failure = normalizePatchFailure(error);
				throw attachApplyPatchRecovery(failure, operations, ctx.cwd, ops);
			}
		},
		renderCall(_args, _theme, context) {
			const details = context.resultDetails as ApplyPatchDetails | undefined;
			const additions = details?.files.reduce((total, file) => total + file.additions, 0) ?? 0;
			const deletions = details?.files.reduce((total, file) => total + file.deletions, 0) ?? 0;
			return configureToolSummary(context.lastComponent, {
				icon: uiGlyphs.patch,
				subject: details ? `${details.files.length} 个文件  ${renderCounts(additions, deletions)}` : "",
				isPartial: context.isPartial,
				isError: context.isError,
				labels: {
					running: t("tool.applyPatch.running"),
					success: t("tool.applyPatch.success"),
					error: t("tool.applyPatch.error"),
				},
				stacked: false,
			});
		},
		renderResult(result, options, theme, context) {
			if (context.isError) {
				const component = context.lastComponent instanceof Container ? context.lastComponent : new Container();
				component.clear();
				const message = getTextResult(result);
				if (message) component.addChild(new Text(theme.fg("error", message), 0, 0));
				return component;
			}

			const details = result.details as
				| { files?: Array<Partial<ApplyPatchFileDetails> & Pick<ApplyPatchFileDetails, "path">> }
				| undefined;
			const component =
				context.lastComponent instanceof ApplyPatchResultComponent
					? context.lastComponent
					: new ApplyPatchResultComponent(context.toolCallId);
			component.update(details?.files ?? [], options.expanded);
			return component;
		},
	};
}

export default function applyPatchExtension(pi: ExtensionAPI): void {
	pi.registerTool(createApplyPatchToolDefinition());
}
