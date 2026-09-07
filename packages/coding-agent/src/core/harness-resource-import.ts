import { createHash } from "node:crypto";
import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";

export type HarnessId = "codex" | "opencode" | "claude-code";
export type HarnessImportScope = "user" | "project";
export type HarnessResourceType = "skill" | "prompt" | "instruction";
export type HarnessImportItemStatus = "ready" | "already-imported" | "conflict" | "unsupported";

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
	instructionHunks?: HarnessImportInstructionHunk[];
	instructionSourceContent?: string;
	instructionTargetContent?: string;
	status: HarnessImportItemStatus;
	warnings: string[];
	contentHash: string;
	sourcePath: string;
	targetPath: string;
}

export interface HarnessImportSource {
	id: string;
	harness: HarnessId;
	label: string;
	scope: HarnessImportScope;
	detected: boolean;
	resourceCount: number;
	resourceTypes: { skills: number; prompts: number; instructions: number };
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
}

export interface HarnessImportInstructionHunk {
	id: string;
	title: string;
	lines: string[];
}

interface ResourceCandidate {
	type: HarnessResourceType;
	path: string;
	root: string;
	name: string;
	description?: string;
}

interface HarnessProfile {
	harness: HarnessId;
	label: string;
	userRoots: string[];
	projectRoots: string[];
	userSkillRoots: string[];
	projectSkillRoots: string[];
	userPromptRoots: string[];
	projectPromptRoots: string[];
	userInstructionFiles: string[];
	projectInstructionFiles: string[];
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
			userPromptRoots: [join(home, ".codex", "prompts")],
			projectPromptRoots: [join(cwd, ".codex", "prompts")],
			userInstructionFiles: [join(home, ".codex", "AGENTS.md")],
			projectInstructionFiles: [join(cwd, ".codex", "AGENTS.md")],
		},
		{
			harness: "opencode",
			label: "OpenCode",
			userRoots: [join(home, ".config", "opencode"), join(home, ".opencode")],
			projectRoots: [join(cwd, ".opencode")],
			userSkillRoots: [join(home, ".config", "opencode", "skills"), join(home, ".opencode", "skills")],
			projectSkillRoots: [join(cwd, ".opencode", "skills")],
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
			projectInstructionFiles: [join(cwd, ".opencode", "AGENTS.md"), join(cwd, ".opencode", "opencode.md")],
		},
		{
			harness: "claude-code",
			label: "Claude Code",
			userRoots: [join(home, ".claude")],
			projectRoots: [join(cwd, ".claude")],
			userSkillRoots: [join(home, ".claude", "skills")],
			projectSkillRoots: [join(cwd, ".claude", "skills")],
			userPromptRoots: [join(home, ".claude", "commands"), join(home, ".claude", "prompts")],
			projectPromptRoots: [join(cwd, ".claude", "commands"), join(cwd, ".claude", "prompts")],
			userInstructionFiles: [join(home, ".claude", "CLAUDE.md")],
			projectInstructionFiles: [join(cwd, ".claude", "CLAUDE.md")],
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

function skillPathRewrites(options: {
	harness: HarnessId;
	sourceScope: HarnessImportScope;
	sourcePath: string;
	targetPath: string;
	targetScope: HarnessImportScope;
	cwd: string;
	agentDir: string;
}): PathRewrite[] {
	const profile = profilePaths(homedir(), options.cwd).find((candidate) => candidate.harness === options.harness);
	const sourceRoots = options.sourceScope === "user" ? (profile?.userRoots ?? []) : (profile?.projectRoots ?? []);
	const destinationRoot = targetRoot(options.agentDir, options.cwd, options.targetScope);
	const rewrites: PathRewrite[] = [];
	addPathRewrite(rewrites, options.sourcePath, options.targetPath);
	for (const sourceRoot of sourceRoots) {
		addPathRewrite(rewrites, sourceRoot, destinationRoot);
		const sourceBase = options.sourceScope === "user" ? homedir() : options.cwd;
		const sourceRelativeRoot = relative(sourceBase, sourceRoot).split(sep).join("/");
		if (sourceRelativeRoot && sourceRelativeRoot !== ".." && !sourceRelativeRoot.startsWith("../")) {
			const sourceLabel = options.sourceScope === "user" ? `~/${sourceRelativeRoot}` : sourceRelativeRoot;
			addPathRewrite(rewrites, sourceLabel, targetRelativeBase(options.targetScope, options.cwd, options.agentDir));
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

function rewriteTextFilePaths(path: string, rewrites: PathRewrite[], write: boolean): number {
	const content = readFileSync(path);
	if (!isTextFile(path, content)) return 0;
	let text = content.toString("utf8");
	let replacements = 0;
	for (const rewrite of rewrites) {
		const matches = text.split(rewrite.from).length - 1;
		if (matches === 0) continue;
		replacements += matches;
		text = text.replaceAll(rewrite.from, rewrite.to);
	}
	if (write && replacements > 0) writeFileSync(path, text, "utf8");
	return replacements;
}

function countSkillPathRewrites(directory: string, rewrites: PathRewrite[], depth = 0): number {
	if (depth > MAX_SCAN_DEPTH) return 0;
	let count = 0;
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		if (entry.name === ".git" || entry.name === "node_modules" || entry.name.startsWith(".")) continue;
		const path = join(directory, entry.name);
		if (entry.isDirectory()) count += countSkillPathRewrites(path, rewrites, depth + 1);
		else if (entry.isFile() && statSync(path).size <= MAX_FILE_BYTES)
			count += rewriteTextFilePaths(path, rewrites, false);
	}
	return count;
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

function collectCandidates(profile: HarnessProfile, scope: HarnessImportScope): ResourceCandidate[] {
	const candidates: ResourceCandidate[] = [];
	const skillRoots = scope === "user" ? profile.userSkillRoots : profile.projectSkillRoots;
	const promptRoots = scope === "user" ? profile.userPromptRoots : profile.projectPromptRoots;
	const instructionFiles = scope === "user" ? profile.userInstructionFiles : profile.projectInstructionFiles;
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
	return candidates;
}

function sourceDetected(profile: HarnessProfile, scope: HarnessImportScope): boolean {
	const roots = scope === "user" ? profile.userRoots : profile.projectRoots;
	const candidates = collectCandidates(profile, scope);
	return roots.some((root) => existsSync(root)) || candidates.length > 0;
}

function sourceRelativePath(candidate: ResourceCandidate): string {
	return relative(candidate.root, candidate.path).split(sep).join("/") || basename(candidate.path);
}

function instructionBlocks(content: string): string[] {
	return content
		.replace(/\r\n/gu, "\n")
		.trim()
		.split(/\n{2,}/u)
		.map((block) => block.trim())
		.filter(Boolean);
}

function instructionHunks(candidate: ResourceCandidate, targetPath: string): HarnessImportInstructionHunk[] {
	const sourceBlocks = instructionBlocks(readFileSync(candidate.path, "utf8"));
	const targetBlocks = new Set(
		(existsSync(targetPath) ? instructionBlocks(readFileSync(targetPath, "utf8")) : []).map((block) => block),
	);
	return sourceBlocks
		.map((block, index) => ({ block, index }))
		.filter(({ block }) => !targetBlocks.has(block))
		.map(({ block, index }) => {
			const lines = block.split("\n");
			const heading = lines.find((line) => /^#{1,6}\s+/u.test(line))?.replace(/^#{1,6}\s+/u, "");
			return {
				id: hashText(`${pathKey(candidate.path)}:${index}:${block}`),
				title: heading || lines[0]?.slice(0, 80) || `规则块 ${index + 1}`,
				lines,
			};
		});
}

function targetRelativePath(candidate: ResourceCandidate): string {
	if (candidate.type === "skill") {
		const relativePath = sourceRelativePath(candidate);
		return `skills/${relativePath}`;
	}
	if (candidate.type === "prompt") return `prompts/${basename(candidate.path)}`;
	return "AGENTS.md";
}

function targetRoot(agentDir: string, cwd: string, scope: HarnessImportScope): string {
	return scope === "user" ? agentDir : join(cwd, ".pi");
}

function itemStatus(
	candidate: ResourceCandidate,
	targetPath: string,
	type: HarnessResourceType,
	ruleHunks?: HarnessImportInstructionHunk[],
): HarnessImportItemStatus {
	if (!existsSync(targetPath)) return type === "instruction" && ruleHunks?.length === 0 ? "already-imported" : "ready";
	if (type === "instruction") return ruleHunks?.length ? "ready" : "already-imported";
	const sourceHash = type === "skill" ? hashDirectory(candidate.path) : hashText(readFileSync(candidate.path, "utf8"));
	const targetHash = type === "skill" ? hashDirectory(targetPath) : hashText(readFileSync(targetPath, "utf8"));
	return sourceHash === targetHash ? "already-imported" : "conflict";
}

function createItem(
	profile: HarnessProfile,
	candidate: ResourceCandidate,
	sourceScope: HarnessImportScope,
	targetScope: HarnessImportScope,
	agentDir: string,
	cwd: string,
): HarnessImportItem {
	const destinationRoot = targetRoot(agentDir, cwd, targetScope);
	const targetRelative = targetRelativePath(candidate);
	const targetPath = join(destinationRoot, targetRelative);
	const instructionSourceContent = candidate.type === "instruction" ? readFileSync(candidate.path, "utf8") : undefined;
	const instructionTargetContent =
		candidate.type === "instruction" && existsSync(targetPath) ? readFileSync(targetPath, "utf8") : undefined;
	const ruleHunks = candidate.type === "instruction" ? instructionHunks(candidate, targetPath) : undefined;
	const contentHash =
		candidate.type === "skill" ? hashDirectory(candidate.path) : hashText(readFileSync(candidate.path, "utf8"));
	const warnings: string[] = [];
	if (candidate.type === "instruction") warnings.push("导入内容会追加到目标 AGENTS.md");
	if (candidate.type === "prompt" && candidate.description === undefined) warnings.push("未发现提示词描述");
	if (candidate.type === "skill") {
		const rewriteCount = countSkillPathRewrites(
			candidate.path,
			skillPathRewrites({
				harness: profile.harness,
				sourceScope,
				sourcePath: candidate.path,
				targetPath,
				targetScope,
				cwd,
				agentDir,
			}),
		);
		if (rewriteCount > 0)
			warnings.push(`导入时会改写 ${rewriteCount} 处 ${profile.label} 路径引用，并保留脚本执行权限`);
	}
	const id = hashText(`${profile.harness}:${sourceScope}:${targetScope}:${pathKey(candidate.path)}:${targetRelative}`);
	return {
		id,
		harness: profile.harness,
		harnessLabel: profile.label,
		sourceScope,
		resourceType: candidate.type,
		name: candidate.name,
		sourceRelativePath: sourceRelativePath(candidate),
		targetRelativePath: targetRelative,
		...(candidate.description ? { description: candidate.description } : {}),
		...(ruleHunks ? { instructionHunks: ruleHunks } : {}),
		...(instructionSourceContent !== undefined ? { instructionSourceContent } : {}),
		...(instructionTargetContent !== undefined ? { instructionTargetContent } : {}),
		status: itemStatus(candidate, targetPath, candidate.type, ruleHunks),
		warnings,
		contentHash,
		sourcePath: candidate.path,
		targetPath,
	};
}

export function discoverHarnessImports(options: {
	cwd: string;
	agentDir: string;
	targetScope: HarnessImportScope;
}): HarnessImportPreview {
	const cwd = resolve(options.cwd);
	const agentDir = resolve(options.agentDir);
	const profiles = profilePaths(homedir(), cwd);
	const sources: HarnessImportSource[] = [];
	const items: HarnessImportItem[] = [];
	for (const profile of profiles) {
		for (const scope of ["user", "project"] as const) {
			const candidates = collectCandidates(profile, scope);
			const detected = sourceDetected(profile, scope);
			const sourceItems = candidates.map((candidate) =>
				createItem(profile, candidate, scope, options.targetScope, agentDir, cwd),
			);
			items.push(...sourceItems);
			sources.push({
				id: `${profile.harness}:${scope}`,
				harness: profile.harness,
				label: profile.label,
				scope,
				detected,
				resourceCount: sourceItems.length,
				resourceTypes: {
					skills: sourceItems.filter((item) => item.resourceType === "skill").length,
					prompts: sourceItems.filter((item) => item.resourceType === "prompt").length,
					instructions: sourceItems.filter((item) => item.resourceType === "instruction").length,
				},
			});
		}
	}
	return { sources, items };
}

function copyDirectory(source: string, target: string, rewrites: PathRewrite[] = []): void {
	mkdirSync(target, { recursive: true });
	for (const entry of readdirSync(source, { withFileTypes: true })) {
		if (entry.name === ".git" || entry.name === "node_modules" || entry.name.startsWith(".")) continue;
		const sourcePath = join(source, entry.name);
		const targetPath = join(target, entry.name);
		if (entry.isDirectory()) copyDirectory(sourcePath, targetPath, rewrites);
		else if (entry.isFile()) {
			const sourceStat = statSync(sourcePath);
			if (sourceStat.size > MAX_FILE_BYTES) throw new Error(`文件过大：${entry.name}`);
			mkdirSync(dirname(targetPath), { recursive: true });
			copyFileSync(sourcePath, targetPath);
			chmodSync(targetPath, sourceStat.mode & 0o777);
			rewriteTextFilePaths(targetPath, rewrites, true);
		}
	}
}

function overwriteInstruction(item: HarnessImportItem): void {
	const source = item.instructionSourceContent ?? readFileSync(item.sourcePath, "utf8");
	mkdirSync(dirname(item.targetPath), { recursive: true });
	writeFileSync(item.targetPath, source, "utf8");
}

function appendInstruction(item: HarnessImportItem, selectedHunkIds?: string[]): boolean {
	const target = existsSync(item.targetPath) ? readFileSync(item.targetPath, "utf8").trimEnd() : "";
	const hunks = item.instructionHunks ?? [
		{
			id: "legacy",
			title: item.name,
			lines: readFileSync(item.sourcePath, "utf8").trim().split(/\r?\n/u),
		},
	];
	const selected = selectedHunkIds === undefined ? new Set(hunks.map((hunk) => hunk.id)) : new Set(selectedHunkIds);
	const additions: string[] = [];
	for (const hunk of hunks) {
		if (!selected.has(hunk.id)) continue;
		const block = hunk.lines.join("\n").trim();
		const start = `<!-- LYStar 导入自 ${item.harnessLabel}：${item.sourceRelativePath}#${hunk.id} -->`;
		const end = `<!-- LYStar 导入结束：${item.sourceRelativePath}#${hunk.id} -->`;
		if (!block || target.includes(start) || target.includes(block)) continue;
		additions.push([start, block, end].join("\n\n"));
	}
	if (additions.length === 0) return false;
	const content = [target, ...additions].filter(Boolean).join("\n\n");
	mkdirSync(dirname(item.targetPath), { recursive: true });
	writeFileSync(item.targetPath, `${content}\n`, "utf8");
	return true;
}

export function importHarnessResources(options: {
	cwd: string;
	agentDir: string;
	targetScope: HarnessImportScope;
	itemIds: string[];
	ruleSelections?: Record<string, string[]>;
	replaceItemIds?: string[];
}): HarnessImportResult {
	const preview = discoverHarnessImports({
		cwd: options.cwd,
		agentDir: options.agentDir,
		targetScope: options.targetScope,
	});
	const selected = new Set(options.itemIds);
	const replacements = new Set(options.replaceItemIds);
	const result: HarnessImportResult = { imported: 0, skipped: 0, failed: 0, items: [] };
	for (const item of preview.items.filter((candidate) => selected.has(candidate.id))) {
		if (item.status === "already-imported" || item.status === "conflict" || item.status === "unsupported") {
			result.skipped++;
			result.items.push({
				id: item.id,
				status: "skipped",
				message:
					item.status === "already-imported"
						? "内容已经导入"
						: item.status === "conflict"
							? "目标文件已存在且内容不同"
							: "资源格式不支持",
			});
			continue;
		}
		if (item.resourceType !== "instruction" && existsSync(item.targetPath)) {
			result.skipped++;
			result.items.push({ id: item.id, status: "skipped", message: "目标路径已被其他资源占用" });
			continue;
		}
		try {
			if (item.resourceType === "skill") {
				copyDirectory(
					item.sourcePath,
					item.targetPath,
					skillPathRewrites({
						harness: item.harness,
						sourceScope: item.sourceScope,
						sourcePath: item.sourcePath,
						targetPath: item.targetPath,
						targetScope: options.targetScope,
						cwd: options.cwd,
						agentDir: options.agentDir,
					}),
				);
			} else if (item.resourceType === "instruction") {
				if (replacements.has(item.id)) overwriteInstruction(item);
				else if (!appendInstruction(item, options.ruleSelections?.[item.id])) {
					result.skipped++;
					result.items.push({ id: item.id, status: "skipped", message: "没有选择新的规则块" });
					continue;
				}
			} else {
				mkdirSync(dirname(item.targetPath), { recursive: true });
				writeFileSync(item.targetPath, readFileSync(item.sourcePath, "utf8"), "utf8");
			}
			result.imported++;
			result.items.push({ id: item.id, status: "imported" });
		} catch (error) {
			result.failed++;
			result.items.push({
				id: item.id,
				status: "failed",
				message: error instanceof Error ? error.message : String(error),
			});
		}
	}
	return result;
}
