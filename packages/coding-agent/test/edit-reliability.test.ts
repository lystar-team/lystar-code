import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyPatch } from "diff";
import { afterEach, describe, expect, it } from "vitest";
import { applyEditsToNormalizedContent as applyDurableEdits } from "../../durable/src/tools/edit-diff.ts";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { createEditTool, createEditToolDefinition } from "../src/core/tools/edit.ts";
import { applyEditsToNormalizedContent, type Edit, type EditIssue } from "../src/core/tools/edit-diff.ts";

type ApplyEdits = typeof applyEditsToNormalizedContent;
const implementations: Array<[string, ApplyEdits]> = [
	["coding-agent", applyEditsToNormalizedContent],
	["durable", applyDurableEdits],
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
		details: { recovery: { code: string; issues: EditIssue[]; sourceRevision: string } };
	};
}

async function recover(
	tool: ReturnType<typeof createEditTool>,
	edits: Edit[],
): Promise<{ failure: unknown; result: RecoveryResolution; text: string }> {
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
	const result = await handler({});
	return { failure, result, text: result.replacementResult.content.map((part) => part.text).join("\n") };
}

for (const [name, apply] of implementations) {
	describe(`${name} edit interval invariants`, () => {
		for (const prefix of ["", "header\n", "\tbefore  \n\n"]) {
			for (const suffix of ["", "\n", "\n\tuntouched  \n"]) {
				it(`preserves surrounding bytes for a Unicode inline edit ${JSON.stringify([prefix, suffix])}`, () => {
					const original = `${prefix}\tlog(“x”);${suffix}`;
					const result = apply(original, [{ oldText: name === "coding-agent" ? "log(“x”);" : 'log("x");', newText: 'log("y");' }], "memory.txt");
					expect(result.newContent).toBe(`${prefix}\tlog("y");${suffix}`);
				});
			}
		}

		it("retains explicit indentation and adjacent whole-line replacements", () => {
			expect(
				apply(
					"\tfoo();\n\tbar();\n",
					[
						{ oldText: name === "coding-agent" ? "\tfoo();\n" : "  foo();\n", newText: "  baz();\n" },
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
						{ oldText: name === "coding-agent" ? "“one”\n" : '"one"\n', newText: '"ONE"\n' },
						{ oldText: name === "coding-agent" ? "“two”" : '"two"', newText: '"TWO"' },
					],
					"memory.txt",
				).newContent,
			).toBe('head\n\t"ONE"\n\t"TWO"\n');
		});

		it("does not remove trailing whitespace outside an inline match", () => {
			expect(apply("head\n\t“one”   \n", [{ oldText: name === "coding-agent" ? "“one”" : '"one"', newText: "two" }], "memory.txt").newContent).toBe(
				"head\n\ttwo   \n",
			);
		});

		it("retains blank lines and maps Unicode graphemes as complete units", () => {
			expect(
				apply("head\n  \n\tﬀ café 👩‍💻\n", [{ oldText: name === "coding-agent" ? "ﬀ café 👩‍💻" : "ff cafe\u0301 👩‍💻", newText: "done" }], "memory.txt")
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

		it("finds overlapping Unicode occurrences without guessing a position", () => {
			expect(() => apply("ａｂａｂａ", [{ oldText: name === "coding-agent" ? "ａｂａ" : "aba", newText: "X" }], "memory.txt")).toThrow(
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
	it("returns numbered current evidence for unmatched source text", async () => {
		const current = Array.from({ length: 8 }, (_, index) => `line-${index + 1}`).join("\n");
		const { tool, path } = await fixture(current);
		const { failure, result, text } = await recover(tool, [{ oldText: "line-4-old", newText: "FOUR" }]);
		expect(failure).toMatchObject({ code: "MATCH_NOT_FOUND", details: { writeState: "not_written" } });
		expect(result.type).toBe("ask_model_to_rebuild");
		expect(result.replacementResult.details.recovery).toMatchObject({ code: "MATCH_NOT_FOUND", sourceRevision: expect.any(String) });
		expect(text).toContain("1| line-1");
		expect(text).toContain("4| line-4");
		expect(text).not.toContain("[snapshot");
		expect(await readFile(path, "utf8")).toBe(current);
	});

	it("resubmits the complete corrected batch after a rejection", async () => {
		const original = "a\nb\nc\n";
		const { tool, path } = await fixture(original);
		await recover(tool, [{ oldText: "a", newText: "A" }, { oldText: "missing", newText: "C" }]);
		expect(await readFile(path, "utf8")).toBe(original);
		const result = await tool.execute("repair", { path: "target.txt", edits: [{ oldText: "a", newText: "A" }, { oldText: "c", newText: "C" }] });
		expect(result.details).toMatchObject({ status: "written", applied: 2 });
		expect(await readFile(path, "utf8")).toBe("A\nb\nC\n");
	});

	it("rejects duplicate corrections for the same source interval", async () => {
		const original = "a\nb\nc\n";
		const { tool, path } = await fixture(original);
		await expect(tool.execute("duplicate-correction", { path: "target.txt", edits: [{ oldText: "a", newText: "A" }, { oldText: "a", newText: "other" }] })).rejects.toMatchObject({
			code: "EDIT_OVERLAP", details: { writeState: "not_written", issues: [expect.objectContaining({ code: "EDIT_OVERLAP", editIndex: 0, overlapEditIndex: 1 })] },
		});
		expect(await readFile(path, "utf8")).toBe(original);
	});

	it("returns current numbered evidence when the target changes externally", async () => {
		const { tool, path } = await fixture("one\ntwo\nthree\n");
		const current = "one\nexternal\nthree\n";
		await writeFile(path, current);
		const { failure, text } = await recover(tool, [{ oldText: "two", newText: "TWO" }]);
		expect(failure).toMatchObject({ code: "MATCH_NOT_FOUND", category: "precondition" });
		expect(text).toContain("2| external");
		expect(await readFile(path, "utf8")).toBe(current);
	});

	it("reports overlapping batch intervals without applying valid items", async () => {
		const original = "one\ntwo\nthree\nfour\n";
		const { tool, path } = await fixture(original);
		const { failure, text } = await recover(tool, [{ oldText: "one\ntwo", newText: "ONE\nTWO" }, { oldText: "two\nthree", newText: "TWO\nTHREE" }, { oldText: "four", newText: "FOUR" }]);
		expect(failure).toMatchObject({ code: "EDIT_OVERLAP", details: { writeState: "not_written", issues: [expect.objectContaining({ code: "EDIT_OVERLAP", editIndex: 0, overlapEditIndex: 1 })] } });
		expect(text).toContain("No changes were written");
		expect(await readFile(path, "utf8")).toBe(original);
	});

	it("bounds Unicode recovery evidence and directs oversized lines back to read", async () => {
		const current = `${"中文".repeat(10000)}\n`;
		const { tool, path } = await fixture(current);
		const { text } = await recover(tool, [{ oldText: "missing", newText: "replacement" }]);
		expect(Buffer.byteLength(text)).toBeLessThan(16 * 1024);
		expect(text).not.toContain("\uFFFD");
		expect(text).toContain("read offset=1 limit=2");
		expect(await readFile(path, "utf8")).toBe(current);
	});

	it("reports a completed write when cancellation arrives during the write", async () => {
		const { directory, path } = await fixture("before\n");
		const controller = new AbortController();
		const tool = createEditTool(directory, { operations: { access: async () => {}, readFile, writeFile: async (target, content) => { await writeFile(target, content); controller.abort(); } } });
		await expect(tool.execute("cancel", { path, edits: [{ oldText: "before", newText: "after" }] }, controller.signal)).rejects.toMatchObject({ details: { writeState: "written" }, message: expect.stringContaining("File was written") });
		expect(await readFile(path, "utf8")).toBe("after\n");
	});

	it("reports an unknown write state when an operation writes and then throws", async () => {
		const { directory, path } = await fixture("before\n");
		const tool = createEditTool(directory, { operations: { access: async () => {}, readFile, writeFile: async (target, content) => { await writeFile(target, content); throw new Error("connection lost"); } } });
		await expect(tool.execute("unknown", { path, edits: [{ oldText: "before", newText: "after" }] })).rejects.toMatchObject({ details: { writeState: "unknown" }, message: expect.stringContaining("Write outcome is unknown") });
		expect(await readFile(path, "utf8")).toBe("after\n");
	});

	it("uses the execution context cwd for the mutation key", async () => {
		const { directory, path } = await fixture("before\n");
		const tool = createEditToolDefinition("/");
		expect(await tool.getExecutionKeys?.({ path: "target.txt" }, { cwd: directory } as ExtensionContext)).toEqual([path]);
	});

	it("returns an applicable patch for a whole-line Unicode replacement", async () => {
		const current = "head\n\tlog(“x”);\n\tuntouched  \n";
		const { tool, path } = await fixture(current);
		const result = await tool.execute("patch", { path, edits: [{ oldText: "\tlog(“x”);\n", newText: '\tlog("y");\n' }] });
		const expected = 'head\n\tlog("y");\n\tuntouched  \n';
		expect(await readFile(path, "utf8")).toBe(expected);
		expect(applyPatch(current, result.details?.patch ?? "")).toBe(expected);
	});
});
