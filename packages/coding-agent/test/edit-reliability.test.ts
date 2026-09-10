import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyPatch } from "diff";
import { afterEach, describe, expect, it } from "vitest";
import { applyEditsToNormalizedContent as applyHarnessEdits } from "../../agent/src/harness/tools/edit-diff.ts";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { createEditTool, createEditToolDefinition } from "../src/core/tools/edit.ts";
import { applyEditsToNormalizedContent, type Edit } from "../src/core/tools/edit-diff.ts";

type ApplyEdits = typeof applyEditsToNormalizedContent;
const implementations: Array<[string, ApplyEdits]> = [
	["coding-agent", applyEditsToNormalizedContent],
	["harness", applyHarnessEdits],
];
const directories: string[] = [];

async function fixture(content: string) {
	const directory = await mkdtemp(join(tmpdir(), "pi-edit-reliability-"));
	directories.push(directory);
	const path = join(directory, "target.txt");
	await writeFile(path, content);
	return { directory, path, tool: createEditTool(directory) };
}

afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

interface RecoveryResolution {
	type: string;
	replacementResult: {
		content: Array<{ type: string; text: string }>;
		details: { recovery: { evidenceLines: number; candidateLines: number[]; targetChanged: boolean } };
	};
}

async function recover(tool: ReturnType<typeof createEditTool>, edits: Edit[], beforeRecovery?: () => Promise<void>) {
	let failure: unknown;
	try {
		await tool.execute("failed", { path: "target.txt", edits });
	} catch (error) {
		failure = error;
	}
	expect(failure).toBeInstanceOf(Error);
	const handler = (failure as { [key: symbol]: (context: object) => Promise<RecoveryResolution> })[
		Symbol.for("pi.toolRecoveryHandler")
	];
	expect(handler).toBeTypeOf("function");
	await beforeRecovery?.();
	const result = await handler({});
	return { result, text: result.replacementResult.content.map((part) => part.text).join("\n") };
}

for (const [name, apply] of implementations) {
	describe(`${name} edit interval invariants`, () => {
		for (const prefix of ["", "header\n", "\tbefore  \n\n"]) {
			for (const suffix of ["", "\n", "\n\tuntouched  \n"]) {
				it(`preserves surrounding bytes for a Unicode inline edit ${JSON.stringify([prefix, suffix])}`, () => {
					const original = `${prefix}\tlog(“x”);${suffix}`;
					const result = apply(original, [{ oldText: 'log("x");', newText: 'log("y");' }], "memory.txt");
					expect(result.newContent).toBe(`${prefix}\tlog("y");${suffix}`);
				});
			}
		}

		it("retains explicit indentation and adjacent whole-line replacements", () => {
			expect(
				apply(
					"\tfoo();\n\tbar();\n",
					[
						{ oldText: "  foo();\n", newText: "  baz();\n" },
						{ oldText: "\tbar();\n", newText: "\tqux();\n" },
					],
					"memory.txt",
				).newContent,
			).toBe("  baz();\n\tqux();\n");
		});

		it("preserves indentation when an edit ends at the next line boundary", () => {
			expect(
				apply(
					"head\n\t“one”\n\t“two”\n",
					[
						{ oldText: '"one"\n', newText: '"ONE"\n' },
						{ oldText: '"two"', newText: '"TWO"' },
					],
					"memory.txt",
				).newContent,
			).toBe('head\n\t"ONE"\n\t"TWO"\n');
		});

		it("does not remove trailing whitespace outside an inline match", () => {
			expect(apply("head\n\t“one”   \n", [{ oldText: '"one"', newText: "two" }], "memory.txt").newContent).toBe(
				"head\n\ttwo   \n",
			);
		});

		it("retains blank lines and maps Unicode graphemes as complete units", () => {
			expect(
				apply("head\n  \n\tﬀ café 👩‍💻\n", [{ oldText: "ff cafe\u0301 👩‍💻", newText: "done" }], "memory.txt")
					.newContent,
			).toBe("head\n  \n\tdone\n");
			expect(() => apply("ﬀ\n", [{ oldText: "f", newText: "x" }], "memory.txt")).toThrow("Could not find");
		});

		it.each(["ababa", "aaaaa"])("rejects overlapping occurrences in %s", (content) => {
			const oldText = content === "ababa" ? "aba" : "aaa";
			expect(() => apply(content, [{ oldText, newText: "X" }], "memory.txt")).toThrow(
				`Found ${content === "ababa" ? 2 : 3} occurrences`,
			);
		});

		it("finds overlapping occurrences after Unicode normalization", () => {
			expect(() => apply("ａｂａｂａ", [{ oldText: "aba", newText: "X" }], "memory.txt")).toThrow(
				"Found 2 occurrences",
			);
		});

		it("reports every independently diagnosable issue in one batch", () => {
			let failure: unknown;
			try {
				apply(
					"alpha beta gamma\nrepeat\nrepeat\n",
					[
						{ oldText: "missing-one", newText: "one" },
						{ oldText: "repeat", newText: "two" },
						{ oldText: "missing-two", newText: "three" },
						{ oldText: "alpha beta", newText: "four" },
						{ oldText: "beta gamma", newText: "five" },
						{ oldText: "", newText: "six" },
					],
					"memory.txt",
				);
			} catch (error) {
				failure = error;
			}
			expect(failure).toMatchObject({
				issueCount: 5,
				totalEdits: 6,
				issues: expect.arrayContaining([
					expect.objectContaining({ code: "MATCH_NOT_FOUND", editIndex: 0 }),
					expect.objectContaining({ code: "MATCH_AMBIGUOUS", editIndex: 1, candidateLines: [2, 3] }),
					expect.objectContaining({ code: "MATCH_NOT_FOUND", editIndex: 2 }),
					expect.objectContaining({ code: "EDIT_OVERLAP", editIndex: 3, overlapEditIndex: 4 }),
					expect.objectContaining({ code: "EMPTY_OLD_TEXT", editIndex: 5 }),
				]),
			});
			expect((failure as Error).message).toContain("5 issue(s)");
			expect((failure as Error).message).toContain("No changes were written");
		});

		it("counts every overlapping pair, including nested intervals", () => {
			try {
				apply(
					"abcdefghij",
					[
						{ oldText: "abcdefghij", newText: "outer" },
						{ oldText: "bcdef", newText: "middle" },
						{ oldText: "cde", newText: "inner" },
					],
					"memory.txt",
				);
				throw new Error("expected rejection");
			} catch (error) {
				expect(error).toMatchObject({
					issueCount: 3,
					issues: [
						expect.objectContaining({ editIndex: 0, overlapEditIndex: 1 }),
						expect.objectContaining({ editIndex: 0, overlapEditIndex: 2 }),
						expect.objectContaining({ editIndex: 1, overlapEditIndex: 2 }),
					],
				});
			}
		});

		it("bounds stored issues without losing the count", () => {
			try {
				apply(
					"current",
					Array.from({ length: 100 }, (_, index) => ({ oldText: `missing-${index}`, newText: "next" })),
					"memory.txt",
				);
				throw new Error("expected rejection");
			} catch (error) {
				expect(error).toMatchObject({ issueCount: 100, totalEdits: 100 });
				expect((error as { issues: unknown[] }).issues.length).toBeLessThanOrEqual(20);
				expect((error as Error).message.length).toBeLessThan(6000);
			}
		});
	});
}

describe("edit recovery evidence and write outcomes", () => {
	it("returns the beginning of a block when only its last anchor survives", async () => {
		const anchor = "THE_STABLE_LONG_ANCHOR_AT_END_OF_TARGET_BLOCK";
		const current = [...Array.from({ length: 11 }, (_, index) => `current-${index}`), anchor].join("\n");
		const oldText = [...Array.from({ length: 11 }, (_, index) => `old-${index}`), anchor].join("\n");
		const { tool, path } = await fixture(current);
		const { text } = await recover(tool, [{ oldText, newText: "replacement" }]);
		expect(text).toContain("current-0");
		expect(text).toContain(anchor);
		expect(text).not.toMatch(/^\d+: /m);
		expect(await readFile(path, "utf8")).toBe(current);
	});

	it("shows all long ambiguous candidates within the evidence budget", async () => {
		const block = Array.from({ length: 80 }, (_, index) => `duplicate-block-line-${index}`).join("\n");
		const current = Array.from(
			{ length: 5 },
			(_, index) => `${block}\n${Array.from({ length: 50 }, (_, row) => `gap-${index}-${row}`).join("\n")}`,
		).join("\n");
		const { tool } = await fixture(current);
		const { text, result } = await recover(tool, [{ oldText: `${block}\n`, newText: "replacement\n" }]);
		expect(result.replacementResult.details.recovery.candidateLines).toEqual([1, 131, 261, 391, 521]);
		for (let index = 0; index < 5; index++) expect(text).toContain(`gap-${index}-0`);
		expect(result.replacementResult.details.recovery.evidenceLines).toBeLessThanOrEqual(200);
		expect(Buffer.byteLength(text)).toBeLessThanOrEqual(16 * 1024);
	});

	it("does not label the first occurrence of a repeated anchor as the only target", async () => {
		const { tool } = await fixture(
			"function first() {\nshared long anchor\ncurrent-one\n}\nfunction second() {\nshared long anchor\ncurrent-two\n}\n",
		);
		const { text } = await recover(tool, [{ oldText: "shared long anchor\nmissing-value", newText: "replacement" }]);
		expect(text).toContain("current-one");
		expect(text).toContain("current-two");
	});

	it("does not present the start of an unrelated file as located evidence", async () => {
		const { tool } = await fixture("completely unrelated file content\n");
		const { text } = await recover(tool, [{ oldText: "missing target", newText: "replacement" }]);
		expect(text).toContain("未定位");
		expect(text).not.toContain("completely unrelated file content");
	});

	it("relocates candidates if the file changes between failure and recovery", async () => {
		const original = "old-head\nduplicate target\nmiddle\nduplicate target\n";
		const { tool, path } = await fixture(original);
		const { text, result } = await recover(
			tool,
			[{ oldText: "duplicate target", newText: "replacement" }],
			async () => {
				await writeFile(path, `new-head\n${original}`);
			},
		);
		expect(result.replacementResult.details.recovery).toMatchObject({ targetChanged: true, candidateLines: [3, 5] });
		expect(text).toContain("已变化");
		expect(await readFile(path, "utf8")).toBe(`new-head\n${original}`);
	});

	it("provides batch issues for overlap failures without writing valid blocks", async () => {
		const { tool, path } = await fixture("one\ntwo\nthree\nfour\n");
		const { text } = await recover(tool, [
			{ oldText: "one\ntwo\n", newText: "ONE\nTWO\n" },
			{ oldText: "two\nthree\n", newText: "TWO\nTHREE\n" },
			{ oldText: "four", newText: "FOUR" },
		]);
		expect(text).toContain("overlap");
		expect(text).toContain("No changes were written");
		expect(await readFile(path, "utf8")).toBe("one\ntwo\nthree\nfour\n");
	});

	it("keeps source snippets useful for long Unicode lines and fence characters", async () => {
		const current = `head\n${"中文".repeat(10000)} stable anchor\n\`\`\`\n`;
		const { tool } = await fixture(current);
		const { text } = await recover(tool, [
			{ oldText: `head\n${"中文".repeat(10000)} stable anchor\nmissing`, newText: "replacement" },
		]);
		expect(Buffer.byteLength(text)).toBeLessThanOrEqual(16 * 1024);
		expect(text).toContain("中文");
		expect(text).not.toContain("\uFFFD");
		expect(text).toContain("read");
	});

	it("reports a completed write when cancellation arrives during the write", async () => {
		const { directory, path } = await fixture("before\n");
		const controller = new AbortController();
		const tool = createEditTool(directory, {
			operations: {
				access: async () => {},
				readFile,
				writeFile: async (target, content) => {
					await writeFile(target, content);
					controller.abort();
				},
			},
		});
		await expect(
			tool.execute("cancel", { path, edits: [{ oldText: "before", newText: "after" }] }, controller.signal),
		).rejects.toMatchObject({
			details: { writeState: "written" },
			message: expect.stringContaining("File was written"),
		});
		expect(await readFile(path, "utf8")).toBe("after\n");
	});

	it("reports an unknown write state when an operation writes and then throws", async () => {
		const { directory, path } = await fixture("before\n");
		const tool = createEditTool(directory, {
			operations: {
				access: async () => {},
				readFile,
				writeFile: async (target, content) => {
					await writeFile(target, content);
					throw new Error("connection lost");
				},
			},
		});
		await expect(
			tool.execute("unknown", { path, edits: [{ oldText: "before", newText: "after" }] }),
		).rejects.toMatchObject({
			details: { writeState: "unknown" },
			message: expect.stringContaining("Write outcome is unknown"),
		});
	});

	it("uses the execution context cwd for the mutation key", async () => {
		const { directory, path } = await fixture("before\n");
		const tool = createEditToolDefinition("/");
		expect(await tool.getExecutionKeys?.({ path: "target.txt" }, { cwd: directory } as ExtensionContext)).toEqual([
			path,
		]);
	});

	it("returns an applicable patch after an inline Unicode replacement", async () => {
		const current = "head\n\tlog(“x”);\n\tuntouched  \n";
		const { tool, path } = await fixture(current);
		const result = await tool.execute("patch", { path, edits: [{ oldText: 'log("x");', newText: 'log("y");' }] });
		const expected = 'head\n\tlog("y");\n\tuntouched  \n';
		expect(await readFile(path, "utf8")).toBe(expected);
		expect(applyPatch(current, result.details?.patch ?? "")).toBe(expected);
	});
});
