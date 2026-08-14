import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const assetsByPlatform = {
	"linux-x64": "AppImage",
	"linux-arm64": "AppImage",
	"darwin-arm64": "dmg",
	"darwin-x64": "dmg",
	"windows-x64": "exe",
};

const [artifactDirArg, version, repository] = process.argv.slice(2);
if (!artifactDirArg || !version || !repository) {
	console.error(
		"Usage: node scripts/generate-gui-beta-metadata.mjs <artifact-dir> <version> <owner/repository>",
	);
	process.exit(2);
}

if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
	throw new Error(`Invalid release repository: ${repository}`);
}

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDir, "..");
const guiPackage = JSON.parse(await readFile(join(projectRoot, "packages/gui/package.json"), "utf8"));
const codingAgentPackage = JSON.parse(
	await readFile(join(projectRoot, "packages/coding-agent/package.json"), "utf8"),
);
if (version !== guiPackage.version) {
	throw new Error(`GUI version mismatch: expected ${guiPackage.version}, received ${version}`);
}
if (repository !== codingAgentPackage.piConfig?.releaseRepository) {
	throw new Error(
		`Release repository mismatch: expected ${codingAgentPackage.piConfig?.releaseRepository ?? "none"}, received ${repository}`,
	);
}

const artifactDir = resolve(artifactDirArg);
const expectedAssets = Object.entries(assetsByPlatform).map(([platform, extension]) => ({
	platform,
	file: `lystar-code-gui-${version}-${platform}.${extension}`,
}));
const expectedFiles = new Set(expectedAssets.map(({ file }) => file));
const directoryEntries = await readdir(artifactDir, { withFileTypes: true });
const unexpectedEntries = directoryEntries.filter(
	(entry) => !entry.isFile() || !expectedFiles.has(entry.name),
);
if (unexpectedEntries.length > 0) {
	throw new Error(`Unexpected GUI release artifacts: ${unexpectedEntries.map((entry) => entry.name).join(", ")}`);
}

const missingFiles = expectedAssets.filter(({ file }) => !directoryEntries.some((entry) => entry.name === file));
if (missingFiles.length > 0) {
	throw new Error(`Missing GUI release artifacts: ${missingFiles.map(({ file }) => file).join(", ")}`);
}

async function sha256(path) {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(path)) {
		hash.update(chunk);
	}
	return hash.digest("hex");
}

const assets = {};
const sums = [];
for (const { platform, file } of expectedAssets) {
	const path = join(artifactDir, file);
	const fileStat = await stat(path);
	if (!fileStat.isFile() || fileStat.size === 0) {
		throw new Error(`GUI release artifact is not a non-empty regular file: ${file}`);
	}
	const sha = await sha256(path);
	assets[platform] = { file, size: fileStat.size, sha256: sha };
	sums.push(`${sha}  ${file}`);
}

const manifest = {
	channel: "beta",
	signed: false,
	version,
	repository,
	assets,
};
await mkdir(artifactDir, { recursive: true });
await writeFile(join(artifactDir, "SHA256SUMS"), `${sums.join("\n")}\n`);
await writeFile(join(artifactDir, "gui-release-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
