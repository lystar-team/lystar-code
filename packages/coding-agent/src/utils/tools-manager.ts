import chalk from "chalk";
import { type SpawnSyncReturns, spawnSync } from "child_process";
import { createHash } from "crypto";
import {
	chmodSync,
	closeSync,
	copyFileSync,
	createWriteStream,
	existsSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	unlinkSync,
	utimesSync,
	writeFileSync,
} from "fs";
import { arch, platform } from "os";
import { delimiter, join, resolve } from "path";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import type { ReadableStream as NodeReadableStream } from "stream/web";
import { setTimeout as delay } from "timers/promises";
import { APP_NAME, getBinDir } from "../config.ts";
import { fetchWithRetry } from "./management-http.ts";

const TOOLS_DIR = getBinDir();
const MANAGED_MINGIT_DIR = join(TOOLS_DIR, "mingit");
const MINGIT_VERSION = "2.55.0.3";
const MINGIT_ASSET = `MinGit-${MINGIT_VERSION}-64-bit.zip`;
const MINGIT_SHA256 = "f48e2d2dc74a24454adc6d8fd0ac25bf9c2386f19cfb06202b9465aaad4f9f05";
const MINGIT_URLS = [
	`https://registry.npmmirror.com/-/binary/git-for-windows/v2.55.0.windows.3/${MINGIT_ASSET}`,
	`https://github.com/git-for-windows/git/releases/download/v2.55.0.windows.3/${MINGIT_ASSET}`,
];
const MINGIT_LOCK_PATH = join(TOOLS_DIR, "mingit.install.lock");
const MINGIT_LOCK_TIMEOUT_MS = 6 * 60_000;
const MINGIT_STALE_LOCK_MS = 5 * 60_000;
const NETWORK_TIMEOUT_MS = 10_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;
let managedWindowsBashPromise: Promise<string | undefined> | undefined;

function isOfflineModeEnabled(): boolean {
	const value = process.env.PI_OFFLINE;
	if (!value) return false;
	return value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "yes";
}

interface ToolConfig {
	name: string;
	repo: string; // GitHub repo (e.g., "sharkdp/fd")
	binaryName: string; // Name of the binary inside the archive
	systemBinaryNames?: string[]; // Alternative system command names to try before downloading
	tagPrefix: string; // Prefix for tags (e.g., "v" for v1.0.0, "" for 1.0.0)
	getAssetName: (version: string, plat: string, architecture: string) => string | null;
}

const TOOLS: Record<string, ToolConfig> = {
	fd: {
		name: "fd",
		repo: "sharkdp/fd",
		binaryName: "fd",
		systemBinaryNames: ["fd", "fdfind"],
		tagPrefix: "v",
		getAssetName: (version, plat, architecture) => {
			if (plat === "darwin") {
				const archStr = architecture === "arm64" ? "aarch64" : "x86_64";
				return `fd-v${version}-${archStr}-apple-darwin.tar.gz`;
			} else if (plat === "linux") {
				const archStr = architecture === "arm64" ? "aarch64" : "x86_64";
				return `fd-v${version}-${archStr}-unknown-linux-gnu.tar.gz`;
			} else if (plat === "win32") {
				const archStr = architecture === "arm64" ? "aarch64" : "x86_64";
				return `fd-v${version}-${archStr}-pc-windows-msvc.zip`;
			}
			return null;
		},
	},
	rg: {
		name: "ripgrep",
		repo: "BurntSushi/ripgrep",
		binaryName: "rg",
		tagPrefix: "",
		getAssetName: (version, plat, architecture) => {
			if (plat === "darwin") {
				const archStr = architecture === "arm64" ? "aarch64" : "x86_64";
				return `ripgrep-${version}-${archStr}-apple-darwin.tar.gz`;
			} else if (plat === "linux") {
				if (architecture === "arm64") {
					return `ripgrep-${version}-aarch64-unknown-linux-gnu.tar.gz`;
				}
				return `ripgrep-${version}-x86_64-unknown-linux-musl.tar.gz`;
			} else if (plat === "win32") {
				const archStr = architecture === "arm64" ? "aarch64" : "x86_64";
				return `ripgrep-${version}-${archStr}-pc-windows-msvc.zip`;
			}
			return null;
		},
	},
};

// Check if a command exists in PATH by trying to run it
function commandExists(cmd: string): boolean {
	try {
		const result = spawnSync(cmd, ["--version"], { stdio: "pipe" });
		// Check for ENOENT error (command not found)
		return result.error === undefined || result.error === null;
	} catch {
		return false;
	}
}

// Get the path to a tool (system-wide or in our tools dir)
export function getToolPath(tool: "fd" | "rg"): string | null {
	const config = TOOLS[tool];
	if (!config) return null;

	// Check our tools directory first
	const localPath = join(TOOLS_DIR, config.binaryName + (platform() === "win32" ? ".exe" : ""));
	if (existsSync(localPath)) {
		return localPath;
	}

	// Check system PATH - if found, just return the command name (it's in PATH)
	const systemBinaryNames = config.systemBinaryNames ?? [config.binaryName];
	for (const systemBinaryName of systemBinaryNames) {
		if (commandExists(systemBinaryName)) {
			return systemBinaryName;
		}
	}

	return null;
}

// Fetch latest release version from GitHub
async function getLatestVersion(repo: string): Promise<string> {
	const response = await fetchWithRetry(
		`https://api.github.com/repos/${repo}/releases/latest`,
		{
			headers: { "User-Agent": `${APP_NAME}-coding-agent` },
		},
		{ timeoutMs: NETWORK_TIMEOUT_MS },
	);

	if (!response.ok) {
		throw new Error(`GitHub API error: ${response.status}`);
	}

	const data = (await response.json()) as { tag_name: string };
	return data.tag_name.replace(/^v/, "");
}

function formatMegabytes(bytes: number): string {
	return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

// Download a file from URL
async function downloadFile(
	url: string,
	dest: string,
	onStart?: (sizeBytes: number | undefined) => void,
): Promise<void> {
	const response = await fetchWithRetry(url, undefined, { timeoutMs: DOWNLOAD_TIMEOUT_MS });

	if (!response.ok) {
		throw new Error(`Failed to download: ${response.status}`);
	}

	if (!response.body) {
		throw new Error("No response body");
	}

	const contentLength = Number(response.headers.get("content-length"));
	onStart?.(Number.isFinite(contentLength) && contentLength > 0 ? contentLength : undefined);
	const fileStream = createWriteStream(dest);
	await pipeline(Readable.fromWeb(response.body as NodeReadableStream<Uint8Array>), fileStream);
}

function calculateFileSha256(filePath: string): string {
	return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function findBinaryRecursively(rootDir: string, binaryFileName: string): string | null {
	const stack: string[] = [rootDir];

	while (stack.length > 0) {
		const currentDir = stack.pop();
		if (!currentDir) continue;

		const entries = readdirSync(currentDir, { withFileTypes: true });
		for (const entry of entries) {
			const fullPath = join(currentDir, entry.name);
			if (entry.isFile() && entry.name === binaryFileName) {
				return fullPath;
			}
			if (entry.isDirectory()) {
				stack.push(fullPath);
			}
		}
	}

	return null;
}

function formatSpawnFailure(result: SpawnSyncReturns<string | Buffer>): string {
	if (result.error?.message) {
		return result.error.message;
	}
	const stderr = result.stderr?.toString().trim();
	if (stderr) {
		return stderr;
	}
	const stdout = result.stdout?.toString().trim();
	if (stdout) {
		return stdout;
	}
	return `exit status ${result.status ?? "unknown"}`;
}

function runExtractionCommand(command: string, args: string[]): string | null {
	const result = spawnSync(command, args, { stdio: "pipe" });
	if (!result.error && result.status === 0) {
		return null;
	}
	return `${command}: ${formatSpawnFailure(result)}`;
}

function extractTarGzArchive(archivePath: string, extractDir: string, assetName: string): void {
	const failure = runExtractionCommand("tar", ["xzf", archivePath, "-C", extractDir]);
	if (failure) {
		throw new Error(`Failed to extract ${assetName}: ${failure}`);
	}
}

function getWindowsTarCommand(): string {
	const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
	if (systemRoot) {
		const systemTar = join(systemRoot, "System32", "tar.exe");
		if (existsSync(systemTar)) {
			return systemTar;
		}
	}
	return "tar.exe";
}

function extractZipArchive(archivePath: string, extractDir: string, assetName: string): void {
	const failures: string[] = [];

	if (platform() === "win32") {
		// Windows ships bsdtar as tar.exe, which supports zip files. Prefer the
		// System32 binary over Git Bash's GNU tar, which does not handle zip archives.
		const tarFailure = runExtractionCommand(getWindowsTarCommand(), ["xf", archivePath, "-C", extractDir]);
		if (!tarFailure) return;
		failures.push(tarFailure);

		const script =
			"& { param($archive, $destination) $ErrorActionPreference = 'Stop'; Expand-Archive -LiteralPath $archive -DestinationPath $destination -Force }";
		const powershellFailure = runExtractionCommand("powershell.exe", [
			"-NoLogo",
			"-NoProfile",
			"-NonInteractive",
			"-ExecutionPolicy",
			"Bypass",
			"-Command",
			script,
			archivePath,
			extractDir,
		]);
		if (!powershellFailure) return;
		failures.push(powershellFailure);
	} else {
		const unzipFailure = runExtractionCommand("unzip", ["-q", archivePath, "-d", extractDir]);
		if (!unzipFailure) return;
		failures.push(unzipFailure);

		const tarFailure = runExtractionCommand("tar", ["xf", archivePath, "-C", extractDir]);
		if (!tarFailure) return;
		failures.push(tarFailure);
	}

	throw new Error(`Failed to extract ${assetName}: ${failures.join("; ")}`);
}

function getManagedWindowsBashCandidate(rootDir: string): string {
	return join(rootDir, "usr", "bin", "bash.exe");
}

function getManagedMinGitPathEntries(rootDir: string): string[] {
	return [join(rootDir, "cmd"), join(rootDir, "mingw64", "bin"), join(rootDir, "usr", "bin")];
}

function getManagedMinGitEnv(rootDir: string, baseEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	const pathKey = Object.keys(baseEnv).find((key) => key.toLowerCase() === "path") ?? "PATH";
	const currentPath = baseEnv[pathKey] ?? "";
	const currentEntries = currentPath.split(delimiter).filter(Boolean);
	const missingEntries = getManagedMinGitPathEntries(rootDir).filter(
		(candidate) => !currentEntries.some((entry) => entry.toLowerCase() === candidate.toLowerCase()),
	);
	return {
		...baseEnv,
		[pathKey]: [...missingEntries, currentPath].filter(Boolean).join(delimiter),
	};
}

export function getManagedWindowsEnv(baseEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	return platform() === "win32" && getManagedWindowsBashPath()
		? getManagedMinGitEnv(MANAGED_MINGIT_DIR, baseEnv)
		: { ...baseEnv };
}

export function getManagedWindowsGitPath(): string | null {
	if (!getManagedWindowsBashPath()) return null;
	const gitPath = join(MANAGED_MINGIT_DIR, "cmd", "git.exe");
	return existsSync(gitPath) ? gitPath : null;
}

function addManagedMinGitToPath(rootDir: string): void {
	const env = getManagedMinGitEnv(rootDir);
	const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
	process.env[pathKey] = env[pathKey];
}

function isProcessRunning(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

function readManagedMinGitLock(): { pid?: number; token?: string } {
	try {
		const raw = readFileSync(MINGIT_LOCK_PATH, "utf8").trim();
		if (raw.startsWith("{")) return JSON.parse(raw) as { pid?: number; token?: string };
		const pid = Number.parseInt(raw, 10);
		return Number.isFinite(pid) ? { pid } : {};
	} catch {
		return {};
	}
}

async function acquireManagedMinGitLock(): Promise<() => void> {
	mkdirSync(TOOLS_DIR, { recursive: true });
	const deadline = Date.now() + MINGIT_LOCK_TIMEOUT_MS;
	while (Date.now() < deadline) {
		try {
			const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
			const fd = openSync(MINGIT_LOCK_PATH, "wx");
			writeFileSync(
				fd,
				`${JSON.stringify({ pid: process.pid, startedAt: Date.now(), version: MINGIT_VERSION, token })}\n`,
			);
			closeSync(fd);
			const heartbeat = setInterval(() => {
				try {
					const now = new Date();
					utimesSync(MINGIT_LOCK_PATH, now, now);
				} catch {}
			}, 30_000);
			heartbeat.unref();
			return () => {
				clearInterval(heartbeat);
				if (readManagedMinGitLock().token === token) rmSync(MINGIT_LOCK_PATH, { force: true });
			};
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			try {
				const lock = readManagedMinGitLock();
				if (
					Date.now() - statSync(MINGIT_LOCK_PATH).mtimeMs > MINGIT_STALE_LOCK_MS &&
					(!lock.pid || !isProcessRunning(lock.pid))
				) {
					unlinkSync(MINGIT_LOCK_PATH);
					continue;
				}
			} catch (statError) {
				if ((statError as NodeJS.ErrnoException).code === "ENOENT") continue;
				throw statError;
			}
			await delay(250);
		}
	}
	throw new Error("等待另一个 LYStar 进程安装 MinGit Bash 超时");
}

export function getManagedWindowsBashPath(): string | null {
	if (platform() !== "win32") return null;
	const bashPath = getManagedWindowsBashCandidate(MANAGED_MINGIT_DIR);
	const versionPath = join(MANAGED_MINGIT_DIR, ".lystar-version");
	if (!existsSync(bashPath) || !existsSync(versionPath)) return null;
	return readFileSync(versionPath, "utf8").trim() === MINGIT_VERSION ? bashPath : null;
}

function validateManagedWindowsBash(bashPath: string, rootDir: string): void {
	const env = getManagedMinGitEnv(rootDir);
	const whereGit = spawnSync("where.exe", ["git.exe"], { encoding: "utf8", env, stdio: "pipe", windowsHide: true });
	const firstGit = whereGit.stdout?.trim().split(/\r?\n/)[0];
	const expectedGit = join(rootDir, "cmd", "git.exe");
	const resolvedFirstGit = firstGit && existsSync(firstGit) ? realpathSync.native(firstGit).toLowerCase() : "";
	const resolvedExpectedGit = existsSync(expectedGit) ? realpathSync.native(expectedGit).toLowerCase() : "";
	if (whereGit.error || whereGit.status !== 0 || resolvedFirstGit !== resolvedExpectedGit) {
		throw new Error(`Managed MinGit validation failed: expected ${expectedGit}, resolved ${firstGit ?? "nothing"}`);
	}

	const result = spawnSync(
		bashPath,
		["--noprofile", "--norc", "-c", '[[ -n "$BASH_VERSION" ]] && git --version >/dev/null && ls / >/dev/null'],
		{ cwd: rootDir, encoding: "utf8", env, stdio: "pipe", windowsHide: true },
	);
	if (result.error || result.status !== 0) {
		throw new Error(`MinGit Bash validation failed: ${formatSpawnFailure(result)}`);
	}
}

async function downloadManagedWindowsBash(silent: boolean, localArchivePath?: string): Promise<string> {
	if (platform() !== "win32" || arch() !== "x64") {
		throw new Error(`Unsupported managed MinGit platform: ${platform()}/${arch()}`);
	}

	mkdirSync(TOOLS_DIR, { recursive: true });
	const stagingRoot = join(TOOLS_DIR, `mingit_tmp_${process.pid}_${Date.now()}`);
	const extractDir = join(stagingRoot, "extract");
	const archivePath = join(stagingRoot, MINGIT_ASSET);
	mkdirSync(extractDir, { recursive: true });

	try {
		if (localArchivePath) {
			const resolvedArchivePath = resolve(localArchivePath);
			if (!existsSync(resolvedArchivePath)) throw new Error(`MinGit 离线包不存在：${resolvedArchivePath}`);
			copyFileSync(resolvedArchivePath, archivePath);
			if (!silent) console.log(chalk.dim(`正在使用 MinGit 离线包：${resolvedArchivePath}`));
		} else {
			if (isOfflineModeEnabled()) throw new Error("离线模式缺少 --archive 指定的 MinGit 安装包");
			const failures: string[] = [];
			let downloaded = false;
			for (const url of MINGIT_URLS) {
				try {
					rmSync(archivePath, { force: true });
					await downloadFile(url, archivePath, (sizeBytes) => {
						if (!silent) {
							const size = sizeBytes ? `（${formatMegabytes(sizeBytes)}）` : "";
							console.log(chalk.dim(`正在下载 MinGit Bash${size}...`));
						}
					});
					if (!silent)
						console.log(chalk.dim(`已下载 MinGit Bash（${formatMegabytes(statSync(archivePath).size)}）。`));
					downloaded = true;
					break;
				} catch (error) {
					failures.push(`${url}: ${error instanceof Error ? error.message : String(error)}`);
				}
			}
			if (!downloaded) throw new Error(`MinGit 下载失败：${failures.join("; ")}`);
		}
		const actualSha256 = calculateFileSha256(archivePath);
		if (actualSha256 !== MINGIT_SHA256) {
			throw new Error(`MinGit SHA-256 校验失败：期望 ${MINGIT_SHA256}，实际 ${actualSha256}`);
		}

		extractZipArchive(archivePath, extractDir, MINGIT_ASSET);
		const shPath = join(extractDir, "usr", "bin", "sh.exe");
		const bashPath = getManagedWindowsBashCandidate(extractDir);
		if (!existsSync(shPath)) throw new Error(`${MINGIT_ASSET} 缺少 usr/bin/sh.exe`);
		copyFileSync(shPath, bashPath);
		writeFileSync(join(extractDir, ".lystar-version"), `${MINGIT_VERSION}\n`);
		validateManagedWindowsBash(bashPath, extractDir);

		const backupDir = `${MANAGED_MINGIT_DIR}.previous`;
		rmSync(backupDir, { recursive: true, force: true });
		if (existsSync(MANAGED_MINGIT_DIR)) renameSync(MANAGED_MINGIT_DIR, backupDir);
		try {
			renameSync(extractDir, MANAGED_MINGIT_DIR);
			rmSync(backupDir, { recursive: true, force: true });
		} catch (error) {
			if (existsSync(backupDir) && !existsSync(MANAGED_MINGIT_DIR)) renameSync(backupDir, MANAGED_MINGIT_DIR);
			throw error;
		}

		const installedBash = getManagedWindowsBashPath();
		if (!installedBash) throw new Error("MinGit Bash 安装后未找到 bash.exe");
		return installedBash;
	} finally {
		rmSync(stagingRoot, { recursive: true, force: true });
	}
}

async function provisionManagedWindowsBash(silent: boolean, archivePath?: string): Promise<string> {
	const releaseLock = await acquireManagedMinGitLock();
	try {
		const existing = getManagedWindowsBashPath();
		if (existing) {
			try {
				validateManagedWindowsBash(existing, MANAGED_MINGIT_DIR);
				addManagedMinGitToPath(MANAGED_MINGIT_DIR);
				return existing;
			} catch {
				// 锁内重新检查后仍损坏，继续安装。
			}
		}
		const installed = await downloadManagedWindowsBash(silent, archivePath);
		addManagedMinGitToPath(MANAGED_MINGIT_DIR);
		return installed;
	} finally {
		releaseLock();
	}
}

export async function ensureManagedWindowsBash(
	options: boolean | { silent?: boolean; archivePath?: string } = false,
): Promise<string | undefined> {
	if (platform() !== "win32") return undefined;
	const { silent = false, archivePath } = typeof options === "boolean" ? { silent: options } : options;
	const existing = getManagedWindowsBashPath();
	if (existing) {
		try {
			validateManagedWindowsBash(existing, MANAGED_MINGIT_DIR);
			addManagedMinGitToPath(MANAGED_MINGIT_DIR);
			return existing;
		} catch {
			// 损坏或不完整的托管环境会在下面重新安装。
		}
	}

	managedWindowsBashPromise ??= provisionManagedWindowsBash(silent, archivePath)
		.then((bashPath) => {
			if (!silent) console.log(chalk.dim(`MinGit Bash 已安装到 ${bashPath}`));
			return bashPath;
		})
		.catch((error) => {
			if (!silent)
				console.log(chalk.yellow(`MinGit Bash 安装失败：${error instanceof Error ? error.message : error}`));
			return undefined;
		})
		.finally(() => {
			managedWindowsBashPromise = undefined;
		});
	return managedWindowsBashPromise;
}

// Download and install a tool
async function downloadTool(tool: "fd" | "rg"): Promise<string> {
	const config = TOOLS[tool];
	if (!config) throw new Error(`Unknown tool: ${tool}`);

	const plat = platform();
	const architecture = arch();

	// Get latest version
	let version = await getLatestVersion(config.repo);
	if (tool === "fd" && plat === "darwin" && architecture === "x64") {
		version = "10.3.0";
	}

	// Get asset name for this platform
	const assetName = config.getAssetName(version, plat, architecture);
	if (!assetName) {
		throw new Error(`Unsupported platform: ${plat}/${architecture}`);
	}

	// Create tools directory
	mkdirSync(TOOLS_DIR, { recursive: true });

	const downloadUrl = `https://github.com/${config.repo}/releases/download/${config.tagPrefix}${version}/${assetName}`;
	const archivePath = join(TOOLS_DIR, assetName);
	const binaryExt = plat === "win32" ? ".exe" : "";
	const binaryPath = join(TOOLS_DIR, config.binaryName + binaryExt);

	// Download
	await downloadFile(downloadUrl, archivePath);

	// Extract into a unique temp directory. fd and rg downloads can run concurrently
	// during startup, so sharing a fixed directory causes races.
	const extractDir = join(
		TOOLS_DIR,
		`extract_tmp_${config.binaryName}_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
	);
	mkdirSync(extractDir, { recursive: true });

	try {
		if (assetName.endsWith(".tar.gz")) {
			extractTarGzArchive(archivePath, extractDir, assetName);
		} else if (assetName.endsWith(".zip")) {
			extractZipArchive(archivePath, extractDir, assetName);
		} else {
			throw new Error(`Unsupported archive format: ${assetName}`);
		}

		// Find the binary in extracted files. Some archives contain files directly
		// at root, others nest under a versioned subdirectory.
		const binaryFileName = config.binaryName + binaryExt;
		const extractedDir = join(extractDir, assetName.replace(/\.(tar\.gz|zip)$/, ""));
		const extractedBinaryCandidates = [join(extractedDir, binaryFileName), join(extractDir, binaryFileName)];
		let extractedBinary = extractedBinaryCandidates.find((candidate) => existsSync(candidate));

		if (!extractedBinary) {
			extractedBinary = findBinaryRecursively(extractDir, binaryFileName) ?? undefined;
		}

		if (extractedBinary) {
			renameSync(extractedBinary, binaryPath);
		} else {
			throw new Error(`Binary not found in archive: expected ${binaryFileName} under ${extractDir}`);
		}

		// Make executable (Unix only)
		if (plat !== "win32") {
			chmodSync(binaryPath, 0o755);
		}
	} finally {
		// Cleanup
		rmSync(archivePath, { force: true });
		rmSync(extractDir, { recursive: true, force: true });
	}

	return binaryPath;
}

// Termux package names for tools
const TERMUX_PACKAGES: Record<string, string> = {
	fd: "fd",
	rg: "ripgrep",
};

export interface ToolStatus {
	type: "info" | "warning";
	message: string;
}

/**
 * Ensure a tool is available, downloading if necessary.
 * Reports progress through `onStatus`; status messages are otherwise silent.
 * Returns the tool path, or undefined if unavailable.
 */
export async function ensureTool(
	tool: "fd" | "rg",
	onStatus?: (status: ToolStatus) => void,
): Promise<string | undefined> {
	const existingPath = getToolPath(tool);
	if (existingPath) {
		return existingPath;
	}

	const config = TOOLS[tool];
	if (!config) return undefined;

	if (isOfflineModeEnabled()) {
		onStatus?.({ type: "warning", message: `${config.name} not found. Offline mode enabled, skipping download.` });
		return undefined;
	}

	// On Android/Termux, Linux binaries don't work due to Bionic libc incompatibility.
	// Users must install via pkg.
	if (platform() === "android") {
		const pkgName = TERMUX_PACKAGES[tool] ?? tool;
		onStatus?.({ type: "warning", message: `${config.name} not found. Install with: pkg install ${pkgName}` });
		return undefined;
	}

	// Tool not found - download it
	onStatus?.({ type: "info", message: `${config.name} not found. Downloading...` });

	try {
		const path = await downloadTool(tool);
		onStatus?.({ type: "info", message: `${config.name} installed to ${path}` });
		return path;
	} catch (e) {
		onStatus?.({
			type: "warning",
			message: `Failed to download ${config.name}: ${e instanceof Error ? e.message : e}`,
		});
		return undefined;
	}
}
