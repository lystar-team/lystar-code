import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const platformExtensions = {
	"linux-x64": "AppImage",
	"linux-arm64": "AppImage",
	"darwin-arm64": "dmg",
	"darwin-x64": "dmg",
	"windows-x64": "exe",
};

const [sourceArg, outputArg, version, platform] = process.argv.slice(2);
if (!sourceArg || !outputArg || !version || !platform) {
	console.error(
		"Usage: node scripts/collect-gui-beta-artifact.mjs <source-dir> <output-dir> <version> <platform>",
	);
	process.exit(2);
}

const extension = platformExtensions[platform];
if (!extension) {
	throw new Error(`Unsupported GUI release platform: ${platform}`);
}

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDir, "..");
const packageVersion = JSON.parse(readFileSync(join(projectRoot, "packages/gui/package.json"), "utf8")).version;
if (version !== packageVersion) {
	throw new Error(`GUI version mismatch: expected ${packageVersion}, received ${version}`);
}

const sourceDir = resolve(sourceArg);
if (!existsSync(sourceDir) || !statSync(sourceDir).isDirectory()) {
	throw new Error(`Tauri bundle directory does not exist: ${sourceDir}`);
}

function findCandidates(directory) {
	const candidates = [];
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) {
			candidates.push(...findCandidates(path));
		} else if (entry.isFile() && entry.name.endsWith(`.${extension}`)) {
			candidates.push(path);
		}
	}
	return candidates;
}

const candidates = findCandidates(sourceDir);
if (candidates.length !== 1) {
	throw new Error(
		`Expected exactly one ${extension} bundle for ${platform}, found ${candidates.length}: ${candidates.map((path) => basename(path)).join(", ") || "none"}`,
	);
}

const outputDir = resolve(outputArg);
mkdirSync(outputDir, { recursive: true });
const outputPath = join(outputDir, `lystar-code-gui-${version}-${platform}.${extension}`);
if (existsSync(outputPath)) {
	throw new Error(`Refusing to overwrite existing release artifact: ${outputPath}`);
}

copyFileSync(candidates[0], outputPath);
console.log(outputPath);
