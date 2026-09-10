import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

const execute = promisify(execFile);
const script = new URL("./edit-tool-stats.mjs", import.meta.url).pathname;
const timestamp = Date.parse("2026-09-06T00:00:00+08:00");
const replacement = { oldText: "中文", newText: "正文" };

function call(id, options = {}) {
	return {
		type: "message", id: `assistant-${id}`, timestamp: "2026-01-01T00:00:00Z",
		message: {
			role: "assistant", timestamp, provider: "fixture", model: "faux",
			content: [{ type: "toolCall", name: "edit", id, arguments: { path: "target.ts", edits: [replacement] } }],
			...options,
		},
	};
}

function result(id, text, isError = true, details = {}) {
	return { type: "message", message: { role: "toolResult", toolName: "edit", toolCallId: id, isError, content: [{ type: "text", text }], details } };
}

async function scan(entries, args = []) {
	const directory = await mkdtemp(join(tmpdir(), "pi-edit-stats-"));
	try {
		await writeFile(join(directory, "2026-01-01T00-00-00-000Z_old.jsonl"), entries.map((entry) => typeof entry === "string" ? entry : JSON.stringify(entry)).join("\n"));
		const { stdout } = await execute(process.execPath, [script, "--sessions-dir", directory, "--since", "2026-09-06T00:00:00+08:00", "--json", "--include-records", ...args]);
		return JSON.parse(stdout);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

test("filters call timestamps, not session filenames or newer results", async () => {
	const missing = call("missing-time");
	delete missing.timestamp;
	delete missing.message.timestamp;
	const output = await scan([
		call("old", { timestamp: timestamp - 1 }), result("old", "done", false),
		call("new"), result("new", "done", false), missing,
	]);
	assert.equal(output.summary.counts.totalEditCalls, 1);
	assert.equal(output.records[0].toolCallId, "new");
	assert.equal(output.summary.scan.callsBeforeSince, 1);
	assert.equal(output.summary.scan.callsMissingTimestamp, 1);
	assert.equal(output.summary.scan.unmatchedToolResults, 0);
});

test("deduplicates calls and results and excludes missing results from the denominator", async () => {
	const output = await scan([
		result("failed", "Could not find edits[0] in target.ts."),
		call("failed"), call("failed"), result("failed", "duplicate serialization"),
		call("success"), result("success", "done", false), call("pending"),
		"{malformed", result("unmatched", "unknown"),
	]);
	assert.deepEqual(output.summary.counts, {
		assistantMessagesWithEditCalls: 3, totalEditCalls: 3, resolvedEditCalls: 2,
		success: 1, failed: 1, unresolved: 1, single: 0, multi: 3, noCoreChange: 0,
	});
	assert.equal(output.summary.scan.duplicateToolCalls, 1);
	assert.equal(output.summary.scan.duplicateToolResults, 1);
	assert.equal(output.summary.scan.malformedLines, 1);
	assert.equal(output.summary.scan.unmatchedToolResults, 1);
	assert.equal(output.records.find((record) => record.toolCallId === "pending").errorKind, "missing_result");
});

test("classifies current errors and keeps rebuild guidance separate from repeat blocking", async () => {
	const examples = [
		["Could not find edits[2] in target.ts. 不要原样重复失败参数。", "not_found_exact_text"],
		["Found 2 occurrences of edits[0] in target.ts.", "multiple_occurrences"],
		["edits[0] and edits[2] overlap in target.ts.", "overlapping_edits"],
		["同一条助手回复中不能同时修改同一个目标：target.ts。", "same_response_target_conflict"],
		["已阻止重复失败，需修改参数、刷新状态、切换工具或请求用户决定。", "repeat_blocked"],
		["Could not edit file: target.ts. Error code: ENOENT.", "file_not_found"],
		["Could not edit file: target.ts. Error code: EACCES.", "permission_denied"],
		["Target changed before write; no changes were written.", "write_conflict"],
	];
	const output = await scan(examples.flatMap(([text], index) => [call(String(index)), result(String(index), text)]));
	assert.deepEqual(output.records.map((record) => record.errorKind), examples.map(([, kind]) => kind));
});

test("uses structured error codes before text and counts usage once per assistant", async () => {
	const first = call("first", { usage: { input: 100, output: 20, cacheRead: 30, cacheWrite: 40, totalTokens: 190 } });
	first.message.content.push({ ...first.message.content[0], id: "second" });
	const output = await scan([first, result("first", "unrelated", true, { recovery: { code: "EDIT_OVERLAP" } }), result("second", "done", false)]);
	assert.equal(output.records[0].errorKind, "overlapping_edits");
	assert.equal(output.summary.cost.failedPayloadBytes, 12);
	assert.equal(output.summary.cost.failedResultBytes, Buffer.byteLength("unrelated"));
	assert.equal(output.summary.cost.assistantMessages, 1);
	assert.deepEqual(output.summary.cost.tokenUsage.input, { total: 100, messagesWithUsage: 1 });
	assert.deepEqual(output.summary.cost.tokenUsage.cacheRead, { total: 30, messagesWithUsage: 1 });
	assert.match(output.summary.measurement.outcome, /not established/);
});

test("counts normalized JSON, object and mixed legacy edit blocks without changing raw style", async () => {
	const entries = [
		{ edits: JSON.stringify([replacement, replacement]) },
		{ edits: replacement },
		{ edits: [replacement], ...replacement },
	];
	const output = await scan(entries.flatMap((args, index) => {
		const entry = call(String(index));
		entry.message.content[0].arguments = { path: "target.ts", ...args };
		return [entry, result(String(index), "done", false)];
	}));
	assert.deepEqual(output.records.map((record) => record.editsCount), [2, 1, 2]);
	assert.deepEqual(output.records.map((record) => record.totalEditBytes), [24, 12, 24]);
	assert.deepEqual(output.summary.cost.tokenUsage.input, { total: null, messagesWithUsage: 0 });
});
