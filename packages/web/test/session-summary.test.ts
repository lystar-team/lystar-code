import { describe, expect, it } from "vitest";
import { mergeSessionSummaries, updateSessionSummaryFirstMessage } from "../src/state/use-workbench.ts";
import type { WebProject, WebSessionSummary } from "../src/types.ts";

function session(overrides: Partial<WebSessionSummary> = {}): WebSessionSummary {
	return {
		id: "session-1",
		createdAt: 1,
		updatedAt: 1,
		messageCount: 0,
		firstMessage: "未命名会话",
		activity: "idle",
		writeAccess: "available",
		...overrides,
	};
}

function project(current: WebSessionSummary): WebProject {
	return {
		id: "project-1",
		name: "项目",
		path: "/tmp/project",
		sessions: [current],
	};
}

describe("session summary lifecycle", () => {
	it("shows the first accepted prompt before the generated title arrives", () => {
		const next = updateSessionSummaryFirstMessage([project(session())], "session-1", "  首条 Prompt  ");

		expect(next[0]?.sessions[0]).toMatchObject({ firstMessage: "首条 Prompt", messageCount: 1 });
	});

	it("does not let an empty refresh overwrite the optimistic first message or title", () => {
		const current = session({ firstMessage: "首条 Prompt", messageCount: 1, name: "自动标题" });
		const incoming = session({ firstMessage: "未命名会话" });

		expect(mergeSessionSummaries([current], [incoming])[0]).toMatchObject({
			firstMessage: "首条 Prompt",
			name: "自动标题",
		});
	});
});
