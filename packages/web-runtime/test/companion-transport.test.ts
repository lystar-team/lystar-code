import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import type {
	AgentSession,
	AgentSessionEvent,
	AgentSessionEventListener,
} from "../../coding-agent/src/core/agent-session.ts";
import type { ToolActivitySnapshot } from "../../coding-agent/src/core/tool-activity.ts";
import { WebCompanionServer } from "../../coding-agent/src/core/web-companion.ts";
import { WebCompanionRuntime } from "../src/web-companion-runtime.ts";

it("大历史工具结果不重复广播，连续文本增量保持完整", async () => {
	const root = mkdtempSync(join(tmpdir(), "companion-transport-"));
	const agentDir = join(root, "agent");
	const sessionPath = join(root, "session.jsonl");
	mkdirSync(agentDir);
	writeFileSync(sessionPath, "{}\n");
	let listener: AgentSessionEventListener | undefined;
	const activities: ToolActivitySnapshot[] = Array.from({ length: 319 }, (_, index) => ({
		activityEpoch: "epoch",
		revision: index,
		toolCallId: `tool-${index}`,
		name: "bash",
		state: "success",
		summary: "完成",
		output: "x".repeat(16 * 1024),
		updatedAt: 1,
	}));
	activities.push({
		activityEpoch: "epoch",
		revision: 320,
		toolCallId: "active",
		name: "bash",
		state: "running",
		summary: "运行中",
		updatedAt: 1,
	});
	const streamingMessage = { role: "assistant", content: [{ type: "text", text: "断线前" }] };
	const session = {
		agent: { state: { streamingMessage } },
		sessionFile: sessionPath,
		sessionManager: {
			getEntries: () => [],
			getHeader: () => ({ timestamp: new Date(0).toISOString() }),
			getCwd: () => root,
			getSessionId: () => "session",
			getLeafId: () => null,
		},
		getContextUsage: () => undefined,
		isCompacting: false,
		retryAttempt: 0,
		isStreaming: false,
		thinkingLevel: "off",
		getSteeringMessages: () => [],
		getFollowUpMessages: () => [],
		getToolActivityEpoch: () => "epoch",
		getToolActivityRevision: () => 320,
		getToolActivitySnapshot: (options?: { activeOnly?: boolean }) =>
			options?.activeOnly ? activities.filter((activity) => activity.state === "running") : activities,
		subscribe: (next: AgentSessionEventListener) => {
			listener = next;
			return () => {
				listener = undefined;
			};
		},
	} as unknown as AgentSession;
	const server = new WebCompanionServer(session, agentDir);
	let runtime: WebCompanionRuntime | undefined;
	try {
		await server.start();
		runtime = await WebCompanionRuntime.open(agentDir, sessionPath);
		expect(runtime.getSnapshot("available")).toMatchObject({ phase: "turn", activity: "running" });
		expect(JSON.stringify(runtime.getSnapshot("available")).length).toBeLessThan(2048);
		let text = "";
		let snapshots = 0;
		runtime.onEvent((event) => {
			if (event.type === "state_changed") snapshots++;
			if (
				event.type === "progress" &&
				event.payload &&
				typeof event.payload === "object" &&
				!Array.isArray(event.payload) &&
				event.payload.type === "assistant_delta"
			)
				text += event.payload.text;
		});
		const message = { role: "assistant", content: [{ type: "text", text: "x".repeat(2 * 1024 * 1024) }] };
		for (let index = 0; index < 200; index++) {
			listener?.({
				type: "message_update",
				message,
				assistantMessageEvent: { type: "text_delta", delta: "中", contentIndex: 0, partial: message },
			} as AgentSessionEvent);
		}
		await new Promise((resolve) => setTimeout(resolve, 600));
		expect(text).toBe("中".repeat(200));
		expect(snapshots).toBe(1);
		expect(runtime.isConnected()).toBe(true);
		expect(runtime.getLiveMessage()?.text).toBe(`断线前${"中".repeat(200)}`);
		streamingMessage.content[0].text = "恢复时的完整文字";
		expect(await runtime.readLiveMessage()).toEqual({ text: "恢复时的完整文字", thinking: "" });
	} finally {
		await runtime?.dispose();
		await server.dispose();
		rmSync(root, { recursive: true, force: true });
	}
});
