import { describe, expect, it } from "vitest";
import { readLastSession, saveLastSession } from "../src/state/session-persistence.ts";

function createStorage(): Pick<Storage, "getItem" | "setItem"> {
	const values = new Map<string, string>();
	return {
		getItem: (key) => values.get(key) ?? null,
		setItem: (key, value) => values.set(key, value),
	};
}

describe("Web 会话持久化", () => {
	it("保存并读取最近打开的会话", () => {
		const storage = createStorage();

		saveLastSession("project-2", "session-7", storage);

		expect(readLastSession(storage)).toEqual({ projectId: "project-2", sessionId: "session-7" });
	});

	it("忽略损坏的会话记录", () => {
		const storage = createStorage();
		storage.setItem("lystar.web.last-session.v1", "损坏数据");

		expect(readLastSession(storage)).toBeUndefined();
	});
});
