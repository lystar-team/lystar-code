import { type Edit, type EditIssue, normalizeForFuzzyMatch, normalizeToLF } from "./edit-diff.ts";

const MAX_RECOVERY_LINES = 200;

interface RecoveryWindow {
	start: number;
	end: number;
	editIndexes: number[];
}

interface AnchorLocation {
	start: number;
	anchorLine: number;
}

export interface EditRecoveryEvidence {
	text: string;
	lineCount: number;
	truncated: boolean;
	candidateLines: number[];
	evidenceLine?: number;
}

export function truncateEditEvidence(text: string, maxBytes: number): string {
	const bytes = Buffer.from(text, "utf8");
	if (bytes.length <= maxBytes) return text;
	let end = Math.max(0, maxBytes);
	while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
	return bytes.subarray(0, end).toString("utf8");
}

function findAnchorLocations(
	oldLines: readonly string[],
	lineIndex: ReadonlyMap<string, { count: number; lines: number[] }>,
): AnchorLocation[] {
	const anchors = oldLines
		.map((line, offset) => ({ key: normalizeForFuzzyMatch(line).trim(), offset }))
		.filter((anchor) => anchor.key.length >= 6)
		.sort((left, right) => right.key.length - left.key.length);
	let repeated: { lines: number[]; offset: number } | undefined;
	for (const anchor of anchors) {
		const found = lineIndex.get(anchor.key);
		if (!found) continue;
		if (found.count === 1) {
			return [{ start: Math.max(0, found.lines[0] - anchor.offset), anchorLine: found.lines[0] + 1 }];
		}
		repeated ??= { lines: found.lines, offset: anchor.offset };
	}
	return repeated?.lines.map((line) => ({ start: Math.max(0, line - repeated.offset), anchorLine: line + 1 })) ?? [];
}

function expandIdenticalWindows(lines: readonly string[], windows: RecoveryWindow[], maxBytes: number): string[] {
	if (windows.length < 2) return [];
	const lineBudget = Math.floor(MAX_RECOVERY_LINES / windows.length);
	// 为窗口标题、代码围栏和补读说明留出预算；最终输出仍由格式化层截断。
	const byteBudget = Math.max(0, Math.floor((maxBytes * 3) / 4 / windows.length) - 160);
	const notes: string[] = [];
	const duplicateGroups = (entries: RecoveryWindow[]): RecoveryWindow[][] => {
		const groups = new Map<string, RecoveryWindow[]>();
		for (const window of entries) {
			const key = JSON.stringify([window.editIndexes, lines.slice(window.start, window.end)]);
			const group = groups.get(key) ?? [];
			group.push(window);
			groups.set(key, group);
		}
		return [...groups.values()].filter((group) => group.length > 1);
	};
	const pending = duplicateGroups(windows);
	while (pending.length > 0) {
		const group = pending.pop()!;
		// 同一窗口中的多个候选交给合并和原候选行号展示，无须重复扩展。
		if (group.every((window) => window.start === group[0].start && window.end === group[0].end)) continue;
		const expanded = group.map((window) => ({
			start: Math.max(0, window.start - 1),
			end: Math.min(lines.length, window.end + 1),
		}));
		if (
			expanded.some(
				(window) =>
					window.end - window.start > lineBudget ||
					Buffer.byteLength(lines.slice(window.start, window.end).join("\n")) > byteBudget,
			)
		) {
			const ranges = expanded.map((window) => `read offset=${window.start + 1} limit=${window.end - window.start}`);
			notes.push(
				`edits[${group[0].editIndexes[0]}] 候选上下文仍相同，预算内无法区分；请补读 ${ranges.join("；")}，不要猜测目标。`,
			);
			continue;
		}
		for (let index = 0; index < group.length; index++) {
			group[index].start = expanded[index].start;
			group[index].end = expanded[index].end;
		}
		pending.push(...duplicateGroups(group));
	}
	return notes;
}

/** 证据只用于重建参数；推算出的行位置不能作为写入授权。 */
export function createEditRecoveryEvidence(
	content: string,
	edits: readonly Edit[],
	issues: readonly EditIssue[],
	maxBytes: number,
): EditRecoveryEvidence {
	const lines = content.split("\n");
	const lineIndex = new Map<string, { count: number; lines: number[] }>();
	for (let index = 0; index < lines.length; index++) {
		const key = normalizeForFuzzyMatch(lines[index]).trim();
		if (key.length < 6) continue;
		const entry = lineIndex.get(key) ?? { count: 0, lines: [] };
		entry.count++;
		if (entry.lines.length < 5) entry.lines.push(index);
		lineIndex.set(key, entry);
	}

	const windows: RecoveryWindow[] = [];
	const notes: string[] = [];
	const candidateLines = issues[0]?.candidateLines ?? [];
	let evidenceLine: number | undefined;
	const visited = new Set<number>();
	for (const issue of issues) {
		for (const editIndex of [
			issue.editIndex,
			...(issue.overlapEditIndex === undefined ? [] : [issue.overlapEditIndex]),
		]) {
			if (visited.has(editIndex)) continue;
			visited.add(editIndex);
			const oldText = normalizeToLF(edits[editIndex]?.oldText ?? "");
			const oldLines = oldText.split("\n");
			if (oldText.endsWith("\n")) oldLines.pop();
			const blockLines = Math.max(1, oldLines.length);
			const locations =
				issue.code === "MATCH_AMBIGUOUS" && issue.candidateLines
					? issue.candidateLines.map((line) => ({ start: line - 1, anchorLine: line }))
					: findAnchorLocations(oldLines, lineIndex);
			if (locations.length === 0) {
				notes.push(`edits[${editIndex}] 未定位到稳定上下文；请搜索目标后用 read 读取，不要沿用旧片段。`);
				continue;
			}
			evidenceLine ??= locations[0].anchorLine;
			for (const location of locations) {
				const start = Math.max(0, location.start - 3);
				const end = Math.min(lines.length, location.start + blockLines + 3);
				if (end - start <= 20) {
					windows.push({ start, end, editIndexes: [editIndex] });
				} else {
					windows.push({ start, end: Math.min(end, location.start + 3), editIndexes: [editIndex] });
					windows.push({ start: Math.max(start, location.start + blockLines - 3), end, editIndexes: [editIndex] });
					notes.push(
						`edits[${editIndex}] 候选块第 ${location.start + 1}—${Math.min(lines.length, location.start + blockLines)} 行较长，仅展示首尾。`,
					);
				}
			}
		}
	}

	notes.push(...expandIdenticalWindows(lines, windows, maxBytes - Buffer.byteLength(notes.join("\n"))));
	windows.sort((left, right) => left.start - right.start);
	const merged: RecoveryWindow[] = [];
	for (const window of windows) {
		const previous = merged.at(-1);
		if (previous && window.start <= previous.end) {
			previous.end = Math.max(previous.end, window.end);
			previous.editIndexes = [...new Set([...previous.editIndexes, ...window.editIndexes])];
		} else merged.push({ ...window });
	}

	const truncationNote = "\n证据已截断；片段不是完整 oldText。请按标注的 read 范围补读目标。";
	const noteText = truncateEditEvidence(notes.join("\n"), Math.max(0, Math.floor(maxBytes / 4)));
	const output = noteText ? [noteText] : [];
	let remainingBytes = Math.max(0, maxBytes - Buffer.byteLength(noteText) - Buffer.byteLength(truncationNote) - 2);
	let remainingLines = MAX_RECOVERY_LINES;
	let truncated = noteText !== notes.join("\n");
	let lineCount = 0;

	for (let index = 0; index < merged.length; index++) {
		const window = merged[index];
		const windowsLeft = merged.length - index;
		const byteBudget = Math.floor(remainingBytes / windowsLeft);
		const count = Math.min(window.end - window.start, Math.floor(remainingLines / windowsLeft));
		if (count <= 0 || byteBudget < 160) {
			truncated = true;
			continue;
		}
		const start = window.start;
		const end = start + count;
		const label = window.editIndexes.map((editIndex) => `edits[${editIndex}]`).join(", ");
		const heading = `${label} 当前候选上下文，第 ${start + 1}—${end} 行（read offset=${start + 1} limit=${window.end - start}）：\n`;
		// 给每个窗口和源行预留预算，长行不能挤掉其他候选。
		const perLineBytes = Math.max(0, Math.floor((byteBudget - Buffer.byteLength(heading) - 48) / count) - 1);
		const sourceLines = lines.slice(start, end).map((line) => {
			const clipped = truncateEditEvidence(line, perLineBytes);
			if (clipped !== line) truncated = true;
			return clipped;
		});
		const source = sourceLines.join("\n");
		const backticks = Math.max(2, ...Array.from(source.matchAll(/`+/g), (match) => match[0].length));
		const tildes = Math.max(2, ...Array.from(source.matchAll(/~+/g), (match) => match[0].length));
		const fence = backticks <= tildes ? "`".repeat(backticks + 1) : "~".repeat(tildes + 1);
		const rendered = `${heading}${fence}\n${source}\n${fence}`;
		const bytes = Buffer.byteLength(rendered) + 2;
		if (bytes > byteBudget) {
			truncated = true;
			continue;
		}
		output.push(rendered);
		remainingBytes -= bytes;
		remainingLines -= count;
		lineCount += count;
		if (end < window.end) truncated = true;
	}
	return {
		text: output.join("\n\n") + (truncated ? truncationNote : ""),
		lineCount,
		truncated,
		candidateLines,
		...(evidenceLine === undefined ? {} : { evidenceLine }),
	};
}
