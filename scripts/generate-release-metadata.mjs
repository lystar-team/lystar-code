import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const RELEASE_PLATFORMS = ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64", "windows-x64"];

const RELEASE_REPOSITORY_PLACEHOLDER = "__LYSTAR_RELEASE_REPOSITORY__";
const installerAssignments = {
	"install.sh": `REPOSITORY="${RELEASE_REPOSITORY_PLACEHOLDER}"`,
	"install.ps1": `$Repository = "${RELEASE_REPOSITORY_PLACEHOLDER}"`,
	"install.cmd": `https://github.com/${RELEASE_REPOSITORY_PLACEHOLDER}/releases/latest/download/install.ps1`,
};

function archiveName(version, platform) {
	return `lystar-agent-v${version}-${platform}.${platform.startsWith("windows-") ? "zip" : "tar.gz"}`;
}

export function releaseAssetNames(version) {
	return [
		...RELEASE_PLATFORMS.map((platform) => archiveName(version, platform)),
		"SHA256SUMS",
		"release-manifest.json",
		...Object.keys(installerAssignments),
	];
}

function sha256(path) {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function generateReleaseMetadata(outputArg, version, repository = "") {
	const outputDir = resolve(outputArg);
	const assets = {};
	const sums = [];
	for (const platform of RELEASE_PLATFORMS) {
		const file = archiveName(version, platform);
		const path = join(outputDir, file);
		if (!existsSync(path)) continue;
		assets[platform] = { file, sha256: sha256(path), size: statSync(path).size };
		sums.push(`${assets[platform].sha256}  ${file}`);
	}

	const manifest = {
		version,
		piVersion: version.split("-lystar.")[0],
		channel: "stable",
		publishedAt: new Date().toISOString(),
		...(repository ? { repository } : {}),
		assets,
	};
	writeFileSync(join(outputDir, "release-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
	writeFileSync(join(outputDir, "SHA256SUMS"), `${sums.join("\n")}\n`);

	for (const [name, assignment] of Object.entries(installerAssignments)) {
		const source = readFileSync(resolve("scripts", name), "utf8");
		const materialized = repository
			? source.replace(assignment, assignment.replace(RELEASE_REPOSITORY_PLACEHOLDER, repository))
			: source;
		writeFileSync(join(outputDir, basename(name)), materialized, { mode: name.endsWith(".sh") ? 0o755 : 0o644 });
	}
}

function readManifest(path, errors) {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		errors.push(`invalid release manifest: ${error instanceof Error ? error.message : String(error)}`);
		return null;
	}
}

export function releaseMetadataErrors(outputArg, version, repository) {
	const outputDir = resolve(outputArg);
	const errors = [];
	const expectedAssets = releaseAssetNames(version);
	const expectedArchives = RELEASE_PLATFORMS.map((platform) => archiveName(version, platform));
	const expectedEntries = new Set([...expectedAssets, "VERSION"]);

	if (!repository) errors.push("release repository is required for verification");
	if (!existsSync(outputDir)) return [...errors, `release directory is missing: ${outputDir}`];
	for (const entry of readdirSync(outputDir, { withFileTypes: true })) {
		if (!expectedEntries.has(entry.name)) errors.push(`unexpected release directory entry: ${entry.name}`);
		if (expectedAssets.includes(entry.name) && !entry.isFile()) errors.push(`release asset is not a file: ${entry.name}`);
	}
	for (const name of expectedAssets) {
		if (!existsSync(join(outputDir, name))) errors.push(`release asset is missing: ${name}`);
	}
	if (errors.length > 0) return errors;

	const manifest = readManifest(join(outputDir, "release-manifest.json"), errors);
	if (!manifest) return errors;
	if (manifest.version !== version) errors.push(`manifest version mismatch: expected ${version}`);
	if (manifest.piVersion !== version.split("-lystar.")[0]) errors.push("manifest Pi version mismatch");
	if (manifest.repository !== repository) errors.push(`manifest repository mismatch: expected ${repository}`);
	const manifestAssets = manifest.assets;
	if (!manifestAssets || typeof manifestAssets !== "object" || Array.isArray(manifestAssets)) {
		errors.push("manifest assets must be an object");
	} else {
		const platforms = Object.keys(manifestAssets);
		if (platforms.length !== RELEASE_PLATFORMS.length || RELEASE_PLATFORMS.some((platform) => !platforms.includes(platform))) {
			errors.push("manifest must contain exactly five platform assets");
		}
		for (const platform of RELEASE_PLATFORMS) {
			const file = archiveName(version, platform);
			const asset = manifestAssets[platform];
			const path = join(outputDir, file);
			if (!asset || typeof asset !== "object") {
				errors.push(`manifest asset is missing: ${platform}`);
				continue;
			}
			if (asset.file !== file) errors.push(`manifest asset filename mismatch: ${platform}`);
			if (asset.size !== statSync(path).size) errors.push(`manifest asset size mismatch: ${platform}`);
			if (asset.sha256 !== sha256(path)) errors.push(`manifest asset SHA-256 mismatch: ${platform}`);
		}
	}

	const expectedSums = expectedArchives.map((file) => `${sha256(join(outputDir, file))}  ${file}`);
	const actualSums = readFileSync(join(outputDir, "SHA256SUMS"), "utf8").trimEnd().split("\n");
	if (actualSums.length !== expectedSums.length || expectedSums.some((sum, index) => actualSums[index] !== sum)) {
		errors.push("SHA256SUMS must contain exactly the five current platform archives");
	}
	for (const [name, assignment] of Object.entries(installerAssignments)) {
		const expected = readFileSync(resolve("scripts", name), "utf8").replace(
			assignment,
			assignment.replace(RELEASE_REPOSITORY_PLACEHOLDER, repository),
		);
		if (readFileSync(join(outputDir, name), "utf8") !== expected) errors.push(`materialized installer mismatch: ${name}`);
	}
	return errors;
}

function usage() {
	console.error("Usage: node scripts/generate-release-metadata.mjs [--verify] <output-dir> <version> [owner/repo]");
	process.exit(2);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	const [mode, outputArg, version, repository = ""] = process.argv.slice(2);
	if (mode === "--verify") {
		if (!outputArg || !version || !repository) usage();
		const errors = releaseMetadataErrors(outputArg, version, repository);
		if (errors.length > 0) throw new Error(errors.join("\n"));
		console.log("Release metadata, checksums, installers, and public assets are consistent");
	} else {
		const [legacyOutputArg, legacyVersion, legacyRepository = ""] = process.argv.slice(2);
		if (!legacyOutputArg || !legacyVersion) usage();
		generateReleaseMetadata(legacyOutputArg, legacyVersion, legacyRepository);
	}
}
