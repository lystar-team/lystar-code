import type { JsonValue, TranscriptItem } from "@lystar/code-gui-protocol";
import { describe, expect, it } from "vitest";
import { buildTranscriptRows, readLineRange, toolFiles, transcriptImages } from "../src/transcript-tools.ts";

function item(entryId: string, message: JsonValue): TranscriptItem {
	return {
		entryId,
		parentId: null,
		timestamp: "2026-08-13T00:00:00Z",
		kind: "message",
		payload: { type: "message", id: entryId, parentId: null, timestamp: "2026-08-13T00:00:00Z", message },
	};
}

function assistant(entryId: string, content: JsonValue[]): TranscriptItem {
	return item(entryId, { role: "assistant", content, stopReason: "toolUse", timestamp: 1 });
}

function result(entryId: string, callId: string, toolName: string, details?: JsonValue): TranscriptItem {
	return item(entryId, {
		role: "toolResult",
		toolCallId: callId,
		toolName,
		content: [{ type: "text", text: `${toolName} output` }],
		...(details === undefined ? {} : { details }),
		isError: false,
		timestamp: 1,
	});
}

describe("buildTranscriptRows", () => {
	it("collapses Host projection views that share one raw entry", () => {
		const raw = assistant("assistant-projected", [{ type: "text", text: "REAL_SMOKE_OK" }]);
		const projected = [
			{ ...raw, view: { type: "thinking" as const, text: "hidden reasoning" } },
			{ ...raw, view: { type: "assistant" as const, text: "REAL_SMOKE_OK" } },
		];

		const rows = buildTranscriptRows(projected);

		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ kind: "entry", item: projected[0] });
	});

	it("pairs results by toolCallId and groups adjacent Bash calls across result entries", () => {
		const rows = buildTranscriptRows([
			assistant("assistant-1", [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "pwd" } }]),
			result("result-1", "call-1", "bash"),
			assistant("assistant-2", [
				{ type: "toolCall", id: "call-2", name: "bash", arguments: { command: "git status" } },
			]),
			result("result-2", "call-2", "bash"),
		]);

		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			kind: "bash-group",
			sourceEntryIds: ["assistant-1", "result-1", "assistant-2", "result-2"],
			executions: [
				{ callId: "call-1", arguments: { command: "pwd" }, result: { entryId: "result-1" } },
				{ callId: "call-2", arguments: { command: "git status" }, result: { entryId: "result-2" } },
			],
		});
	});

	it("maps standalone Bash history into the same grouped activity view", () => {
		const rows = buildTranscriptRows([
			item("bash-1", {
				role: "bashExecution",
				command: "printf native-ok",
				output: "native-ok",
				exitCode: 0,
				cancelled: false,
				timestamp: 1,
			}),
			item("bash-2", {
				role: "bashExecution",
				command: "false",
				output: "",
				exitCode: 1,
				cancelled: false,
				timestamp: 2,
			}),
		]);

		expect(rows).toEqual([
			expect.objectContaining({
				kind: "bash-group",
				sourceEntryIds: ["bash-1", "bash-2"],
				executions: [
					expect.objectContaining({
						arguments: { command: "printf native-ok" },
						result: expect.objectContaining({ text: "native-ok", isError: false }),
					}),
					expect.objectContaining({
						arguments: { command: "false" },
						result: expect.objectContaining({ text: "", isError: true }),
					}),
				],
			}),
		]);
	});

	it("keeps the Bash group key when an adjacent earlier page is prepended", () => {
		const currentPage = buildTranscriptRows([
			item("bash-2", {
				role: "bashExecution",
				command: "printf current",
				output: "current",
				exitCode: 0,
				cancelled: false,
				timestamp: 2,
			}),
		]);
		const withEarlierPage = buildTranscriptRows([
			item("bash-1", {
				role: "bashExecution",
				command: "printf earlier",
				output: "earlier",
				exitCode: 0,
				cancelled: false,
				timestamp: 1,
			}),
			item("bash-2", {
				role: "bashExecution",
				command: "printf current",
				output: "current",
				exitCode: 0,
				cancelled: false,
				timestamp: 2,
			}),
		]);

		expect(withEarlierPage[0]?.key).toBe(currentPage[0]?.key);
	});

	it("keeps user and Tool images as inline data or content references", () => {
		const reference = {
			type: "content_ref",
			contentRef: "image-ref",
			previewHead: "",
			previewTail: "",
			byteLength: 128,
			lineCount: 0,
			mimeType: "image/png",
		};
		const user = item("user-image", {
			role: "user",
			content: [
				{ type: "text", text: "检查图片" },
				{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
			],
		});
		const rows = buildTranscriptRows([
			user,
			assistant("assistant-image", [
				{ type: "toolCall", id: "read-image", name: "read", arguments: { path: "/project/view.png" } },
			]),
			item("result-image", {
				role: "toolResult",
				toolCallId: "read-image",
				toolName: "read",
				content: [{ type: "image", data: reference, mimeType: "image/png" }],
				isError: false,
			}),
		]);

		expect(transcriptImages(user)).toEqual([{ mimeType: "image/png", data: "aW1hZ2U=" }]);
		const execution = rows.find((row) => row.kind === "tool");
		expect(execution?.kind === "tool" ? execution.execution.result?.images : undefined).toEqual([
			{ mimeType: "image/png", reference },
		]);
	});

	it("keeps visible assistant text as a boundary and leaves unmatched results visible", () => {
		const unmatched = result("orphan-result", "outside-window", "read");
		const rows = buildTranscriptRows([
			assistant("assistant-1", [
				{ type: "text", text: "先检查状态。" },
				{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "pwd" } },
			]),
			result("result-1", "call-1", "bash"),
			unmatched,
		]);

		expect(rows.map((row) => row.kind)).toEqual(["entry", "bash-group", "entry"]);
		expect(rows[2]).toMatchObject({ kind: "entry", item: unmatched });
	});
});

describe("Tool structured details", () => {
	it("uses edit and apply_patch details without parsing result text", () => {
		const rows = buildTranscriptRows([
			assistant("assistant-edit", [
				{ type: "toolCall", id: "edit-call", name: "edit", arguments: { path: "/project/app.ts", edits: [] } },
				{ type: "toolCall", id: "patch-call", name: "apply_patch", arguments: { input: "*** Begin Patch" } },
			]),
			result("edit-result", "edit-call", "edit", { diff: "-old\n+new", additions: 1, deletions: 1 }),
			result("patch-result", "patch-call", "apply_patch", {
				files: [{ path: "/project/new.ts", operation: "add", additions: 2, deletions: 0, diff: "+line" }],
			}),
		]);
		const executions = rows.flatMap((row) => (row.kind === "tool" ? [row.execution] : []));

		expect(toolFiles(executions[0])).toEqual([
			{ path: "/project/app.ts", operation: "edit", additions: 1, deletions: 1, diff: "-old\n+new" },
		]);
		expect(toolFiles(executions[1])).toEqual([
			{ path: "/project/new.ts", operation: "add", additions: 2, deletions: 0, diff: "+line" },
		]);
	});

	it("formats read ranges from call arguments", () => {
		const rows = buildTranscriptRows([
			assistant("assistant-read", [
				{
					type: "toolCall",
					id: "read-call",
					name: "read",
					arguments: { path: "/project/app.ts", offset: 20, limit: 40 },
				},
			]),
		]);
		const execution = rows[0]?.kind === "tool" ? rows[0].execution : undefined;

		expect(execution && readLineRange(execution)).toBe("20-59");
	});
});
