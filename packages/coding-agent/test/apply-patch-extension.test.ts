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
			expect.objectContaining({ path: "add.txt", additions: 1, deletions: 0 }),
			expect.objectContaining({ path: "delete.txt", additions: 0, deletions: 1 }),
			expect.objectContaining({ path: "update.txt", additions: 1, deletions: 1 }),
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
		).rejects.toThrow("Could not find");

		expect(await readFile(join(dir, "existing.txt"), "utf-8")).toBe("original\n");
		await expect(readFile(join(dir, "new.txt"), "utf-8")).rejects.toMatchObject({ code: "ENOENT" });
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
