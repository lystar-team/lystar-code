/**
 * Agent discovery and configuration
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "../../config.ts";
import { parseFrontmatter } from "../../utils/frontmatter.ts";

export type AgentScope = "user" | "project" | "both";

export interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	systemPrompt: string;
	source: "builtin" | "user" | "project";
	filePath: string;
}

export interface AgentDiscoveryResult {
	agents: AgentConfig[];
	projectAgentsDir: string | null;
}

export const BUILTIN_AGENTS: AgentConfig[] = [
	{
		name: "research-specialist",
		description: "只读调查代码、配置和文档，向主代理返回简洁证据",
		tools: ["read", "grep", "find", "ls"],
		systemPrompt: `你是只读研究子代理。严格按任务范围调查代码、配置和文档，不修改文件。先定位入口和调用关系，再读取关键实现；结论必须给出准确路径和证据，无法确认时说明缺口。最终返回简洁、可供主代理继续工作的结果。`,
		source: "builtin",
		filePath: "<builtin:research-specialist>",
	},
	{
		name: "review-specialist",
		description: "只读审查正确性、回归、安全风险和验证缺口",
		tools: ["read", "grep", "find", "ls"],
		systemPrompt: `你是只读审查子代理。独立检查任务范围内的正确性、行为回归、安全风险和验证缺口，不修改文件。问题按严重程度排序，每条写清路径、触发条件和影响；没有发现问题时明确说明剩余验证边界。`,
		source: "builtin",
		filePath: "<builtin:review-specialist>",
	},
	{
		name: "worker",
		description: "在明确文件范围内完成一个实现单元并运行必要验证",
		systemPrompt: `你是实现子代理。只完成任务卡分配的单个工作单元，在指定文件范围内实现和验证。保留其他人的改动，不派发其他代理，不执行破坏性 Git 操作。优先复用现有能力，修正责任位置上的根因，最终只报告实际改动、验证结果和未完成事项。`,
		source: "builtin",
		filePath: "<builtin:worker>",
	},
];

function loadAgentsFromDir(dir: string, source: "user" | "project"): AgentConfig[] {
	const agents: AgentConfig[] = [];

	if (!fs.existsSync(dir)) {
		return agents;
	}

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return agents;
	}

	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;

		const filePath = path.join(dir, entry.name);
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}

		const { frontmatter, body } = parseFrontmatter<Record<string, string>>(content);

		if (!frontmatter.name || !frontmatter.description) {
			continue;
		}

		const tools = frontmatter.tools
			?.split(",")
			.map((t: string) => t.trim())
			.filter(Boolean);

		agents.push({
			name: frontmatter.name,
			description: frontmatter.description,
			tools: tools && tools.length > 0 ? tools : undefined,
			model: frontmatter.model,
			systemPrompt: body,
			source,
			filePath,
		});
	}

	return agents;
}

function isDirectory(p: string): boolean {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

function findNearestProjectAgentsDir(cwd: string): string | null {
	let currentDir = cwd;
	while (true) {
		const candidate = path.join(currentDir, CONFIG_DIR_NAME, "agents");
		if (isDirectory(candidate)) return candidate;

		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) return null;
		currentDir = parentDir;
	}
}

export function discoverAgents(cwd: string, scope: AgentScope): AgentDiscoveryResult {
	const userDir = path.join(getAgentDir(), "agents");
	const projectAgentsDir = findNearestProjectAgentsDir(cwd);

	const userAgents = scope === "project" ? [] : loadAgentsFromDir(userDir, "user");
	const projectAgents = scope === "user" || !projectAgentsDir ? [] : loadAgentsFromDir(projectAgentsDir, "project");

	const agentMap = new Map<string, AgentConfig>();
	for (const agent of BUILTIN_AGENTS) agentMap.set(agent.name, agent);

	if (scope === "both") {
		for (const agent of userAgents) agentMap.set(agent.name, agent);
		for (const agent of projectAgents) agentMap.set(agent.name, agent);
	} else if (scope === "user") {
		for (const agent of userAgents) agentMap.set(agent.name, agent);
	} else {
		for (const agent of projectAgents) agentMap.set(agent.name, agent);
	}

	return { agents: Array.from(agentMap.values()), projectAgentsDir };
}

export function formatAgentList(agents: AgentConfig[], maxItems: number): { text: string; remaining: number } {
	if (agents.length === 0) return { text: "none", remaining: 0 };
	const listed = agents.slice(0, maxItems);
	const remaining = agents.length - listed.length;
	return {
		text: listed.map((a) => `${a.name} (${a.source}): ${a.description}`).join("; "),
		remaining,
	};
}
