import { type Dirent, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { CONFIG_DIR_NAME, getAgentDir } from "../config.ts";
import {
	type AgentDefinition,
	type AgentDefinitionScope,
	discoverAgentDefinitions,
} from "../extensions/subagent/agents.ts";
import { formatSubagentModelReference } from "./subagent-config.ts";

const THINKING_LEVELS = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);

export interface SessionProfile {
	id: string;
	name: string;
	description: string;
	icon?: string;
	model?: string;
	thinkingLevel?: ThinkingLevel;
	tools?: string[];
	skillNames?: string[];
	systemPrompt: string;
	agentsInstructions?: string;
	scope: AgentDefinitionScope;
	sourcePath: string;
}

interface ProfileFile {
	name?: unknown;
	description?: unknown;
	icon?: unknown;
	model?: unknown;
	thinkingLevel?: unknown;
	tools?: unknown;
	skills?: unknown;
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringArray(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const values = value.map(stringValue).filter((item): item is string => item !== undefined);
	return values.length > 0 ? [...new Set(values)] : undefined;
}

function isThinkingLevel(value: unknown): value is ThinkingLevel {
	return typeof value === "string" && THINKING_LEVELS.has(value as ThinkingLevel);
}

function profileFromDefinition(definition: AgentDefinition): SessionProfile {
	return {
		id: definition.name,
		name: definition.name,
		description: definition.description,
		...(definition.icon ? { icon: definition.icon } : {}),
		...(definition.model
			? {
					model: formatSubagentModelReference({
						provider: definition.provider,
						model: definition.model,
					}),
				}
			: {}),
		...(definition.thinkingLevel ? { thinkingLevel: definition.thinkingLevel } : {}),
		...(definition.tools ? { tools: [...definition.tools] } : {}),
		...(definition.skillNames ? { skillNames: [...definition.skillNames] } : {}),
		systemPrompt: definition.content,
		scope: definition.scope,
		sourcePath: definition.filePath,
	};
}

function loadDirectoryProfiles(dir: string, scope: "user" | "project"): SessionProfile[] {
	if (!existsSync(dir)) return [];
	let entries: Dirent<string>[] = [];
	try {
		entries = readdirSync(dir, { encoding: "utf8", withFileTypes: true });
	} catch {
		return [];
	}

	const profiles: SessionProfile[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const profileDir = join(dir, entry.name);
		const profilePath = join(profileDir, "profile.json");
		if (!existsSync(profilePath) || !statSync(profilePath).isFile()) continue;

		let config: ProfileFile;
		try {
			const parsed: unknown = JSON.parse(readFileSync(profilePath, "utf8"));
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
			config = parsed as ProfileFile;
		} catch {
			continue;
		}

		const id = entry.name.trim();
		const name = stringValue(config.name) ?? id;
		const description = stringValue(config.description) ?? name;
		const model = stringValue(config.model);
		const thinkingLevel = isThinkingLevel(config.thinkingLevel) ? config.thinkingLevel : undefined;
		const promptPath = join(profileDir, "PROMPT.md");
		const agentsPath = join(profileDir, "AGENTS.md");
		const systemPrompt = existsSync(promptPath) ? readFileSync(promptPath, "utf8").trim() : "";
		const agentsInstructions = existsSync(agentsPath) ? readFileSync(agentsPath, "utf8").trim() : undefined;
		profiles.push({
			id,
			name,
			description,
			...(stringValue(config.icon) ? { icon: stringValue(config.icon) } : {}),
			...(model ? { model } : {}),
			...(thinkingLevel ? { thinkingLevel } : {}),
			...(stringArray(config.tools) ? { tools: stringArray(config.tools) } : {}),
			...(stringArray(config.skills) ? { skillNames: stringArray(config.skills) } : {}),
			systemPrompt,
			...(agentsInstructions ? { agentsInstructions } : {}),
			scope,
			sourcePath: profileDir,
		});
	}
	return profiles;
}

function nearestProjectAgentsDir(cwd: string): string | undefined {
	let current = cwd;
	while (true) {
		const candidate = join(current, CONFIG_DIR_NAME, "agents");
		if (existsSync(candidate)) return candidate;
		const parent = dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
}

export function discoverSessionProfiles(cwd: string, agentDir = getAgentDir()): SessionProfile[] {
	const legacy = discoverAgentDefinitions(cwd, agentDir).definitions.map(profileFromDefinition);
	const userDirectoryProfiles = loadDirectoryProfiles(join(agentDir, "agents"), "user");
	const projectDirectory = nearestProjectAgentsDir(cwd);
	const projectDirectoryProfiles = projectDirectory ? loadDirectoryProfiles(projectDirectory, "project") : [];
	const profiles = new Map<string, SessionProfile>();
	for (const profile of legacy) profiles.set(profile.id, profile);
	for (const profile of userDirectoryProfiles) profiles.set(profile.id, profile);
	for (const profile of projectDirectoryProfiles) profiles.set(profile.id, profile);
	return [...profiles.values()];
}

export function findSessionProfile(
	cwd: string,
	profileId: string,
	agentDir = getAgentDir(),
): SessionProfile | undefined {
	return discoverSessionProfiles(cwd, agentDir).find((profile) => profile.id === profileId);
}
