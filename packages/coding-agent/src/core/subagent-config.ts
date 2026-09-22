import { stringify as stringifyYaml } from "yaml";
import { parseFrontmatter } from "../utils/frontmatter.ts";

export const SUBAGENT_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"] as const;
export type SubagentThinkingLevel = (typeof SUBAGENT_THINKING_LEVELS)[number];

export interface SubagentConfigInput {
	name: string;
	description: string;
	icon?: string;
	provider?: string;
	model?: string;
	thinkingLevel?: SubagentThinkingLevel;
	tools?: string[];
	skills?: string[];
	content: string;
}

export interface ParsedSubagentConfig extends SubagentConfigInput {
	modelReference?: string;
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

export function normalizeSubagentTools(value: unknown): string[] | undefined {
	if (typeof value === "string") {
		const tools = value
			.split(",")
			.map((tool) => tool.trim())
			.filter(Boolean);
		return tools.length > 0 ? [...new Set(tools)] : undefined;
	}
	if (Array.isArray(value)) {
		const tools = value.map(stringValue).filter((tool): tool is string => tool !== undefined);
		return tools.length > 0 ? [...new Set(tools)] : undefined;
	}
	const record = recordValue(value);
	if (!record || record["*"] === true) return undefined;
	const tools = Object.entries(record)
		.filter(([, enabled]) => enabled === true || enabled === "allow")
		.map(([tool]) => tool.trim())
		.filter(Boolean);
	return tools.length > 0 ? [...new Set(tools)] : undefined;
}

export function normalizeSubagentSkills(value: unknown): string[] | undefined {
	const values = typeof value === "string" ? value.split(",") : Array.isArray(value) ? value : [];
	const skills = values.map(stringValue).filter((skill): skill is string => skill !== undefined);
	return skills.length > 0 ? [...new Set(skills)] : undefined;
}

export function parseSubagentModelReference(reference: string | undefined): {
	provider?: string;
	model?: string;
	thinkingLevel?: SubagentThinkingLevel;
} {
	const value = reference?.trim();
	if (!value) return {};
	let modelReference = value;
	let thinkingLevel: SubagentThinkingLevel | undefined;
	const separator = value.lastIndexOf(":");
	if (separator > 0) {
		const suffix = value.slice(separator + 1);
		if (SUBAGENT_THINKING_LEVELS.includes(suffix as SubagentThinkingLevel)) {
			thinkingLevel = suffix as SubagentThinkingLevel;
			modelReference = value.slice(0, separator);
		}
	}
	const slash = modelReference.indexOf("/");
	if (slash > 0 && slash < modelReference.length - 1) {
		return {
			provider: modelReference.slice(0, slash),
			model: modelReference.slice(slash + 1),
			...(thinkingLevel ? { thinkingLevel } : {}),
		};
	}
	return { model: modelReference, ...(thinkingLevel ? { thinkingLevel } : {}) };
}

export function formatSubagentModelReference(input: {
	provider?: string;
	model?: string;
	thinkingLevel?: SubagentThinkingLevel;
}): string | undefined {
	const model = input.model?.trim();
	if (!model) return undefined;
	const provider = input.provider?.trim();
	const reference = provider ? `${provider}/${model}` : model;
	return input.thinkingLevel && input.thinkingLevel !== "off" ? `${reference}:${input.thinkingLevel}` : reference;
}

export function parseSubagentMarkdown(content: string, fallbackName: string): ParsedSubagentConfig | undefined {
	const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(content);
	const name = stringValue(frontmatter.name) ?? fallbackName.trim();
	const description = stringValue(frontmatter.description);
	if (!name || !description) return undefined;
	const modelReference = stringValue(frontmatter.model);
	const tools = normalizeSubagentTools(frontmatter.tools);
	const skills = normalizeSubagentSkills(frontmatter.skills);
	return {
		name,
		description,
		...(stringValue(frontmatter.icon) ? { icon: stringValue(frontmatter.icon) } : {}),
		...parseSubagentModelReference(modelReference),
		...(modelReference ? { modelReference } : {}),
		...(tools ? { tools } : {}),
		...(skills ? { skills } : {}),
		content: body.trim(),
	};
}

export function renderSubagentMarkdown(input: SubagentConfigInput): string {
	const modelReference = formatSubagentModelReference(input);
	const frontmatter: Record<string, unknown> = {
		name: input.name.trim(),
		description: input.description.trim(),
	};
	if (input.icon?.trim()) frontmatter.icon = input.icon.trim();
	if (modelReference) frontmatter.model = modelReference;
	if (input.tools && input.tools.length > 0) frontmatter.tools = [...new Set(input.tools)].join(", ");
	if (input.skills && input.skills.length > 0) frontmatter.skills = [...new Set(input.skills)];
	const yaml = stringifyYaml(frontmatter, { lineWidth: 0 }).trimEnd();
	const body = input.content.trim();
	return `---\n${yaml}\n---\n${body ? `\n${body}\n` : ""}`;
}
