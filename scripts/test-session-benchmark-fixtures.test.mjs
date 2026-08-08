import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const generatorScript = fileURLToPath(new URL("./generate-session-benchmark-fixtures.mjs", import.meta.url));
const bytesPerMiB = 1024 * 1024;

function generateFixture(outputDir) {
	return spawnSync(process.execPath, [generatorScript, "--output", outputDir, "--sizes", "1", "--seed", "8401"], {
		encoding: "utf8",
	});
}

async function readEntries(path) {
	const content = await readFile(path, "utf8");
	return content
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
}

test("generates deterministic, exact-size Session fixtures with benchmark coverage", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-session-benchmark-fixture-"));
	try {
		const firstOutput = join(root, "first");
		const secondOutput = join(root, "second");
		const firstResult = generateFixture(firstOutput);
		const secondResult = generateFixture(secondOutput);
		assert.equal(firstResult.status, 0, firstResult.stderr);
		assert.equal(secondResult.status, 0, secondResult.stderr);

		const firstPath = join(firstOutput, "session-1mb.jsonl");
		const secondPath = join(secondOutput, "session-1mb.jsonl");
		assert.equal((await stat(firstPath)).size, bytesPerMiB);
		const firstBytes = await readFile(firstPath);
		const secondBytes = await readFile(secondPath);
		assert.ok(firstBytes.equals(secondBytes));

		const entries = await readEntries(firstPath);
		assert.equal(entries[0].type, "session");
		assert.equal(entries[0].version, 3);
		assert.ok(entries.some((entry) => entry.type === "compaction"));
		assert.ok(entries.some((entry) => entry.type === "model_change"));
		assert.ok(entries.some((entry) => entry.type === "thinking_level_change"));
		assert.ok(entries.some((entry) => entry.type === "label"));
		assert.ok(entries.some((entry) => entry.type === "custom"));

		const sessionEntries = entries.slice(1);
		const entryIds = new Set(sessionEntries.map((entry) => entry.id));
		for (const entry of sessionEntries) {
			assert.equal(entry.__text, undefined);
			assert.equal(entry.__setText, undefined);
			if (entry.parentId !== null) {
				assert.ok(entryIds.has(entry.parentId));
			}
			if (entry.type === "compaction") {
				assert.ok(entryIds.has(entry.firstKeptEntryId));
			}
			if (entry.type === "label") {
				assert.ok(entryIds.has(entry.targetId));
			}
		}

		const messages = sessionEntries.filter((entry) => entry.type === "message").map((entry) => entry.message);
		assert.ok(messages.some((message) => message.role === "user"));
		assert.ok(messages.some((message) => message.role === "assistant"));
		assert.ok(messages.some((message) => message.role === "toolResult"));
		assert.ok(messages.some((message) => message.content?.some((part) => part.type === "toolCall")));
		assert.ok(messages.some((message) => JSON.stringify(message).includes("```mermaid")));
		assert.ok(messages.some((message) => JSON.stringify(message).includes("$E = mc^2$")));
		assert.ok(messages.some((message) => message.content?.some((part) => part.type === "image")));
		assert.ok(
			sessionEntries.some((entry, index) => index > 0 && entry.parentId !== sessionEntries[index - 1].id),
			"fixture should include a side branch",
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
