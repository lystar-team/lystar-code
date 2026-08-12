import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createEventBus } from "../src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../src/core/extensions/loader.ts";
import applyPatchExtension, {
	type ApplyPatchDetails,
	createApplyPatchToolDefinition,
} from "../src/extensions/apply-patch/index.ts";
import { builtInExtensions } from "../src/extensions/index.ts";

const tempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function createTempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "lystar-apply-patch-"));
	tempDirs.push(dir);
	return dir;
}

function patch(lines: string[]): string {
	return ["*** Begin Patch", ...lines, "*** End Patch"].join("\n");
}

function executePatch(cwd: string, input: string, options?: Parameters<typeof createApplyPatchToolDefinition>[0]) {
	return createApplyPatchToolDefinition(options).execute("apply-patch-test", { input }, undefined, undefined, {
		cwd,
	} as never);
}

describe("built-in apply_patch extension", () => {
	it("adds, updates, and deletes files with structured details", async () => {
		const dir = await createTempDir();
		await writeFile(join(dir, "update.txt"), "before\n", "utf-8");
		await writeFile(join(dir, "delete.txt"), "remove\n", "utf-8");

		const result = await executePatch(
			dir,
			patch([
				"*** Add File: add.txt",
				"+created",
				"*** Update File: update.txt",
				"@@",
				"-before",
				"+after",
				"*** Delete File: delete.txt",
			]),
		);

		expect(await readFile(join(dir, "add.txt"), "utf-8")).toBe("created");
		expect(await readFile(join(dir, "update.txt"), "utf-8")).toBe("after\n");
		await expect(readFile(join(dir, "delete.txt"), "utf-8")).rejects.toMatchObject({ code: "ENOENT" });

		const details = result.details as ApplyPatchDetails;
		expect(details.files).toEqual([
			expect.objectContaining({ path: "add.txt", operation: "add", additions: 1, deletions: 0 }),
			expect.objectContaining({ path: "delete.txt", operation: "delete", additions: 0, deletions: 1 }),
			expect.objectContaining({ path: "update.txt", operation: "update", additions: 1, deletions: 1 }),
		]);
		expect(details.files.every((file) => typeof file.diff === "string" && file.diff.length > 0)).toBe(true);
	});

	it("does not write any file when validation of another file fails", async () => {
		const dir = await createTempDir();
		await writeFile(join(dir, "existing.txt"), "original\n", "utf-8");

		await expect(
			executePatch(
				dir,
				patch(["*** Update File: existing.txt", "@@", "-missing", "+replacement", "*** Add File: new.txt", "+new"]),
			),
		).rejects.toThrow("Could not apply patch");

		expect(await readFile(join(dir, "existing.txt"), "utf-8")).toBe("original\n");
		await expect(readFile(join(dir, "new.txt"), "utf-8")).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("uses @@ context to disambiguate repeated code", async () => {
		const dir = await createTempDir();
		await writeFile(
			join(dir, "functions.ts"),
			"function first() {\n\treturn 1;\n}\n\nfunction second() {\n\treturn 1;\n}\n",
			"utf-8",
		);

		await executePatch(
			dir,
			patch(["*** Update File: functions.ts", "@@ function second() {", "-\treturn 1;", "+\treturn 2;"]),
		);

		expect(await readFile(join(dir, "functions.ts"), "utf-8")).toBe(
			"function first() {\n\treturn 1;\n}\n\nfunction second() {\n\treturn 2;\n}\n",
		);
	});

	it("supports consecutive @@ context headers", async () => {
		const dir = await createTempDir();
		await writeFile(
			join(dir, "nested.ts"),
			"class Example {\n\tfirst() {}\n\tsecond() {\n\t\treturn 1;\n\t}\n}\n",
			"utf-8",
		);

		await executePatch(
			dir,
			patch([
				"*** Update File: nested.ts",
				"@@ class Example {",
				"@@ \tsecond() {",
				"-\t\treturn 1;",
				"+\t\treturn 2;",
			]),
		);

		expect(await readFile(join(dir, "nested.ts"), "utf-8")).toContain("\t\treturn 2;");
	});

	it("locates later hunks only after earlier hunks", async () => {
		const dir = await createTempDir();
		await writeFile(join(dir, "ordered.txt"), "target\nmiddle\ntarget\n", "utf-8");

		await executePatch(
			dir,
			patch([
				"*** Update File: ordered.txt",
				"@@",
				" target",
				" middle",
				"+after middle",
				"@@",
				" target",
				"+after second",
			]),
		);

		expect(await readFile(join(dir, "ordered.txt"), "utf-8")).toBe(
			"target\nmiddle\nafter middle\ntarget\nafter second\n",
		);
	});

	it("matches context with trailing whitespace without rewriting untouched lines", async () => {
		const dir = await createTempDir();
		await writeFile(join(dir, "whitespace.txt"), "before   \ntarget  \nafter   \n", "utf-8");

		await executePatch(
			dir,
			patch(["*** Update File: whitespace.txt", "@@", " before", "-target", "+changed", " after"]),
		);

		expect(await readFile(join(dir, "whitespace.txt"), "utf-8")).toBe("before   \nchanged\nafter   \n");
	});

	it("supports pure additions with a unique context or end-of-file marker", async () => {
		const dir = await createTempDir();
		await writeFile(join(dir, "insert.txt"), "header\nbody\n", "utf-8");

		await executePatch(
			dir,
			patch(["*** Update File: insert.txt", "@@ header", "+after header", "@@", "+footer", "*** End of File"]),
		);

		expect(await readFile(join(dir, "insert.txt"), "utf-8")).toBe("header\nafter header\nbody\nfooter\n");
	});

	it("rejects a pure addition without a stable insertion point", async () => {
		const dir = await createTempDir();
		await writeFile(join(dir, "insert.txt"), "body\n", "utf-8");

		await expect(executePatch(dir, patch(["*** Update File: insert.txt", "@@", "+floating"]))).rejects.toThrow(
			"only adds lines but has no @@ context or *** End of File marker",
		);
		expect(await readFile(join(dir, "insert.txt"), "utf-8")).toBe("body\n");
	});

	it("requires ambiguous hunks to include stable context", async () => {
		const dir = await createTempDir();
		await writeFile(join(dir, "duplicate.txt"), "target\nmiddle\ntarget\n", "utf-8");

		await expect(
			executePatch(dir, patch(["*** Update File: duplicate.txt", "@@", "-target", "+changed"])),
		).rejects.toThrow("matched 2 locations at lines 1, 3");
		expect(await readFile(join(dir, "duplicate.txt"), "utf-8")).toBe("target\nmiddle\ntarget\n");
	});

	it("rejects no-op update hunks without writing", async () => {
		const dir = await createTempDir();
		await writeFile(join(dir, "noop.txt"), "same\n", "utf-8");

		await expect(executePatch(dir, patch(["*** Update File: noop.txt", "@@", "-same", "+same"]))).rejects.toThrow(
			"hunk 1 does not change the file",
		);
		expect(await readFile(join(dir, "noop.txt"), "utf-8")).toBe("same\n");
	});

	it("rejects a no-op hunk even when another hunk would change the file", async () => {
		const dir = await createTempDir();
		await writeFile(join(dir, "mixed-noop.txt"), "same\nchange\n", "utf-8");

		await expect(
			executePatch(
				dir,
				patch(["*** Update File: mixed-noop.txt", "@@", "-same", "+same", "@@", "-change", "+changed"]),
			),
		).rejects.toThrow("hunk 1 does not change the file");
		expect(await readFile(join(dir, "mixed-noop.txt"), "utf-8")).toBe("same\nchange\n");
	});

	it("rejects a hunk whose fuzzy match already has the requested content", async () => {
		const dir = await createTempDir();
		await writeFile(join(dir, "fuzzy-noop.txt"), "\u201ctarget\u201d\n", "utf-8");

		await expect(
			executePatch(dir, patch(["*** Update File: fuzzy-noop.txt", "@@", '-"target"', "+\u201ctarget\u201d"])),
		).rejects.toThrow("hunk 1 does not change the file");
		expect(await readFile(join(dir, "fuzzy-noop.txt"), "utf-8")).toBe("\u201ctarget\u201d\n");
	});

	it("deletes the only line without leaving an empty line", async () => {
		const dir = await createTempDir();
		await writeFile(join(dir, "empty.txt"), "remove\n", "utf-8");

		await executePatch(dir, patch(["*** Update File: empty.txt", "@@", "-remove"]));

		expect(await readFile(join(dir, "empty.txt"), "utf-8")).toBe("");
	});

	it("rolls back prior writes when a later write fails", async () => {
		const dir = await createTempDir();
		const first = join(dir, "a.txt");
		const second = join(dir, "b.txt");
		await writeFile(first, "one\n", "utf-8");
		await writeFile(second, "two\n", "utf-8");

		await expect(
			executePatch(
				dir,
				patch(["*** Update File: a.txt", "@@", "-one", "+ONE", "*** Update File: b.txt", "@@", "-two", "+TWO"]),
				{
					operations: {
						readFile,
						mkdir: async () => {},
						unlink: async (path) => rm(path),
						writeFile: async (path, content) => {
							if (path === second && content === "TWO\n") throw new Error("injected write failure");
							await writeFile(path, content, "utf-8");
						},
					},
				},
			),
		).rejects.toThrow("Changes were rolled back");

		expect(await readFile(first, "utf-8")).toBe("one\n");
		expect(await readFile(second, "utf-8")).toBe("two\n");
	});

	it("accepts patch and raw-string arguments", () => {
		const tool = createApplyPatchToolDefinition();
		expect(tool.promptSnippet).toContain("*** Begin Patch");
		expect(tool.promptGuidelines).toContain(
			"Use apply_patch only with the *** Begin Patch format; use edit for exact oldText/newText replacements.",
		);
		expect(tool.promptGuidelines).toContain(
			"For update hunks, include 3 lines of unchanged context before and after each change when possible.",
		);
		expect(tool.promptGuidelines).toContain(
			"Use an @@ function, class, or stable section header when repeated code makes the hunk ambiguous.",
		);
		expect(tool.prepareArguments?.({ patch: "*** Begin Patch\n*** End Patch" })).toEqual({
			input: "*** Begin Patch\n*** End Patch",
		});
		expect(tool.prepareArguments?.("*** Begin Patch\n*** End Patch")).toEqual({
			input: "*** Begin Patch\n*** End Patch",
		});
	});

	it("is registered as a hidden built-in extension", async () => {
		expect(builtInExtensions).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ name: "apply-patch", factory: applyPatchExtension, hidden: true }),
			]),
		);
		const extension = await loadExtensionFromFactory(
			applyPatchExtension,
			process.cwd(),
			createEventBus(),
			createExtensionRuntime(),
			"<inline:apply-patch>",
		);
		expect(extension.tools.get("apply_patch")?.definition.name).toBe("apply_patch");
	});
});
