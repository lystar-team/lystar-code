import { createHash, randomBytes } from "node:crypto";

export interface SnapshotRangeEdit {
	startLine: number;
	endLine: number;
	newText: string;
	index?: number;
	snapshot?: string;
}

export interface SnapshotEditInput {
	snapshot?: string;
	plan?: string;
	edits?: SnapshotRangeEdit[];
	dropIndexes?: number[];
}

export interface FileSnapshot {
	id: string;
	path: string;
	revision: string;
	startLine: number;
	endLine: number;
	totalLines: number;
}

export interface SnapshotEditIssue {
	code: string;
	editIndex: number;
	message: string;
	startLine?: number;
	endLine?: number;
}

export interface PreparedSnapshotEdit {
	path: string;
	plan: string;
	baseContent: string;
	newContent: string;
	finalContent: string;
	sourceRevision: string;
	resultRevision: string;
	applied: number;
	alreadyApplied: number;
	edits: Array<{
		index: number;
		startLine: number;
		endLine: number;
		status: "applied" | "already_applied" | "unchanged";
	}>;
	preview?: boolean;
}

export class SnapshotEditError extends Error {
	readonly code: string;
	readonly issues: SnapshotEditIssue[];
	readonly plan?: string;
	readonly revision: string;
	readonly attempt: number;
	readonly recoveryAllowed: boolean;

	constructor(
		code: string,
		issues: SnapshotEditIssue[],
		revision: string,
		attempt: number,
		recoveryAllowed: boolean,
		plan?: string,
	) {
		super(`${issues.map((issue) => issue.message).join("\n")}\nNo changes were written.`);
		this.name = "SnapshotEditError";
		this.code = code;
		this.issues = issues;
		this.plan = plan;
		this.revision = revision;
		this.attempt = attempt;
		this.recoveryAllowed = recoveryAllowed;
	}
}

interface LineRecord {
	text: string;
	ending: string;
}

interface SnapshotEntry {
	cacheKey: string;
	metadata: FileSnapshot;
	lines: LineRecord[];
	bytes: number;
}

interface PlanOperation {
	index: number;
	snapshotId?: string;
	startLine: number;
	endLine: number;
	newText: string;
}

interface PlanEntry {
	id: string;
	path: string;
	operations: Map<number, PlanOperation>;
	bytes: number;
}

interface LineRange {
	startLine: number;
	endLine: number;
}

interface CommitChange extends LineRange {
	newLineCount: number;
}

interface CommitRecord {
	path: string;
	sourceRevision: string;
	resultRevision: string;
	changes: CommitChange[];
	bytes: number;
	lastUsed: number;
}

interface Receipt {
	key: string;
	path: string;
	resultRevision: string;
	resultRange: LineRange;
	bytes: number;
}

interface ResolvedOperation extends PlanOperation {
	sourceRevision: string;
	currentRange: LineRange;
	insert: boolean;
	rendered: LineRecord[];
	status: "applied" | "already_applied" | "unchanged";
}

interface CommitDetails {
	path: string;
	plan: string;
	sourceRevision: string;
	resultRevision: string;
	changes: CommitChange[];
	receipts: Receipt[];
}

const MAX_SNAPSHOTS = 128;
const MAX_SNAPSHOT_BYTES = 4 * 1024 * 1024;
const MAX_PLANS = 64;
const MAX_PLAN_BYTES = 1024 * 1024;
const MAX_PLAN_EDITS = 256;
const MAX_RECEIPTS = 512;
const MAX_RECEIPT_BYTES = 1024 * 1024;
const MAX_HISTORY_RECORDS = 256;
const MAX_HISTORY_BYTES = 512 * 1024;
const MAX_FAILURE_KEYS = 1024;

function stripBom(text: string): { bom: string; text: string } {
	return text.startsWith("\uFEFF") ? { bom: "\uFEFF", text: text.slice(1) } : { bom: "", text };
}

function normalizeToLF(text: string): string {
	return text.replace(/\r\n?/g, "\n");
}

function splitLines(text: string): LineRecord[] {
	const lines: LineRecord[] = [];
	let start = 0;
	for (let index = 0; index < text.length; index++) {
		if (text[index] !== "\n" && text[index] !== "\r") continue;
		const ending = text[index] === "\r" && text[index + 1] === "\n" ? "\r\n" : text[index];
		lines.push({ text: text.slice(start, index), ending });
		if (ending === "\r\n") index++;
		start = index + 1;
	}
	if (start < text.length) lines.push({ text: text.slice(start), ending: "" });
	else lines.push({ text: "", ending: "" });
	return lines;
}

function joinLines(lines: readonly LineRecord[]): string {
	return lines.map((line) => line.text + line.ending).join("");
}

function hashContent(content: string): string {
	return createHash("sha256").update(content, "utf8").digest("hex");
}

function randomId(prefix: string): string {
	return `${prefix}${randomBytes(6).toString("hex")}`;
}

function sameLineText(left: readonly LineRecord[], right: readonly LineRecord[]): boolean {
	return left.length === right.length && left.every((line, index) => line.text === right[index].text);
}

function rangeIssue(code: string, edit: PlanOperation, message: string): SnapshotEditIssue {
	return { code, editIndex: edit.index, message, startLine: edit.startLine, endLine: edit.endLine };
}

function isInsertion(range: LineRange): boolean {
	return range.endLine === range.startLine - 1;
}

function replacementLineCount(range: LineRange, newLineCount: number): number {
	return newLineCount - Math.max(0, range.endLine - range.startLine + 1);
}

function mapRangeThroughChanges(range: LineRange, changes: readonly CommitChange[]): LineRange | undefined {
	const insertion = isInsertion(range);
	let shift = 0;
	for (const change of changes) {
		const changedInsertion = isInsertion(change);
		const delta = replacementLineCount(change, change.newLineCount);
		if (insertion) {
			const point = range.startLine;
			if (changedInsertion) {
				if (change.startLine === point) return undefined;
				if (change.startLine < point) shift += delta;
			} else if (change.endLine < point) {
				shift += delta;
			} else if (change.startLine < point && change.endLine >= point) {
				return undefined;
			}
			continue;
		}

		if (changedInsertion) {
			if (change.startLine <= range.startLine) shift += delta;
			else if (change.startLine <= range.endLine) return undefined;
		} else if (change.endLine < range.startLine) {
			shift += delta;
		} else if (change.startLine <= range.endLine) {
			return undefined;
		}
	}
	return { startLine: range.startLine + shift, endLine: range.endLine + shift };
}

function signature(path: string, revision: string, operation: PlanOperation): string {
	return JSON.stringify([path, revision, operation.startLine, operation.endLine, operation.newText]);
}

function planByteSize(plan: PlanEntry): number {
	return Buffer.byteLength(
		JSON.stringify({ id: plan.id, path: plan.path, operations: [...plan.operations.values()] }),
		"utf8",
	);
}

function chooseLineEnding(lines: readonly LineRecord[], startLine: number): string {
	const direct = lines[startLine - 1]?.ending;
	if (direct) return direct;
	for (let index = Math.min(startLine - 2, lines.length - 1); index >= 0; index--) {
		if (lines[index].ending) return lines[index].ending;
	}
	return lines.find((line) => line.ending)?.ending ?? "\n";
}

function parseReplacement(text: string, ending: string): LineRecord[] {
	const normalized = normalizeToLF(stripBom(text).text);
	if (normalized.length === 0) return [];
	const lines = splitLines(normalized);
	if (normalized.endsWith("\n")) lines.pop();
	return lines.map((line) => ({ text: line.text, ending: line.ending ? ending : "" }));
}

function renderReplacement(text: string, lines: readonly LineRecord[], range: LineRange): LineRecord[] {
	const ending = chooseLineEnding(lines, range.startLine);
	const normalized = normalizeToLF(stripBom(text).text);
	const rendered = parseReplacement(normalized, ending);
	if (rendered.length === 0 || normalized.endsWith("\n")) return rendered;
	const originalLast = isInsertion(range) ? undefined : lines[range.endLine - 1];
	const hasFollowingLine = range.endLine < lines.length;
	rendered[rendered.length - 1].ending = originalLast?.ending || (hasFollowingLine ? ending : "");
	return rendered;
}

function renderInsertion(
	text: string,
	_lines: readonly LineRecord[],
	_range: LineRange,
	ending: string,
	hasFollowingLine: boolean,
): LineRecord[] {
	const normalized = normalizeToLF(stripBom(text).text);
	const rendered = parseReplacement(normalized, ending);
	if (rendered.length > 0 && !normalized.endsWith("\n") && hasFollowingLine) {
		rendered[rendered.length - 1].ending = ending;
	}
	return rendered;
}

function rangesOverlap(left: LineRange, right: LineRange): boolean {
	const leftInsert = isInsertion(left);
	const rightInsert = isInsertion(right);
	if (leftInsert && rightInsert) return left.startLine === right.startLine;
	if (leftInsert) return left.startLine > right.startLine && left.startLine <= right.endLine;
	if (rightInsert) return right.startLine > left.startLine && right.startLine <= left.endLine;
	return left.startLine <= right.endLine && right.startLine <= left.endLine;
}

function operationOutputStart(operation: ResolvedOperation, operations: readonly ResolvedOperation[]): number {
	let shift = 0;
	for (const other of operations) {
		if (other === operation || other.status !== "applied") continue;
		const otherRange = other.currentRange;
		const otherDelta = replacementLineCount(otherRange, other.rendered.length);
		if (isInsertion(operation.currentRange)) {
			if (
				isInsertion(otherRange)
					? otherRange.startLine < operation.currentRange.startLine
					: otherRange.endLine < operation.currentRange.startLine
			) {
				shift += otherDelta;
			}
		} else if (
			isInsertion(otherRange)
				? otherRange.startLine <= operation.currentRange.startLine
				: otherRange.endLine < operation.currentRange.startLine
		) {
			shift += otherDelta;
		}
	}
	return operation.currentRange.startLine + shift;
}

function buildUpdatedLines(lines: readonly LineRecord[], operations: readonly ResolvedOperation[]): LineRecord[] {
	const changed = operations.filter((operation) => operation.status === "applied");
	if (changed.length === 0) return [...lines];
	const byPosition = new Map<number, ResolvedOperation[]>();
	for (const operation of changed) {
		const position = operation.currentRange.startLine;
		const group = byPosition.get(position) ?? [];
		group.push(operation);
		byPosition.set(position, group);
	}

	const result: LineRecord[] = [];
	let cursor = 1;
	for (const position of [...byPosition.keys()].sort((left, right) => left - right)) {
		while (cursor < position && cursor <= lines.length) result.push(lines[cursor++ - 1]);
		const atPosition = byPosition.get(position)!;
		for (const operation of atPosition.filter((candidate) => candidate.insert)) {
			if (operation.rendered.length === 0) continue;
			if (position === lines.length + 1 && result.length > 0 && !result[result.length - 1].ending) {
				result[result.length - 1] = { ...result[result.length - 1], ending: chooseLineEnding(lines, position) };
			}
			result.push(...operation.rendered.map((line) => ({ ...line })));
		}
		const replacement = atPosition.find((candidate) => !candidate.insert);
		if (replacement) {
			const removesFinalEmptyLine =
				replacement.rendered.length === 0 &&
				replacement.currentRange.startLine === lines.length &&
				replacement.currentRange.endLine === lines.length &&
				lines.at(-1)?.text === "" &&
				lines.at(-1)?.ending === "";
			if (removesFinalEmptyLine && result.length > 0) {
				result[result.length - 1] = { ...result[result.length - 1], ending: "" };
			}
			result.push(...replacement.rendered.map((line) => ({ ...line })));
			cursor = replacement.currentRange.endLine + 1;
		}
	}
	while (cursor <= lines.length) result.push(lines[cursor++ - 1]);
	return splitLines(joinLines(result));
}

export class FileEditState {
	private readonly snapshots = new Map<string, SnapshotEntry>();
	private readonly snapshotKeys = new Map<string, string>();
	private snapshotBytes = 0;
	private readonly plans = new Map<string, PlanEntry>();
	private planBytes = 0;
	private readonly receipts = new Map<string, Receipt>();
	private receiptBytes = 0;
	private readonly history: CommitRecord[] = [];
	private historyBytes = 0;
	private lruClock = 0;
	private readonly failures = new Map<string, number>();
	private readonly prepared = new WeakMap<PreparedSnapshotEdit, CommitDetails>();
	private readonly committed = new WeakSet<PreparedSnapshotEdit>();

	capture(path: string, rawContent: string, startLine: number, endLine: number): FileSnapshot {
		const { text } = stripBom(rawContent);
		const lines = splitLines(text);
		const totalLines = lines.length;
		if (
			!Number.isSafeInteger(startLine) ||
			!Number.isSafeInteger(endLine) ||
			startLine < 1 ||
			endLine < startLine ||
			endLine > totalLines
		) {
			throw new Error(`Snapshot range ${startLine}-${endLine} is outside the ${totalLines}-line file.`);
		}
		const revision = hashContent(rawContent);
		const cacheKey = JSON.stringify([path, revision, startLine, endLine]);
		const cachedId = this.snapshotKeys.get(cacheKey);
		const cached = cachedId ? this.snapshots.get(cachedId) : undefined;
		if (cached) {
			this.touchSnapshot(cached.metadata.id);
			return { ...cached.metadata };
		}
		const scopedLines = lines.slice(startLine - 1, endLine);
		const bytes = Buffer.byteLength(joinLines(scopedLines), "utf8");
		if (bytes > MAX_SNAPSHOT_BYTES)
			throw new Error("SNAPSHOT_CAPACITY: displayed range exceeds the snapshot cache budget.");
		while (this.snapshots.size >= MAX_SNAPSHOTS || this.snapshotBytes + bytes > MAX_SNAPSHOT_BYTES) {
			const entries = [...this.snapshots.values()];
			const victim = entries.find((entry) => !this.isSnapshotPinned(entry.metadata.id)) ?? entries[0];
			if (!victim) throw new Error("SNAPSHOT_CAPACITY: no snapshot can be evicted.");
			this.evictSnapshot(victim.metadata.id);
		}
		let id = randomId("r");
		while (this.snapshots.has(id)) id = randomId("r");
		const metadata: FileSnapshot = {
			id,
			path,
			revision,
			startLine,
			endLine,
			totalLines,
		};
		this.snapshots.set(id, { cacheKey, metadata, lines: scopedLines, bytes });
		this.snapshotKeys.set(cacheKey, id);
		this.snapshotBytes += bytes;
		return { ...metadata };
	}

	getSnapshot(id: string, path: string): FileSnapshot {
		const entry = this.snapshots.get(id);
		if (!entry || entry.metadata.path !== path) {
			throw new Error(`SNAPSHOT_NOT_FOUND: snapshot ${id} is not available for ${path}; read the range again.`);
		}
		this.touchSnapshot(id);
		return { ...entry.metadata };
	}

	describeSnapshot(snapshot: FileSnapshot): string {
		const range =
			snapshot.totalLines === 0
				? "empty file"
				: `lines ${snapshot.startLine}-${snapshot.endLine} of ${snapshot.totalLines}`;
		return `[snapshot ${snapshot.id}; ${range}]`;
	}

	prepare(path: string, currentRawContent: string, input: SnapshotEditInput, preview = false): PreparedSnapshotEdit {
		const sourceRevision = hashContent(currentRawContent);
		const failureKey = `${path}\0${sourceRevision}`;
		const issues: SnapshotEditIssue[] = [];
		let plan: PlanEntry;
		const existing = input.plan ? this.plans.get(input.plan) : undefined;
		if (existing) this.touchPlan(existing.id);

		if (input.plan) {
			if (!existing || existing.path !== path) {
				issues.push({
					code: "PLAN_NOT_FOUND",
					editIndex: -1,
					message: `Plan ${input.plan} is not available for ${path}.`,
				});
				return this.fail(sourceRevision, failureKey, issues, input.plan, preview);
			}
			plan = { id: existing.id, path, operations: new Map(existing.operations), bytes: existing.bytes };
			for (const index of input.dropIndexes ?? []) {
				if (!plan.operations.delete(index)) {
					issues.push({
						code: "INVALID_INDEX",
						editIndex: index,
						message: `Cannot drop unknown edits[${index}].`,
					});
				}
			}
			const correctedIndexes = new Set<number>();
			for (const edit of input.edits ?? []) {
				if (edit.index !== undefined && correctedIndexes.has(edit.index)) {
					issues.push({
						code: "DUPLICATE_INDEX",
						editIndex: edit.index,
						message: `edits[${edit.index}] is corrected more than once.`,
					});
					continue;
				}
				if (edit.index !== undefined) correctedIndexes.add(edit.index);
				if (edit.index === undefined || !plan.operations.has(edit.index)) {
					issues.push({
						code: "INVALID_INDEX",
						editIndex: edit.index ?? -1,
						message: "A resume edit must specify an existing edit index.",
						startLine: edit.startLine,
						endLine: edit.endLine,
					});
					continue;
				}
				plan.operations.set(edit.index, {
					index: edit.index,
					snapshotId: edit.snapshot ?? input.snapshot ?? plan.operations.get(edit.index)!.snapshotId,
					startLine: edit.startLine,
					endLine: edit.endLine,
					newText: edit.newText,
				});
			}
		} else {
			plan = { id: randomId("p"), path, operations: new Map(), bytes: 0 };
			if (!input.snapshot) {
				issues.push({ code: "SNAPSHOT_REQUIRED", editIndex: -1, message: "An initial snapshot is required." });
			}
			if (!input.edits || input.edits.length === 0) {
				issues.push({
					code: "EDITS_REQUIRED",
					editIndex: -1,
					message: "An initial plan requires at least one edit.",
				});
			}
			if (input.edits && input.edits.length > MAX_PLAN_EDITS) {
				issues.push({
					code: "PLAN_CAPACITY",
					editIndex: -1,
					message: `A plan may contain at most ${MAX_PLAN_EDITS} edits.`,
				});
			}
			for (const [position, edit] of (input.edits ?? []).slice(0, MAX_PLAN_EDITS).entries()) {
				const index = edit.index ?? position;
				if (plan.operations.has(index)) {
					issues.push({
						code: "DUPLICATE_INDEX",
						editIndex: index,
						message: `edits[${index}] is specified more than once.`,
					});
					continue;
				}
				plan.operations.set(index, {
					index,
					snapshotId: edit.snapshot ?? input.snapshot,
					startLine: edit.startLine,
					endLine: edit.endLine,
					newText: edit.newText,
				});
			}
		}

		if (issues.length > 0) return this.failWithPlan(plan, sourceRevision, failureKey, issues, preview);
		if (plan.operations.size === 0) {
			issues.push({ code: "EDITS_REQUIRED", editIndex: -1, message: "The plan has no remaining edits." });
			return this.failWithPlan(plan, sourceRevision, failureKey, issues, preview);
		}

		const { text: currentText } = stripBom(currentRawContent);
		const currentLines = splitLines(currentText);
		const resolved: ResolvedOperation[] = [];
		for (const operation of [...plan.operations.values()].sort((left, right) => left.index - right.index)) {
			const snapshotEntry = operation.snapshotId ? this.snapshots.get(operation.snapshotId) : undefined;
			if (!snapshotEntry || snapshotEntry.metadata.path !== path) {
				issues.push(
					rangeIssue(
						"SNAPSHOT_NOT_FOUND",
						operation,
						`SNAPSHOT_NOT_FOUND: edits[${operation.index}] requires a new read for ${path}.`,
					),
				);
				continue;
			}
			this.touchSnapshot(snapshotEntry.metadata.id);
			if (typeof operation.newText !== "string") {
				issues.push(rangeIssue("INVALID_EDIT", operation, `edits[${operation.index}].newText must be text.`));
				continue;
			}
			if (!Number.isSafeInteger(operation.startLine) || !Number.isSafeInteger(operation.endLine)) {
				issues.push(
					rangeIssue("INVALID_RANGE", operation, `edits[${operation.index}] line numbers must be integers.`),
				);
				continue;
			}
			const requested = { startLine: operation.startLine, endLine: operation.endLine };
			const insert = isInsertion(requested);
			const snapshot = snapshotEntry.metadata;
			const withinSnapshot = insert
				? requested.startLine >= snapshot.startLine && requested.startLine <= snapshot.endLine + 1
				: requested.startLine >= snapshot.startLine &&
					requested.endLine >= requested.startLine &&
					requested.endLine <= snapshot.endLine;
			if (
				requested.startLine < 1 ||
				(!insert && requested.endLine < requested.startLine) ||
				(!insert && requested.endLine > snapshot.totalLines) ||
				(insert && requested.startLine === snapshot.totalLines + 1 && snapshot.endLine !== snapshot.totalLines) ||
				!withinSnapshot
			) {
				issues.push(
					rangeIssue(
						"RANGE_OUTSIDE_SNAPSHOT",
						operation,
						`edits[${operation.index}] is outside the displayed snapshot range.`,
					),
				);
				continue;
			}

			const receiptKey = signature(path, snapshot.revision, operation);
			const receipt = this.receipts.get(receiptKey);
			const receiptRange = receipt
				? this.mapRange(path, receipt.resultRevision, sourceRevision, receipt.resultRange)
				: undefined;
			if (receipt && receiptRange) {
				this.touchReceipt(receipt.key);
				resolved.push({
					...operation,
					sourceRevision: snapshot.revision,
					currentRange: receiptRange,
					insert,
					rendered: [],
					status: "already_applied",
				});
				continue;
			}

			const mapped = this.mapRange(path, snapshot.revision, sourceRevision, requested);
			if (!mapped) {
				issues.push(
					rangeIssue(
						"SOURCE_CHANGED",
						operation,
						`edits[${operation.index}] overlaps an unconfirmed or changed file version.`,
					),
				);
				continue;
			}
			if (
				mapped.startLine < 1 ||
				(!isInsertion(mapped) && mapped.endLine > currentLines.length) ||
				(isInsertion(mapped) && mapped.startLine > currentLines.length + 1)
			) {
				issues.push(
					rangeIssue(
						"SOURCE_CHANGED",
						operation,
						`edits[${operation.index}] no longer maps inside the current file.`,
					),
				);
				continue;
			}
			if (!insert) {
				const sourceOffset = requested.startLine - snapshot.startLine;
				const expected = snapshotEntry.lines.slice(
					sourceOffset,
					sourceOffset + requested.endLine - requested.startLine + 1,
				);
				const actual = currentLines.slice(mapped.startLine - 1, mapped.endLine);
				if (!sameLineText(expected, actual)) {
					issues.push(
						rangeIssue(
							"SOURCE_CHANGED",
							operation,
							`edits[${operation.index}] source lines no longer match the snapshot.`,
						),
					);
					continue;
				}
			}

			const insertionEndingLine = requested.startLine <= snapshot.endLine ? mapped.startLine : mapped.startLine - 1;
			const insertionEnding = insert ? chooseLineEnding(currentLines, insertionEndingLine) : "\n";
			const hasFollowingLine = insert && requested.startLine <= snapshot.totalLines;
			const rendered = insert
				? renderInsertion(operation.newText, currentLines, mapped, insertionEnding, hasFollowingLine)
				: renderReplacement(operation.newText, currentLines, mapped);
			const unchanged = insert
				? rendered.length === 0
				: joinLines(currentLines.slice(mapped.startLine - 1, mapped.endLine)) === joinLines(rendered);
			resolved.push({
				...operation,
				sourceRevision: snapshot.revision,
				currentRange: mapped,
				insert,
				rendered,
				status: unchanged ? "unchanged" : "applied",
			});
		}

		for (let left = 0; left < resolved.length; left++) {
			for (let right = left + 1; right < resolved.length; right++) {
				if (resolved[left].status === "already_applied" || resolved[right].status === "already_applied") continue;
				if (!rangesOverlap(resolved[left].currentRange, resolved[right].currentRange)) continue;
				issues.push(
					rangeIssue(
						"EDIT_OVERLAP",
						resolved[right],
						`edits[${resolved[left].index}] overlaps edits[${resolved[right].index}]; no edit in the batch was applied.`,
					),
				);
			}
		}
		if (issues.length > 0) return this.failWithPlan(plan, sourceRevision, failureKey, issues, preview);

		const updatedLines = buildUpdatedLines(currentLines, resolved);
		const bom = stripBom(currentRawContent).bom;
		const finalContent = bom + joinLines(updatedLines);
		const resultRevision = hashContent(finalContent);
		if (resultRevision === sourceRevision) {
			for (const operation of resolved) {
				if (operation.status === "applied") operation.status = "unchanged";
			}
		}
		if (!preview && !this.storePlan(plan)) {
			issues.push({
				code: "PLAN_CAPACITY",
				editIndex: -1,
				message: "Plan cache capacity exceeded; no edit was prepared.",
			});
			return this.fail(sourceRevision, failureKey, issues, undefined, false);
		}

		const prepared: PreparedSnapshotEdit = {
			path,
			plan: plan.id,
			baseContent: normalizeToLF(stripBom(currentRawContent).text),
			newContent: normalizeToLF(stripBom(finalContent).text),
			finalContent,
			sourceRevision,
			resultRevision,
			applied: resolved.filter((operation) => operation.status === "applied").length,
			alreadyApplied: resolved.filter((operation) => operation.status === "already_applied").length,
			edits: resolved.map((operation) => ({
				index: operation.index,
				startLine: operation.currentRange.startLine,
				endLine: operation.currentRange.endLine,
				status: operation.status,
			})),
			...(preview ? { preview: true } : {}),
		};
		const appliedOperations = resolved.filter((operation) => operation.status === "applied");
		const changes = appliedOperations.map((operation) => ({
			...operation.currentRange,
			newLineCount: operation.rendered.length,
		}));
		const receipts = appliedOperations.map((operation) => {
			const resultStart = operationOutputStart(operation, resolved);
			const resultRange = {
				startLine: resultStart,
				endLine: resultStart + operation.rendered.length - 1,
			};
			const key = signature(path, operation.sourceRevision, operation);
			return { key, path, resultRevision, resultRange, bytes: Buffer.byteLength(key, "utf8") + 128 };
		});
		if (!preview && !this.hasCommitCapacity(changes, receipts)) {
			issues.push({
				code: "STATE_CAPACITY",
				editIndex: -1,
				message: "Snapshot receipt/history capacity exceeded; no edit was prepared.",
			});
			return this.fail(sourceRevision, failureKey, issues, plan.id, false);
		}
		this.prepared.set(prepared, { path, plan: plan.id, sourceRevision, resultRevision, changes, receipts });
		return prepared;
	}

	commit(prepared: PreparedSnapshotEdit): void {
		const details = this.prepared.get(prepared);
		if (!details || prepared.preview || this.committed.has(prepared)) {
			throw new Error("Prepared edit is not committable in this FileEditState.");
		}
		if (details.resultRevision !== details.sourceRevision && details.changes.length > 0) {
			const historyRecord: CommitRecord = {
				path: details.path,
				sourceRevision: details.sourceRevision,
				resultRevision: details.resultRevision,
				changes: details.changes,
				bytes: Buffer.byteLength(JSON.stringify(details.changes), "utf8") + 128,
				lastUsed: ++this.lruClock,
			};
			this.evictHistoryFor(historyRecord.bytes);
			this.history.push(historyRecord);
			this.historyBytes += historyRecord.bytes;
			for (const receipt of details.receipts) this.storeReceipt(receipt);
		}
		this.committed.add(prepared);
		this.removePlan(details.plan);
	}

	private hasCommitCapacity(changes: CommitChange[], receipts: Receipt[]): boolean {
		const historyBytes = Buffer.byteLength(JSON.stringify(changes), "utf8") + 128;
		const receiptBytes = receipts.reduce((total, receipt) => total + receipt.bytes, 0);
		return (
			changes.length <= MAX_HISTORY_RECORDS &&
			historyBytes <= MAX_HISTORY_BYTES &&
			receipts.length <= MAX_RECEIPTS &&
			receiptBytes <= MAX_RECEIPT_BYTES
		);
	}

	private evictHistoryFor(bytes: number): void {
		while (this.history.length >= MAX_HISTORY_RECORDS || this.historyBytes + bytes > MAX_HISTORY_BYTES) {
			let oldestIndex = 0;
			for (let index = 1; index < this.history.length; index++) {
				if (this.history[index].lastUsed < this.history[oldestIndex].lastUsed) oldestIndex = index;
			}
			const [oldest] = this.history.splice(oldestIndex, 1);
			if (!oldest) return;
			this.historyBytes -= oldest.bytes;
		}
	}

	private storeReceipt(receipt: Receipt): void {
		const existing = this.receipts.get(receipt.key);
		if (existing) {
			this.receipts.delete(receipt.key);
			this.receiptBytes -= existing.bytes;
		}
		while (this.receipts.size >= MAX_RECEIPTS || this.receiptBytes + receipt.bytes > MAX_RECEIPT_BYTES) {
			const oldestKey = this.receipts.keys().next().value;
			if (oldestKey === undefined) return;
			const oldest = this.receipts.get(oldestKey);
			this.receipts.delete(oldestKey);
			this.receiptBytes -= oldest?.bytes ?? 0;
		}
		this.receipts.set(receipt.key, receipt);
		this.receiptBytes += receipt.bytes;
	}

	private touchReceipt(key: string): void {
		const receipt = this.receipts.get(key);
		if (!receipt) return;
		this.receipts.delete(key);
		this.receipts.set(key, receipt);
	}

	private mapRange(path: string, fromRevision: string, toRevision: string, range: LineRange): LineRange | undefined {
		if (fromRevision === toRevision) return range;
		const queue: Array<{ revision: string; range: LineRange; visited: Set<string> }> = [
			{ revision: fromRevision, range, visited: new Set([fromRevision]) },
		];
		const results = new Map<string, LineRange>();
		const touched = new Set<CommitRecord>();
		let explored = 0;
		while (queue.length > 0 && explored < MAX_HISTORY_RECORDS * 2) {
			const current = queue.shift()!;
			for (const record of this.history) {
				if (
					record.path !== path ||
					record.sourceRevision !== current.revision ||
					current.visited.has(record.resultRevision)
				)
					continue;
				const mapped = mapRangeThroughChanges(current.range, record.changes);
				if (!mapped) continue;
				touched.add(record);
				if (record.resultRevision === toRevision) {
					results.set(`${mapped.startLine}:${mapped.endLine}`, mapped);
					if (results.size > 1) return undefined;
					continue;
				}
				const visited = new Set(current.visited);
				visited.add(record.resultRevision);
				queue.push({ revision: record.resultRevision, range: mapped, visited });
				explored++;
			}
		}
		for (const record of touched) record.lastUsed = ++this.lruClock;
		return results.values().next().value;
	}

	private failWithPlan(
		plan: PlanEntry,
		revision: string,
		failureKey: string,
		issues: SnapshotEditIssue[],
		preview: boolean,
	): never {
		if (!preview && !this.storePlan(plan)) {
			issues = [
				{
					code: "PLAN_CAPACITY",
					editIndex: -1,
					message: "Plan cache capacity exceeded; the recovery plan was not stored.",
				},
			];
			return this.fail(revision, failureKey, issues, undefined, false);
		}
		return this.fail(revision, failureKey, issues, plan.id, preview);
	}

	private fail(
		revision: string,
		failureKey: string,
		issues: SnapshotEditIssue[],
		plan: string | undefined,
		preview: boolean,
	): never {
		const previous = this.failures.get(failureKey) ?? 0;
		let attempt = previous;
		if (!preview) {
			if (this.failures.has(failureKey) || this.failures.size < MAX_FAILURE_KEYS) {
				attempt = previous + 1;
				this.failures.set(failureKey, attempt);
			} else {
				issues = [{ code: "STATE_CAPACITY", editIndex: -1, message: "Failure recovery state capacity exceeded." }];
				plan = undefined;
				attempt = 0;
			}
		}
		const code = issues[0]?.code ?? "INVALID_EDIT";
		throw new SnapshotEditError(code, issues, revision, attempt, attempt > 0 && attempt <= 2, plan);
	}

	private storePlan(plan: PlanEntry): boolean {
		plan.bytes = planByteSize(plan);
		if (plan.operations.size > MAX_PLAN_EDITS || plan.bytes > MAX_PLAN_BYTES) return false;
		const previous = this.plans.get(plan.id);
		while (
			this.plans.size - (previous ? 1 : 0) >= MAX_PLANS ||
			this.planBytes - (previous?.bytes ?? 0) + plan.bytes > MAX_PLAN_BYTES
		) {
			const oldestId = [...this.plans.keys()].find((id) => id !== plan.id);
			if (!oldestId) return false;
			this.removePlan(oldestId);
		}
		if (previous) {
			this.plans.delete(plan.id);
			this.planBytes -= previous.bytes;
		}
		this.plans.set(plan.id, { ...plan, operations: new Map(plan.operations) });
		this.planBytes += plan.bytes;
		return true;
	}

	private removePlan(id: string): void {
		const plan = this.plans.get(id);
		if (!plan) return;
		this.plans.delete(id);
		this.planBytes -= plan.bytes;
	}

	private touchPlan(id: string): void {
		const plan = this.plans.get(id);
		if (!plan) return;
		this.plans.delete(id);
		this.plans.set(id, plan);
	}

	private isSnapshotPinned(id: string): boolean {
		return [...this.plans.values()].some((plan) =>
			[...plan.operations.values()].some((operation) => operation.snapshotId === id),
		);
	}

	private touchSnapshot(id: string): void {
		const entry = this.snapshots.get(id);
		if (!entry) return;
		this.snapshots.delete(id);
		this.snapshots.set(id, entry);
	}

	private evictSnapshot(id: string): void {
		const entry = this.snapshots.get(id);
		if (!entry) return;
		this.snapshots.delete(id);
		if (this.snapshotKeys.get(entry.cacheKey) === id) this.snapshotKeys.delete(entry.cacheKey);
		this.snapshotBytes -= entry.bytes;
	}
}
