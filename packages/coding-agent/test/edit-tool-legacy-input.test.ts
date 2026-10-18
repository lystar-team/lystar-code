import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionToolContext } from "../src/core/extensions/types.ts";
import { createEditTool, createEditToolDefinition } from "../src/core/tools/edit.ts";

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "pi-edit-text-input-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0, tempDirs.length).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("edit tool prepareArguments", () => {
	it("exposes only the content replacement contract", () => {
		const definition = createEditToolDefinition(process.cwd());
		expect(Object.keys(definition.parameters.properties)).toEqual(["path", "edits"]);
		expect(definition.parameters.properties.edits.items.properties).toHaveProperty("oldText");
		expect(definition.parameters.properties.edits.items.properties).toHaveProperty("newText");
		expect(definition.parameters.additionalProperties).toBe(false);
	});

	it("does not translate top-level oldText/newText fields", () => {
		const definition = createEditToolDefinition(process.cwd());
		const input = { path: "file.txt", oldText: "before", newText: "after" };
		expect(definition.prepareArguments!(input)).toEqual(input);
	});

	it("normalizes a single replacement object inside edits", () => {
		const definition = createEditToolDefinition(process.cwd());
		const edit = { oldText: "before", newText: "after" };
		expect(definition.prepareArguments!({ path: "file.txt", edits: edit })).toEqual({ path: "file.txt", edits: [edit] });
	});

	it("passes valid text input through without changing its shape", () => {
		const definition = createEditToolDefinition(process.cwd());
		const input = { path: "file.txt", edits: [{ oldText: "before", newText: "after" }] };
		expect(definition.prepareArguments!(input)).toEqual(input);
	});

	it("passes non-object input through unchanged", () => {
		const definition = createEditToolDefinition(process.cwd());
		expect(definition.prepareArguments!(null)).toBe(null);
		expect(definition.prepareArguments!(undefined)).toBe(undefined);
		expect(definition.prepareArguments!("garbage")).toBe("garbage");
	});

	it("rejects unsupported top-level edit input without writing", async () => {
		const dir = await createTempDir();
		const filePath = join(dir, "legacy.txt");
		await writeFile(filePath, "before\n", "utf8");
		const tool = createEditTool(dir);
		await expect(tool.execute("legacy-input", { path: filePath, oldText: "before", newText: "after" } as never, undefined, undefined, {} as ExtensionToolContext)).rejects.toMatchObject({
			code: "INVALID_ARGUMENTS", category: "arguments", details: { writeState: "not_written" },
		});
		expect(await readFile(filePath, "utf8")).toBe("before\n");
	});

	it("executes a prepared text replacement without snapshot state", async () => {
		const dir = await createTempDir();
		const filePath = join(dir, "text.txt");
		await writeFile(filePath, "before\n", "utf8");
		const definition = createEditToolDefinition(dir);
		const prepared = definition.prepareArguments!({ path: "text.txt", edits: { oldText: "before", newText: "after" } });
		const result = await definition.execute("tool-1", prepared, undefined, undefined, {} as ExtensionToolContext);
		expect(result.details).toMatchObject({ path: "text.txt", status: "written", applied: 1 });
		expect(await readFile(filePath, "utf8")).toBe("after\n");
	});
});

describe("edit tool stringified text edits", () => {
	it("parses an array of replacements from a JSON string", () => {
		const definition = createEditToolDefinition(process.cwd());
		const edits = [{ oldText: "second", newText: "SECOND" }, { oldText: "fifth", newText: "inserted\nfifth" }];
		expect(definition.prepareArguments!({ path: "file.txt", edits: JSON.stringify(edits) })).toEqual({ path: "file.txt", edits });
	});

	it("normalizes one replacement object from a JSON string", () => {
		const definition = createEditToolDefinition(process.cwd());
		const edit = { oldText: "anchor", newText: "inserted\nanchor" };
		expect(definition.prepareArguments!({ path: "file.txt", edits: JSON.stringify(edit) })).toEqual({ path: "file.txt", edits: [edit] });
	});

	it("does not normalize obsolete range edits from JSON", () => {
		const definition = createEditToolDefinition(process.cwd());
		const obsolete = JSON.stringify({ startLine: 1, endLine: 1, newText: "after" });
		expect(definition.prepareArguments!({ path: "file.txt", edits: obsolete })).toEqual({ path: "file.txt", edits: obsolete });
	});

	it("leaves malformed JSON unchanged for parameter validation", () => {
		const definition = createEditToolDefinition(process.cwd());
		expect(definition.prepareArguments!({ path: "file.txt", edits: "not json" })).toEqual({ path: "file.txt", edits: "not json" });
	});
});
