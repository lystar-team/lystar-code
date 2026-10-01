import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverSessionProfiles, findSessionProfile } from "../src/core/session-profile.ts";
import { discoverAgentDefinitions, discoverAgents } from "../src/extensions/subagent/agents.ts";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("session profiles", () => {
	it("loads user profiles and lets project profiles override the same id", () => {
		const root = mkdtempSync(join(tmpdir(), "lystar-session-profile-"));
		const agentDir = join(root, "agent");
		tempDirs.push(root);
		const userDir = join(agentDir, "agents", "reviewer");
		const projectDir = join(root, ".pi", "agents", "reviewer");
		mkdirSync(userDir, { recursive: true });
		mkdirSync(projectDir, { recursive: true });
		writeFileSync(
			join(userDir, "profile.json"),
			JSON.stringify({ name: "Review", description: "User review", icon: "R", skills: ["review"] }),
		);
		writeFileSync(join(userDir, "PROMPT.md"), "User prompt\n");
		writeFileSync(join(userDir, "AGENTS.md"), "User instructions\n");
		writeFileSync(
			join(projectDir, "profile.json"),
			JSON.stringify({ name: "Project Review", description: "Project review", tools: ["read"] }),
		);
		writeFileSync(join(projectDir, "PROMPT.md"), "Project prompt\n");

		const profile = findSessionProfile(root, "reviewer", agentDir);
		expect(profile).toMatchObject({
			id: "reviewer",
			name: "Project Review",
			description: "Project review",
			scope: "project",
			systemPrompt: "Project prompt",
			tools: ["read"],
		});
		expect(profile?.agentsInstructions).toBeUndefined();
		expect(discoverSessionProfiles(root, agentDir).some((item) => item.id === "reviewer")).toBe(true);
	});

	it("ignores malformed profile files without affecting other profiles", () => {
		const root = mkdtempSync(join(tmpdir(), "lystar-session-profile-invalid-"));
		tempDirs.push(root);
		const profileDir = join(root, ".pi", "agents", "valid");
		const invalidDir = join(root, ".pi", "agents", "invalid");
		mkdirSync(profileDir, { recursive: true });
		mkdirSync(invalidDir, { recursive: true });
		writeFileSync(join(profileDir, "profile.json"), JSON.stringify({ description: "Valid profile" }));
		writeFileSync(join(invalidDir, "profile.json"), "not-json");

		const profiles = discoverSessionProfiles(root, join(root, "agent"));
		expect(profiles.map((profile) => profile.id)).toContain("valid");
		expect(profiles.map((profile) => profile.id)).not.toContain("invalid");
	});

	it("uses one registry for directory management and execution, with stable ids and Chinese names", () => {
		const root = mkdtempSync(join(tmpdir(), "lystar-role-registry-"));
		tempDirs.push(root);
		const agentDir = join(root, "agent");
		const roleDir = join(agentDir, "agents", "frontend-developer");
		mkdirSync(roleDir, { recursive: true });
		const rawConfig = JSON.stringify({
			name: "前端开发",
			description: "实现页面",
			icon: "code",
			provider: "custom",
			model: "review-model",
			thinkingLevel: "high",
			tools: ["read", "edit"],
			excludeTools: ["bash"],
			skills: ["vue"],
			tags: ["页面", "开发"],
		});
		const rawPrompt = "只处理指定页面。\n";
		writeFileSync(join(roleDir, "profile.json"), rawConfig);
		writeFileSync(join(roleDir, "PROMPT.md"), rawPrompt);
		writeFileSync(join(roleDir, "AGENTS.md"), "公共规则\n");
		const [definition] = discoverAgentDefinitions(root, agentDir).definitions;
		const profile = findSessionProfile(root, "frontend-developer", agentDir);
		expect(definition).toMatchObject({
			id: "frontend-developer",
			name: "前端开发",
			scope: "user",
			editable: true,
			content: "只处理指定页面。",
			agentsInstructions: "公共规则",
			rawContent: JSON.stringify([rawConfig, rawPrompt]),
		});
		expect(profile).toMatchObject({
			id: definition.id,
			name: definition.name,
			model: "custom/review-model",
			thinkingLevel: "high",
			tools: ["read", "edit"],
			excludeTools: ["bash"],
			skillNames: ["vue"],
			tags: ["页面", "开发"],
			systemPrompt: "只处理指定页面。",
			agentsInstructions: "公共规则",
		});
		expect(findSessionProfile(root, "前端开发", agentDir)).toBeUndefined();
		expect(discoverAgents(root, "user", agentDir).agents).toMatchObject([
			{ name: "frontend-developer", systemPrompt: "公共规则\n\n只处理指定页面。" },
		]);
	});

	it("returns empty lists when no roles have been configured", () => {
		const root = mkdtempSync(join(tmpdir(), "lystar-role-empty-"));
		tempDirs.push(root);
		const agentDir = join(root, "agent");
		expect(discoverAgentDefinitions(root, agentDir).definitions).toEqual([]);
		expect(discoverSessionProfiles(root, agentDir)).toEqual([]);
		expect(discoverAgents(root, "both", agentDir).agents).toEqual([]);
	});
});
