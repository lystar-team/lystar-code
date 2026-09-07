import { appendFileSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type SessionInfo, type SessionInfoCache, SessionManager } from "../src/core/session-manager.ts";

const directories: string[] = [];
const header = {
	type: "session",
	version: 3,
	id: "metadata-parity",
	cwd: "/tmp",
	timestamp: new Date(1_000).toISOString(),
};
const user = (timestamp: number) => ({ type: "message", message: { role: "user", content: "请求", timestamp } });
const tool = (size: number) => ({
	type: "message",
	message: { role: "toolResult", content: [{ type: "text", text: "x".repeat(size) }] },
});

function createFile(entries: unknown[]): { directory: string; file: string } {
	const directory = mkdtempSync(join(tmpdir(), "lystar-metadata-parity-"));
	directories.push(directory);
	const file = join(directory, "session.jsonl");
	writeFileSync(file, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
	return { directory, file };
}

function displayedInfo(info: SessionInfo) {
	return { ...info, name: info.name || "", messageCount: 0, allMessagesText: "" };
}

afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("metadata and full session list compatibility", () => {
	it("finds a title after the second turn and beyond the old scan limit", async () => {
		const { directory } = createFile([
			header,
			user(2_000),
			user(3_000),
			tool(17 * 1024 * 1024),
			{ type: "session_info", name: "后续轮次的标题" },
			tool(128 * 1024),
		]);
		const [metadata] = await SessionManager.listAll(directory, undefined, { metadataOnly: true });
		const [full] = await SessionManager.listAll(directory);
		expect(metadata.name).toBe("后续轮次的标题");
		expect(displayedInfo(metadata)).toEqual(displayedInfo(full));
	});

	it("uses the latest rename or clear in the middle, including after cache invalidation", async () => {
		const { directory, file } = createFile([
			header,
			{ type: "session_info", name: "首轮名称" },
			user(2_000),
			user(3_000),
			tool(128 * 1024),
			{ type: "session_info", name: "中段重命名" },
			tool(128 * 1024),
		]);
		const cache: SessionInfoCache = { entries: new Map() };
		const options = { metadataOnly: true, cache };
		const [renamed] = await SessionManager.listAll(directory, undefined, options);
		expect(renamed.name).toBe("中段重命名");
		expect((await SessionManager.listAll(directory, undefined, options))[0]).toBe(renamed);

		appendFileSync(
			file,
			`${JSON.stringify({ type: "session_info", name: "" })}\n${JSON.stringify(tool(128 * 1024))}\n`,
		);
		const [cleared] = await SessionManager.listAll(directory, undefined, options);
		const [full] = await SessionManager.listAll(directory);
		expect(cleared).not.toBe(renamed);
		expect(cleared.name).toBe("");
		expect(displayedInfo(cleared)).toEqual(displayedInfo(full));
	});

	it("uses the maximum message activity, not tail activity or file mtime, for sorting", async () => {
		const { directory, file } = createFile([
			header,
			user(2_000),
			tool(128 * 1024),
			{
				type: "message",
				timestamp: new Date(50_000).toISOString(),
				message: { role: "assistant", content: [{ type: "text", text: "中段回复" }], stopReason: "stop" },
			},
			tool(128 * 1024),
			user(3_000),
			{ type: "session_info", name: "改名不改变活动时间" },
		]);
		writeFileSync(
			join(directory, "other.jsonl"),
			`${JSON.stringify({ ...header, id: "other" })}\n${JSON.stringify(user(25_000))}\n`,
		);
		utimesSync(file, new Date(100_000), new Date(100_000));
		const metadata = await SessionManager.listAll(directory, undefined, { metadataOnly: true });
		const full = await SessionManager.listAll(directory);
		expect(metadata.map((info) => info.id)).toEqual([header.id, "other"]);
		expect(metadata[0].modified.getTime()).toBe(50_000);
		expect(metadata.map(displayedInfo)).toEqual(full.map(displayedInfo));
	});

	it.each([[], [user(0)], [user(-1)]])(
		"preserves header-time fallback without positive activity: %j",
		async (...entries) => {
			const { directory, file } = createFile([header, ...entries]);
			utimesSync(file, new Date(100_000), new Date(100_000));
			const [metadata] = await SessionManager.listAll(directory, undefined, { metadataOnly: true });
			const [full] = await SessionManager.listAll(directory);
			expect(metadata.modified.getTime()).toBe(1_000);
			expect(displayedInfo(metadata)).toEqual(displayedInfo(full));
		},
	);

	it("keeps UTF-8, alternate JSON key order, CRLF and malformed-tail behavior", async () => {
		const { directory, file } = createFile([header]);
		const content = "中文".repeat(200_000);
		appendFileSync(
			file,
			[
				JSON.stringify({ message: { content, role: "user", timestamp: 5_000 }, type: "message" }),
				JSON.stringify({ message: { content: [], role: "toolResult" }, type: "message" }),
				JSON.stringify({ name: "非标准字段顺序", type: "session_info" }),
				'{"type":"message","message":',
			].join("\r\n"),
		);
		const [metadata] = await SessionManager.listAll(directory, undefined, { metadataOnly: true });
		const [full] = await SessionManager.listAll(directory);
		expect(metadata.name).toBe("非标准字段顺序");
		expect(metadata.firstMessage).toBe(content);
		expect(metadata.modified.getTime()).toBe(5_000);
		expect(metadata.lastOutcome).toBe("interrupted");
		expect(displayedInfo(metadata)).toEqual(displayedInfo(full));
	});
});
