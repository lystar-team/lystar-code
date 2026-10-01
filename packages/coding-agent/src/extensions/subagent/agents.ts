/**
 * Agent discovery and configuration
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "../../config.ts";
import {
	formatSubagentModelReference,
	normalizeSubagentSkills,
	normalizeSubagentTags,
	normalizeSubagentTools,
	parseSubagentMarkdown,
	parseSubagentModelReference,
	SUBAGENT_THINKING_LEVELS,
	type SubagentThinkingLevel,
} from "../../core/subagent-config.ts";

export type AgentScope = "user" | "project" | "both";
export type AgentDefinitionScope = "user" | "project";

export interface AgentConfig {
	name: string;
	description: string;
	tags?: string[];
	tools?: string[];
	excludeTools?: string[];
	model?: string;
	systemPrompt: string;
	source: AgentDefinitionScope;
	filePath: string;
}

export interface AgentDefinition {
	id: string;
	name: string;
	description: string;
	icon?: string;
	provider?: string;
	model?: string;
	thinkingLevel?: SubagentThinkingLevel;
	tags?: string[];
	tools?: string[];
	excludeTools?: string[];
	skillNames?: string[];
	content: string;
	agentsInstructions?: string;
	scope: AgentDefinitionScope;
	editable: boolean;
	filePath: string;
	rawContent: string;
}

export interface AgentDiscoveryResult {
	agents: AgentConfig[];
	projectAgentsDir: string | null;
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function loadAgentDefinitionsFromDir(dir: string, scope: AgentDefinitionScope): AgentDefinition[] {
	if (!fs.existsSync(dir)) return [];
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}

	const definitions = new Map<string, AgentDefinition>();
	for (const entry of entries) {
		if (!entry.name.endsWith(".md") || (!entry.isFile() && !entry.isSymbolicLink())) continue;
		const filePath = path.join(dir, entry.name);
		let rawContent: string;
		try {
			rawContent = fs.readFileSync(filePath, "utf8");
		} catch {
			continue;
		}
		const id = path.basename(entry.name, ".md");
		const parsed = parseSubagentMarkdown(rawContent, id);
		if (!parsed) continue;
		definitions.set(id, {
			id,
			name: parsed.name,
			description: parsed.description,
			...(parsed.tags ? { tags: parsed.tags } : {}),
			...(parsed.icon ? { icon: parsed.icon } : {}),
			...(parsed.provider ? { provider: parsed.provider } : {}),
			...(parsed.model ? { model: parsed.model } : {}),
			...(parsed.thinkingLevel ? { thinkingLevel: parsed.thinkingLevel } : {}),
			...(parsed.tools ? { tools: parsed.tools } : {}),
			...(parsed.excludeTools ? { excludeTools: parsed.excludeTools } : {}),
			...(parsed.skills ? { skillNames: parsed.skills } : {}),
			content: parsed.content,
			scope,
			editable: true,
			filePath,
			rawContent,
		});
	}

	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const filePath = path.join(dir, entry.name);
		const profilePath = path.join(filePath, "profile.json");
		if (!fs.existsSync(profilePath)) continue;
		let config: Record<string, unknown>;
		let rawConfig: string;
		let rawPrompt: string;
		let agentsInstructions: string | undefined;
		try {
			rawConfig = fs.readFileSync(profilePath, "utf8");
			const parsed: unknown = JSON.parse(rawConfig);
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
			config = parsed as Record<string, unknown>;
			const promptPath = path.join(filePath, "PROMPT.md");
			const agentsPath = path.join(filePath, "AGENTS.md");
			rawPrompt = fs.existsSync(promptPath) ? fs.readFileSync(promptPath, "utf8") : "";
			agentsInstructions = fs.existsSync(agentsPath) ? fs.readFileSync(agentsPath, "utf8").trim() : undefined;
		} catch {
			continue;
		}
		const id = entry.name;
		const name = stringValue(config.name) ?? id;
		const parsedModel = parseSubagentModelReference(stringValue(config.model));
		const provider = stringValue(config.provider) ?? parsedModel.provider;
		const thinkingLevel = SUBAGENT_THINKING_LEVELS.includes(config.thinkingLevel as SubagentThinkingLevel)
			? (config.thinkingLevel as SubagentThinkingLevel)
			: parsedModel.thinkingLevel;
		const tools = normalizeSubagentTools(config.tools);
		const excludeTools = normalizeSubagentTools(config.excludeTools);
		const skills = normalizeSubagentSkills(config.skills);
		const tags = normalizeSubagentTags(config.tags);
		const icon = stringValue(config.icon);
		definitions.set(id, {
			id,
			name,
			description: stringValue(config.description) ?? name,
			...(icon ? { icon } : {}),
			...(provider ? { provider } : {}),
			...(parsedModel.model ? { model: parsedModel.model } : {}),
			...(thinkingLevel ? { thinkingLevel } : {}),
			...(tools ? { tools } : {}),
			...(excludeTools ? { excludeTools } : {}),
			...(skills ? { skillNames: skills } : {}),
			...(tags ? { tags } : {}),
			content: rawPrompt.trim(),
			...(agentsInstructions ? { agentsInstructions } : {}),
			scope,
			editable: true,
			filePath,
			rawContent: JSON.stringify([rawConfig, rawPrompt]),
		});
	}
	return [...definitions.values()];
}

function findNearestProjectAgentsDir(cwd: string): string | null {
	let currentDir = cwd;
	while (true) {
		const candidate = path.join(currentDir, CONFIG_DIR_NAME, "agents");
		if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) return candidate;
		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) return null;
		currentDir = parentDir;
	}
}

export function discoverAgentDefinitions(
	cwd: string,
	agentDir = getAgentDir(),
): {
	definitions: AgentDefinition[];
	projectAgentsDir: string | null;
} {
	const projectAgentsDir = findNearestProjectAgentsDir(cwd);
	return {
		definitions: [
			...loadAgentDefinitionsFromDir(path.join(agentDir, "agents"), "user"),
			...(projectAgentsDir ? loadAgentDefinitionsFromDir(projectAgentsDir, "project") : []),
		],
		projectAgentsDir,
	};
}

function toAgentConfig(definition: AgentDefinition): AgentConfig {
	return {
		name: definition.id,
		description: definition.description,
		...(definition.tags ? { tags: definition.tags } : {}),
		...(definition.tools ? { tools: definition.tools } : {}),
		...(definition.excludeTools ? { excludeTools: definition.excludeTools } : {}),
		...(definition.model
			? {
					model: formatSubagentModelReference({
						provider: definition.provider,
						model: definition.model,
						thinkingLevel: definition.thinkingLevel,
					}),
				}
			: {}),
		systemPrompt: [definition.agentsInstructions, definition.content].filter(Boolean).join("\n\n"),
		source: definition.scope,
		filePath: definition.filePath,
	};
}

export function discoverAgents(cwd: string, scope: AgentScope, agentDir = getAgentDir()): AgentDiscoveryResult {
	const { definitions, projectAgentsDir } = discoverAgentDefinitions(cwd, agentDir);
	const agentMap = new Map<string, AgentConfig>();
	for (const definition of definitions) {
		if (scope === "both" || definition.scope === scope) agentMap.set(definition.id, toAgentConfig(definition));
	}
	return { agents: [...agentMap.values()], projectAgentsDir };
}

export function formatAgentList(agents: AgentConfig[], maxItems: number): { text: string; remaining: number } {
	if (agents.length === 0) return { text: "none", remaining: 0 };
	const listed = agents.slice(0, maxItems);
	const remaining = agents.length - listed.length;
	return {
		text: listed.map((agent) => `${agent.name} (${agent.source}): ${agent.description}`).join("; "),
		remaining,
	};
}
