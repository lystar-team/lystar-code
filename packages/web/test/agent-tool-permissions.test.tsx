import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AgentToolPermissions } from "../src/components/workbench/settings/agent-tool-permissions.tsx";

const draft: Parameters<typeof AgentToolPermissions>[0]["draft"] = {
	tools: [],
	excludeTools: ["bash"],
	toolMode: "deny",
};

describe("agent tool permissions", () => {
	it("renders only registered tools with Chinese purposes and the disabled mode selection", () => {
		const markup = renderToStaticMarkup(
			<AgentToolPermissions
				draft={draft}
				toolOptions={[
					{ name: "bash", description: "Execute commands" },
					{ name: "custom_tool", description: "查看项目状态" },
				]}
				onChange={() => {}}
			/>,
		);
		expect(markup).toContain('aria-label="工具使用规则"');
		expect(markup).toMatch(/<option value="deny" selected="">禁用所选工具<\/option>/);
		expect(markup).toContain("运行终端命令，执行脚本或检查项目");
		expect(markup).toContain("查看项目状态");
		expect(markup).toContain('type="checkbox" checked=""');
		expect(markup).not.toContain("image_gen");
	});
});
