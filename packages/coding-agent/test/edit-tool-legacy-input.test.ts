import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionToolContext } from "../src/core/extensions/types.ts";
import { createEditTool, createEditToolDefinition } from "../src/core/tools/edit.ts";
import { FileEditState } from "../src/core/tools/file-edit-state.ts";
import { normalizeToLF } from "../src/core/tools/edit-diff.ts";
import { splitBom } from "../src/utils/text.ts";

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "pi-edit-range-input-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0, tempDirs.length).map((dir) => rm(dir, { recursive: true, force: true })));
});

function captureSnapshot(state: FileEditState, path: string, content: string): string {
	const totalLines = normalizeToLF(splitBom(content).text).split("\n").length;
	return state.capture(resolve(path), content, 1, totalLines).id;
}

describe("edit tool prepareArguments", () => {
	it("keeps the public schema on the snapshot range contract", () => {
		const definition = createEditToolDefinition(process.cwd());
		expect(definition.parameters.properties).not.toHaveProperty("oldText");
		expect(definition.parameters.properties).not.toHaveProperty("newText");
		expect(definition.parameters.properties).toHaveProperty("snapshot");
		expect(definition.parameters.properties).toHaveProperty("plan");
		expect(definition.parameters.properties).toHaveProperty("edits");
		expect(definition.parameters.properties).toHaveProperty("dropIndexes");
	});

	it("does not translate legacy top-level oldText/newText fields", () => {
		const definition = createEditToolDefinition(process.cwd());
		const input = { path: "file.txt", oldText: "before", newText: "after" };
		expect(definition.prepareArguments!(input)).toEqual(input);
	});

	it("normalizes a single snapshot range object inside edits", () => {
		const definition = createEditToolDefinition(process.cwd());
		const range = { startLine: 3, endLine: 4, newText: "replacement\n", index: 2, snapshot: "current-snapshot" };
		expect(definition.prepareArguments!({ path: "file.txt", snapshot: "base-snapshot", edits: range })).toEqual({
			path: "file.txt",
			snapshot: "base-snapshot",
			edits: [range],
		});
	});

	it("passes valid range input through without changing its shape", () => {
		const definition = createEditToolDefinition(process.cwd());
		const input = {
			path: "file.txt",
			snapshot: "snapshot-id",
			edits: [{ startLine: 1, endLine: 1, newText: "after" }],
		};
		expect(definition.prepareArguments!(input)).toEqual(input);
	});

	it("passes non-object input through unchanged", () => {
		const definition = createEditToolDefinition(process.cwd());
		expect(definition.prepareArguments!(null)).toBe(null);
		expect(definition.prepareArguments!(undefined)).toBe(undefined);
		expect(definition.prepareArguments!("garbage")).toBe("garbage");
	});

	it("rejects legacy edit input instead of applying it", async () => {
		const dir = await createTempDir();
		const filePath = join(dir, "legacy.txt");
		await writeFile(filePath, "before\n", "utf8");
		const state = new FileEditState();
		const tool = createEditTool(dir, { fileEditState: state });

		await expect(
			tool.execute(
				"legacy-input",
				{ path: filePath, oldText: "before", newText: "after" } as never,
				undefined,
				undefined,
				{} as ExtensionToolContext,
			),
		).rejects.toMatchObject({
			code: "SNAPSHOT_REQUIRED",
			category: "arguments",
			details: {
				writeState: "not_written",
				issues: expect.arrayContaining([
					expect.objectContaining({ code: "SNAPSHOT_REQUIRED" }),
					expect.objectContaining({ code: "EDITS_REQUIRED" }),
				]),
			},
		});
		expect(await readFile(filePath, "utf8")).toBe("before\n");
	});

	it("executes a prepared snapshot range", async () => {
		const dir = await createTempDir();
		const filePath = join(dir, "range.txt");
		const original = "before\n";
		await writeFile(filePath, original, "utf8");
		const state = new FileEditState();
		const definition = createEditToolDefinition(dir, { fileEditState: state });
		const snapshot = captureSnapshot(state, filePath, original);
		const prepared = definition.prepareArguments!({
			path: "range.txt",
			snapshot,
			edits: [{ startLine: 1, endLine: 1, newText: "after\n" }],
		});

		const result = await definition.execute("tool-1", prepared, undefined, undefined, {} as ExtensionToolContext);
		expect(result.details).toMatchObject({ path: "range.txt", status: "written", applied: 1, alreadyApplied: 0 });
		expect(await readFile(filePath, "utf8")).toBe("after\n");
	});
});

describe("edit tool stringified range edits", () => {
	it("parses an array of ranges from a JSON string", () => {
		const definition = createEditToolDefinition(process.cwd());
		const ranges = [
			{ startLine: 2, endLine: 2, newText: "second" },
			{ startLine: 5, endLine: 4, newText: "inserted\n" },
		];
		expect(definition.prepareArguments!({ path: "file.txt", snapshot: "snapshot-id", edits: JSON.stringify(ranges) })).toEqual({
			path: "file.txt",
			snapshot: "snapshot-id",
			edits: ranges,
		});
	});

	it("normalizes one range object from a JSON string", () => {
		const definition = createEditToolDefinition(process.cwd());
		const range = { startLine: 1, endLine: 0, newText: "inserted\n" };
		expect(
			definition.prepareArguments!({ path: "file.txt", snapshot: "snapshot-id", edits: JSON.stringify(range) }),
		).toEqual({ path: "file.txt", snapshot: "snapshot-id", edits: [range] });
	});

	it("does not normalize legacy text edits from JSON", () => {
		const definition = createEditToolDefinition(process.cwd());
		const legacy = JSON.stringify({ oldText: "before", newText: "after" });
		expect(definition.prepareArguments!({ path: "file.txt", edits: legacy })).toEqual({ path: "file.txt", edits: legacy });
	});

	it("leaves malformed JSON unchanged for parameter validation", () => {
		const definition = createEditToolDefinition(process.cwd());
		const prepared = definition.prepareArguments!({ path: "file.txt", edits: "not json" });
		expect(prepared).toEqual({ path: "file.txt", edits: "not json" });
	});
});
