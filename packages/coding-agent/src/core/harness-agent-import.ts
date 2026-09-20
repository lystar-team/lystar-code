import { type Dirent, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { type ParseError, parse as parseJsonc } from "jsonc-parser";
import { parse as parseToml } from "smol-toml";
import { parseFrontmatter } from "../utils/frontmatter.ts";
import {
	normalizeSubagentTools,
	renderSubagentMarkdown,
	SUBAGENT_THINKING_LEVELS,
	type SubagentConfigInput,
	type SubagentThinkingLevel,
} from "./subagent-config.ts";

export type HarnessAgentKind = "codex" | "claude-code" | "opencode";

export interface HarnessAgentResource {
	path: string;
	root: string;
	name: string;
	description: string;
	content: string;
	warnings: string[];
	referencedPaths: string[];
}

interface AgentSourceOptions {
	harness: HarnessAgentKind;
	agentRoots: string[];
	configFiles: string[];
}

const MAX_AGENT_DEPTH = 5;
const MAX_AGENT_FILES = 1_000;
const READ_ONLY_TOOLS = ["read", "grep", "find", "ls"];
const TARGET_TOOL_NAMES = new Map<string, string>([
	["read", "read"],
	["grep", "grep"],
	["glob", "find"],
	["find", "find"],
	["list", "ls"],
	["ls", "ls"],
	["bash", "bash"],
	["shell", "bash"],
	["edit", "edit"],
	["multiedit", "edit"],
	["write", "write"],
]);

function recordValue(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

function mapToolName(value: string): string | undefined {
	return TARGET_TOOL_NAMES.get(value.trim().toLowerCase());
}

function mapTools(value: unknown, warnings: string[]): string[] | undefined {
	const normalized = normalizeSubagentTools(value);
	if (!normalized) return undefined;
	const tools: string[] = [];
	const unsupported: string[] = [];
	for (const tool of normalized) {
		const mapped = mapToolName(tool);
		if (mapped) tools.push(mapped);
		else unsupported.push(tool);
	}
	if (unsupported.length > 0) warnings.push(`未迁移不受支持的工具：${unsupported.join("、")}`);
	return tools.length > 0 ? [...new Set(tools)] : undefined;
}

function thinkingLevel(value: unknown, warnings: string[]): SubagentThinkingLevel | undefined {
	const level = stringValue(value);
	if (!level) return undefined;
	if (SUBAGENT_THINKING_LEVELS.includes(level as SubagentThinkingLevel)) return level as SubagentThinkingLevel;
	warnings.push(`未迁移不受支持的思考强度：${level}`);
	return undefined;
}

function appendSkillReferences(content: string, paths: string[]): string {
	if (paths.length === 0) return content;
	const section = `## 关联 Skill\n\n${paths.map((path) => `- \`${path}\``).join("\n")}`;
	return `${content.trim()}\n\n${section}`.trim();
}

function existingFile(path: string): boolean {
	try {
		return existsSync(path) && statSync(path).isFile();
	} catch {
		return false;
	}
}

function collectFiles(root: string, extension: ".md" | ".toml"): string[] {
	if (!existsSync(root)) return [];
	const result: string[] = [];
	const visit = (current: string, depth: number) => {
		if (depth > MAX_AGENT_DEPTH || result.length >= MAX_AGENT_FILES) return;
		let entries: Dirent[];
		try {
			entries = readdirSync(current, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === ".git") continue;
			const path = join(current, entry.name);
			if (entry.isDirectory()) visit(path, depth + 1);
			else if (entry.isFile() && extname(entry.name).toLowerCase() === extension) result.push(path);
			if (result.length >= MAX_AGENT_FILES) return;
		}
	};
	visit(root, 0);
	return result;
}

function sourceRoot(path: string, roots: string[]): string {
	return (
		roots
			.filter((root) => path === root || path.startsWith(`${root}/`))
			.sort((left, right) => right.length - left.length)[0] ?? dirname(path)
	);
}

function codexSkillPaths(value: unknown): string[] {
	const skills = recordValue(value);
	const config = skills?.config;
	if (!Array.isArray(config)) return [];
	return config
		.map(recordValue)
		.filter((entry): entry is Record<string, unknown> => entry !== undefined)
		.filter((entry) => booleanValue(entry.enabled) !== false)
		.map((entry) => stringValue(entry.path))
		.filter((path): path is string => path !== undefined)
		.filter(existingFile);
}

function parseCodexAgent(
	path: string,
	root: string,
	overrides: { name?: string; description?: string } = {},
): HarnessAgentResource | undefined {
	let data: Record<string, unknown>;
	try {
		data = parseToml(readFileSync(path, "utf8")) as Record<string, unknown>;
	} catch {
		return undefined;
	}
	const warnings: string[] = ["将 Codex TOML 转换为 LYStar Code Agent Markdown"];
	const name = overrides.name ?? stringValue(data.name) ?? basename(path, extname(path));
	const description = overrides.description ?? stringValue(data.description) ?? name;
	const model = stringValue(data.model);
	const level = thinkingLevel(data.model_reasoning_effort, warnings);
	const sandboxMode = stringValue(data.sandbox_mode);
	const tools = sandboxMode === "read-only" ? READ_ONLY_TOOLS : undefined;
	if (sandboxMode && sandboxMode !== "read-only" && sandboxMode !== "workspace-write") {
		warnings.push(`sandbox_mode=${sandboxMode} 没有完全等价的 LYStar Code 权限模式`);
	}
	const nestedAgents = recordValue(data.agents);
	if (booleanValue(nestedAgents?.enabled) === true) warnings.push("LYStar Code 智能体不支持继续派发智能体");
	const skillPaths = codexSkillPaths(data.skills);
	const developerInstructions = stringValue(data.developer_instructions) ?? stringValue(data.instructions) ?? "";
	const content = appendSkillReferences(developerInstructions, skillPaths);
	const definition: SubagentConfigInput = {
		name,
		description,
		...(model ? { model } : {}),
		...(level ? { thinkingLevel: level } : {}),
		...(tools ? { tools } : {}),
		content,
	};
	return {
		path,
		root,
		name,
		description,
		content: renderSubagentMarkdown(definition),
		warnings,
		referencedPaths: skillPaths,
	};
}

function discoverCodexAgents(options: AgentSourceOptions): HarnessAgentResource[] {
	const resources = new Map<string, HarnessAgentResource>();
	const referencedConfigs = new Set<string>();
	for (const configPath of options.configFiles.filter(existingFile)) {
		let data: Record<string, unknown>;
		try {
			data = parseToml(readFileSync(configPath, "utf8")) as Record<string, unknown>;
		} catch {
			continue;
		}
		const agents = recordValue(data.agents);
		if (!agents) continue;
		for (const [roleName, value] of Object.entries(agents)) {
			const role = recordValue(value);
			const configFile = stringValue(role?.config_file);
			if (!configFile) continue;
			const path = resolve(dirname(configPath), configFile);
			if (!existingFile(path)) continue;
			referencedConfigs.add(path);
			const parsed = parseCodexAgent(path, sourceRoot(path, options.agentRoots), {
				name: roleName,
				description: stringValue(role?.description),
			});
			if (parsed) resources.set(`${path}\0${roleName}`, parsed);
		}
	}
	for (const root of options.agentRoots) {
		for (const path of collectFiles(root, ".toml")) {
			if (referencedConfigs.has(path)) continue;
			const parsed = parseCodexAgent(path, root);
			if (parsed) resources.set(`${path}\0${parsed.name}`, parsed);
		}
	}
	return [...resources.values()];
}

function permissionModeTools(value: unknown): string[] | undefined {
	const mode = stringValue(value)?.toLowerCase();
	return mode === "plan" ? READ_ONLY_TOOLS : undefined;
}

function parseClaudeAgent(path: string, root: string): HarnessAgentResource | undefined {
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch {
		return undefined;
	}
	const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(raw);
	const warnings: string[] = ["将 Claude Code Agent 转换为 LYStar Code Agent Markdown"];
	const name = stringValue(frontmatter.name) ?? basename(path, extname(path));
	const description = stringValue(frontmatter.description) ?? name;
	const model = stringValue(frontmatter.model);
	const permissionTools = permissionModeTools(frontmatter.permissionMode);
	const tools = permissionTools ?? mapTools(frontmatter.tools, warnings);
	for (const key of ["hooks", "mcpServers", "memory", "background", "isolation", "maxTurns", "skills"]) {
		if (frontmatter[key] !== undefined) warnings.push(`未迁移 Claude Code 专属字段：${key}`);
	}
	return {
		path,
		root,
		name,
		description,
		content: renderSubagentMarkdown({
			name,
			description,
			...(model ? { model } : {}),
			...(tools ? { tools } : {}),
			content: body,
		}),
		warnings,
		referencedPaths: [],
	};
}

function discoverClaudeAgents(options: AgentSourceOptions): HarnessAgentResource[] {
	return options.agentRoots.flatMap((root) =>
		collectFiles(root, ".md")
			.map((path) => parseClaudeAgent(path, root))
			.filter((resource): resource is HarnessAgentResource => resource !== undefined),
	);
}

function openCodeModeSupported(value: unknown): boolean {
	const mode = stringValue(value)?.toLowerCase();
	return mode === undefined || mode === "subagent" || mode === "all";
}

function openCodePermissionTools(value: unknown, tools: string[] | undefined): string[] | undefined {
	const permission = recordValue(value);
	if (!permission || !tools) return tools;
	return tools.filter((tool) => {
		const setting = permission[tool];
		return setting !== false && setting !== "deny";
	});
}

function resolveOpenCodePrompt(prompt: string, baseDir: string, warnings: string[]): string {
	return prompt.replace(/\{file:([^}]+)\}/gu, (token, rawPath: string) => {
		const value = rawPath.trim();
		const path = isAbsolute(value) ? value : resolve(baseDir, value);
		if (!existingFile(path)) {
			warnings.push(`OpenCode Prompt 引用文件不存在：${value}`);
			return token;
		}
		try {
			return readFileSync(path, "utf8");
		} catch {
			warnings.push(`OpenCode Prompt 引用文件读取失败：${value}`);
			return token;
		}
	});
}

function openCodeDefinition(
	value: Record<string, unknown>,
	name: string,
	path: string,
	root: string,
	body: string,
): HarnessAgentResource | undefined {
	if (!openCodeModeSupported(value.mode)) return undefined;
	const warnings: string[] = ["将 OpenCode Agent 转换为 LYStar Code Agent Markdown"];
	const description = stringValue(value.description) ?? name;
	const modelReference = stringValue(value.model);
	const slash = modelReference?.indexOf("/") ?? -1;
	const provider = slash > 0 ? modelReference?.slice(0, slash) : undefined;
	const model = slash > 0 ? modelReference?.slice(slash + 1) : modelReference;
	const mappedTools = mapTools(value.tools, warnings);
	const tools = openCodePermissionTools(value.permission, mappedTools);
	for (const key of ["temperature", "top_p", "steps", "color", "hidden"]) {
		if (value[key] !== undefined) warnings.push(`未迁移 OpenCode 专属字段：${key}`);
	}
	return {
		path,
		root,
		name,
		description,
		content: renderSubagentMarkdown({
			name,
			description,
			...(provider ? { provider } : {}),
			...(model ? { model } : {}),
			...(tools ? { tools } : {}),
			content: resolveOpenCodePrompt(body, dirname(path), warnings),
		}),
		warnings,
		referencedPaths: [],
	};
}

function parseOpenCodeMarkdown(path: string, root: string): HarnessAgentResource | undefined {
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch {
		return undefined;
	}
	const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(raw);
	const name = stringValue(frontmatter.name) ?? basename(path, extname(path));
	return openCodeDefinition(frontmatter, name, path, root, body);
}

function parseOpenCodeConfig(path: string, roots: string[]): HarnessAgentResource[] {
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch {
		return [];
	}
	const errors: ParseError[] = [];
	const parsed = parseJsonc(raw, errors, { allowTrailingComma: true, disallowComments: false }) as unknown;
	if (errors.length > 0) return [];
	const agents = recordValue(recordValue(parsed)?.agent);
	if (!agents) return [];
	const root = sourceRoot(path, roots);
	return Object.entries(agents)
		.map(([name, value]) => {
			const definition = recordValue(value);
			if (!definition) return undefined;
			const prompt = stringValue(definition.prompt) ?? "";
			return openCodeDefinition(definition, name, path, root, prompt);
		})
		.filter((resource): resource is HarnessAgentResource => resource !== undefined);
}

function discoverOpenCodeAgents(options: AgentSourceOptions): HarnessAgentResource[] {
	const resources = new Map<string, HarnessAgentResource>();
	for (const root of options.agentRoots) {
		for (const path of collectFiles(root, ".md")) {
			const parsed = parseOpenCodeMarkdown(path, root);
			if (parsed) resources.set(parsed.name, parsed);
		}
	}
	for (const path of options.configFiles.filter(existingFile)) {
		for (const parsed of parseOpenCodeConfig(path, options.agentRoots)) {
			if (!resources.has(parsed.name)) resources.set(parsed.name, parsed);
		}
	}
	return [...resources.values()];
}

export function discoverHarnessAgentResources(options: AgentSourceOptions): HarnessAgentResource[] {
	if (options.harness === "codex") return discoverCodexAgents(options);
	if (options.harness === "claude-code") return discoverClaudeAgents(options);
	return discoverOpenCodeAgents(options);
}
