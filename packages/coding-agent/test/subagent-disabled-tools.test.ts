import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findSessionProfile } from "../src/core/session-profile.ts";
import { parseSubagentMarkdown, renderSubagentMarkdown } from "../src/core/subagent-config.ts";
import { discoverAgents } from "../src/extensions/subagent/agents.ts";

describe("subagent disabled tools", () => {
	it("keeps a blocklist in Markdown, CLI discovery, and Web profiles", () => {
		const root = mkdtempSync(join(tmpdir(), "subagent-disabled-tools-"));
		try {
			const cwd = join(root, "project");
			const agentDir = join(root, "agent");
			mkdirSync(cwd, { recursive: true });
			mkdirSync(join(agentDir, "agents"), { recursive: true });
			const markdown = renderSubagentMarkdown({
				name: "reviewer",
				description: "Review source code",
				excludeTools: ["bash", "write"],
				content: "Read the source.",
			});
			writeFileSync(join(agentDir, "agents", "reviewer.md"), markdown);
			expect(parseSubagentMarkdown(markdown, "reviewer")).toMatchObject({ excludeTools: ["bash", "write"] });
			expect(discoverAgents(cwd, "user", agentDir).agents.find((agent) => agent.name === "reviewer")).toMatchObject({
				excludeTools: ["bash", "write"],
			});
			expect(findSessionProfile(cwd, "reviewer", agentDir)).toMatchObject({ excludeTools: ["bash", "write"] });
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
