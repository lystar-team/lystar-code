import { createHash, randomUUID } from "node:crypto";
import {
	chmodSync,
	copyFileSync,
	cpSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { discoverHarnessAgentResources } from "./harness-agent-import.ts";

export type HarnessId = "codex" | "opencode" | "claude-code";
export type HarnessImportScope = "user" | "project";
export type HarnessResourceType = "skill" | "prompt" | "instruction" | "agent" | "reference";

export interface HarnessImportItem {
	id: string;
	harness: HarnessId;
	harnessLabel: string;
	sourceScope: HarnessImportScope;
	resourceType: HarnessResourceType;
	name: string;
	sourceRelativePath: string;
	targetRelativePath: string;
	description?: string;
	referencedItemIds?: string[];
	warnings: string[];
	contentHash: string;
	sourcePath: string;
	targetPath: string;
	generatedContent?: string;
}

export interface HarnessImportSource {
	id: string;
	harness: HarnessId;
	label: string;
	scope: HarnessImportScope;
	detected: boolean;
	resourceCount: number;
	resourceTypes: { skills: number; agents: number; prompts: number; instructions: number; references: number };
}

export interface HarnessImportPreview {
	sources: HarnessImportSource[];
	items: HarnessImportItem[];
}

export interface HarnessImportResultItem {
	id: string;
	status: "imported" | "skipped" | "failed";
	message?: string;
}

export interface HarnessImportResult {
	imported: number;
	skipped: number;
	failed: number;
	items: HarnessImportResultItem[];
	backupPath?: string;
}

interface ResourceCandidate {
	type: HarnessResourceType;
	path: string;
	root: string;
	name: string;
	description?: string;
	referencedPaths?: string[];
	content?: string;
	warnings?: string[];
}

interface HarnessProfile {
	harness: HarnessId;
	label: string;
	userRoots: string[];
	projectRoots: string[];
	userSkillRoots: string[];
	projectSkillRoots: string[];
	userAgentRoots: string[];
	projectAgentRoots: string[];
	userAgentConfigFiles: string[];
	projectAgentConfigFiles: string[];
	userPromptRoots: string[];
	projectPromptRoots: string[];
	userInstructionFiles: string[];
}

const MAX_SCAN_DEPTH = 5;
const MAX_RESOURCE_FILES = 1_000;
const MAX_FILE_BYTES = 32 * 1024 * 1024;
const TEXT_FILE_EXTENSIONS = new Set([
	".bash",
	".bat",
	".cfg",
	".cmd",
	".cjs",
	".css",
	".env",
	".html",
	".ini",
	".js",
	".json",
	".mjs",
	".md",
	".ps1",
	".py",
	".rb",
	".rs",
	".sh",
	".sql",
	".toml",
	".ts",
	".txt",
	".xml",
	".yaml",
	".yml",
]);

const REFERENCE_DOCUMENT_EXTENSIONS = new Set([".md", ".mdx", ".txt"]);

interface PathRewrite {
	from: string;
	to: string;
}

function profilePaths(home: string, cwd: string): HarnessProfile[] {
	return [
		{
			harness: "codex",
			label: "Codex",
			userRoots: [join(home, ".codex")],
			projectRoots: [join(cwd, ".codex")],
			userSkillRoots: [join(home, ".codex", "skills"), join(home, ".codex", "vendor_imports", "skills")],
			projectSkillRoots: [join(cwd, ".codex", "skills")],
			userAgentRoots: [join(home, ".codex", "agents")],
			projectAgentRoots: [join(cwd, ".codex", "agents")],
			userAgentConfigFiles: [join(home, ".codex", "config.toml")],
			projectAgentConfigFiles: [join(cwd, ".codex", "config.toml")],
			userPromptRoots: [join(home, ".codex", "prompts")],
			projectPromptRoots: [join(cwd, ".codex", "prompts")],
			userInstructionFiles: [join(home, ".codex", "AGENTS.md")],
		},
		{
			harness: "opencode",
			label: "OpenCode",
			userRoots: [join(home, ".config", "opencode"), join(home, ".opencode")],
			projectRoots: [join(cwd, ".opencode")],
			userSkillRoots: [join(home, ".config", "opencode", "skills"), join(home, ".opencode", "skills")],
			projectSkillRoots: [join(cwd, ".opencode", "skills")],
			userAgentRoots: [join(home, ".config", "opencode", "agents"), join(home, ".opencode", "agents")],
			projectAgentRoots: [join(cwd, ".opencode", "agents")],
			userAgentConfigFiles: [
				join(home, ".config", "opencode", "opencode.json"),
				join(home, ".config", "opencode", "opencode.jsonc"),
				join(home, ".opencode", "opencode.json"),
				join(home, ".opencode", "opencode.jsonc"),
			],
			projectAgentConfigFiles: [
				join(cwd, "opencode.json"),
				join(cwd, "opencode.jsonc"),
				join(cwd, ".opencode", "opencode.json"),
				join(cwd, ".opencode", "opencode.jsonc"),
			],
			userPromptRoots: [
				join(home, ".config", "opencode", "commands"),
				join(home, ".config", "opencode", "prompts"),
				join(home, ".opencode", "commands"),
				join(home, ".opencode", "prompts"),
			],
			projectPromptRoots: [join(cwd, ".opencode", "commands"), join(cwd, ".opencode", "prompts")],
			userInstructionFiles: [
				join(home, ".config", "opencode", "AGENTS.md"),
				join(home, ".config", "opencode", "opencode.md"),
				join(home, ".opencode", "AGENTS.md"),
				join(home, ".opencode", "opencode.md"),
			],
		},
		{
			harness: "claude-code",
			label: "Claude Code",
			userRoots: [join(home, ".claude")],
			projectRoots: [join(cwd, ".claude")],
			userSkillRoots: [join(home, ".claude", "skills")],
			projectSkillRoots: [join(cwd, ".claude", "skills")],
			userAgentRoots: [join(home, ".claude", "agents")],
			projectAgentRoots: [join(cwd, ".claude", "agents")],
			userAgentConfigFiles: [],
			projectAgentConfigFiles: [],
			userPromptRoots: [join(home, ".claude", "commands"), join(home, ".claude", "prompts")],
			projectPromptRoots: [join(cwd, ".claude", "commands"), join(cwd, ".claude", "prompts")],
			userInstructionFiles: [join(home, ".claude", "CLAUDE.md")],
		},
	];
}

function pathKey(path: string): string {
	return resolve(path).split(sep).join("/");
}

function hashText(content: string): string {
	return createHash("sha256").update(content).digest("hex");
}

function pathVariants(path: string): string[] {
	return [...new Set([path, path.replaceAll("\\", "/"), path.replaceAll("/", "\\")])];
}

function addPathRewrite(rewrites: PathRewrite[], from: string, to: string): void {
	if (!from || from === to || from === ".") return;
	for (const source of pathVariants(from)) {
		const target = source.includes("\\") ? to.replaceAll("/", "\\") : to.replaceAll("\\", "/");
		if (!rewrites.some((rewrite) => rewrite.from === source && rewrite.to === target))
			rewrites.push({ from: source, to: target });
	}
}

function targetRelativeBase(targetScope: HarnessImportScope, cwd: string, agentDir: string): string {
	if (targetScope === "project")
		return (
			relative(cwd, targetRoot(agentDir, cwd, targetScope))
				.split(sep)
				.join("/") || "."
		);
	const relativeAgentDir = relative(homedir(), agentDir).split(sep).join("/");
	return relativeAgentDir ? `~/${relativeAgentDir}` : "~";
}

function isInside(parent: string, child: string): boolean {
	const parentKey = pathKey(parent).replace(/\/+$/u, "");
	const childKey = pathKey(child);
	return childKey === parentKey || childKey.startsWith(`${parentKey}/`);
}

function targetPathLabel(base: string, targetRelativePath: string): string {
	return base === "." ? targetRelativePath : `${base}/${targetRelativePath}`;
}

function resourcePathRewrites(options: {
	harness: HarnessId;
	sourceScope: HarnessImportScope;
	sourcePath: string;
	sourceRelativePath: string;
	targetPath: string;
	targetRelativePath: string;
	targetScope: HarnessImportScope;
	cwd: string;
	agentDir: string;
}): PathRewrite[] {
	const profile = profilePaths(homedir(), options.cwd).find((candidate) => candidate.harness === options.harness);
	const sourceRoots = options.sourceScope === "user" ? (profile?.userRoots ?? []) : (profile?.projectRoots ?? []);
	const sourceBase = options.sourceScope === "user" ? homedir() : options.cwd;
	const destinationRoot = targetRoot(options.agentDir, options.cwd, options.targetScope);
	const targetBase = targetRelativeBase(options.targetScope, options.cwd, options.agentDir);
	const targetLabel = targetPathLabel(targetBase, options.targetRelativePath);
	const rewrites: PathRewrite[] = [];
	addPathRewrite(rewrites, options.sourcePath, options.targetPath);
	if (options.sourceRelativePath.includes("/") || options.sourceRelativePath.startsWith(".")) {
		addPathRewrite(rewrites, options.sourceRelativePath, targetLabel);
	}
	const sourceBaseRelative = relative(sourceBase, options.sourcePath).split(sep).join("/");
	if (sourceBaseRelative && sourceBaseRelative !== ".." && !sourceBaseRelative.startsWith("../")) {
		addPathRewrite(rewrites, sourceBaseRelative, targetLabel);
	}
	for (const sourceRoot of sourceRoots) {
		addPathRewrite(rewrites, sourceRoot, destinationRoot);
		const sourceRelativeRoot = relative(sourceBase, sourceRoot).split(sep).join("/");
		if (sourceRelativeRoot && sourceRelativeRoot !== ".." && !sourceRelativeRoot.startsWith("../")) {
			const sourceLabel = options.sourceScope === "user" ? `~/${sourceRelativeRoot}` : sourceRelativeRoot;
			addPathRewrite(rewrites, sourceLabel, targetBase);
		}
	}
	const environmentNames: Partial<Record<HarnessId, string>> = {
		codex: "CODEX_HOME",
		opencode: "OPENCODE_CONFIG_DIR",
		"claude-code": "CLAUDE_CONFIG_DIR",
	};
	const environmentName = environmentNames[options.harness];
	if (environmentName && options.sourceScope === "user") {
		addPathRewrite(rewrites, `\${${environmentName}}`, destinationRoot);
		addPathRewrite(rewrites, `$${environmentName}`, destinationRoot);
	}
	return rewrites.sort((left, right) => right.from.length - left.from.length);
}

function isTextFile(path: string, content: Buffer): boolean {
	if (content.includes(0)) return false;
	if (TEXT_FILE_EXTENSIONS.has(extname(path).toLowerCase())) return true;
	if (content.subarray(0, 2).toString("utf8") === "#!") return true;
	return !content.toString("utf8").includes("\ufffd");
}

function rewriteText(content: string, rewrites: PathRewrite[]): { text: string; replacements: number } {
	if (rewrites.length === 0) return { text: content, replacements: 0 };
	const targets = new Map(rewrites.map((rewrite) => [rewrite.from, rewrite.to]));
	const pattern = [...targets.keys()]
		.sort((left, right) => right.length - left.length)
		.map((source) => source.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"))
		.join("|");
	let replacements = 0;
	const text = content.replace(new RegExp(pattern, "gu"), (source) => {
		replacements++;
		return targets.get(source) ?? source;
	});
	return { text, replacements };
}

function rewriteTextFilePaths(path: string, rewrites: PathRewrite[], write: boolean): number {
	const content = readFileSync(path);
	if (!isTextFile(path, content)) return 0;
	const result = rewriteText(content.toString("utf8"), rewrites);
	if (write && result.replacements > 0) writeFileSync(path, result.text, "utf8");
	return result.replacements;
}

function countDirectoryPathRewrites(directory: string, rewrites: PathRewrite[], depth = 0): number {
	if (depth > MAX_SCAN_DEPTH) return 0;
	let count = 0;
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		if (entry.name === ".git" || entry.name === "node_modules" || entry.name.startsWith(".")) continue;
		const path = join(directory, entry.name);
		if (entry.isDirectory()) count += countDirectoryPathRewrites(path, rewrites, depth + 1);
		else if (entry.isFile() && statSync(path).size <= MAX_FILE_BYTES)
			count += rewriteTextFilePaths(path, rewrites, false);
	}
	return count;
}

function countResourcePathRewrites(path: string, rewrites: PathRewrite[]): number {
	return statSync(path).isDirectory()
		? countDirectoryPathRewrites(path, rewrites)
		: statSync(path).size <= MAX_FILE_BYTES
			? rewriteTextFilePaths(path, rewrites, false)
			: 0;
}

function hashDirectory(directory: string): string {
	const hash = createHash("sha256");
	const files: string[] = [];
	const collect = (current: string, depth: number) => {
		if (depth > MAX_SCAN_DEPTH || files.length >= MAX_RESOURCE_FILES) return;
		for (const entry of readdirSync(current, { withFileTypes: true }).sort((left, right) =>
			left.name.localeCompare(right.name),
		)) {
			if (
				entry.name === ".git" ||
				entry.name === "node_modules" ||
				entry.name === ".system" ||
				entry.name.startsWith(".")
			)
				continue;
			const entryPath = join(current, entry.name);
			if (entry.isDirectory()) collect(entryPath, depth + 1);
			else if (entry.isFile()) files.push(entryPath);
		}
	};
	collect(directory, 0);
	for (const file of files.sort()) {
		const relativePath = relative(directory, file).split(sep).join("/");
		const stat = statSync(file);
		if (stat.size > MAX_FILE_BYTES) continue;
		hash.update(relativePath);
		hash.update(readFileSync(file));
	}
	return hash.digest("hex");
}

function readFrontmatter(path: string): { name?: string; description?: string } {
	try {
		const content = readFileSync(path, "utf8");
		const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
		if (!match) return {};
		const values: Record<string, string> = {};
		for (const line of match[1].split(/\r?\n/u)) {
			const field = /^([A-Za-z][\w-]*):\s*(.*)$/u.exec(line);
			if (field) values[field[1]] = field[2].replace(/^['"]|['"]$/gu, "");
		}
		return { name: values.name, description: values.description };
	} catch {
		return {};
	}
}

function isSafePath(path: string): boolean {
	try {
		return statSync(path).isFile() || statSync(path).isDirectory();
	} catch {
		return false;
	}
}

function collectSkillDirectories(root: string): string[] {
	if (!existsSync(root) || !statSync(root).isDirectory()) return [];
	const result: string[] = [];
	const visit = (current: string, depth: number) => {
		if (depth > MAX_SCAN_DEPTH || result.length >= MAX_RESOURCE_FILES) return;
		try {
			const entries = readdirSync(current, { withFileTypes: true, encoding: "utf8" });
			if (entries.some((entry) => entry.isFile() && entry.name.toUpperCase() === "SKILL.MD")) {
				result.push(current);
				return;
			}
			for (const entry of entries) {
				if (
					!entry.isDirectory() ||
					entry.name === ".git" ||
					entry.name === "node_modules" ||
					entry.name === ".system" ||
					entry.name.startsWith(".")
				)
					continue;
				visit(join(current, entry.name), depth + 1);
			}
		} catch {
			return;
		}
	};
	visit(root, 0);
	return result;
}

function collectPromptFiles(root: string): string[] {
	if (!existsSync(root) || !statSync(root).isDirectory()) return [];
	const result: string[] = [];
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		if (entry.isFile() && extname(entry.name).toLowerCase() === ".md") result.push(join(root, entry.name));
	}
	return result;
}

function isImportableReferenceFile(path: string): boolean {
	try {
		const stat = statSync(path);
		return stat.isFile() && stat.size <= MAX_FILE_BYTES;
	} catch {
		return false;
	}
}

function canContainInstructionReferences(path: string): boolean {
	return REFERENCE_DOCUMENT_EXTENSIONS.has(extname(path).toLowerCase());
}

function referenceTokens(content: string): string[] {
	const values = new Set<string>();
	const add = (raw: string) => {
		const value = raw
			.trim()
			.replace(/^@/u, "")
			.replace(/[?#].*$/u, "")
			.replace(/^[<([{]+/u, "")
			.replace(/[>)\]},.;:!?]+$/u, "");
		if (!value || /\s/u.test(value) || /^(?:https?|ftp|mailto):/iu.test(value) || value.includes("://")) return;
		if (
			!value.includes("/") &&
			!value.includes("\\") &&
			!/\.(?:md|mdx|txt|json|jsonc|yaml|yml|toml|cfg|ini)$/iu.test(value)
		)
			return;
		values.add(value);
	};
	for (const match of content.matchAll(/\]\(([^)\s]+)(?:\s+["'][^)]*)?\)/gu)) add(match[1]);
	for (const match of content.matchAll(/`([^`\n]+)`/gu)) add(match[1]);
	const pathPattern =
		/(?:^|[\s"'([{])(@?(?:(?:~\/)|(?:\$\{?[A-Z][A-Z0-9_]*\}?\/)|(?:\.{0,2}[/\\]))?[A-Za-z0-9_.@+$(){}-]+(?:[/\\][A-Za-z0-9_.@+$(){}-]+)*(?:\.[A-Za-z0-9_-]+)?)/gmu;
	for (const match of content.matchAll(pathPattern)) add(match[1]);
	return [...values];
}

function sourceRootForPath(profile: HarnessProfile, scope: HarnessImportScope, path: string, cwd: string): string {
	const roots = scope === "user" ? profile.userRoots : profile.projectRoots;
	return (
		roots.filter((root) => isInside(root, path)).sort((left, right) => right.length - left.length)[0] ??
		(scope === "user" ? homedir() : cwd)
	);
}

function expandReferencePath(
	reference: string,
	profile: HarnessProfile,
	sourceScope: HarnessImportScope,
	instructionPath: string,
	cwd: string,
): string[] {
	const sourceRoots = sourceScope === "user" ? profile.userRoots : profile.projectRoots;
	const sourceBase = sourceScope === "user" ? homedir() : cwd;
	const environmentNames: Partial<Record<HarnessId, string>> = {
		codex: "CODEX_HOME",
		opencode: "OPENCODE_CONFIG_DIR",
		"claude-code": "CLAUDE_CONFIG_DIR",
	};
	let expanded = reference.replaceAll("\\", "/");
	const environmentName = environmentNames[profile.harness];
	if (environmentName && sourceRoots[0]) {
		expanded = expanded.replace(new RegExp(`^\\$\\{?${environmentName}\\}?`), sourceRoots[0]);
	}
	if (expanded === "~") expanded = homedir();
	else if (expanded.startsWith("~/")) expanded = join(homedir(), expanded.slice(2));
	const candidates = isAbsolute(expanded)
		? [expanded]
		: [
				resolve(dirname(instructionPath), expanded),
				resolve(sourceBase, expanded),
				...sourceRoots.map((root) => resolve(root, expanded)),
			];
	const allowedRoots = [sourceBase, ...sourceRoots];
	return [...new Set(candidates.map(pathKey))]
		.filter((path) => allowedRoots.some((root) => isInside(root, path)))
		.filter((path) => isImportableReferenceFile(path));
}

function readTextFile(path: string): string | undefined {
	try {
		const content = readFileSync(path);
		return isTextFile(path, content) ? content.toString("utf8") : undefined;
	} catch {
		return undefined;
	}
}

function discoverReferencedPaths(
	profile: HarnessProfile,
	sourceScope: HarnessImportScope,
	instructionPath: string,
	cwd: string,
	managedCandidates: ResourceCandidate[],
): string[] {
	const pending = [instructionPath];
	const visited = new Set<string>();
	const result = new Set<string>();
	while (pending.length > 0 && result.size < MAX_RESOURCE_FILES) {
		const current = pending.shift();
		if (!current) break;
		const currentKey = pathKey(current);
		if (visited.has(currentKey)) continue;
		visited.add(currentKey);
		const content = readTextFile(current);
		if (content === undefined) continue;
		for (const reference of referenceTokens(content)) {
			for (const referencedPath of expandReferencePath(reference, profile, sourceScope, current, cwd)) {
				if (pathKey(referencedPath) === pathKey(instructionPath)) continue;
				if (managedCandidates.some((candidate) => isInside(candidate.path, referencedPath))) continue;
				result.add(referencedPath);
				if (canContainInstructionReferences(referencedPath)) pending.push(referencedPath);
				if (result.size >= MAX_RESOURCE_FILES) break;
			}
			if (result.size >= MAX_RESOURCE_FILES) break;
		}
	}
	return [...result];
}

function collectCandidates(profile: HarnessProfile, scope: HarnessImportScope, cwd: string): ResourceCandidate[] {
	const candidates: ResourceCandidate[] = [];
	const skillRoots = scope === "user" ? profile.userSkillRoots : profile.projectSkillRoots;
	const agentRoots = scope === "user" ? profile.userAgentRoots : profile.projectAgentRoots;
	const agentConfigFiles = scope === "user" ? profile.userAgentConfigFiles : profile.projectAgentConfigFiles;
	const promptRoots = scope === "user" ? profile.userPromptRoots : profile.projectPromptRoots;
	const instructionFiles = scope === "user" ? profile.userInstructionFiles : [];
	for (const root of skillRoots) {
		for (const path of collectSkillDirectories(root)) {
			const metadata = readFrontmatter(join(path, "SKILL.md"));
			candidates.push({
				type: "skill",
				path,
				root,
				name: metadata.name || basename(path),
				description: metadata.description,
			});
		}
	}
	const agentNames = new Set<string>();
	for (const resource of discoverHarnessAgentResources({
		harness: profile.harness,
		agentRoots,
		configFiles: agentConfigFiles,
	})) {
		if (agentNames.has(resource.name)) continue;
		agentNames.add(resource.name);
		candidates.push({
			type: "agent",
			path: resource.path,
			root: resource.root,
			name: resource.name,
			description: resource.description,
			content: resource.content,
			warnings: resource.warnings,
			referencedPaths: resource.referencedPaths,
		});
	}
	for (const root of promptRoots) {
		for (const path of collectPromptFiles(root)) {
			const metadata = readFrontmatter(path);
			candidates.push({
				type: "prompt",
				path,
				root,
				name: basename(path, extname(path)),
				description: metadata.description,
			});
		}
	}
	for (const path of instructionFiles) {
		if (!existsSync(path) || !isSafePath(path)) continue;
		candidates.push({ type: "instruction", path, root: dirname(path), name: basename(path) });
	}
	const managedCandidates = [...candidates];
	const referenceCandidates = new Map<string, ResourceCandidate>();
	for (const instruction of candidates.filter((candidate) => candidate.type === "instruction")) {
		const referencedPaths = discoverReferencedPaths(profile, scope, instruction.path, cwd, managedCandidates);
		instruction.referencedPaths = referencedPaths;
		for (const path of referencedPaths) {
			const key = pathKey(path);
			if (referenceCandidates.has(key)) continue;
			const root = sourceRootForPath(profile, scope, path, cwd);
			const candidate: ResourceCandidate = { type: "reference", path, root, name: basename(path) };
			referenceCandidates.set(key, candidate);
			candidates.push(candidate);
		}
	}
	return candidates;
}

function sourceDetected(
	profile: HarnessProfile,
	scope: HarnessImportScope,
	candidates: readonly ResourceCandidate[],
): boolean {
	const roots = scope === "user" ? profile.userRoots : profile.projectRoots;
	return roots.some((root) => existsSync(root)) || candidates.length > 0;
}

function sourceRelativePath(candidate: ResourceCandidate): string {
	return relative(candidate.root, candidate.path).split(sep).join("/") || basename(candidate.path);
}

function targetRelativePath(candidate: ResourceCandidate): string {
	if (candidate.type === "skill") {
		const relativePath = sourceRelativePath(candidate);
		return `skills/${relativePath}`;
	}
	if (candidate.type === "agent") {
		const fileName = candidate.name.trim().replaceAll("/", "-").replaceAll("\\", "-") || "agent";
		return `agents/${fileName}.md`;
	}
	if (candidate.type === "prompt") return `prompts/${basename(candidate.path)}`;
	if (candidate.type === "reference") return sourceRelativePath(candidate);
	return "AGENTS.md";
}

function targetRoot(agentDir: string, cwd: string, scope: HarnessImportScope): string {
	return scope === "user" ? agentDir : join(cwd, ".pi");
}

function hashResource(path: string, content?: string): string {
	if (content !== undefined) return hashText(content);
	return statSync(path).isDirectory() ? hashDirectory(path) : hashText(readFileSync(path, "utf8"));
}

function createItem(
	profile: HarnessProfile,
	candidate: ResourceCandidate,
	sourceScope: HarnessImportScope,
	agentDir: string,
	cwd: string,
): HarnessImportItem {
	const targetScope = sourceScope;
	const destinationRoot = targetRoot(agentDir, cwd, targetScope);
	const targetRelative = targetRelativePath(candidate);
	const targetPath = join(destinationRoot, targetRelative);
	const sourceRelative = sourceRelativePath(candidate);
	const rewrites = resourcePathRewrites({
		harness: profile.harness,
		sourceScope,
		sourcePath: candidate.path,
		sourceRelativePath: sourceRelative,
		targetPath,
		targetRelativePath: targetRelative,
		targetScope,
		cwd,
		agentDir,
	});
	const warnings: string[] = [...(candidate.warnings ?? [])];
	if (candidate.type === "instruction") {
		warnings.push("会完整覆盖 LYStar Code 的全局 AGENTS.md，来源 Harness 文件不会被修改");
		if (candidate.referencedPaths?.length)
			warnings.push(`会一并迁移 ${candidate.referencedPaths.length} 个被引用文件`);
	} else if (candidate.type === "prompt" && candidate.description === undefined) {
		warnings.push("未发现提示词描述");
	}
	const rewriteCount =
		candidate.content === undefined
			? countResourcePathRewrites(candidate.path, rewrites)
			: rewriteText(candidate.content, rewrites).replacements;
	if (rewriteCount > 0)
		warnings.push(
			`导入到 LYStar Code 时会改写 ${rewriteCount} 处 ${profile.label} 路径引用；原 Harness 文件不变，脚本执行权限会保留`,
		);
	const id = hashText(`${profile.harness}:${sourceScope}:${pathKey(candidate.path)}:${targetRelative}`);
	return {
		id,
		harness: profile.harness,
		harnessLabel: profile.label,
		sourceScope,
		resourceType: candidate.type,
		name: candidate.name,
		sourceRelativePath: sourceRelative,
		targetRelativePath: targetRelative,
		...(candidate.description ? { description: candidate.description } : {}),
		warnings,
		contentHash: hashResource(candidate.path, candidate.content),
		sourcePath: candidate.path,
		targetPath,
		...(candidate.content === undefined ? {} : { generatedContent: candidate.content }),
	};
}

export function discoverHarnessImports(options: { cwd: string; agentDir: string }): HarnessImportPreview {
	const cwd = resolve(options.cwd);
	const agentDir = resolve(options.agentDir);
	const profiles = profilePaths(homedir(), cwd);
	const sources: HarnessImportSource[] = [];
	const items: HarnessImportItem[] = [];
	for (const profile of profiles) {
		for (const scope of ["user", "project"] as const) {
			const candidates = collectCandidates(profile, scope, cwd);
			const detected = sourceDetected(profile, scope, candidates);
			const sourceItems = candidates.map((candidate) => createItem(profile, candidate, scope, agentDir, cwd));
			const enrichedItems = sourceItems.map((item, index) => {
				const referencedItemIds = [
					...new Set(
						(candidates[index]?.referencedPaths ?? [])
							.map((path) => {
								const referencedIndex = candidates.findIndex(
									(candidate) => pathKey(candidate.path) === pathKey(path) || isInside(candidate.path, path),
								);
								return referencedIndex >= 0 ? sourceItems[referencedIndex]?.id : undefined;
							})
							.filter((id): id is string => id !== undefined),
					),
				];
				return referencedItemIds.length > 0 ? { ...item, referencedItemIds } : item;
			});
			items.push(...enrichedItems);
			sources.push({
				id: `${profile.harness}:${scope}`,
				harness: profile.harness,
				label: profile.label,
				scope,
				detected,
				resourceCount: enrichedItems.length,
				resourceTypes: {
					skills: enrichedItems.filter((item) => item.resourceType === "skill").length,
					agents: enrichedItems.filter((item) => item.resourceType === "agent").length,
					prompts: enrichedItems.filter((item) => item.resourceType === "prompt").length,
					instructions: enrichedItems.filter((item) => item.resourceType === "instruction").length,
					references: enrichedItems.filter((item) => item.resourceType === "reference").length,
				},
			});
		}
	}
	return { sources, items };
}

function copyFile(source: string, target: string, rewrites: PathRewrite[]): void {
	const sourceStat = statSync(source);
	if (sourceStat.size > MAX_FILE_BYTES) throw new Error(`文件过大：${basename(source)}`);
	mkdirSync(dirname(target), { recursive: true });
	const content = readFileSync(source);
	if (isTextFile(source, content)) {
		const rewritten = rewriteText(content.toString("utf8"), rewrites);
		writeFileSync(target, rewritten.text, "utf8");
	} else {
		copyFileSync(source, target);
	}
	chmodSync(target, sourceStat.mode & 0o777);
}

function copyDirectory(source: string, target: string, rewrites: PathRewrite[] = []): void {
	mkdirSync(target, { recursive: true });
	for (const entry of readdirSync(source, { withFileTypes: true })) {
		if (entry.name === ".git" || entry.name === "node_modules" || entry.name.startsWith(".")) continue;
		const sourcePath = join(source, entry.name);
		const targetPath = join(target, entry.name);
		if (entry.isDirectory()) copyDirectory(sourcePath, targetPath, rewrites);
		else if (entry.isFile()) copyFile(sourcePath, targetPath, rewrites);
	}
}

function previewPathRewrites(items: HarnessImportItem[], cwd: string, agentDir: string): PathRewrite[] {
	const rewrites: PathRewrite[] = [];
	for (const item of items) {
		for (const rewrite of resourcePathRewrites({
			harness: item.harness,
			sourceScope: item.sourceScope,
			sourcePath: item.sourcePath,
			sourceRelativePath: item.sourceRelativePath,
			targetPath: item.targetPath,
			targetRelativePath: item.targetRelativePath,
			targetScope: item.sourceScope,
			cwd,
			agentDir,
		})) {
			if (!rewrites.some((candidate) => candidate.from === rewrite.from && candidate.to === rewrite.to))
				rewrites.push(rewrite);
		}
	}
	return rewrites.sort((left, right) => right.from.length - left.from.length);
}

export function importHarnessResources(options: {
	cwd: string;
	agentDir: string;
	itemIds: string[];
}): HarnessImportResult {
	const preview = discoverHarnessImports({ cwd: options.cwd, agentDir: options.agentDir });
	const selected = new Set(options.itemIds);
	for (const item of preview.items) {
		if (!selected.has(item.id)) continue;
		for (const dependencyId of item.referencedItemIds ?? []) selected.add(dependencyId);
	}
	const selectedItems = preview.items.filter((candidate) => selected.has(candidate.id));
	const rewrites = previewPathRewrites(selectedItems, options.cwd, options.agentDir);
	const result: HarnessImportResult = { imported: 0, skipped: 0, failed: 0, items: [] };
	const backupRoot = join(
		resolve(options.agentDir),
		"migration-backups",
		`${new Date().toISOString().replace(/[:.]/gu, "-")}-${randomUUID()}`,
	);
	const backups = new Map<string, string>();
	for (const item of selectedItems) {
		let itemBackupPath = backups.get(item.targetPath);
		try {
			if (!itemBackupPath && existsSync(item.targetPath)) {
				itemBackupPath = join(backupRoot, item.sourceScope, item.targetRelativePath);
				mkdirSync(dirname(itemBackupPath), { recursive: true });
				cpSync(item.targetPath, itemBackupPath, { recursive: true, force: true, preserveTimestamps: true });
				backups.set(item.targetPath, itemBackupPath);
			}
			rmSync(item.targetPath, { recursive: true, force: true });
			if (item.generatedContent !== undefined) {
				mkdirSync(dirname(item.targetPath), { recursive: true });
				writeFileSync(item.targetPath, rewriteText(item.generatedContent, rewrites).text, "utf8");
			} else if (statSync(item.sourcePath).isDirectory()) copyDirectory(item.sourcePath, item.targetPath, rewrites);
			else copyFile(item.sourcePath, item.targetPath, rewrites);
			result.imported++;
			result.items.push({ id: item.id, status: "imported" });
		} catch (error) {
			if (itemBackupPath && existsSync(itemBackupPath)) {
				rmSync(item.targetPath, { recursive: true, force: true });
				mkdirSync(dirname(item.targetPath), { recursive: true });
				cpSync(itemBackupPath, item.targetPath, { recursive: true, force: true, preserveTimestamps: true });
			}
			result.failed++;
			result.items.push({
				id: item.id,
				status: "failed",
				message: error instanceof Error ? error.message : String(error),
			});
		}
	}
	if (backups.size > 0) result.backupPath = backupRoot;
	return result;
}
