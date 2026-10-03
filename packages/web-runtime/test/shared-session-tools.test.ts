import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionWorkspaceSnapshot } from "@earendil-works/pi-coding-agent/core";
import { afterEach, describe, expect, it } from "vitest";
import { CodingAgentRuntimeAdapter } from "../src/runtime-adapter.ts";
import type { RuntimeSession } from "../src/types.ts";

const ui = async () => ({ cancelled: true });

describe("shared session tools", () => {
	const roots: string[] = [];
	afterEach(() => {
		for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	});

	function fixture(permissions?: { tools?: string[]; excludeTools?: string[] }) {
		const root = mkdtempSync(join(tmpdir(), "web-shared-session-tools-"));
		roots.push(root);
		const agentDir = join(root, "agent");
		const cwd = join(root, "project");
		const probe = join(root, "probe.ts");
		const captured = join(root, "active-tools.json");
		for (const directory of [agentDir, cwd]) mkdirSync(directory, { recursive: true });
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ defaultProjectTrust: "always", extensions: [probe] }),
		);
		writeFileSync(
			probe,
			`import { writeFileSync } from "node:fs";
import { Type } from "typebox";
export default function(pi) {
	pi.registerTool({
		name: "workspace_probe",
		label: "Workspace probe",
		description: "检查扩展工具装载",
		parameters: Type.Object({}),
		async execute() {
			return { content: [{ type: "text", text: "ok" }], details: undefined };
		}
	});
	pi.registerCommand("capture-tools", {
		description: "读取当前工具列表供测试断言",
		handler: async () => { writeFileSync(${JSON.stringify(captured)}, JSON.stringify(pi.getActiveTools().sort())); }
	});
}`,
		);
		const profileId = permissions ? "tool-policy" : undefined;
		if (profileId) {
			const roleDir = join(agentDir, "agents", profileId);
			mkdirSync(roleDir, { recursive: true });
			writeFileSync(join(roleDir, "profile.json"), JSON.stringify({ name: "工具权限测试", ...permissions }));
			writeFileSync(join(roleDir, "PROMPT.md"), "核对工具权限。\n");
		}
		const collaborationWorkspace: SessionWorkspaceSnapshot = {
			id: "shared-workspace",
			mode: "shared",
			projectCwd: cwd,
			cwd,
			status: "active",
		};
		return { agentDir, cwd, profileId, collaborationWorkspace, captured };
	}

	async function captureTools(runtime: RuntimeSession, captured: string): Promise<string[]> {
		await runtime.prompt("/capture-tools");
		return JSON.parse(readFileSync(captured, "utf8"));
	}

	it("loads the same default and extension tools when creating and reopening shared sessions", async () => {
		const { agentDir, cwd, collaborationWorkspace, captured } = fixture();
		const adapter = new CodingAgentRuntimeAdapter(agentDir);
		let runtime: RuntimeSession | undefined;
		try {
			runtime = await adapter.createSession(cwd, ui);
			const defaultTools = await captureTools(runtime, captured);
			expect(defaultTools).toEqual(
				expect.arrayContaining(["read", "bash", "write", "edit", "image_gen", "workspace_probe", "create_agent"]),
			);
			await runtime.dispose();

			runtime = await adapter.createSession(cwd, ui, { collaborationWorkspace });
			expect(runtime.getSnapshot("available").cwd).toBe(cwd);
			expect(await captureTools(runtime, captured)).toEqual(defaultTools);
			const sessionPath = runtime.sessionPath;
			await runtime.dispose();

			runtime = await new CodingAgentRuntimeAdapter(agentDir).openSession(sessionPath, ui);
			expect(runtime.getSnapshot("available").cwd).toBe(cwd);
			expect(await captureTools(runtime, captured)).toEqual(defaultTools);
		} finally {
			await runtime?.dispose();
		}
	});

	it.each([
		{
			name: "tools and excludeTools",
			permissions: {
				tools: ["read", "write", "image_gen", "workspace_probe"],
				excludeTools: ["write"],
			},
			allowed: ["read", "image_gen", "workspace_probe"],
			excluded: ["write", "bash", "create_agent", "session_create"],
		},
		{
			name: "excludeTools without a tools allowlist",
			permissions: {
				excludeTools: ["image_gen", "workspace_probe", "create_agent", "session_create"],
			},
			allowed: ["read", "bash", "write", "edit"],
			excluded: ["image_gen", "workspace_probe", "create_agent", "session_create"],
		},
	])("respects role $name when creating and reopening shared sessions", async ({ permissions, allowed, excluded }) => {
		const { agentDir, cwd, profileId, collaborationWorkspace, captured } = fixture(permissions);
		let runtime: RuntimeSession | undefined;
		try {
			runtime = await new CodingAgentRuntimeAdapter(agentDir).createSession(cwd, ui, {
				profileId,
				collaborationWorkspace,
			});
			const tools = await captureTools(runtime, captured);
			expect(tools).toEqual(expect.arrayContaining(allowed));
			for (const name of excluded) expect(tools).not.toContain(name);
			const sessionPath = runtime.sessionPath;
			await runtime.dispose();

			runtime = await new CodingAgentRuntimeAdapter(agentDir).openSession(sessionPath, ui);
			expect(await captureTools(runtime, captured)).toEqual(tools);
		} finally {
			await runtime?.dispose();
		}
	});
});
