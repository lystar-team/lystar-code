import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverSessionProfiles, findSessionProfile } from "../src/core/session-profile.ts";

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
});
