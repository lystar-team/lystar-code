import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { getAgentDir } from "../config.ts";
import {
	type AgentDefinition,
	type AgentDefinitionScope,
	discoverAgentDefinitions,
} from "../extensions/subagent/agents.ts";
import { formatSubagentModelReference } from "./subagent-config.ts";

export interface SessionProfile {
	id: string;
	name: string;
	description: string;
	icon?: string;
	model?: string;
	thinkingLevel?: ThinkingLevel;
	tools?: string[];
	excludeTools?: string[];
	skillNames?: string[];
	tags?: string[];
	systemPrompt: string;
	agentsInstructions?: string;
	scope: AgentDefinitionScope | "builtin";
	sourcePath: string;
}

function profileFromDefinition(definition: AgentDefinition): SessionProfile {
	return {
		id: definition.id,
		name: definition.name,
		description: definition.description,
		...(definition.icon ? { icon: definition.icon } : {}),
		...(definition.model
			? { model: formatSubagentModelReference({ provider: definition.provider, model: definition.model }) }
			: {}),
		...(definition.thinkingLevel ? { thinkingLevel: definition.thinkingLevel } : {}),
		...(definition.tools ? { tools: [...definition.tools] } : {}),
		...(definition.excludeTools ? { excludeTools: [...definition.excludeTools] } : {}),
		...(definition.skillNames ? { skillNames: [...definition.skillNames] } : {}),
		...(definition.tags ? { tags: [...definition.tags] } : {}),
		systemPrompt: definition.content,
		...(definition.agentsInstructions ? { agentsInstructions: definition.agentsInstructions } : {}),
		scope: definition.scope,
		sourcePath: definition.filePath,
	};
}

export function discoverSessionProfiles(cwd: string, agentDir = getAgentDir()): SessionProfile[] {
	const profiles = new Map<string, SessionProfile>();
	for (const definition of discoverAgentDefinitions(cwd, agentDir).definitions) {
		profiles.set(definition.id, profileFromDefinition(definition));
	}
	return [...profiles.values()];
}

export function findSessionProfile(
	cwd: string,
	profileId: string,
	agentDir = getAgentDir(),
): SessionProfile | undefined {
	return discoverSessionProfiles(cwd, agentDir).find((profile) => profile.id === profileId);
}
