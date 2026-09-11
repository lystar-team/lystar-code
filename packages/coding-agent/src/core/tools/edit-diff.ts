/**
 * Shared diff computation utilities for the edit and similar tools.
 */

import * as Diff from "diff";
import { constants } from "fs";
import { access, readFile } from "fs/promises";
import { splitBom } from "../../utils/text.ts";
import { resolveToCwd } from "./path-utils.ts";

export function detectLineEnding(content: string): "\r\n" | "\n" {
	const crlfIdx = content.indexOf("\r\n");
	const lfIdx = content.indexOf("\n");
	if (lfIdx === -1) return "\n";
	if (crlfIdx === -1) return "\n";
	return crlfIdx < lfIdx ? "\r\n" : "\n";
}

export function normalizeToLF(text: string): string {
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function restoreLineEndings(text: string, ending: "\r\n" | "\n"): string {
	return ending === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}

/**
 * Normalize text for fuzzy matching. Applies progressive transformations:
 * - Strip trailing whitespace from each line
 * - Normalize smart quotes to ASCII equivalents
 * - Normalize Unicode dashes/hyphens to ASCII hyphen
 * - Normalize special Unicode spaces to regular space
 */
export function normalizeForFuzzyMatch(text: string): string {
	return text
		.split("\n")
		.map((line) => normalizeMatchSegment(line.trimEnd()))
		.join("\n");
}

type MatchTier = "trailing" | "unicode-indented" | "trimmed" | "unicode";

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function normalizeMatchSegment(text: string): string {
	return text
		.normalize("NFKC")
		.replace(/[\u2018\u2019\u201A\u201B]/g, "'")
		.replace(/[\u201C\u201D\u201E\u201F]/g, '"')
		.replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
		.replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ");
}

function createMatchView(content: string, tier: MatchTier): MatchView {
	let text = "";
	const starts: Array<number | undefined> = [];
	const ends: Array<number | undefined> = [];
	const lines: MatchLine[] = [];
	let lineStart = 0;

	while (lineStart < content.length) {
		const newline = content.indexOf("\n", lineStart);
		const lineEnd = newline === -1 ? content.length : newline;
		const line = content.slice(lineStart, lineEnd);
		const leading = tier === "trailing" || tier === "unicode-indented" ? 0 : line.length - line.trimStart().length;
		const trailing = line.trimEnd().length;
		const keptStart = lineStart + Math.min(leading, trailing);
		const keptEnd = lineStart + trailing;
		const textStart = text.length;

		// 删除空白后，同一规范化位置的起点和终点对应不同的原始偏移。
		starts[textStart] = keptStart;
		if (ends[textStart] === undefined) ends[textStart] = keptStart;
		for (const segment of graphemeSegmenter.segment(content.slice(keptStart, keptEnd))) {
			const originalStart = keptStart + segment.index;
			const originalEnd = originalStart + segment.segment.length;
			const normalized =
				tier === "unicode" || tier === "unicode-indented"
					? normalizeMatchSegment(segment.segment)
					: segment.segment;
			starts[text.length] = originalStart;
			text += normalized;
			// 展开后的字素内部没有合法边界。
			starts.length = text.length + 1;
			ends.length = text.length + 1;
			starts[text.length] = originalEnd;
			ends[text.length] = originalEnd;
		}
		lines.push({ textStart, originalStart: lineStart });
		if (newline === -1) break;
		starts[text.length] = newline;
		text += "\n";
		starts[text.length] = newline + 1;
		ends[text.length] = newline + 1;
		lineStart = newline + 1;
	}

	if (content.length === 0) starts[0] = ends[0] = 0;
	return { text, starts, ends, lines };
}

function splitLinesWithEndings(content: string): string[] {
	return content.match(/[^\n]*\n|[^\n]+/g) ?? [];
}

interface LineSpan {
	start: number;
	end: number;
}

interface MatchedEdit {
	editIndex: number;
	matchIndex: number;
	matchLength: number;
	newText: string;
}

interface MatchLine {
	textStart: number;
	originalStart: number;
}

interface MatchView {
	text: string;
	starts: Array<number | undefined>;
	ends: Array<number | undefined>;
	lines: MatchLine[];
}

export interface EditIssue {
	code: "MATCH_NOT_FOUND" | "MATCH_AMBIGUOUS" | "EDIT_OVERLAP" | "EMPTY_OLD_TEXT";
	editIndex: number;
	message: string;
	candidateLines?: number[];
	matchCount?: number;
	overlapEditIndex?: number;
}

export class EditMatchError extends Error {
	readonly issues: readonly EditIssue[];
	readonly issueCount: number;
	readonly totalEdits: number;

	constructor(issues: readonly EditIssue[], issueCount: number, totalEdits: number) {
		const first = issues[0].message;
		const summary = issues.slice(1, 6).map((issue) => issue.message.split("\n")[0]);
		const remaining = issueCount - Math.min(issues.length, 6);
		super(
			first +
				(first.includes("No changes were written") ? "" : "\nNo changes were written.") +
				(issueCount > 1
					? `\nBatch validation: ${issueCount} issue(s) in ${totalEdits} edit(s).\n${summary.join("\n")}${remaining > 0 ? `\n${remaining} more issue(s); inspect the remaining edits before retrying.` : ""}`
					: ""),
		);
		this.name = "EditMatchError";
		this.issues = issues;
		this.issueCount = issueCount;
		this.totalEdits = totalEdits;
	}
}

type TextReplacement = Pick<MatchedEdit, "matchIndex" | "matchLength" | "newText">;

function getLineSpans(content: string): LineSpan[] {
	let offset = 0;
	return splitLinesWithEndings(content).map((line) => {
		const span = { start: offset, end: offset + line.length };
		offset = span.end;
		return span;
	});
}

function getReplacementLineRange(lines: LineSpan[], replacement: TextReplacement) {
	const replacementStart = replacement.matchIndex;
	const replacementEnd = replacement.matchIndex + replacement.matchLength;

	let startLine = -1;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (replacementStart >= line.start && replacementStart < line.end) {
			startLine = i;
			break;
		}
	}
	if (startLine === -1) {
		throw new Error("Replacement range is outside the base content.");
	}

	let endLine = startLine;
	while (endLine < lines.length && lines[endLine].end < replacementEnd) {
		endLine++;
	}
	if (endLine >= lines.length) {
		throw new Error("Replacement range is outside the base content.");
	}

	return { startLine, endLine: endLine + 1 };
}

function applyReplacements(content: string, replacements: TextReplacement[], offset = 0): string {
	let result = content;
	for (let i = replacements.length - 1; i >= 0; i--) {
		const replacement = replacements[i];
		const matchIndex = replacement.matchIndex - offset;
		result =
			result.substring(0, matchIndex) + replacement.newText + result.substring(matchIndex + replacement.matchLength);
	}
	return result;
}

/**
 * Apply replacements matched against `baseContent` to `originalContent` while
 * preserving unchanged line blocks from the original.
 *
 * This is useful when `baseContent` is a normalized view of the original. Each
 * replacement is widened to the lines it actually touches, those touched lines
 * are rewritten from the normalized base, and all other lines are copied back
 * from `originalContent`. The actual replacement ranges drive preservation so
 * duplicate normalized lines cannot be aligned to the wrong occurrence.
 */
export function applyReplacementsPreservingUnchangedLines(
	originalContent: string,
	baseContent: string,
	replacements: TextReplacement[],
): string {
	const originalLines = splitLinesWithEndings(originalContent);
	const baseLines = getLineSpans(baseContent);
	if (originalLines.length !== baseLines.length) {
		throw new Error("Cannot preserve unchanged lines because the base content has a different line count.");
	}

	const groups: Array<{ startLine: number; endLine: number; replacements: TextReplacement[] }> = [];
	const sortedReplacements = [...replacements].sort((a, b) => a.matchIndex - b.matchIndex);
	for (const replacement of sortedReplacements) {
		const range = getReplacementLineRange(baseLines, replacement);
		const current = groups[groups.length - 1];
		if (current && range.startLine < current.endLine) {
			current.endLine = Math.max(current.endLine, range.endLine);
			current.replacements.push(replacement);
			continue;
		}
		groups.push({ ...range, replacements: [replacement] });
	}

	let originalLineIndex = 0;
	let result = "";
	for (const group of groups) {
		result += originalLines.slice(originalLineIndex, group.startLine).join("");

		const groupStartOffset = baseLines[group.startLine].start;
		const groupEndOffset = baseLines[group.endLine - 1].end;
		result += applyReplacements(
			baseContent.slice(groupStartOffset, groupEndOffset),
			group.replacements,
			groupStartOffset,
		);
		originalLineIndex = group.endLine;
	}
	result += originalLines.slice(originalLineIndex).join("");

	return result;
}

export interface FuzzyMatchResult {
	/** Whether a match was found */
	found: boolean;
	/** The index where the match starts (in the content that should be used for replacement) */
	index: number;
	/** Length of the matched text */
	matchLength: number;
	/** Whether fuzzy matching was used (false = exact match) */
	usedFuzzyMatch: boolean;
	/**
	 * The content to use for replacement operations.
	 * When exact match: original content. When fuzzy match: normalized content.
	 */
	contentForReplacement: string;
}

export interface Edit {
	oldText: string;
	newText: string;
}

export interface AppliedEditsResult {
	baseContent: string;
	newContent: string;
}

/**
 * Find oldText in content, trying exact match first, then fuzzy match.
 * When fuzzy matching is used, the returned contentForReplacement is the
 * fuzzy-normalized version of the content (trailing whitespace stripped,
 * Unicode quotes/dashes normalized to ASCII).
 */
export function fuzzyFindText(content: string, oldText: string): FuzzyMatchResult {
	// Try exact match first
	const exactMatches = findAllOccurrences(content, oldText);
	if (exactMatches.count > 0) {
		return {
			found: true,
			index: exactMatches.offsets[0],
			matchLength: oldText.length,
			usedFuzzyMatch: false,
			contentForReplacement: content,
		};
	}

	// Try fuzzy match - work entirely in normalized space
	const fuzzyContent = normalizeForFuzzyMatch(content);
	const fuzzyOldText = normalizeForFuzzyMatch(oldText);
	const fuzzyMatches = findAllOccurrences(fuzzyContent, fuzzyOldText);

	if (fuzzyMatches.count === 0) {
		return {
			found: false,
			index: -1,
			matchLength: 0,
			usedFuzzyMatch: false,
			contentForReplacement: content,
		};
	}

	// When fuzzy matching, return offsets in normalized space. Callers can use
	// the normalized content to compute replacements, then decide how much of
	// that normalized output should be written back.
	return {
		found: true,
		index: fuzzyMatches.offsets[0],
		matchLength: fuzzyOldText.length,
		usedFuzzyMatch: true,
		contentForReplacement: fuzzyContent,
	};
}

/** Strip UTF-8 BOM if present, return both the BOM (if any) and the text without it */
export function stripBom(content: string): { bom: string; text: string } {
	return content.startsWith("\uFEFF") ? { bom: "\uFEFF", text: content.slice(1) } : { bom: "", text: content };
}

function findAllOccurrences(
	content: string,
	text: string,
	view?: MatchView,
	preferIndentBoundary = false,
): { count: number; offsets: number[] } {
	const offsets: number[] = [];
	const preferredOffsets: number[] = [];
	let count = 0;
	let preferredCount = 0;
	let hasIndentBoundaryMatch = false;
	if (text.length === 0) return { count, offsets };
	let searchStart = 0;
	while (true) {
		const offset = content.indexOf(text, searchStart);
		if (offset === -1)
			return hasIndentBoundaryMatch ? { count: preferredCount, offsets: preferredOffsets } : { count, offsets };
		if (!view || (view.starts[offset] !== undefined && view.ends[offset + text.length] !== undefined)) {
			count++;
			if (offsets.length < 5) offsets.push(offset);
			if (preferIndentBoundary) {
				const lineStart = offset === 0 ? 0 : content.lastIndexOf("\n", offset - 1) + 1;
				// 显式缩进优先匹配完整行首，不能把较深缩进的尾部视为同等候选。
				// 代码中的空白子串仍是候选；没有更强证据时保留原有子串匹配。
				if (offset === lineStart) hasIndentBoundaryMatch = true;
				if (offset === lineStart || /\S/.test(content.slice(lineStart, offset))) {
					preferredCount++;
					if (preferredOffsets.length < 5) preferredOffsets.push(offset);
				}
			}
		}
		searchStart = offset + 1;
	}
}

function getLineStarts(content: string): number[] {
	const lineStarts = [0];
	for (let index = 0; index < content.length; index++) {
		if (content[index] === "\n") lineStarts.push(index + 1);
	}
	return lineStarts;
}

function getLineNumber(offset: number, lineStarts: number[]): number {
	let low = 0;
	let high = lineStarts.length;
	while (low + 1 < high) {
		const middle = Math.floor((low + high) / 2);
		if (lineStarts[middle] <= offset) {
			low = middle;
		} else {
			high = middle;
		}
	}
	return low + 1;
}

function getNotFoundError(path: string, editIndex: number, totalEdits: number): Error {
	if (totalEdits === 1) {
		return new Error(
			`Could not find the exact text in ${path}. Tried exact matching, whitespace-tolerant matching, and Unicode punctuation normalization.\nNo changes were written. Re-read the target region and retry with unique oldText.`,
		);
	}
	return new Error(
		`Could not find edits[${editIndex}] in ${path}. Tried exact matching, whitespace-tolerant matching, and Unicode punctuation normalization.\nNo changes were written. Re-read the target region and retry with unique oldText.`,
	);
}

function getDuplicateError(path: string, editIndex: number, displayedLines: number[], count: number): Error {
	const remaining = count - displayedLines.length;
	const more = remaining > 0 ? ` +${remaining} more` : "";
	return new Error(
		`Found ${count} occurrences of edits[${editIndex}] in ${path} at lines ${displayedLines.join(", ")}${more}.\nInclude one stable unchanged line before or after the intended block, then retry.\nNo changes were written.`,
	);
}

function getEmptyOldTextError(path: string, editIndex: number, totalEdits: number): Error {
	if (totalEdits === 1) {
		return new Error(`oldText must not be empty in ${path}.`);
	}
	return new Error(`edits[${editIndex}].oldText must not be empty in ${path}.`);
}

function firstLineHasIndent(text: string): boolean {
	const newline = text.indexOf("\n");
	const firstLine = newline === -1 ? text : text.slice(0, newline);
	return firstLine.length !== firstLine.trimStart().length;
}

function findEditMatch(
	content: string,
	oldText: string,
	path: string,
	editIndex: number,
	totalEdits: number,
	lineStarts: number[],
	views: Map<MatchTier, MatchView>,
): MatchedEdit | EditIssue {
	const preferIndentBoundary = /^[^\S\n]+\S/.test(oldText);
	const exactMatches = findAllOccurrences(content, oldText, undefined, preferIndentBoundary);
	if (exactMatches.count > 1) {
		const candidateLines = exactMatches.offsets.map((offset) => getLineNumber(offset, lineStarts));
		return {
			code: "MATCH_AMBIGUOUS",
			editIndex,
			candidateLines,
			matchCount: exactMatches.count,
			message: getDuplicateError(path, editIndex, candidateLines, exactMatches.count).message,
		};
	}
	if (exactMatches.count === 1) {
		return { editIndex, matchIndex: exactMatches.offsets[0], matchLength: oldText.length, newText: "" };
	}

	// 先归一化标点并保留缩进，再尝试丢弃缩进的弱匹配。
	for (const tier of ["trailing", "unicode-indented", "trimmed", "unicode"] as const) {
		let contentView = views.get(tier);
		if (!contentView) {
			contentView = createMatchView(content, tier);
			views.set(tier, contentView);
		}
		const matchText = createMatchView(oldText, tier).text;
		if (!matchText) continue;
		const matches = findAllOccurrences(contentView.text, matchText, contentView, preferIndentBoundary);
		if (matches.count > 1) {
			const candidateLines = matches.offsets.map((offset) => getLineNumber(contentView.starts[offset]!, lineStarts));
			return {
				code: "MATCH_AMBIGUOUS",
				editIndex,
				candidateLines,
				matchCount: matches.count,
				message: getDuplicateError(path, editIndex, candidateLines, matches.count).message,
			};
		}
		if (matches.count === 1) {
			const offset = matches.offsets[0];
			let start = contentView.starts[offset]!;
			const end = contentView.ends[offset + matchText.length]!;
			if (firstLineHasIndent(oldText)) {
				const startLine = contentView.lines.find((line) => line.textStart === offset);
				if (startLine) start = startLine.originalStart;
			}
			return { editIndex, matchIndex: start, matchLength: end - start, newText: "" };
		}
	}

	return { code: "MATCH_NOT_FOUND", editIndex, message: getNotFoundError(path, editIndex, totalEdits).message };
}

/**
 * Apply one or more exact-text replacements to LF-normalized content.
 *
 * All edits are matched against the same original content. Replacements are
 * then applied in reverse order so offsets remain stable. Each edit chooses its
 * own matching tier, and fuzzy matches are mapped back to original offsets so
 * unrelated edits and untouched text keep their original bytes. Explicit leading
 * indentation prefers matches at its full boundary over suffixes of deeper indentation.
 */
export function applyEditsToNormalizedContent(
	normalizedContent: string,
	edits: readonly Edit[],
	path: string,
): AppliedEditsResult {
	const normalizedEdits = edits.map((edit) => ({
		oldText: normalizeToLF(edit.oldText),
		newText: normalizeToLF(edit.newText),
	}));

	const lineStarts = getLineStarts(normalizedContent);
	const views = new Map<MatchTier, MatchView>();
	const matchedEdits: MatchedEdit[] = [];
	const issues: EditIssue[] = [];
	let issueCount = 0;
	const addIssue = (issue: EditIssue): void => {
		issueCount++;
		if (issues.length < 20) issues.push(issue);
	};
	for (let index = 0; index < normalizedEdits.length; index++) {
		const edit = normalizedEdits[index];
		if (edit.oldText.length === 0) {
			addIssue({
				code: "EMPTY_OLD_TEXT",
				editIndex: index,
				message: getEmptyOldTextError(path, index, normalizedEdits.length).message,
			});
			continue;
		}
		const match = findEditMatch(
			normalizedContent,
			edit.oldText,
			path,
			index,
			normalizedEdits.length,
			lineStarts,
			views,
		);
		if ("code" in match) addIssue(match);
		else matchedEdits.push({ ...match, newText: edit.newText });
	}

	matchedEdits.sort((a, b) => a.matchIndex - b.matchIndex);
	const ends = matchedEdits.map((edit) => edit.matchIndex + edit.matchLength).sort((left, right) => left - right);
	let ended = 0;
	for (let i = 0; i < matchedEdits.length; i++) {
		const current = matchedEdits[i];
		while (ended < ends.length && ends[ended] <= current.matchIndex) ended++;
		const conflicts = i - ended;
		issueCount += conflicts;
		if (conflicts === 0 || issues.length >= 20) continue;
		// Count all pairs, but materialize only the bounded diagnostic sample.
		for (let previousIndex = 0; previousIndex < i && issues.length < 20; previousIndex++) {
			const previous = matchedEdits[previousIndex];
			if (previous.matchIndex + previous.matchLength <= current.matchIndex) continue;
			issues.push({
				code: "EDIT_OVERLAP",
				editIndex: previous.editIndex,
				overlapEditIndex: current.editIndex,
				message: `edits[${previous.editIndex}] and edits[${current.editIndex}] overlap in ${path}. Merge them into one edit or target disjoint regions.`,
			});
		}
	}
	if (issueCount > 0) throw new EditMatchError(issues, issueCount, normalizedEdits.length);

	const baseContent = normalizedContent;
	const newContent = applyReplacements(normalizedContent, matchedEdits);

	return { baseContent, newContent };
}

/** Generate a standard unified patch. */
export function generateUnifiedPatch(path: string, oldContent: string, newContent: string, contextLines = 4): string {
	return Diff.createTwoFilesPatch(path, path, oldContent, newContent, undefined, undefined, {
		context: contextLines,
		headerOptions: Diff.FILE_HEADERS_ONLY,
	});
}

/**
 * Generate a display-oriented diff string with line numbers and context.
 * Returns both the diff string and the first changed line number (in the new file).
 */
export function generateDiffString(
	oldContent: string,
	newContent: string,
	contextLines = 4,
): { diff: string; firstChangedLine: number | undefined; additions: number; deletions: number } {
	const parts = Diff.diffLines(oldContent, newContent);
	const output: string[] = [];
	let additions = 0;
	let deletions = 0;

	const oldLines = oldContent.split("\n");
	const newLines = newContent.split("\n");
	const maxLineNum = Math.max(oldLines.length, newLines.length);
	const lineNumWidth = String(maxLineNum).length;

	let oldLineNum = 1;
	let newLineNum = 1;
	let lastWasChange = false;
	let firstChangedLine: number | undefined;

	for (let i = 0; i < parts.length; i++) {
		const part = parts[i];
		const raw = part.value.split("\n");
		if (raw[raw.length - 1] === "") {
			raw.pop();
		}

		if (part.added || part.removed) {
			if (part.added) additions += raw.length;
			if (part.removed) deletions += raw.length;
			// Capture the first changed line (in the new file)
			if (firstChangedLine === undefined) {
				firstChangedLine = newLineNum;
			}

			// Show the change
			for (const line of raw) {
				if (part.added) {
					const lineNum = String(newLineNum).padStart(lineNumWidth, " ");
					output.push(`+${lineNum} ${line}`);
					newLineNum++;
				} else {
					// removed
					const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
					output.push(`-${lineNum} ${line}`);
					oldLineNum++;
				}
			}
			lastWasChange = true;
		} else {
			// Context lines - only show a few before/after changes
			const nextPartIsChange = i < parts.length - 1 && (parts[i + 1].added || parts[i + 1].removed);
			const hasLeadingChange = lastWasChange;
			const hasTrailingChange = nextPartIsChange;

			if (hasLeadingChange && hasTrailingChange) {
				if (raw.length <= contextLines * 2) {
					for (const line of raw) {
						const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
						output.push(` ${lineNum} ${line}`);
						oldLineNum++;
						newLineNum++;
					}
				} else {
					const leadingLines = raw.slice(0, contextLines);
					const trailingLines = raw.slice(raw.length - contextLines);
					const skippedLines = raw.length - leadingLines.length - trailingLines.length;

					for (const line of leadingLines) {
						const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
						output.push(` ${lineNum} ${line}`);
						oldLineNum++;
						newLineNum++;
					}

					output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
					oldLineNum += skippedLines;
					newLineNum += skippedLines;

					for (const line of trailingLines) {
						const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
						output.push(` ${lineNum} ${line}`);
						oldLineNum++;
						newLineNum++;
					}
				}
			} else if (hasLeadingChange) {
				const shownLines = raw.slice(0, contextLines);
				const skippedLines = raw.length - shownLines.length;

				for (const line of shownLines) {
					const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
					output.push(` ${lineNum} ${line}`);
					oldLineNum++;
					newLineNum++;
				}

				if (skippedLines > 0) {
					output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
					oldLineNum += skippedLines;
					newLineNum += skippedLines;
				}
			} else if (hasTrailingChange) {
				const skippedLines = Math.max(0, raw.length - contextLines);
				if (skippedLines > 0) {
					output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
					oldLineNum += skippedLines;
					newLineNum += skippedLines;
				}

				for (const line of raw.slice(skippedLines)) {
					const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
					output.push(` ${lineNum} ${line}`);
					oldLineNum++;
					newLineNum++;
				}
			} else {
				// Skip these context lines entirely
				oldLineNum += raw.length;
				newLineNum += raw.length;
			}

			lastWasChange = false;
		}
	}

	return { diff: output.join("\n"), firstChangedLine, additions, deletions };
}

export interface EditDiffResult {
	diff: string;
	firstChangedLine: number | undefined;
	additions: number;
	deletions: number;
}

export interface EditDiffError {
	error: string;
}

/**
 * Compute the diff for one or more edit operations without applying them.
 * Used for preview rendering in the TUI before the tool executes.
 */
export async function computeEditsDiff(
	path: string,
	edits: Edit[],
	cwd: string,
): Promise<EditDiffResult | EditDiffError> {
	const absolutePath = resolveToCwd(path, cwd);

	try {
		// Check if file exists and is readable
		try {
			await access(absolutePath, constants.R_OK);
		} catch (error: unknown) {
			const errorMessage = error instanceof Error && "code" in error ? `Error code: ${error.code}` : String(error);
			return { error: `Could not edit file: ${path}. ${errorMessage}.` };
		}

		// Read the file
		const rawContent = await readFile(absolutePath, "utf-8");

		// Strip BOM before matching (LLM won't include invisible BOM in oldText)
		const { text: content } = splitBom(rawContent);
		const normalizedContent = normalizeToLF(content);
		const { baseContent, newContent } = applyEditsToNormalizedContent(normalizedContent, edits, path);

		// Generate the diff
		return generateDiffString(baseContent, newContent);
	} catch (err) {
		return { error: err instanceof Error ? err.message : String(err) };
	}
}

/**
 * Compute the diff for a single edit operation without applying it.
 * Kept as a convenience wrapper for single-edit callers.
 */
export async function computeEditDiff(
	path: string,
	oldText: string,
	newText: string,
	cwd: string,
): Promise<EditDiffResult | EditDiffError> {
	return computeEditsDiff(path, [{ oldText, newText }], cwd);
}
