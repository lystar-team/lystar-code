import { chmodSync, copyFileSync, existsSync, mkdirSync } from "node:fs";
import { arch as osArch, platform as osPlatform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function releasePlatform(nodePlatform = osPlatform(), nodeArch = osArch()) {
	if (nodePlatform === "darwin" && nodeArch === "arm64") return "darwin-arm64";
	if (nodePlatform === "darwin" && nodeArch === "x64") return "darwin-x64";
	if (nodePlatform === "linux" && nodeArch === "arm64") return "linux-arm64";
	if (nodePlatform === "linux" && nodeArch === "x64") return "linux-x64";
	if (nodePlatform === "win32" && nodeArch === "x64") return "windows-x64";
	throw new Error(`Unsupported Rust TUI release platform: ${nodePlatform} ${nodeArch}`);
}

export function sidecarExecutable(nodePlatform = osPlatform()) {
	return nodePlatform === "win32" ? "lystar-tui.exe" : "lystar-tui";
}

function parseArgs(args) {
	let platform;
	let outDir;
	for (let index = 0; index < args.length; index += 1) {
		const argument = args[index];
		if (argument === "--platform") platform = args[++index];
		else if (argument === "--out-dir") outDir = args[++index];
		else throw new Error(`Unknown option: ${argument}`);
	}
	if (!outDir) throw new Error("--out-dir is required");
	return { platform, outDir };
}

export function buildRustTuiSidecar({ platform, outDir }) {
	const nativePlatform = releasePlatform();
	if (platform && platform !== nativePlatform) {
		throw new Error(`Rust TUI sidecar must be built natively: requested ${platform}, current ${nativePlatform}`);
	}

	const result = spawnSync("cargo", ["build", "--release", "-p", "lystar-tui"], {
		cwd: repositoryRoot,
		encoding: "utf8",
		stdio: "inherit",
	});
	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error(`cargo build failed with exit code ${result.status ?? "unknown"}`);

	const executable = sidecarExecutable();
	const targetRoot = resolve(repositoryRoot, process.env.CARGO_TARGET_DIR || "target");
	const source = join(targetRoot, "release", executable);
	if (!existsSync(source)) throw new Error(`Rust TUI sidecar is missing after cargo build: ${source}`);

	const destinationDirectory = resolve(outDir);
	const destination = join(destinationDirectory, executable);
	mkdirSync(destinationDirectory, { recursive: true });
	copyFileSync(source, destination);
	if (osPlatform() !== "win32") chmodSync(destination, 0o755);
	console.log(`Rust TUI sidecar built for ${nativePlatform}: ${destination}`);
	return destination;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	try {
		buildRustTuiSidecar(parseArgs(process.argv.slice(2)));
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	}
}
