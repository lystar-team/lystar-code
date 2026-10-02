import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { createCollaborationTools } from "../src/core/session-tool.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

describe("协作工具权限", () => {
	it("禁用 session_create 后保留通信工具，能力租约不能重新启用创建工具", async () => {
		const root = mkdtempSync(join(tmpdir(), "lystar-collaboration-tools-"));
		const agentDir = join(root, "agent");
		mkdirSync(agentDir, { recursive: true });
		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		const { session } = await createAgentSession({
			cwd: root,
			agentDir,
			model,
			thinkingLevel: "off",
			settingsManager: SettingsManager.create(root, agentDir),
			sessionManager: SessionManager.inMemory(),
			customTools: createCollaborationTools(() => undefined),
			excludeTools: ["session_create"],
		});
		try {
			const names = session.getAllTools().map((tool) => tool.name);
			expect(names).toContain("session_send");
			expect(names).toContain("room_task_update");
			expect(names).not.toContain("session_create");
			expect(session.getActiveToolNames()).not.toContain("session_create");

			// 房间任务能力租约列出创建工具时，角色禁用仍然生效。
			session.setActiveToolsByName(["session_create", "session_send"]);
			expect(session.getActiveToolNames()).toEqual(["session_send"]);
		} finally {
			session.dispose();
			rmSync(root, { recursive: true, force: true });
		}
	});
});
