import { spawn, spawnSync } from "node:child_process";
import {
	closeSync,
	chmodSync,
	copyFileSync,
	cpSync,
	createReadStream,
	createWriteStream,
	mkdirSync,
	openSync,
	readFileSync,
	readSync,
	readdirSync,
	rmSync,
	statSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const guiDir = resolve(scriptDir, "..");
const repositoryRoot = resolve(guiDir, "../..");
const codingAgentDir = join(repositoryRoot, "packages/coding-agent");
const binariesDir = join(guiDir, "src-tauri/binaries");
const resourcesDir = join(guiDir, "src-tauri/resources");
const prebuiltRemoteHostsDir = process.env.PI_GUI_PREBUILT_REMOTE_HOSTS_DIR
	? resolve(process.env.PI_GUI_PREBUILT_REMOTE_HOSTS_DIR)
	: undefined;
const hostPayloadHeader = Buffer.from("LYSTAR-GUI-BINARY/1\n");
const hostPackage = JSON.parse(readFileSync(join(repositoryRoot, "packages/gui-host/package.json"), "utf8"));
const codingAgentPackage = JSON.parse(readFileSync(join(codingAgentDir, "package.json"), "utf8"));

const platforms = {
	"darwin-arm64": { bun: "bun-darwin-arm64", triple: "aarch64-apple-darwin", magic: "cffaedfe" },
	"darwin-x64": { bun: "bun-darwin-x64-baseline", triple: "x86_64-apple-darwin", magic: "cffaedfe" },
	"linux-arm64": { bun: "bun-linux-arm64", triple: "aarch64-unknown-linux-gnu", magic: "7f454c46" },
	"linux-x64": { bun: "bun-linux-x64-baseline", triple: "x86_64-unknown-linux-gnu", magic: "7f454c46" },
	"windows-x64": { bun: "bun-windows-x64-baseline", triple: "x86_64-pc-windows-msvc", magic: "4d5a", extension: ".exe" },
};

function currentPlatform() {
	const platform = process.env.TAURI_ENV_PLATFORM || process.platform;
	const arch = process.env.TAURI_ENV_ARCH || process.arch;
	const normalizedPlatform = platform === "win32" || platform === "windows" ? "windows" : platform;
	const normalizedArch = arch === "x86_64" ? "x64" : arch === "aarch64" ? "arm64" : arch;
	return `${normalizedPlatform}-${normalizedArch}`;
}

function run(command, args, options = {}) {
	const result = spawnSync(command, args, { cwd: repositoryRoot, stdio: "inherit", ...options });
	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status}`);
}

function bunCommand() {
	const available = spawnSync("bun", ["--version"], { stdio: "ignore" });
	if (!available.error && available.status === 0) return { command: "bun", args: [] };
	return {
		command: process.platform === "win32" ? "npx.cmd" : "npx",
		args: ["--yes", "bun@1.3.9"],
	};
}

function prepareResources() {
	rmSync(resourcesDir, { recursive: true, force: true });
	mkdirSync(resourcesDir, { recursive: true });
	copyFileSync(join(repositoryRoot, "packages/gui-host/package.json"), join(resourcesDir, "gui-host-package.json"));
	for (const name of ["package.json", "README.md", "CHANGELOG.md"]) {
		copyFileSync(join(codingAgentDir, name), join(resourcesDir, name));
	}
	for (const name of ["LICENSE", "THIRD_PARTY_LICENSES.md"]) {
		copyFileSync(join(repositoryRoot, name), join(resourcesDir, name));
	}
	for (const name of ["docs", "examples"]) {
		cpSync(join(codingAgentDir, name), join(resourcesDir, name), { recursive: true });
	}
	cpSync(join(codingAgentDir, "dist/skills"), join(resourcesDir, "skills"), { recursive: true });
	cpSync(join(codingAgentDir, "dist/core/export-html"), join(resourcesDir, "export-html"), { recursive: true });
	for (const [source, destination] of [
		["dist/modes/interactive/theme", "theme"],
		["dist/modes/interactive/assets", "assets"],
	]) {
		const sourceDir = join(codingAgentDir, source);
		const destinationDir = join(resourcesDir, destination);
		mkdirSync(destinationDir, { recursive: true });
		for (const entry of readdirSync(sourceDir)) {
			if (destination === "theme" && !entry.endsWith(".json")) continue;
			copyFileSync(join(sourceDir, entry), join(destinationDir, entry));
		}
	}
	copyFileSync(
		join(repositoryRoot, "node_modules/@silvia-odwyer/photon-node/photon_rs_bg.wasm"),
		join(resourcesDir, "photon_rs_bg.wasm"),
	);
}

async function smokeSidecar(outputPath) {
	const protocol = await import(pathToFileURL(join(repositoryRoot, "packages/gui-protocol/dist/index.js")).href);
	const child = spawn(outputPath, [], {
		cwd: repositoryRoot,
		env: {
			...process.env,
			PI_GUI_HOST_VERSION: hostPackage.version,
			PI_OFFLINE: "1",
			PI_PACKAGE_DIR: resourcesDir,
			PI_PHOTON_WASM_PATH: join(resourcesDir, "photon_rs_bg.wasm"),
		},
		stdio: ["pipe", "pipe", "pipe"],
	});
	const decoder = new protocol.ServerMessageDecoder();
	const messages = [];
	let stderr = "";
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk) => {
		stderr += chunk;
	});
	try {
		const received = new Promise((resolvePromise, reject) => {
			const timeout = setTimeout(() => reject(new Error(`sidecar smoke timed out: ${stderr}`)), 10_000);
			child.stdout.on("data", (chunk) => {
				try {
					messages.push(...decoder.push(chunk));
					if (messages.length >= 2) {
						clearTimeout(timeout);
						resolvePromise();
					}
				} catch (error) {
					clearTimeout(timeout);
					reject(error);
				}
			});
			child.once("error", reject);
			child.once("exit", (code) => {
				if (messages.length < 2) reject(new Error(`sidecar exited ${code}: ${stderr}`));
			});
		});
		child.stdin.write(protocol.encodeClientMessage({ type: "hello", version: 1, clientInstanceId: "sidecar-smoke" }));
		child.stdin.write(
			protocol.encodeClientMessage({ type: "request", id: "about", request: { command: "get_about" } }),
		);
		await received;
		if (messages[0]?.type !== "hello" || messages[0].productVersion !== codingAgentPackage.piConfig.productVersion) {
			throw new Error(`invalid sidecar hello: ${JSON.stringify(messages[0])}`);
		}
		if (messages[1]?.type !== "response" || !messages[1].ok || messages[1].result?.hostVersion !== hostPackage.version) {
			throw new Error(`invalid sidecar response: ${JSON.stringify(messages[1])}`);
		}
	} finally {
		child.stdin.end();
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
	}
}

function validateBinary(outputPath, platform, target) {
	const headerBytes = Buffer.alloc(target.magic.length / 2);
	const file = openSync(outputPath, "r");
	try {
		readSync(file, headerBytes, 0, headerBytes.length, 0);
	} finally {
		closeSync(file);
	}
	const header = headerBytes.toString("hex");
	if (header !== target.magic || statSync(outputPath).size < 1024 * 1024) {
		rmSync(outputPath, { force: true });
		throw new Error(`invalid ${platform} GUI Host header: expected ${target.magic}, received ${header || "empty"}`);
	}
}

function buildCompiledHost(platform, target, outputPath, bun) {
	rmSync(outputPath, { force: true });
	mkdirSync(dirname(outputPath), { recursive: true });
	const bunArgs = [
		...bun.args,
		"build",
		"--compile",
		"--no-compile-autoload-bunfig",
		// Windows runner 已安装同版本 baseline Bun，直接复用可避免重复提取正在使用的 target。
		...(platform === "windows-x64" && currentPlatform() === platform ? [] : [`--target=${target.bun}`]),
		"../gui-host/dist/cli.js",
		"./src/utils/image-resize-worker.ts",
		"--outfile",
		outputPath,
	];
	if (platform === "windows-x64" && process.platform === "win32") bunArgs.push("--windows-hide-console");
	run(bun.command, bunArgs, { cwd: codingAgentDir });
	if (platform !== "windows-x64") chmodSync(outputPath, 0o755);
	validateBinary(outputPath, platform, target);
}

async function embedHost(sourcePath, outputPath) {
	mkdirSync(dirname(outputPath), { recursive: true });
	const output = createWriteStream(outputPath, { mode: 0o644 });
	output.write(hostPayloadHeader);
	await pipeline(createReadStream(sourcePath), output);
	chmodSync(outputPath, 0o644);
}

function copyPrebuiltHost(platform, target, outputPath) {
	const sourcePath = join(prebuiltRemoteHostsDir, platform, "lystar-gui-host.bin");
	const expected = Buffer.concat([hostPayloadHeader, Buffer.from(target.magic, "hex")]);
	const actual = Buffer.alloc(expected.length);
	const file = openSync(sourcePath, "r");
	try {
		readSync(file, actual, 0, actual.length, 0);
	} finally {
		closeSync(file);
	}
	if (!actual.equals(expected) || statSync(sourcePath).size < hostPayloadHeader.length + 1024 * 1024) {
		throw new Error(`invalid prebuilt ${platform} GUI Host payload`);
	}
	mkdirSync(dirname(outputPath), { recursive: true });
	copyFileSync(sourcePath, outputPath);
}

const requested = process.argv.find((argument) => argument.startsWith("--platform="))?.slice("--platform=".length);
const platform = requested || currentPlatform();
const target = platforms[platform];
if (!target) throw new Error(`unsupported GUI sidecar platform: ${platform}`);

const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error("npm_execpath is required to build the GUI Host");
run(process.execPath, [npmCli, "run", "build:offline"]);
prepareResources();

const outputPath = join(binariesDir, `lystar-gui-host-${target.triple}${target.extension ?? ""}`);
const remoteHostsDir = join(resourcesDir, "remote-hosts");
const bun = bunCommand();
buildCompiledHost(platform, target, outputPath, bun);

const localHostPath = join(resourcesDir, "local-host", "lystar-gui-host.bin");
await embedHost(outputPath, localHostPath);

for (const [remotePlatform, remoteTarget] of Object.entries(platforms)) {
	const remoteOutput = join(remoteHostsDir, remotePlatform, "lystar-gui-host.bin");
	if (prebuiltRemoteHostsDir) {
		copyPrebuiltHost(remotePlatform, remoteTarget, remoteOutput);
		continue;
	}
	let remoteSource = outputPath;
	if (remotePlatform !== platform) {
		remoteSource = join(
			binariesDir,
			"remote-hosts",
			remotePlatform,
			`lystar-gui-host${remoteTarget.extension ?? ""}`,
		);
		buildCompiledHost(remotePlatform, remoteTarget, remoteSource, bun);
	}
	await embedHost(remoteSource, remoteOutput);
}

if (platform === currentPlatform()) await smokeSidecar(outputPath);
console.log(`GUI sidecar ready: ${outputPath}`);
console.log(`Local GUI Host resource ready: ${localHostPath}`);
console.log(`Remote GUI Hosts ready: ${remoteHostsDir}`);
