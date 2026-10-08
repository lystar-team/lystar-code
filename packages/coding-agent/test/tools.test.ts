import { applyPatch } from "diff";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executeBashWithOperations } from "../src/core/bash-executor.ts";
import type { ExtensionToolContext } from "../src/core/extensions/types.ts";
import {
	type BashOperations,
	createBashTool,
	createBashToolDefinition,
	createLocalBashOperations,
} from "../src/core/tools/bash.ts";
import { createEditToolDefinition, type EditToolOptions } from "../src/core/tools/edit.ts";
import { normalizeToLF } from "../src/core/tools/edit-diff.ts";
import { FileEditState, type SnapshotRangeEdit } from "../src/core/tools/file-edit-state.ts";
import { createFindToolDefinition } from "../src/core/tools/find.ts";
import { createGrepToolDefinition } from "../src/core/tools/grep.ts";
import { createLsToolDefinition } from "../src/core/tools/ls.ts";
import { createReadToolDefinition } from "../src/core/tools/read.ts";
import { createWriteToolDefinition } from "../src/core/tools/write.ts";
import {
	createEditTool,
	createFindTool,
	createGrepTool,
	createLsTool,
	createReadTool,
	createWriteTool,
} from "../src/index.ts";
import * as shellModule from "../src/utils/shell.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { splitBom } from "../src/utils/text.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const readTool = createReadTool(process.cwd());
const writeTool = createWriteTool(process.cwd());
const bashTool = createBashTool(process.cwd());
const grepTool = createGrepTool(process.cwd());
const findTool = createFindTool(process.cwd());
const lsTool = createLsTool(process.cwd());

// Helper to extract text from content blocks
function getTextOutput(result: any): string {
	return (
		result.content
			?.filter((c: any) => c.type === "text")
			.map((c: any) => c.text)
			.join("\n") || ""
	);
}

async function executeSnapshotEdit(
	cwd: string,
	callId: string,
	path: string,
	rawContent: string,
	edits: SnapshotRangeEdit[],
	options?: EditToolOptions,
	signal?: AbortSignal,
	context?: ExtensionToolContext,
) {
	const state = new FileEditState();
	const effectiveCwd = context?.cwd || cwd;
	const totalLines = normalizeToLF(splitBom(rawContent).text).split("\n").length;
	const snapshot = state.capture(resolve(effectiveCwd, path), rawContent, 1, totalLines);
	const tool = createEditTool(cwd, { ...options, fileEditState: state });
	return tool.execute(callId, { path, snapshot: snapshot.id, edits }, signal, undefined, context);
}

function createTinyBmp1x1Red24bpp(): Buffer {
	const buffer = Buffer.alloc(58);
	buffer.write("BM", 0, "ascii");
	buffer.writeUInt32LE(buffer.length, 2);
	buffer.writeUInt32LE(54, 10);
	buffer.writeUInt32LE(40, 14);
	buffer.writeInt32LE(1, 18);
	buffer.writeInt32LE(1, 22);
	buffer.writeUInt16LE(1, 26);
	buffer.writeUInt16LE(24, 28);
	buffer.writeUInt32LE(0, 30);
	buffer.writeUInt32LE(4, 34);
	buffer[56] = 0xff;
	return buffer;
}

describe("Coding Agent Tools", () => {
	let testDir: string;

	beforeEach(() => {
		// Create a unique temporary directory for each test
		testDir = join(tmpdir(), `coding-agent-test-${Date.now()}`);
		mkdirSync(testDir, { recursive: true });
	});

	afterEach(() => {
		vi.restoreAllMocks();
		// Clean up test directory
		rmSync(testDir, { recursive: true, force: true });
	});

	describe("read tool", () => {
		it("should read file contents that fit within limits", async () => {
			const testFile = join(testDir, "test.txt");
			const content = "Hello, world!\nLine 2\nLine 3";
			writeFileSync(testFile, content);

			const result = await readTool.execute("test-call-1", { path: testFile });

			const output = getTextOutput(result);
			expect(output).toMatch(/^\[snapshot [^;]+; lines 1-3[^\]]*\]\n1\| Hello, world!\n2\| Line 2\n3\| Line 3$/);
			// No continuation message since the complete file was displayed.
			expect(output).not.toContain("Use offset=");
			expect(result.details?.source).toMatchObject({
				snapshot: expect.any(String),
				absolutePath: testFile,
				startLine: 1,
				endLine: 3,
				totalLines: 3,
				revision: expect.any(String),
				outputHash: expect.any(String),
			});
			expect(result.structuredContent).toBe(output);
		});

		it("should handle non-existent files", async () => {
			const testFile = join(testDir, "nonexistent.txt");

			await expect(readTool.execute("test-call-2", { path: testFile })).rejects.toThrow(/ENOENT|not found/i);
		});

		it("should truncate files exceeding line limit", async () => {
			const testFile = join(testDir, "large.txt");
			const lines = Array.from({ length: 2500 }, (_, i) => `Line ${i + 1}`);
			writeFileSync(testFile, lines.join("\n"));

			const result = await readTool.execute("test-call-3", { path: testFile });
			const output = getTextOutput(result);

			expect(output).toContain("1| Line 1");
			expect(output).toContain("2000| Line 2000");
			expect(output).not.toContain("2001| Line 2001");
			expect(output).toContain("[500 more lines in file. Use offset=2001 to continue.]");
		});

		it("should truncate when byte limit exceeded", async () => {
			const testFile = join(testDir, "large-bytes.txt");
			// Create file that exceeds 50KB byte limit but has fewer than 2000 lines
			const lines = Array.from({ length: 500 }, (_, i) => `Line ${i + 1}: ${"x".repeat(200)}`);
			writeFileSync(testFile, lines.join("\n"));

			const result = await readTool.execute("test-call-4", { path: testFile });
			const output = getTextOutput(result);

			expect(output).toContain("1| Line 1:");
			// The displayed source is numbered and the remaining range is explicit.
			expect(output).toMatch(/\[\d+ more lines in file\. Use offset=\d+ to continue\.\]/);
		});

		it("should handle offset parameter", async () => {
			const testFile = join(testDir, "offset-test.txt");
			const lines = Array.from({ length: 100 }, (_, i) => `Line ${i + 1}`);
			writeFileSync(testFile, lines.join("\n"));

			const result = await readTool.execute("test-call-5", { path: testFile, offset: 51 });
			const output = getTextOutput(result);

			expect(output).not.toContain("50| Line 50");
			expect(output).toContain("51| Line 51");
			expect(output).toContain("100| Line 100");
			// No truncation message since file fits within limits
			expect(output).not.toContain("Use offset=");
		});

		it("should handle limit parameter", async () => {
			const testFile = join(testDir, "limit-test.txt");
			const lines = Array.from({ length: 100 }, (_, i) => `Line ${i + 1}`);
			writeFileSync(testFile, lines.join("\n"));

			const result = await readTool.execute("test-call-6", { path: testFile, limit: 10 });
			const output = getTextOutput(result);

			expect(output).toContain("1| Line 1");
			expect(output).toContain("10| Line 10");
			expect(output).not.toContain("11| Line 11");
			expect(output).toContain("[90 more lines in file. Use offset=11 to continue.]");
		});

		it("should handle offset + limit together", async () => {
			const testFile = join(testDir, "offset-limit-test.txt");
			const lines = Array.from({ length: 100 }, (_, i) => `Line ${i + 1}`);
			writeFileSync(testFile, lines.join("\n"));

			const result = await readTool.execute("test-call-7", {
				path: testFile,
				offset: 41,
				limit: 20,
			});
			const output = getTextOutput(result);

			expect(output).not.toContain("40| Line 40");
			expect(output).toContain("41| Line 41");
			expect(output).toContain("60| Line 60");
			expect(output).not.toContain("61| Line 61");
			expect(output).toContain("[40 more lines in file. Use offset=61 to continue.]");
		});

		it("should show error when offset is beyond file length", async () => {
			const testFile = join(testDir, "short.txt");
			writeFileSync(testFile, "Line 1\nLine 2\nLine 3");

			await expect(readTool.execute("test-call-8", { path: testFile, offset: 100 })).rejects.toThrow(
				/Offset 100 is beyond end of file \(3 lines total\)/,
			);
		});

		it("should include truncation details when truncated", async () => {
			const testFile = join(testDir, "large-file.txt");
			const lines = Array.from({ length: 2500 }, (_, i) => `Line ${i + 1}`);
			writeFileSync(testFile, lines.join("\n"));

			const result = await readTool.execute("test-call-9", { path: testFile });

			expect(result.details).toBeDefined();
			expect(result.details?.truncation).toBeDefined();
			expect(result.details?.truncation?.truncated).toBe(true);
			expect(result.details?.truncation?.truncatedBy).toBe("lines");
			expect(result.details?.truncation?.totalLines).toBe(2500);
			expect(result.details?.truncation?.outputLines).toBe(2000);
		});

		it("should detect image MIME type from file magic (not extension)", async () => {
			const png1x1Base64 =
				"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==";
			const pngBuffer = Buffer.from(png1x1Base64, "base64");

			const testFile = join(testDir, "image.txt");
			writeFileSync(testFile, pngBuffer);

			const result = await readTool.execute("test-call-img-1", { path: testFile });

			expect(result.content[0]?.type).toBe("text");
			expect(getTextOutput(result)).toContain("Read image file [image/png]");

			const imageBlock = result.content.find(
				(c): c is { type: "image"; mimeType: string; data: string } => c.type === "image",
			);
			expect(imageBlock).toBeDefined();
			expect(imageBlock?.mimeType).toBe("image/png");
			expect(typeof imageBlock?.data).toBe("string");
			expect((imageBlock?.data ?? "").length).toBeGreaterThan(0);
			// Programmatic callers get the same image as a block. https://github.com/earendil-works/pi/issues/10251
			expect(result.structuredContent).toEqual({
				type: "image",
				data: imageBlock?.data,
				mimeType: "image/png",
				note: getTextOutput(result),
			});
		});

		it("should read BMP files from disk as PNG image attachments", async () => {
			const testFile = join(testDir, "image.bmp");
			writeFileSync(testFile, createTinyBmp1x1Red24bpp());

			const result = await readTool.execute("test-call-img-bmp", { path: testFile });

			expect(result.content[0]?.type).toBe("text");
			expect(getTextOutput(result)).toContain("Read image file [image/png]");
			expect(getTextOutput(result)).toContain("[Image converted from image/bmp to image/png.]");

			const imageBlock = result.content.find(
				(c): c is { type: "image"; mimeType: string; data: string } => c.type === "image",
			);
			expect(imageBlock).toBeDefined();
			expect(imageBlock?.mimeType).toBe("image/png");
			expect(Buffer.from(imageBlock?.data ?? "", "base64")[0]).toBe(0x89);
		});

		it("should treat files with image extension but non-image content as text", async () => {
			const testFile = join(testDir, "not-an-image.png");
			writeFileSync(testFile, "definitely not a png");

			const result = await readTool.execute("test-call-img-2", { path: testFile });
			const output = getTextOutput(result);

			expect(output).toContain("definitely not a png");
			expect(result.content.some((c: any) => c.type === "image")).toBe(false);
		});
	});

	describe("write tool", () => {
		it("should write file contents", async () => {
			const testFile = join(testDir, "write-test.txt");
			const content = "Test content";

			const result = await writeTool.execute("test-call-3", { path: testFile, content });

			expect(getTextOutput(result)).toContain("Successfully wrote");
			expect(getTextOutput(result)).toContain(testFile);
			expect(result.details).toEqual({ path: testFile, operation: "created", additions: 1, deletions: 0 });
		});

		it("should report line changes when overwriting a file", async () => {
			const testFile = join(testDir, "overwrite-test.txt");
			writeFileSync(testFile, "one\ntwo\n");

			const result = await writeTool.execute("test-call-overwrite", {
				path: testFile,
				content: "one\nthree\nfour\n",
			});

			expect(result.details).toEqual({ path: testFile, operation: "updated", additions: 2, deletions: 1 });
		});

		it("should create parent directories", async () => {
			const testFile = join(testDir, "nested", "dir", "test.txt");
			const content = "Nested content";

			const result = await writeTool.execute("test-call-4", { path: testFile, content });

			expect(getTextOutput(result)).toContain("Successfully wrote");
		});
	});

	describe("edit tool", () => {
		it("should replace text in file", async () => {
			const testFile = join(testDir, "edit-test.txt");
			const originalContent = "Hello, world!";
			writeFileSync(testFile, originalContent);

			const result = await executeSnapshotEdit(process.cwd(), "test-call-5", testFile, originalContent, [
				{ startLine: 1, endLine: 1, newText: "Hello, testing!" },
			]);

			expect(getTextOutput(result)).toContain("Successfully edited");
			expect(result.details).toMatchObject({ path: testFile, status: "written", additions: 1, deletions: 1 });
			expect(result.details?.diff).toContain("testing");
			expect(result.details?.patch).toContain("--- ");
			expect(result.details?.patch).toContain("+++ ");
			expect(result.details?.patch).toContain("@@");
			expect(result.details?.patch).toContain("-Hello, world!");
			expect(result.details?.patch).toContain("+Hello, testing!");
			expect(applyPatch(originalContent, result.details?.patch ?? "")).toBe("Hello, testing!");
		});

		it("should treat a validated no-op edit as an idempotent success", async () => {
			const testFile = join(testDir, "edit-no-op.txt");
			const originalContent = "already final\n";
			writeFileSync(testFile, originalContent);

			const result = await executeSnapshotEdit(process.cwd(), "test-call-no-op", testFile, originalContent, [
				{ startLine: 1, endLine: 1, newText: "already final\n" },
			]);

			expect(getTextOutput(result)).toContain("No changes needed");
			expect(result.details).toMatchObject({ status: "unchanged", additions: 0, deletions: 0 });
			expect(readFileSync(testFile, "utf-8")).toBe(originalContent);
		});

		it("should reject an edit when the target changes before write", async () => {
			const testFile = join(testDir, "edit-write-conflict.txt");
			const original = "alpha\nbeta\n";
			writeFileSync(testFile, original);
			let readCount = 0;
			let writeCount = 0;
			const operations = {
				access: async () => {},
				readFile: async (path: string) => {
					readCount++;
					if (readCount === 2) writeFileSync(path, "changed\n");
					return readFileSync(path);
				},
				writeFile: async (path: string, content: string) => {
					writeCount++;
					writeFileSync(path, content);
				},
			};

			await expect(
				executeSnapshotEdit(testDir, "test-call-write-conflict", testFile, original, [
					{ startLine: 1, endLine: 1, newText: "ALPHA\n" },
				], { operations }),
			).rejects.toMatchObject({
				code: "SOURCE_CHANGED",
				category: "stale_state",
				retryable: false,
				details: {
					path: testFile,
					plan: expect.any(String),
					writeState: "not_written",
					issues: expect.arrayContaining([expect.objectContaining({ code: "SOURCE_CHANGED" })]),
				},
				fingerprintConstraint: { kind: "edit_snapshot", revision: expect.any(String) },
			});
			expect(writeCount).toBe(0);
			expect(readFileSync(testFile, "utf-8")).toBe("changed\n");
		});

		it("should reject a reused snapshot after a prior edit changes the file", async () => {
			const testFile = join(testDir, "edit-stale-snapshot.txt");
			const original = "alpha\nbeta\n";
			writeFileSync(testFile, original);
			const state = new FileEditState();
			const totalLines = normalizeToLF(splitBom(original).text).split("\n").length;
			const snapshot = state.capture(resolve(testFile), original, 1, totalLines);
			const tool = createEditTool(process.cwd(), { fileEditState: state });

			await tool.execute("test-call-stale-first", {
				path: testFile,
				snapshot: snapshot.id,
				edits: [{ startLine: 1, endLine: 1, newText: "ALPHA\n" }],
			});
			await expect(
				tool.execute("test-call-stale-second", {
					path: testFile,
					snapshot: snapshot.id,
					edits: [{ startLine: 1, endLine: 1, newText: "changed\n" }],
				}),
			).rejects.toMatchObject({
				code: "SOURCE_CHANGED",
				category: "stale_state",
				details: { writeState: "not_written" },
			});
			expect(readFileSync(testFile, "utf-8")).toBe("ALPHA\nbeta\n");
		});

		it("should report a missing edit target without writing", async () => {
			const missingFile = join(testDir, "missing.txt");
			const tool = createEditTool(testDir);
			await expect(
				tool.execute("test-call-missing", {
					path: missingFile,
					snapshot: "unavailable-snapshot",
					edits: [{ startLine: 1, endLine: 1, newText: "world" }],
				}),
			).rejects.toMatchObject({ code: "TARGET_NOT_FOUND", details: { path: missingFile, writeState: "not_written" } });
		});

		it("should select one repeated source line by its exact range", async () => {
			const testFile = join(testDir, "edit-repeated-lines.txt");
			const original = "foo\nfoo\nfoo\n";
			writeFileSync(testFile, original);
			await executeSnapshotEdit(process.cwd(), "test-call-repeated-lines", testFile, original, [
				{ startLine: 2, endLine: 2, newText: "bar\n" },
			]);
			expect(readFileSync(testFile, "utf-8")).toBe("foo\nbar\nfoo\n");
		});

		it("should replace the requested occurrence among duplicate source lines", async () => {
			const testFile = join(testDir, "edit-duplicate-lines.txt");
			const original = "\uFEFFbefore\r\nrepeat\r\nmiddle\r\nrepeat\r\nafter\r\nrepeat\r\n";
			writeFileSync(testFile, original);
			await executeSnapshotEdit(process.cwd(), "test-call-duplicate-lines", testFile, original, [
				{ startLine: 4, endLine: 4, newText: "changed\n" },
			]);
			expect(readFileSync(testFile, "utf-8")).toBe("\uFEFFbefore\r\nrepeat\r\nmiddle\r\nchanged\r\nafter\r\nrepeat\r\n");
		});

		it("should select a Unicode-equivalent duplicate only by its requested line range", async () => {
			const testFile = join(testDir, "edit-fuzzy-duplicate-lines.txt");
			const original = "header\n\u201ctarget\u201d\nbody\n\u201etarget\u201f\n";
			writeFileSync(testFile, original);
			await executeSnapshotEdit(process.cwd(), "test-call-fuzzy-duplicate-lines", testFile, original, [
				{ startLine: 4, endLine: 4, newText: "changed\n" },
			]);
			expect(readFileSync(testFile, "utf-8")).toBe("header\n\u201ctarget\u201d\nbody\nchanged\n");
		});

		it("should address a repeated source line beyond the former candidate display limit", async () => {
			const testFile = join(testDir, "edit-many-duplicates.txt");
			const original = Array.from({ length: 101 }, () => "target").join("\n");
			writeFileSync(testFile, original);
			await executeSnapshotEdit(process.cwd(), "test-call-many-duplicates", testFile, original, [
				{ startLine: 101, endLine: 101, newText: "changed" },
			]);
			const lines = readFileSync(testFile, "utf-8").split("\n");
			expect(lines).toHaveLength(101);
			expect(lines.slice(0, 100)).toEqual(Array.from({ length: 100 }, () => "target"));
			expect(lines[100]).toBe("changed");
		});

		it("should replace multiple disjoint regions in one call", async () => {
			const testFile = join(testDir, "edit-multi.txt");
			const original = "alpha\nbeta\ngamma\ndelta\n";
			writeFileSync(testFile, original);

			const result = await executeSnapshotEdit(process.cwd(), "test-call-8", testFile, original, [
				{ startLine: 1, endLine: 1, newText: "ALPHA\n" },
				{ startLine: 3, endLine: 3, newText: "GAMMA\n" },
			]);

			expect(getTextOutput(result)).toContain("Successfully edited");
			expect(readFileSync(testFile, "utf-8")).toBe("ALPHA\nbeta\nGAMMA\ndelta\n");
			expect(result.details?.diff).toContain("ALPHA");
			expect(result.details?.diff).toContain("GAMMA");
		});

		it("should collapse large unchanged gaps in multi-edit diffs", async () => {
			const testFile = join(testDir, "edit-multi-large-gap.txt");
			const lines = Array.from({ length: 600 }, (_, i) => `line ${String(i + 1).padStart(3, "0")}`);
			const original = `${lines.join("\n")}\n`;
			writeFileSync(testFile, original);

			const result = await executeSnapshotEdit(process.cwd(), "test-call-8b", testFile, original, [
				{ startLine: 100, endLine: 100, newText: "LINE 100\n" },
				{ startLine: 300, endLine: 300, newText: "LINE 300\n" },
				{ startLine: 500, endLine: 500, newText: "LINE 500\n" },
			]);

			const diff = result.details?.diff ?? "";
			expect(diff).toContain("LINE 100");
			expect(diff).toContain("LINE 300");
			expect(diff).toContain("LINE 500");
			expect(diff).toContain("...");
			expect(diff).not.toContain("line 250");
			expect(diff.split("\n").length).toBeLessThan(50);
		});

		it("should match edits against the original file, not incrementally", async () => {
			const testFile = join(testDir, "edit-multi-original.txt");
			const original = "foo\nbar\nbaz\n";
			writeFileSync(testFile, original);

			await executeSnapshotEdit(process.cwd(), "test-call-9", testFile, original, [
				{ startLine: 1, endLine: 1, newText: "foo bar\n" },
				{ startLine: 2, endLine: 2, newText: "BAR\n" },
			]);

			expect(readFileSync(testFile, "utf-8")).toBe("foo bar\nBAR\nbaz\n");
		});

		it("should fail when edits is empty", async () => {
			const testFile = join(testDir, "edit-empty-edits.txt");
			writeFileSync(testFile, "hello\nworld\n");

			await expect(executeSnapshotEdit(process.cwd(), "test-call-11", testFile, "hello\nworld\n", [])).rejects.toThrow(
				/at least one/i,
			);
		});

		it("should fail when multi-edit regions overlap", async () => {
			const testFile = join(testDir, "edit-overlap.txt");
			const original = "one\ntwo\nthree\n";
			writeFileSync(testFile, original);

			await expect(
				executeSnapshotEdit(process.cwd(), "test-call-12", testFile, original, [
					{ startLine: 1, endLine: 2, newText: "ONE\nTWO\n" },
					{ startLine: 2, endLine: 3, newText: "TWO\nTHREE\n" },
				]),
			).rejects.toThrow(/overlap/i);
		});

		it("should classify overlapping edits with stable recovery metadata", async () => {
			const testFile = join(testDir, "edit-overlap-metadata.txt");
			const original = "one\ntwo\nthree\n";
			writeFileSync(testFile, original);

			await expect(
				executeSnapshotEdit(process.cwd(), "test-call-overlap-metadata", testFile, original, [
					{ startLine: 1, endLine: 2, newText: "ONE\nTWO\n" },
					{ startLine: 2, endLine: 3, newText: "TWO\nTHREE\n" },
				]),
			).rejects.toMatchObject({
				code: "EDIT_OVERLAP",
				category: "precondition",
				retryable: false,
				details: {
							issues: expect.arrayContaining([
								expect.objectContaining({ code: "EDIT_OVERLAP", editIndex: 1, startLine: 2, endLine: 3 }),
							]),
					writeState: "not_written",
				},
				fingerprintConstraint: { kind: "edit_snapshot", revision: expect.any(String) },
			});
		});

		it("should keep failed edit fingerprints stable for the same source revision", async () => {
			const testFile = join(testDir, "edit-fingerprint.txt");
			const original = "current";
			writeFileSync(testFile, original);
			const firstError = await executeSnapshotEdit(process.cwd(), "test-call-fingerprint-1", testFile, original, [
				{ startLine: 2, endLine: 2, newText: "a" },
			]).then(
				() => undefined,
				(error: unknown) => error,
			);
			const secondError = await executeSnapshotEdit(process.cwd(), "test-call-fingerprint-2", testFile, original, [
				{ startLine: 3, endLine: 3, newText: "b" },
			]).then(
				() => undefined,
				(error: unknown) => error,
			);

			expect(firstError).toMatchObject({ code: expect.any(String) });
			expect(secondError).toMatchObject({ code: expect.any(String) });
			expect((firstError as { fingerprintConstraint?: unknown }).fingerprintConstraint).toEqual(
				(secondError as { fingerprintConstraint?: unknown }).fingerprintConstraint,
			);
		});

		it("should not partially apply edits when one edit fails", async () => {
			const testFile = join(testDir, "edit-no-partial.txt");
			const originalContent = "alpha\nbeta\ngamma\n";
			writeFileSync(testFile, originalContent);

			await expect(
				executeSnapshotEdit(process.cwd(), "test-call-13", testFile, originalContent, [
					{ startLine: 1, endLine: 1, newText: "ALPHA\n" },
					{ startLine: 8, endLine: 8, newText: "MISSING\n" },
				]),
			).rejects.toMatchObject({
				details: {
					writeState: "not_written",
					issues: expect.arrayContaining([expect.objectContaining({ editIndex: 1 })]),
				},
			});

			expect(readFileSync(testFile, "utf-8")).toBe(originalContent);
		});

		it("should include EACCES for read-only files", async () => {
			const testFile = join(testDir, "edit-readonly.txt");
			const original = "hello\n";
			writeFileSync(testFile, original);
			chmodSync(testFile, 0o444);

			await expect(
				executeSnapshotEdit(process.cwd(), "test-call-14", testFile, original, [
					{ startLine: 1, endLine: 1, newText: "world\n" },
				]),
			).rejects.toMatchObject({ code: "PERMISSION_DENIED", details: { path: testFile, writeState: "not_written" } });
		});

		it("should include the original error message for unknown edit access errors", async () => {
			const genericFailureOptions: EditToolOptions = {
				operations: {
					access: async () => {
						throw new Error("disk offline");
					},
					readFile: async () => Buffer.from("hello\n", "utf-8"),
					writeFile: async () => {},
				},
			};

			await expect(
				executeSnapshotEdit(testDir, "test-call-16", "broken.txt", "hello\n", [
					{ startLine: 1, endLine: 1, newText: "world\n" },
				], genericFailureOptions),
			).rejects.toMatchObject({ code: "UNCLASSIFIED", message: "disk offline" });
		});

		it("should render only supplied ranges before execution and return the real diff after execution", async () => {
			initTheme("dark");
			const testFile = join(testDir, "preview-range.txt");
			const original = "first\nsecond\nthird\nfourth\n";
			const state = new FileEditState();
			const snapshot = state.capture(resolve(testFile), original, 1, 5);
			let current = Buffer.from(original, "utf-8");
			const operations = {
				access: vi.fn(async () => {}),
				readFile: vi.fn(async () => current),
				writeFile: vi.fn(async (_path: string, content: string) => {
					current = Buffer.from(content, "utf-8");
				}),
			};
			const definition = createEditToolDefinition(testDir, { fileEditState: state, operations });
			const args = {
				path: testFile,
				snapshot: snapshot.id,
				edits: [{ startLine: 2, endLine: 3, newText: "replacement\n" }],
			};
			const preview = definition.renderCall!(args as never, theme, {
				args,
				toolCallId: "preview",
				invalidate: () => {},
				lastComponent: undefined,
				state: {},
				cwd: testDir,
				executionStarted: false,
				argsComplete: true,
				isPartial: true,
				expanded: true,
				showImages: false,
				isError: false,
			} as never);
			const previewText = stripAnsi(preview.render(120).join("\n"));
			expect(previewText).toContain("@@ read lines 2-3 @@");
			expect(previewText).toContain("replacement");
			expect(previewText).not.toContain("second");
			expect(previewText).not.toContain("third");
			expect(operations.access).not.toHaveBeenCalled();
			expect(operations.readFile).not.toHaveBeenCalled();

			const result = await definition.execute(
				"preview-execute",
				args as never,
				undefined,
				undefined,
				{ cwd: testDir } as ExtensionToolContext,
			);
			expect(result.details?.diff).toContain("-2 second");
			expect(result.details?.diff).toContain("-3 third");
			expect(result.details?.diff).toContain("+2 replacement");
		});
	});

	describe("bash tool", () => {
		it("should execute simple commands", async () => {
			const result = await bashTool.execute("test-call-8", { command: "echo 'test output'" });

			expect(getTextOutput(result)).toContain("test output");
			expect(result.details).toBeUndefined();
		});

		it("should report non-zero exit codes as error results with structured content", async () => {
			const result = await bashTool.execute("test-call-9", { command: "echo out; exit 3" });
			expect(result.isError).toBe(true);
			expect(getTextOutput(result)).toBe("out\n\n\nCommand exited with code 3");
			expect(result.structuredContent).toEqual({
				output: "out\n",
				truncated: false,
				exit_code: 3,
				wall_time_seconds: expect.any(Number),
			});

			const ok = await bashTool.execute("test-call-9b", { command: "echo fine" });
			expect(ok.isError).toBeUndefined();
			expect(ok.structuredContent).toMatchObject({ output: "fine\n", exit_code: 0 });

			const empty = await bashTool.execute("test-call-9c", { command: "true" });
			expect(getTextOutput(empty)).toBe("(no output)");
			expect(empty.structuredContent).toMatchObject({ output: "", truncated: false });
		});

		it("should return up to 1 MiB of output in structured content", async () => {
			// 3000 lines exceed the model-facing 2000 line limit but not 1 MiB.
			const medium = await bashTool.execute("test-call-9d", { command: "seq 1 3000" });
			expect(getTextOutput(medium)).not.toContain("\n1\n2\n");
			expect(medium.details?.truncation?.truncated).toBe(true);
			const mediumOutput = medium.structuredContent as { output: string; truncated: boolean };
			expect(mediumOutput.truncated).toBe(false);
			expect(mediumOutput.output).toBe(`${Array.from({ length: 3000 }, (_, i) => i + 1).join("\n")}\n`);

			// About 2 MB: keeps the first and last 512 KiB around an omission marker.
			const large = await bashTool.execute("test-call-9e", { command: "seq 1 300000" });
			const largeOutput = large.structuredContent as {
				output: string;
				truncated: boolean;
				full_output_path?: string;
			};
			expect(largeOutput.truncated).toBe(true);
			expect(largeOutput.output.startsWith("1\n2\n3\n")).toBe(true);
			expect(largeOutput.output.endsWith("299999\n300000\n")).toBe(true);
			expect(largeOutput.output).toMatch(/\n\n\[\.\.\. \d+ bytes omitted \.\.\.\]\n\n/);
			expect(Buffer.byteLength(largeOutput.output)).toBeLessThan(1024 * 1024 + 100);
			expect(largeOutput.full_output_path).toBe(large.details?.fullOutputPath);
			expect(readFileSync(largeOutput.full_output_path!, "utf-8").endsWith("300000\n")).toBe(true);
		});

		// Regression tests for https://github.com/earendil-works/pi/issues/9577
		it.skipIf(process.platform === "win32")(
			"should map signal-killed commands to 128 plus the signal number",
			async () => {
				const operations = createLocalBashOperations();
				for (const { signal, exitCode } of [
					{ signal: "KILL", exitCode: 137 },
					{ signal: "TERM", exitCode: 143 },
				]) {
					const result = await operations.exec(`kill -${signal} $$`, testDir, { onData: () => {} });
					expect(result.exitCode).toBe(exitCode);
				}
			},
		);

		it.skipIf(process.platform === "win32")(
			"should report signal-killed commands as errors while preserving partial output",
			async () => {
				for (const { signal, exitCode } of [
					{ signal: "KILL", exitCode: 137 },
					{ signal: "TERM", exitCode: 143 },
				]) {
					const result = await bashTool.execute(`test-call-signal-${signal}`, {
						command: `printf 'before-kill\\n'; kill -${signal} $$`,
					});
					expect(result.isError).toBe(true);
					expect(getTextOutput(result)).toMatch(
						new RegExp(`before-kill\\s+Command exited with code ${exitCode}$`),
					);
				}
			},
		);

		it("should reject a null exit code from custom operations", async () => {
			const operations: BashOperations = {
				exec: async (_command, _cwd, { onData }) => {
					onData(Buffer.from("partial\n", "utf-8"));
					return { exitCode: null };
				},
			};
			const bash = createBashTool(testDir, { operations });

			await expect(bash.execute("test-call-null-exit", { command: "remote" })).rejects.toThrow(
				/partial\s+Command terminated without an exit code$/,
			);
		});

		it("should respect timeout", async () => {
			const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify("setInterval(() => {}, 1000)")}`;
			await expect(bashTool.execute("test-call-10", { command, timeout: 0.05 })).rejects.toThrow(/timed out/i);
		});

		it("should include full output path for truncated timeout and abort errors", async () => {
			for (const testCase of [
				{ error: "timeout:5", expected: "Command timed out after 5 seconds" },
				{ error: "aborted", expected: "Command aborted" },
			]) {
				const operations: BashOperations = {
					exec: async (_command, _cwd, { onData }) => {
						for (let i = 1; i <= 3000; i++) {
							onData(Buffer.from(`${i}\n`, "utf-8"));
						}
						throw new Error(testCase.error);
					},
				};
				const bash = createBashTool(testDir, { operations });

				let error: unknown;
				try {
					await bash.execute(`test-call-${testCase.error}`, { command: "chatty-fail" });
				} catch (err) {
					error = err;
				}

				expect(error).toBeInstanceOf(Error);
				const message = (error as Error).message;
				expect(message).toContain(testCase.expected);
				expect(message).toMatch(/\[Showing lines \d+-\d+ of \d+\. Full output: /);
				expect(message).not.toContain("Full output: undefined");
				const fullOutputPath = message.match(/Full output: ([^\]\n]+)/)?.[1];
				expect(fullOutputPath).toBeDefined();
				expect(existsSync(fullOutputPath!)).toBe(true);
				const fullOutput = readFileSync(fullOutputPath!, "utf-8");
				expect(fullOutput).toContain("1\n2\n3");
				expect(fullOutput).toContain("2998\n2999\n3000");
			}
		});

		it("should throw error when cwd does not exist", async () => {
			const nonexistentCwd = "/this/directory/definitely/does/not/exist/12345";

			const bashToolWithBadCwd = createBashTool(nonexistentCwd);

			await expect(bashToolWithBadCwd.execute("test-call-11", { command: "echo test" })).rejects.toThrow(
				/Working directory does not exist/,
			);
		});

		it("should handle process spawn errors", async () => {
			vi.spyOn(shellModule, "ensureShellConfig").mockResolvedValueOnce({
				shell: "/nonexistent-shell-path-xyz123",
				args: ["-c"],
			});

			const bashWithBadShell = createBashTool(testDir);

			await expect(bashWithBadShell.execute("test-call-12", { command: "echo test" })).rejects.toThrow(/ENOENT/);
		});

		it("should pass shellPath through to shell resolution", async () => {
			const ensureShellConfigSpy = vi.spyOn(shellModule, "ensureShellConfig");
			const bashWithCustomShell = createBashTool(testDir, {
				shellPath: "/custom/bash",
				operations: {
					exec: async () => ({ exitCode: 0 }),
				},
			});

			await bashWithCustomShell.execute("test-call-12b", { command: "echo test" });

			expect(ensureShellConfigSpy).not.toHaveBeenCalled();

			const ops = createLocalBashOperations({ shellPath: "/custom/bash" });
			await expect(
				ops.exec("echo test", testDir, {
					onData: () => {},
				}),
			).rejects.toThrow("Custom shell path not found: /custom/bash");
			expect(ensureShellConfigSpy).toHaveBeenCalledWith("/custom/bash");
		});

		it("should send commands over stdin when shell resolution requires it", async () => {
			vi.spyOn(shellModule, "ensureShellConfig").mockResolvedValue({
				shell: process.execPath,
				args: [
					"-e",
					'let input = ""; process.stdin.setEncoding("utf8"); process.stdin.on("data", (chunk) => { input += chunk; }); process.stdin.on("end", () => { process.stdout.write(input); });',
				],
				commandTransport: "stdin",
			});
			const chunks: Buffer[] = [];
			const ops = createLocalBashOperations({ shellPath: "C:\\Windows\\System32\\bash.exe" });
			const nameExpansion = "$" + "{name}";
			const countExpansion = "$" + "{count}";
			const iExpansion = "$" + "{i}";
			const command = `name='World'; echo "Hello, ${nameExpansion}!"; count=3; for i in $(seq 1 ${countExpansion}); do echo "Iteration ${iExpansion} of ${countExpansion}"; done`;

			const result = await ops.exec(command, testDir, {
				onData: (data) => chunks.push(data),
			});

			expect(result.exitCode).toBe(0);
			expect(Buffer.concat(chunks).toString("utf-8")).toBe(command);
		});

		it("should keep the macOS Web command wrapper ahead of the login shell PATH", async () => {
			vi.spyOn(shellModule, "ensureShellConfig").mockResolvedValue({
				shell: process.execPath,
				args: [
					"-e",
					'let input = ""; process.stdin.setEncoding("utf8"); process.stdin.on("data", (chunk) => { input += chunk; }); process.stdin.on("end", () => { process.stdout.write(input); });',
				],
				commandTransport: "stdin",
			});
			const originalPlatform = process.platform;
			Object.defineProperty(process, "platform", { configurable: true, value: "darwin" });
			try {
				const chunks: Buffer[] = [];
				const ops = createLocalBashOperations();
				await ops.exec("sudo whoami", testDir, {
					onData: (data) => chunks.push(data),
					env: {
						LYSTAR_WEB_SERVICE_CHILD: "1",
						LYSTAR_WEB_COMMAND_BIN: "/tmp/lystar web/bin",
					},
				});
				expect(Buffer.concat(chunks).toString("utf8")).toBe(
					`export PATH='/tmp/lystar web/bin':"$PATH"\nsudo whoami`,
				);
			} finally {
				Object.defineProperty(process, "platform", { configurable: true, value: originalPlatform });
			}
		});

		it("should resolve legacy WSL bash.exe to stdin command transport", () => {
			if (process.platform === "win32") return;
			const originalCwd = process.cwd();
			const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
			const shellPath = "C:\\Windows\\System32\\bash.exe";
			writeFileSync(join(testDir, shellPath), "");
			try {
				process.chdir(testDir);
				Object.defineProperty(process, "platform", {
					configurable: true,
					value: "win32",
				});

				expect(shellModule.getShellConfig(shellPath)).toEqual({
					shell: shellPath,
					args: ["-s"],
					commandTransport: "stdin",
				});
			} finally {
				process.chdir(originalCwd);
				if (platformDescriptor) {
					Object.defineProperty(process, "platform", platformDescriptor);
				}
			}
		});

		it("should prepend command prefix when configured", async () => {
			const bashWithPrefix = createBashTool(testDir, {
				commandPrefix: "export TEST_VAR=hello",
			});

			const result = await bashWithPrefix.execute("test-prefix-1", { command: "echo $TEST_VAR" });
			expect(getTextOutput(result).trim()).toBe("hello");
		});

		it("should include output from both prefix and command", async () => {
			const bashWithPrefix = createBashTool(testDir, {
				commandPrefix: "echo prefix-output",
			});

			const result = await bashWithPrefix.execute("test-prefix-2", { command: "echo command-output" });
			expect(getTextOutput(result).trim()).toBe("prefix-output\ncommand-output");
		});

		it("should work without command prefix", async () => {
			const bashWithoutPrefix = createBashTool(testDir, {});

			const result = await bashWithoutPrefix.execute("test-prefix-3", { command: "echo no-prefix" });
			expect(getTextOutput(result).trim()).toBe("no-prefix");
		});

		it("should coalesce streaming updates for chatty output", async () => {
			const operations: BashOperations = {
				exec: async (_command, _cwd, { onData }) => {
					for (let i = 0; i < 5000; i++) {
						onData(Buffer.from(`line ${i}\n`, "utf-8"));
					}
					return { exitCode: 0 };
				},
			};
			const updates: Array<{ content: Array<{ type: string; text?: string }>; details?: unknown }> = [];
			const bash = createBashTool(testDir, { operations });

			const result = await bash.execute("test-call-chatty-updates", { command: "chatty" }, undefined, (update) =>
				updates.push(update),
			);

			expect(updates.length).toBeLessThan(25);
			expect(getTextOutput(result)).toContain("line 4999");
		});

		it("should not count a trailing newline as an extra truncated bash output line", async () => {
			const operations: BashOperations = {
				exec: async (_command, _cwd, { onData }) => {
					for (let i = 1; i <= 4000; i++) {
						onData(Buffer.from(`line-${String(i).padStart(4, "0")}\n`, "utf-8"));
					}
					return { exitCode: 0 };
				},
			};
			const bash = createBashTool(testDir, { operations });

			const result = await bash.execute("test-call-trailing-newline-line-count", { command: "many-lines" });
			const output = getTextOutput(result);

			expect(result.details?.truncation?.totalLines).toBe(4000);
			expect(result.details?.truncation?.outputLines).toBe(2000);
			expect(output).toContain("line-2001");
			expect(output).toContain("line-4000");
			expect(output).toMatch(/\[Showing lines 2001-4000 of 4000\. Full output: /);
			expect(output).not.toContain("4001");
		});

		it("should decode UTF-8 characters split across output chunks", async () => {
			const euro = Buffer.from("€\n", "utf-8");
			const operations: BashOperations = {
				exec: async (_command, _cwd, { onData }) => {
					onData(euro.subarray(0, 1));
					onData(euro.subarray(1));
					return { exitCode: 0 };
				},
			};
			const bash = createBashTool(testDir, { operations });

			const result = await bash.execute("test-call-split-utf8", { command: "split-utf8" });

			expect(getTextOutput(result).trim()).toBe("€");
		});

		it("should expose local bash operations for extension reuse", async () => {
			const ops = createLocalBashOperations();
			const chunks: Buffer[] = [];

			const result = await ops.exec("echo $TEST_LOCAL_BASH_OPS", testDir, {
				onData: (data) => chunks.push(data),
				env: { ...process.env, TEST_LOCAL_BASH_OPS: "from-local-ops" },
			});

			expect(result.exitCode).toBe(0);
			expect(Buffer.concat(chunks).toString("utf-8").trim()).toBe("from-local-ops");
		});

		it("should preserve executeBash sanitization when using local bash operations", async () => {
			const result = await executeBashWithOperations(
				"printf '\\033[31mred\\033[0m\\r\\n'",
				process.cwd(),
				createLocalBashOperations(),
			);

			expect(result.exitCode).toBe(0);
			expect(result.output).toBe("red\n");
		});

		it("should persist full output when truncation happens by line count only", async () => {
			const bash = createBashTool(testDir);
			const result = await bash.execute("test-call-line-truncation", { command: "seq 3000" });
			const output = getTextOutput(result);
			const fullOutputPath = result.details?.fullOutputPath;

			expect(result.details?.truncation?.truncated).toBe(true);
			expect(result.details?.truncation?.truncatedBy).toBe("lines");
			expect(fullOutputPath).toBeDefined();
			expect(output).toMatch(/\[Showing lines \d+-\d+ of \d+\. Full output: /);
			expect(output).not.toContain("Full output: undefined");

			for (let i = 0; i < 20 && (!fullOutputPath || !existsSync(fullOutputPath)); i++) {
				await new Promise((resolve) => setTimeout(resolve, 10));
			}

			expect(fullOutputPath).toBeDefined();
			expect(existsSync(fullOutputPath!)).toBe(true);
			const fullOutput = readFileSync(fullOutputPath!, "utf-8");
			expect(fullOutput).toContain("1\n2\n3");
			expect(fullOutput).toContain("2998\n2999\n3000");
		});

		it("executeBash should persist full output when truncation happens by line count only", async () => {
			const result = await executeBashWithOperations("seq 3000", process.cwd(), createLocalBashOperations());
			const fullOutputPath = result.fullOutputPath;

			expect(result.truncated).toBe(true);
			expect(fullOutputPath).toBeDefined();

			for (let i = 0; i < 20 && (!fullOutputPath || !existsSync(fullOutputPath)); i++) {
				await new Promise((resolve) => setTimeout(resolve, 10));
			}

			expect(fullOutputPath).toBeDefined();
			expect(existsSync(fullOutputPath!)).toBe(true);
			const fullOutput = readFileSync(fullOutputPath!, "utf-8");
			expect(fullOutput).toContain("1\n2\n3");
			expect(fullOutput).toContain("2998\n2999\n3000");
		});
	});

	describe("grep tool", () => {
		it("should include filename when searching a single file", async () => {
			const testFile = join(testDir, "example.txt");
			writeFileSync(testFile, "first line\nmatch line\nlast line");

			const result = await grepTool.execute("test-call-11", {
				pattern: "match",
				path: testFile,
			});

			const output = getTextOutput(result);
			expect(output).toContain("example.txt:2: match line");
		});

		it("should respect global limit and include context lines", async () => {
			const testFile = join(testDir, "context.txt");
			const content = ["before", "match one", "after", "middle", "match two", "after two"].join("\n");
			writeFileSync(testFile, content);

			const result = await grepTool.execute("test-call-12", {
				pattern: "match",
				path: testFile,
				limit: 1,
				context: 1,
			});

			const output = getTextOutput(result);
			expect(output).toContain("context.txt-1- before");
			expect(output).toContain("context.txt:2: match one");
			expect(output).toContain("context.txt-3- after");
			expect(output).toContain("[1 matches limit reached. Use limit=2 for more, or refine pattern]");
			// Ensure second match is not present
			expect(output).not.toContain("match two");
		});

		it("should treat flag-like patterns as search text", async () => {
			const marker = join(testDir, "grep-injection-marker");
			const payload = join(testDir, "payload.sh");
			const testFile = join(testDir, "target.txt");
			writeFileSync(payload, `#!/bin/sh\necho executed > ${marker}\ncat "$1"\n`);
			chmodSync(payload, 0o755);
			writeFileSync(testFile, "target\n");

			const result = await grepTool.execute("test-call-grep-injection", {
				pattern: `--pre=${payload}`,
				path: testDir,
			});

			expect(getTextOutput(result)).toContain("No matches found");
			expect(existsSync(marker)).toBe(false);
		});
	});

	describe("find tool", () => {
		it("should include hidden files that are not gitignored", async () => {
			const hiddenDir = join(testDir, ".secret");
			mkdirSync(hiddenDir);
			writeFileSync(join(hiddenDir, "hidden.txt"), "hidden");
			writeFileSync(join(testDir, "visible.txt"), "visible");

			const result = await findTool.execute("test-call-13", {
				pattern: "**/*.txt",
				path: testDir,
			});

			const outputLines = getTextOutput(result)
				.split("\n")
				.map((line) => line.trim())
				.filter(Boolean);

			expect(outputLines).toContain("visible.txt");
			expect(outputLines).toContain(".secret/hidden.txt");
		});

		it("should respect .gitignore", async () => {
			writeFileSync(join(testDir, ".gitignore"), "ignored.txt\n");
			writeFileSync(join(testDir, "ignored.txt"), "ignored");
			writeFileSync(join(testDir, "kept.txt"), "kept");

			const result = await findTool.execute("test-call-14", {
				pattern: "**/*.txt",
				path: testDir,
			});

			const output = getTextOutput(result);
			expect(output).toContain("kept.txt");
			expect(output).not.toContain("ignored.txt");
		});

		it("should surface fd glob parse errors", async () => {
			await expect(
				findTool.execute("test-call-15", {
					pattern: "[",
					path: testDir,
				}),
			).rejects.toThrow(/error parsing glob|fd exited with code 1|fd error/i);
		});

		it("should treat flag-like patterns as search text", async () => {
			const result = await findTool.execute("test-call-find-flag-pattern", {
				pattern: "--help",
				path: testDir,
			});

			expect(getTextOutput(result)).toContain("No files found matching pattern");
		});
	});

	describe("ls tool", () => {
		it("should list dotfiles and directories", async () => {
			writeFileSync(join(testDir, ".hidden-file"), "secret");
			mkdirSync(join(testDir, ".hidden-dir"));

			const result = await lsTool.execute("test-call-15", { path: testDir });
			const output = getTextOutput(result);

			expect(output).toContain(".hidden-file");
			expect(output).toContain(".hidden-dir/");
		});
	});
});

function fakeCtx(cwd: string): ExtensionToolContext {
	return { cwd } as ExtensionToolContext;
}

describe("tool cwd resolution", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = join(tmpdir(), `coding-agent-cwd-test-${Date.now()}`);
		mkdirSync(testDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	it("read uses ctx.cwd when provided", async () => {
		const testFile = join(testDir, "ctx-cwd-read.txt");
		writeFileSync(testFile, "hello from ctx.cwd");
		const tool = createReadToolDefinition("/");
		const result = await tool.execute(
			"test-read-ctx-cwd",
			{ path: "ctx-cwd-read.txt" },
			undefined,
			undefined,
			fakeCtx(testDir),
		);
		const output = getTextOutput(result);
		expect(output).toContain("hello from ctx.cwd");
	});

	it("write uses ctx.cwd when provided", async () => {
		const tool = createWriteToolDefinition("/");
		await tool.execute(
			"test-write-ctx-cwd",
			{ path: "ctx-cwd-write.txt", content: "written via ctx.cwd" },
			undefined,
			undefined,
			fakeCtx(testDir),
		);
		const content = readFileSync(join(testDir, "ctx-cwd-write.txt"), "utf-8");
		expect(content).toBe("written via ctx.cwd");
	});

	it("edit uses ctx.cwd when provided", async () => {
		const testFile = join(testDir, "ctx-cwd-edit.txt");
		writeFileSync(testFile, "old text");
		const tool = createEditToolDefinition("/");
		await executeSnapshotEdit(
			"/",
			"test-edit-ctx-cwd",
			"ctx-cwd-edit.txt",
			"old text",
			[{ startLine: 1, endLine: 1, newText: "new text" }],
			undefined,
			undefined,
			fakeCtx(testDir),
		);
		const content = readFileSync(testFile, "utf-8");
		expect(content).toBe("new text");
	});

	it("grep uses ctx.cwd when provided", async () => {
		const testFile = join(testDir, "ctx-cwd-grep.txt");
		writeFileSync(testFile, "match in ctx.cwd");
		const tool = createGrepToolDefinition("/");
		const result = await tool.execute(
			"test-grep-ctx-cwd",
			{ pattern: "match" },
			undefined,
			undefined,
			fakeCtx(testDir),
		);
		const output = getTextOutput(result);
		expect(output).toContain("ctx-cwd-grep.txt");
	});

	it("find uses ctx.cwd when provided", async () => {
		writeFileSync(join(testDir, "ctx-cwd-find.txt"), "find me");
		const tool = createFindToolDefinition("/");
		const result = await tool.execute(
			"test-find-ctx-cwd",
			{ pattern: "ctx-cwd-find.txt" },
			undefined,
			undefined,
			fakeCtx(testDir),
		);
		const output = getTextOutput(result);
		expect(output).toContain("ctx-cwd-find.txt");
	});

	it("ls uses ctx.cwd when provided", async () => {
		writeFileSync(join(testDir, "ctx-cwd-ls.txt"), "list me");
		const tool = createLsToolDefinition("/");
		const result = await tool.execute("test-ls-ctx-cwd", {}, undefined, undefined, fakeCtx(testDir));
		const output = getTextOutput(result);
		expect(output).toContain("ctx-cwd-ls.txt");
	});

	it("bash uses ctx.cwd when provided", async () => {
		const tool = createBashToolDefinition("/", { exposeSessionEnvironment: false });
		const result = await tool.execute(
			"test-bash-ctx-cwd",
			{ command: "pwd" },
			undefined,
			undefined,
			fakeCtx(testDir),
		);
		const output = getTextOutput(result);
		expect(output).toContain(testDir);
	});
});

describe("edit tool explicit line ranges", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = join(tmpdir(), `coding-agent-fuzzy-test-${Date.now()}`);
		mkdirSync(testDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	it("should preserve whitespace outside the selected line range", async () => {
		const testFile = join(testDir, "trailing-ws.txt");
		const original = "line one   \nline two  \nline three\n";
		writeFileSync(testFile, original);
		const result = await executeSnapshotEdit(process.cwd(), "range-ws", testFile, original, [
			{ startLine: 1, endLine: 1, newText: "replaced\n" },
		]);

		expect(getTextOutput(result)).toContain("Successfully edited");
		expect(readFileSync(testFile, "utf-8")).toBe("replaced\nline two  \nline three\n");
	});

	it("should replace explicitly selected Chinese source lines", async () => {
		const testFile = join(testDir, "chinese-punctuation.txt");
		const original = "你好，世界\n你好（世界）\n";
		writeFileSync(testFile, original);

		const result = await executeSnapshotEdit(process.cwd(), "range-chinese", testFile, original, [
			{ startLine: 1, endLine: 2, newText: "你好，pi\n你好(pi)\n" },
		]);

		expect(getTextOutput(result)).toContain("Successfully edited");
		expect(readFileSync(testFile, "utf-8")).toBe("你好，pi\n你好(pi)\n");
	});

	it("should replace Unicode source lines by their snapshot range", async () => {
		const testFile = join(testDir, "unicode-compatibility.txt");
		const original = "ＡＢＣ１２３\ncafe\u0301\n";
		writeFileSync(testFile, original);

		const result = await executeSnapshotEdit(process.cwd(), "range-unicode", testFile, original, [
			{ startLine: 1, endLine: 2, newText: "XYZ789\ncoffee\n" },
		]);

		expect(getTextOutput(result)).toContain("Successfully edited");
		expect(readFileSync(testFile, "utf-8")).toBe("XYZ789\ncoffee\n");
	});

	it("should replace the selected line containing smart single quotes", async () => {
		const testFile = join(testDir, "smart-quotes.txt");
		const original = "console.log(\u2018hello\u2019);\n";
		writeFileSync(testFile, original);

		const result = await executeSnapshotEdit(process.cwd(), "range-smart-single-quotes", testFile, original, [
			{ startLine: 1, endLine: 1, newText: "console.log('world');\n" },
		]);

		expect(getTextOutput(result)).toContain("Successfully edited");
		expect(readFileSync(testFile, "utf-8")).toBe("console.log('world');\n");
	});

	it("should replace the selected line containing smart double quotes", async () => {
		const testFile = join(testDir, "smart-double-quotes.txt");
		const original = "const msg = \u201CHello World\u201D;\n";
		writeFileSync(testFile, original);

		const result = await executeSnapshotEdit(process.cwd(), "range-smart-double-quotes", testFile, original, [
			{ startLine: 1, endLine: 1, newText: 'const msg = "Goodbye";\n' },
		]);

		expect(getTextOutput(result)).toContain("Successfully edited");
		expect(readFileSync(testFile, "utf-8")).toBe('const msg = "Goodbye";\n');
	});

	it("should replace explicitly selected lines containing Unicode dashes", async () => {
		const testFile = join(testDir, "unicode-dashes.txt");
		const original = "range: 1\u20135\nbreak\u2014here\n";
		writeFileSync(testFile, original);

		const result = await executeSnapshotEdit(process.cwd(), "range-unicode-dashes", testFile, original, [
			{ startLine: 1, endLine: 2, newText: "range: 10-50\nbreak--here\n" },
		]);

		expect(getTextOutput(result)).toContain("Successfully edited");
		expect(readFileSync(testFile, "utf-8")).toBe("range: 10-50\nbreak--here\n");
	});

	it("should replace the selected line containing a non-breaking space", async () => {
		const testFile = join(testDir, "nbsp.txt");
		const original = "hello\u00A0world\n";
		writeFileSync(testFile, original);

		const result = await executeSnapshotEdit(process.cwd(), "range-nbsp", testFile, original, [
			{ startLine: 1, endLine: 1, newText: "hello universe\n" },
		]);

		expect(getTextOutput(result)).toContain("Successfully edited");
		expect(readFileSync(testFile, "utf-8")).toBe("hello universe\n");
	});

	it("should edit only the explicitly selected line when another line is similar", async () => {
		const testFile = join(testDir, "exact-preferred.txt");
		const original = "const x = 'exact';\nconst y = 'other';\n";
		writeFileSync(testFile, original);

		const result = await executeSnapshotEdit(process.cwd(), "range-exact-line", testFile, original, [
			{ startLine: 1, endLine: 1, newText: "const x = 'changed';\n" },
		]);

		expect(getTextOutput(result)).toContain("Successfully edited");
		expect(readFileSync(testFile, "utf-8")).toBe("const x = 'changed';\nconst y = 'other';\n");
	});

	it("should reject a range outside the returned snapshot", async () => {
		const testFile = join(testDir, "invalid-range.txt");
		const original = "completely different content";
		writeFileSync(testFile, original);

		await expect(
			executeSnapshotEdit(process.cwd(), "invalid-range", testFile, original, [
				{ startLine: 2, endLine: 2, newText: "replacement" },
			]),
		).rejects.toMatchObject({
			details: { writeState: "not_written", issues: expect.arrayContaining([expect.objectContaining({ editIndex: 0 })]) },
		});
		expect(readFileSync(testFile, "utf-8")).toBe(original);
	});

	it("should select one similar line without changing its duplicate", async () => {
		const testFile = join(testDir, "fuzzy-dups.txt");
		const original = "hello world   \nhello world\n";
		writeFileSync(testFile, original);

		await executeSnapshotEdit(process.cwd(), "range-similar-line", testFile, original, [
			{ startLine: 2, endLine: 2, newText: "replaced\n" },
		]);
		expect(readFileSync(testFile, "utf-8")).toBe("hello world   \nreplaced\n");
	});

	it("should apply multiple explicit ranges to Unicode source lines", async () => {
		const testFile = join(testDir, "fuzzy-multi.txt");
		const original = "console.log(\u2018hello\u2019);\nhello\u00A0world\n";
		writeFileSync(testFile, original);

		await executeSnapshotEdit(process.cwd(), "range-unicode-multi", testFile, original, [
			{ startLine: 1, endLine: 1, newText: "console.log('world');\n" },
			{ startLine: 2, endLine: 2, newText: "hello universe\n" },
		]);

		expect(readFileSync(testFile, "utf-8")).toBe("console.log('world');\nhello universe\n");
	});

	it("should apply disjoint ranges independently when lines have similar text", async () => {
		const testFile = join(testDir, "fuzzy-independent-tiers.txt");
		const original = '\u201ctarget\u201d\n"exact"\n\u201cexact\u201d\n';
		writeFileSync(testFile, original);

		await executeSnapshotEdit(process.cwd(), "range-independent-lines", testFile, original, [
			{ startLine: 1, endLine: 1, newText: '"changed"\n' },
			{ startLine: 3, endLine: 3, newText: "precise\n" },
		]);

		expect(readFileSync(testFile, "utf-8")).toBe('"changed"\n"exact"\nprecise\n');
	});

	it("should replace one indented source line without changing the next line", async () => {
		const testFile = join(testDir, "fuzzy-indent-boundary.txt");
		const original = "\tfoo();\n\tbar();\n";
		writeFileSync(testFile, original);

		await executeSnapshotEdit(process.cwd(), "range-indent-boundary", testFile, original, [
			{ startLine: 1, endLine: 1, newText: "  baz();\n" },
		]);

		expect(readFileSync(testFile, "utf-8")).toBe("  baz();\n\tbar();\n");
	});

	it("should accept adjacent but disjoint source ranges", async () => {
		const testFile = join(testDir, "fuzzy-adjacent-edits.txt");
		const original = "\tfoo();\n\tbar();\n";
		writeFileSync(testFile, original);

		await executeSnapshotEdit(process.cwd(), "range-adjacent-edits", testFile, original, [
			{ startLine: 1, endLine: 1, newText: "  baz();\n" },
			{ startLine: 2, endLine: 2, newText: "\tqux();\n" },
		]);

		expect(readFileSync(testFile, "utf-8")).toBe("  baz();\n\tqux();\n");
	});

	it("should keep the selected range distinct from a nearby identical replacement", async () => {
		const testFile = join(testDir, "fuzzy-preserve-duplicate-line.txt");
		const original = ["replace me\u0020\u0020\u0020", "after\u0020\u0020\u0020", ""].join("\n");
		writeFileSync(testFile, original);

		const result = await executeSnapshotEdit(process.cwd(), "range-preserve-duplicate-line", testFile, original, [
			{ startLine: 1, endLine: 1, newText: "after\n" },
		]);

		const expectedContent = ["after", "after\u0020\u0020\u0020", ""].join("\n");
		expect(readFileSync(testFile, "utf-8")).toBe(expectedContent);
		expect(applyPatch(original, result.details?.patch ?? "")).toBe(expectedContent);
	});

	it("should preserve untouched lines and produce an applicable patch for explicit multi-ranges", async () => {
		const testFile = join(testDir, "fuzzy-preserve-multi.txt");
		const originalContent = [
			"keep before\u0020\u0020",
			"first target\u0020\u0020",
			"first after",
			"keep middle\u0020\u0020\u0020",
			"second target\u0020\u0020",
			"second after",
			"keep after\u0020\u0020",
			"",
		].join("\n");
		writeFileSync(testFile, originalContent);

		const result = await executeSnapshotEdit(process.cwd(), "range-preserve-multi", testFile, originalContent, [
			{ startLine: 2, endLine: 3, newText: "FIRST\nFIRST2\n" },
			{ startLine: 5, endLine: 6, newText: "SECOND\nSECOND2\n" },
		]);

		const expectedContent = [
			"keep before\u0020\u0020",
			"FIRST",
			"FIRST2",
			"keep middle\u0020\u0020\u0020",
			"SECOND",
			"SECOND2",
			"keep after\u0020\u0020",
			"",
		].join("\n");
		expect(readFileSync(testFile, "utf-8")).toBe(expectedContent);
		expect(applyPatch(originalContent, result.details?.patch ?? "")).toBe(expectedContent);
	});
});

describe("edit tool CRLF handling", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = join(tmpdir(), `coding-agent-crlf-test-${Date.now()}`);
		mkdirSync(testDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	it("should edit a selected line in CRLF content and preserve its line endings", async () => {
		const testFile = join(testDir, "crlf-test.txt");
		const original = "line one\r\nline two\r\nline three\r\n";
		writeFileSync(testFile, original);

		const result = await executeSnapshotEdit(process.cwd(), "range-crlf-one", testFile, original, [
			{ startLine: 2, endLine: 2, newText: "replaced line\n" },
		]);

		expect(getTextOutput(result)).toContain("Successfully edited");
		expect(readFileSync(testFile, "utf-8")).toBe("line one\r\nreplaced line\r\nline three\r\n");
	});

	it("should preserve CRLF line endings after edit", async () => {
		const testFile = join(testDir, "crlf-preserve.txt");
		const original = "first\r\nsecond\r\nthird\r\n";
		writeFileSync(testFile, original);

		await executeSnapshotEdit(process.cwd(), "range-crlf-preserve", testFile, original, [
			{ startLine: 2, endLine: 2, newText: "REPLACED\n" },
		]);

		const content = readFileSync(testFile, "utf-8");
		expect(content).toBe("first\r\nREPLACED\r\nthird\r\n");
	});

	it("should preserve LF line endings for LF files", async () => {
		const testFile = join(testDir, "lf-preserve.txt");
		const original = "first\nsecond\nthird\n";
		writeFileSync(testFile, original);

		await executeSnapshotEdit(process.cwd(), "range-lf-preserve", testFile, original, [
			{ startLine: 2, endLine: 2, newText: "REPLACED\n" },
		]);

		const content = readFileSync(testFile, "utf-8");
		expect(content).toBe("first\nREPLACED\nthird\n");
	});

	it("should edit only the selected line when CRLF and LF endings coexist", async () => {
		const testFile = join(testDir, "mixed-endings.txt");
		const original = "hello\r\nworld\r\n---\r\nhello\nworld\n";
		writeFileSync(testFile, original);

		await executeSnapshotEdit(process.cwd(), "range-mixed-endings", testFile, original, [
			{ startLine: 4, endLine: 4, newText: "replaced\n" },
		]);
		expect(readFileSync(testFile, "utf-8")).toBe("hello\r\nworld\r\n---\r\nreplaced\nworld\n");
	});

	it("should preserve UTF-8 BOM after edit", async () => {
		const testFile = join(testDir, "bom-test.txt");
		const original = "\uFEFFfirst\r\nsecond\r\nthird\r\n";
		writeFileSync(testFile, original);

		await executeSnapshotEdit(process.cwd(), "range-bom", testFile, original, [
			{ startLine: 2, endLine: 2, newText: "REPLACED\n" },
		]);

		const content = readFileSync(testFile, "utf-8");
		expect(content).toBe("\uFEFFfirst\r\nREPLACED\r\nthird\r\n");
	});

	it("should preserve CRLF line endings and BOM in multi-edit mode", async () => {
		const testFile = join(testDir, "bom-crlf-multi.txt");
		const original = "\uFEFFfirst\r\nsecond\r\nthird\r\nfourth\r\n";
		writeFileSync(testFile, original);

		await executeSnapshotEdit(process.cwd(), "range-crlf-multi", testFile, original, [
			{ startLine: 2, endLine: 2, newText: "SECOND\n" },
			{ startLine: 4, endLine: 4, newText: "FOURTH\n" },
		]);

		const content = readFileSync(testFile, "utf-8");
		expect(content).toBe("\uFEFFfirst\r\nSECOND\r\nthird\r\nFOURTH\r\n");
	});
});
