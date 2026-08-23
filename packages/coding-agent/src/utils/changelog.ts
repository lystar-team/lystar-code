import path from "node:path";
import { existsSync, readFileSync } from "fs";
import { getChangelogPath } from "../config.ts";

export interface ChangelogEntry {
	major: number;
	minor: number;
	patch: number;
	qualifier?: string;
	content: string;
}

type ChangelogVersion = Omit<ChangelogEntry, "content">;

const GITHUB_REPO = "earendil-works/pi";
const CHANGELOG_LINK_BASE_PATH = "packages/coding-agent";
const LEGACY_REPO_RE = /^https:\/\/github\.com\/(?:badlogic|earendil-works)\/pi-mono(?=\/|$)/;
const URL_SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;
const INLINE_MARKDOWN_LINK_RE = /(!?\[[^\]\n]+\]\()([^\s)]+)((?:\s+[^)]*)?\))/g;

function entryVersion(entry: ChangelogEntry): string {
	const baseVersion = `${entry.major}.${entry.minor}.${entry.patch}`;
	return entry.qualifier ? `${baseVersion}-${entry.qualifier}` : baseVersion;
}

function normalizeTag(version: string | ChangelogEntry): string {
	const versionString = typeof version === "string" ? version : entryVersion(version);
	return versionString.startsWith("v") ? versionString : `v${versionString}`;
}

function parseVersion(version: string): ChangelogVersion | undefined {
	const match = version.trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z][0-9A-Za-z.-]*))?$/);
	if (!match) return undefined;

	return {
		major: Number.parseInt(match[1], 10),
		minor: Number.parseInt(match[2], 10),
		patch: Number.parseInt(match[3], 10),
		...(match[4] ? { qualifier: match[4] } : {}),
	};
}

function splitLocalTarget(target: string): { fragment: string; pathPart: string; query: string } {
	const hashIndex = target.indexOf("#");
	const beforeHash = hashIndex === -1 ? target : target.slice(0, hashIndex);
	const fragment = hashIndex === -1 ? "" : target.slice(hashIndex);
	const queryIndex = beforeHash.indexOf("?");

	if (queryIndex === -1) {
		return { fragment, pathPart: beforeHash, query: "" };
	}

	return {
		fragment,
		pathPart: beforeHash.slice(0, queryIndex),
		query: beforeHash.slice(queryIndex),
	};
}

function normalizePathPart(value: string): string {
	return value.replaceAll("\\", "/");
}

function resolveRepositoryPath(targetPath: string): string | undefined {
	const normalizedTarget = normalizePathPart(targetPath);
	const joined = normalizedTarget.startsWith("/")
		? path.posix.normalize(normalizedTarget.replace(/^\/+/, ""))
		: path.posix.normalize(path.posix.join(CHANGELOG_LINK_BASE_PATH, normalizedTarget));

	if (joined === "." || joined.startsWith("../") || joined === "..") {
		return undefined;
	}

	return joined;
}

function isDirectoryTarget(originalPath: string, repositoryPath: string): boolean {
	if (originalPath.endsWith("/")) {
		return true;
	}

	const basename = path.posix.basename(repositoryPath);
	return !basename.includes(".");
}

function normalizeChangelogLinkTarget(target: string, tag: string): string {
	let canonicalTarget = target.replace(LEGACY_REPO_RE, `https://github.com/${GITHUB_REPO}`);
	const repoUrl = `https://github.com/${GITHUB_REPO}`;

	for (const route of ["blob", "tree"]) {
		for (const branch of ["main", "master"]) {
			const floatingRefPrefix = `${repoUrl}/${route}/${branch}/`;
			if (canonicalTarget.startsWith(floatingRefPrefix)) {
				canonicalTarget = `${repoUrl}/${route}/${tag}/${canonicalTarget.slice(floatingRefPrefix.length)}`;
			}
		}
	}

	if (canonicalTarget.startsWith("#") || canonicalTarget.startsWith("//") || URL_SCHEME_RE.test(canonicalTarget)) {
		return canonicalTarget;
	}

	const { fragment, pathPart, query } = splitLocalTarget(canonicalTarget);
	if (!pathPart) {
		return canonicalTarget;
	}

	const repositoryPath = resolveRepositoryPath(pathPart);
	if (!repositoryPath) {
		return canonicalTarget;
	}

	const route = isDirectoryTarget(pathPart, repositoryPath) ? "tree" : "blob";
	return `https://github.com/${GITHUB_REPO}/${route}/${tag}/${encodeURI(repositoryPath)}${query}${fragment}`;
}

export function normalizeChangelogLinks(markdown: string, version: string | ChangelogEntry): string {
	const tag = normalizeTag(version);
	return markdown.replace(INLINE_MARKDOWN_LINK_RE, (_match, prefix, target, suffix) => {
		return `${prefix}${normalizeChangelogLinkTarget(target, tag)}${suffix}`;
	});
}

/**
 * Parse changelog entries from CHANGELOG.md
 * Scans for ## lines and collects content until next ## or EOF
 */
export function parseChangelog(changelogPath: string): ChangelogEntry[] {
	if (!existsSync(changelogPath)) {
		return [];
	}

	try {
		const content = readFileSync(changelogPath, "utf-8");
		const lines = content.split("\n");
		const entries: ChangelogEntry[] = [];

		let currentLines: string[] = [];
		let currentVersion: ChangelogVersion | null = null;

		for (const line of lines) {
			// Check if this is a version header (## [x.y.z] ...)
			if (line.startsWith("## ")) {
				// Save previous entry if exists
				if (currentVersion && currentLines.length > 0) {
					entries.push({
						...currentVersion,
						content: currentLines.join("\n").trim(),
					});
				}

				// Try to parse version from this line
				const versionMatch = line.match(/^##\s+\[?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z][0-9A-Za-z.-]*))?\]?/);
				if (versionMatch) {
					currentVersion = {
						major: Number.parseInt(versionMatch[1], 10),
						minor: Number.parseInt(versionMatch[2], 10),
						patch: Number.parseInt(versionMatch[3], 10),
						...(versionMatch[4] ? { qualifier: versionMatch[4] } : {}),
					};
					currentLines = [line];
				} else {
					// Reset if we can't parse version
					currentVersion = null;
					currentLines = [];
				}
			} else if (currentVersion) {
				// Collect lines for current version
				currentLines.push(line);
			}
		}

		// Save last entry
		if (currentVersion && currentLines.length > 0) {
			entries.push({
				...currentVersion,
				content: currentLines.join("\n").trim(),
			});
		}

		return entries;
	} catch (error) {
		console.error(`Warning: Could not parse changelog: ${error}`);
		return [];
	}
}

export function getFullChangelogMarkdown(changelogPath = getChangelogPath()): string {
	const entries = parseChangelog(changelogPath);
	return entries.length > 0
		? entries.map((entry) => normalizeChangelogLinks(entry.content, entry)).join("\n\n")
		: "没有更新记录。";
}

/**
 * Compare versions. Returns: -1 if v1 < v2, 0 if v1 === v2, 1 if v1 > v2
 */
export function compareVersions(v1: ChangelogEntry, v2: ChangelogEntry): number {
	if (v1.major !== v2.major) return v1.major - v2.major;
	if (v1.minor !== v2.minor) return v1.minor - v2.minor;
	if (v1.patch !== v2.patch) return v1.patch - v2.patch;

	if (v1.qualifier === v2.qualifier) return 0;
	if (!v1.qualifier) return -1;
	if (!v2.qualifier) return 1;

	const firstParts = v1.qualifier.split(/[.-]/);
	const secondParts = v2.qualifier.split(/[.-]/);
	for (let index = 0; index < Math.max(firstParts.length, secondParts.length); index++) {
		const firstPart = firstParts[index];
		const secondPart = secondParts[index];
		if (firstPart === undefined) return -1;
		if (secondPart === undefined) return 1;
		if (firstPart === secondPart) continue;

		const firstNumber = /^\d+$/.test(firstPart) ? Number.parseInt(firstPart, 10) : undefined;
		const secondNumber = /^\d+$/.test(secondPart) ? Number.parseInt(secondPart, 10) : undefined;
		if (firstNumber !== undefined && secondNumber !== undefined) return firstNumber - secondNumber;
		if (firstNumber !== undefined) return -1;
		if (secondNumber !== undefined) return 1;
		return firstPart.localeCompare(secondPart);
	}

	return 0;
}

/**
 * Get entries newer than lastVersion
 */
export function getNewEntries(entries: ChangelogEntry[], lastVersion: string): ChangelogEntry[] {
	const last: ChangelogEntry = {
		...(parseVersion(lastVersion) ?? { major: 0, minor: 0, patch: 0 }),
		content: "",
	};

	return entries.filter((entry) => compareVersions(entry, last) > 0);
}

// Re-export getChangelogPath from config.ts for convenience
export { getChangelogPath };
