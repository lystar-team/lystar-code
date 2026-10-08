import { createHash } from "node:crypto";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import lockfile from "proper-lockfile";
import { CONFIG_DIR_NAME } from "../config.ts";
import { canonicalizePath, resolvePath } from "../utils/paths.ts";
import { stripBom } from "../utils/text.ts";

export type ProjectTrustDecision = boolean | null;

export interface ProjectTrustStoreEntry {
	path: string;
	decision: boolean;
}

export interface ProjectTrustUpdate {
	path: string;
	decision: ProjectTrustDecision;
}

export interface ProjectTrustCollaborationInheritance {
	enabled: boolean;
	resourceFingerprint?: string;
}

interface ProjectTrustRecord {
	decision?: ProjectTrustDecision;
	collaborationInheritance?: ProjectTrustCollaborationInheritance;
}

type TrustFileValue = boolean | null | ProjectTrustRecord | undefined;
type TrustFile = Record<string, TrustFileValue>;

export interface ProjectTrustOption {
	label: string;
	trusted: boolean;
	updates: ProjectTrustUpdate[];
	savedPath?: string;
}

const TRUST_REQUIRING_PROJECT_CONFIG_RESOURCES = [
	"settings.json",
	"mcp.json",
	"extensions",
	"skills",
	"prompts",
	"themes",
	"SYSTEM.md",
	"APPEND_SYSTEM.md",
] as const;

function normalizeCwd(cwd: string): string {
	return canonicalizePath(resolvePath(cwd));
}

function trustRecord(value: TrustFileValue): ProjectTrustRecord {
	if (typeof value === "boolean" || value === null) return { decision: value };
	return value ?? {};
}

function trustDecision(value: TrustFileValue): boolean | undefined {
	const decision = trustRecord(value).decision;
	return typeof decision === "boolean" ? decision : undefined;
}

function findNearestTrustEntry(data: TrustFile, cwd: string): ProjectTrustStoreEntry | null {
	let currentDir = normalizeCwd(cwd);
	while (true) {
		const decision = trustDecision(data[currentDir]);
		if (decision !== undefined) return { path: currentDir, decision };

		const parentDir = dirname(currentDir);
		if (parentDir === currentDir) return null;
		currentDir = parentDir;
	}
}

export function getProjectTrustParentPath(cwd: string): string | undefined {
	const trustPath = normalizeCwd(cwd);
	const parentDir = dirname(trustPath);
	return parentDir === trustPath ? undefined : parentDir;
}

export function getProjectTrustOptions(cwd: string, options?: { includeSessionOnly?: boolean }): ProjectTrustOption[] {
	const trustPath = normalizeCwd(cwd);
	const trustOptions: ProjectTrustOption[] = [
		{ label: "信任此项目", trusted: true, updates: [{ path: trustPath, decision: true }], savedPath: trustPath },
	];
	const parentPath = getProjectTrustParentPath(cwd);
	if (parentPath !== undefined) {
		trustOptions.push({
			label: `信任上级目录（${parentPath}）`,
			trusted: true,
			updates: [
				{ path: parentPath, decision: true },
				{ path: trustPath, decision: null },
			],
			savedPath: parentPath,
		});
	}
	if (options?.includeSessionOnly) {
		trustOptions.push({ label: "仅本次会话信任", trusted: true, updates: [] });
	}
	trustOptions.push({
		label: "不信任此项目",
		trusted: false,
		updates: [{ path: trustPath, decision: false }],
		savedPath: trustPath,
	});
	if (options?.includeSessionOnly) {
		trustOptions.push({ label: "仅本次会话不信任", trusted: false, updates: [] });
	}
	return trustOptions;
}

function readTrustFile(path: string): TrustFile {
	if (!existsSync(path)) return {};

	let parsed: unknown;
	try {
		parsed = JSON.parse(stripBom(readFileSync(path, "utf-8")));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Failed to read trust store ${path}: ${message}`);
	}

	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error(`Invalid trust store ${path}: expected an object`);
	}

	const data: TrustFile = {};
	for (const [key, value] of Object.entries(parsed)) {
		if (value === true || value === false || value === null) {
			data[key] = value;
			continue;
		}
		if (typeof value !== "object" || value === null || Array.isArray(value)) {
			throw new Error(`Invalid trust store ${path}: invalid entry for ${JSON.stringify(key)}`);
		}
		const candidate = value as Record<string, unknown>;
		if (
			candidate.decision !== undefined &&
			candidate.decision !== true &&
			candidate.decision !== false &&
			candidate.decision !== null
		) {
			throw new Error(`Invalid trust store ${path}: invalid decision for ${JSON.stringify(key)}`);
		}
		let collaborationInheritance: ProjectTrustCollaborationInheritance | undefined;
		if (candidate.collaborationInheritance !== undefined) {
			const inheritance = candidate.collaborationInheritance;
			if (typeof inheritance !== "object" || inheritance === null || Array.isArray(inheritance)) {
				throw new Error(
					`Invalid trust store ${path}: invalid collaboration inheritance for ${JSON.stringify(key)}`,
				);
			}
			const record = inheritance as Record<string, unknown>;
			if (
				typeof record.enabled !== "boolean" ||
				(record.resourceFingerprint !== undefined && typeof record.resourceFingerprint !== "string")
			) {
				throw new Error(
					`Invalid trust store ${path}: invalid collaboration inheritance for ${JSON.stringify(key)}`,
				);
			}
			collaborationInheritance = {
				enabled: record.enabled,
				...(typeof record.resourceFingerprint === "string"
					? { resourceFingerprint: record.resourceFingerprint }
					: {}),
			};
		}
		data[key] = {
			...(candidate.decision === undefined ? {} : { decision: candidate.decision as ProjectTrustDecision }),
			...(collaborationInheritance ? { collaborationInheritance } : {}),
		};
	}
	return data;
}

function writeTrustFile(path: string, data: TrustFile): void {
	const sorted: TrustFile = {};
	for (const key of Object.keys(data).sort()) {
		const value = data[key];
		if (typeof value === "boolean" || value === null) {
			sorted[key] = value;
			continue;
		}
		if (!value) continue;
		const normalized: ProjectTrustRecord = {
			...(value.decision === undefined ? {} : { decision: value.decision }),
			...(value.collaborationInheritance
				? {
						collaborationInheritance: {
							enabled: value.collaborationInheritance.enabled,
							...(value.collaborationInheritance.enabled && value.collaborationInheritance.resourceFingerprint
								? { resourceFingerprint: value.collaborationInheritance.resourceFingerprint }
								: {}),
						},
					}
				: {}),
		};
		if (normalized.decision !== undefined || normalized.collaborationInheritance) sorted[key] = normalized;
	}
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(sorted, null, 2)}\n`, "utf-8");
}

function acquireTrustLockSync(path: string): () => void {
	const trustDir = dirname(path);
	mkdirSync(trustDir, { recursive: true });
	const maxAttempts = 10;
	const delayMs = 20;
	let lastError: unknown;

	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		try {
			return lockfile.lockSync(trustDir, { realpath: false, lockfilePath: `${path}.lock` });
		} catch (error) {
			const code =
				typeof error === "object" && error !== null && "code" in error
					? String((error as { code?: unknown }).code)
					: undefined;
			if (code !== "ELOCKED" || attempt === maxAttempts) throw error;
			lastError = error;
			const start = Date.now();
			while (Date.now() - start < delayMs) {
				// Keep synchronous trust-store callers synchronous while retrying contention.
			}
		}
	}
	if (lastError instanceof Error) throw lastError;
	throw new Error("Failed to acquire trust store lock");
}

function withTrustFileLock<T>(path: string, fn: () => T): T {
	const release = acquireTrustLockSync(path);
	try {
		return fn();
	} finally {
		release();
	}
}

/** Returns whether cwd contains project resources gated by project trust. */
export function hasTrustRequiringProjectResources(cwd: string): boolean {
	const homeDir = canonicalizePath(resolvePath(process.env.HOME || homedir()));
	const userAgentsSkillsDir = join(homeDir, ".agents", "skills");
	let currentDir = canonicalizePath(resolvePath(cwd));
	const configDir = join(currentDir, CONFIG_DIR_NAME);
	if (TRUST_REQUIRING_PROJECT_CONFIG_RESOURCES.some((entry) => existsSync(join(configDir, entry)))) return true;

	while (true) {
		const agentsSkillsDir = join(currentDir, ".agents", "skills");
		if (agentsSkillsDir !== userAgentsSkillsDir && existsSync(agentsSkillsDir)) return true;
		const parentDir = dirname(currentDir);
		if (parentDir === currentDir) return false;
		currentDir = parentDir;
	}
}
function pathIsInside(root: string, path: string): boolean {
	const value = relative(root, path);
	return value === "" || (value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value));
}

function configuredProjectResourcePaths(cwd: string): Array<{ key: string; path: string }> {
	const settingsPath = join(cwd, CONFIG_DIR_NAME, "settings.json");
	if (!existsSync(settingsPath)) return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(stripBom(readFileSync(settingsPath, "utf-8")));
	} catch {
		return [];
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return [];
	const settings = parsed as Record<string, unknown>;
	const result: Array<{ key: string; path: string }> = [];
	const addPath = (key: string, value: unknown): void => {
		if (typeof value !== "string") return;
		const source = value.replace(/^[+-]/, "").trim();
		if (!(isAbsolute(source) || source.startsWith(".") || source.startsWith("~"))) return;
		result.push({ key, path: source.startsWith("~") ? resolvePath(source) : resolve(cwd, source) });
	};
	for (const key of ["extensions", "skills", "prompts", "themes"]) {
		const values = settings[key];
		if (Array.isArray(values)) for (const value of values) addPath(key, value);
	}
	const packages = settings.packages;
	if (Array.isArray(packages)) {
		for (const item of packages) {
			addPath(
				"packages",
				typeof item === "string"
					? item
					: typeof item === "object" && item !== null && !Array.isArray(item)
						? (item as Record<string, unknown>).source
						: undefined,
			);
		}
	}
	return result;
}

function projectResourceFingerprint(cwd: string, repositoryRoot?: string): string {
	const root = normalizeCwd(cwd);
	const repoRoot = repositoryRoot ? normalizeCwd(repositoryRoot) : undefined;
	const hash = createHash("sha256");
	const visit = (path: string, label: string, stack: Set<string>): void => {
		hash.update(`${label}\0`);
		let info: ReturnType<typeof lstatSync>;
		try {
			info = lstatSync(path);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				hash.update("missing\0");
				return;
			}
			throw error;
		}
		if (info.isSymbolicLink()) {
			hash.update(`link:${readlinkSync(path)}\0`);
			const resolved = realpathSync(path);
			if (!stack.has(resolved)) visit(resolved, `${label}/target`, stack);
			return;
		}
		if (info.isDirectory()) {
			const resolved = realpathSync(path);
			if (stack.has(resolved)) {
				hash.update("cycle\0");
				return;
			}
			hash.update("directory\0");
			const nextStack = new Set([...stack, resolved]);
			for (const name of readdirSync(path).sort()) visit(join(path, name), `${label}/${name}`, nextStack);
			return;
		}
		if (info.isFile()) {
			hash.update("file\0");
			hash.update(readFileSync(path));
			return;
		}
		hash.update("other\0");
	};
	const configRoot = join(root, CONFIG_DIR_NAME);
	for (const entry of TRUST_REQUIRING_PROJECT_CONFIG_RESOURCES) {
		visit(join(configRoot, entry), `${CONFIG_DIR_NAME}/${entry}`, new Set());
	}
	for (const resource of configuredProjectResourcePaths(root)) {
		const canonicalResource = existsSync(resource.path) ? canonicalizePath(resource.path) : resolve(resource.path);
		const label =
			repoRoot && pathIsInside(repoRoot, canonicalResource)
				? `configured/${resource.key}/repo/${relative(repoRoot, canonicalResource)}`
				: `configured/${resource.key}/external/${canonicalResource}`;
		visit(resource.path, label, new Set());
	}
	const homeDir = canonicalizePath(resolvePath(process.env.HOME || homedir()));
	const userAgentsSkillsDir = join(homeDir, ".agents", "skills");
	let currentDir = root;
	while (true) {
		const skillsPath = join(currentDir, ".agents", "skills");
		if (canonicalizePath(resolvePath(skillsPath)) !== userAgentsSkillsDir && existsSync(skillsPath)) {
			const canonicalCurrent = canonicalizePath(resolvePath(currentDir));
			const label =
				repoRoot && pathIsInside(repoRoot, canonicalCurrent)
					? `repo/${relative(repoRoot, canonicalCurrent)}/.agents/skills`
					: `external/${canonicalizePath(resolvePath(skillsPath))}`;
			visit(skillsPath, label, new Set());
		}
		const parentDir = dirname(currentDir);
		if (parentDir === currentDir) break;
		currentDir = parentDir;
	}
	return hash.digest("hex");
}

export class ProjectTrustStore {
	private trustPath: string;

	constructor(agentDir: string) {
		this.trustPath = join(resolvePath(agentDir), "trust.json");
	}

	get(cwd: string): ProjectTrustDecision {
		return this.getEntry(cwd)?.decision ?? null;
	}

	getEntry(cwd: string): ProjectTrustStoreEntry | null {
		return withTrustFileLock(this.trustPath, () => {
			const data = readTrustFile(this.trustPath);
			return findNearestTrustEntry(data, cwd);
		});
	}
	getResourceFingerprint(cwd: string, repositoryRoot?: string): string {
		return projectResourceFingerprint(cwd, repositoryRoot);
	}

	getCollaborationInheritance(cwd: string): ProjectTrustCollaborationInheritance {
		return withTrustFileLock(this.trustPath, () => {
			const entry = trustRecord(readTrustFile(this.trustPath)[normalizeCwd(cwd)]).collaborationInheritance;
			return {
				enabled: entry?.enabled === true,
				...(entry?.enabled && entry.resourceFingerprint ? { resourceFingerprint: entry.resourceFingerprint } : {}),
			};
		});
	}

	set(cwd: string, decision: ProjectTrustDecision): void {
		this.setMany([{ path: cwd, decision }]);
	}

	setMany(decisions: ProjectTrustUpdate[]): void {
		withTrustFileLock(this.trustPath, () => {
			const data = readTrustFile(this.trustPath);
			for (const { path, decision } of decisions) {
				const key = normalizeCwd(path);
				const existing = trustRecord(data[key]);
				if (decision === null) {
					if (existing.collaborationInheritance?.enabled) {
						data[key] = { collaborationInheritance: { enabled: false } };
					} else {
						delete data[key];
					}
				} else if (decision === false && existing.collaborationInheritance?.enabled) {
					data[key] = { decision, collaborationInheritance: { enabled: false } };
				} else if (decision === true && existing.collaborationInheritance?.enabled) {
					data[key] = { decision, collaborationInheritance: existing.collaborationInheritance };
				} else {
					data[key] = decision;
				}
			}
			writeTrustFile(this.trustPath, data);
		});
	}

	setCollaborationInheritance(cwd: string, enabled: boolean, resourceFingerprint?: string): void {
		withTrustFileLock(this.trustPath, () => {
			const data = readTrustFile(this.trustPath);
			const key = normalizeCwd(cwd);
			const existing = trustRecord(data[key]);
			if (enabled && trustDecision(data[key]) !== true) {
				throw Object.assign(new Error("协作信任继承需要来源项目已有的显式信任决定"), {
					code: "project_trust_required",
				});
			}
			if (enabled && !resourceFingerprint) {
				throw Object.assign(new Error("协作信任继承缺少资源授权指纹"), {
					code: "project_trust_fingerprint_required",
				});
			}
			data[key] = {
				...(existing.decision === undefined ? {} : { decision: existing.decision }),
				collaborationInheritance: {
					enabled,
					...(enabled && resourceFingerprint ? { resourceFingerprint } : {}),
				},
			};
			writeTrustFile(this.trustPath, data);
		});
	}
}
