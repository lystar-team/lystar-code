import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { basename, dirname, join } from "node:path";

export type MacosPermissionId = "administrator" | "keychain" | "accessibility" | "automation" | "screen-recording";
export type MacosPermissionState = "granted" | "required" | "unknown" | "unsupported";

export interface MacosPermissionStatus {
	id: MacosPermissionId;
	name: string;
	state: MacosPermissionState;
	message: string;
	canRequest: boolean;
}

export interface MacosPermissionsStatus {
	platform: NodeJS.Platform;
	supported: boolean;
	permissions: MacosPermissionStatus[];
}

interface PermissionMarkers {
	automationGrantedAt?: number;
	keychainInitializedAt?: number;
	keychainPendingHosts?: string[];
	keychainProbeVersion?: number;
	terminalApplication?: string;
}

interface CommandResult {
	ok: boolean;
	stdout: string;
	stderr: string;
}

interface MacosGitCredentialTarget {
	host: string;
	account: string;
	path?: string;
	port?: number;
	authenticationType?: string;
}

interface MacosGitKeychainPlan {
	gitAvailable: boolean;
	helperPath?: string;
	helperPartition?: string;
	keychainPath: string;
	hosts: string[];
	targets: MacosGitCredentialTarget[];
	pendingHosts: string[];
	problem?: string;
}

export interface MacosPermissionsSetupOptions {
	readKeychainPassword?: () => Promise<string>;
	forceKeychain?: boolean;
	keychainPasswordTimeoutMs?: number;
}

const ACCESSIBILITY_SETTINGS = "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility";
const AUTOMATION_SETTINGS = "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation";
const SCREEN_RECORDING_SETTINGS = "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture";
const PERMISSION_REQUEST_TIMEOUT_MS = 30_000;
const PERMISSION_POLL_INTERVAL_MS = 500;
const KEYCHAIN_PASSWORD_INPUT_TIMEOUT_MS = 30_000;
const KEYCHAIN_PROBE_VERSION = 4;

interface MacosWebAdminStatus {
	granted: boolean;
	message: string;
}

export function getMacosWebAdminStatus(): MacosWebAdminStatus {
	const uid = process.getuid?.() ?? userInfo().uid;
	const helperPath = join("/Library", "PrivilegedHelperTools", `com.lystar.web-service-admin.${uid}`);
	const result = run("/usr/bin/sudo", ["-n", helperPath, "status"]);
	return {
		granted: result.ok,
		message: result.ok ? "管理员静默执行通道可用" : "请在本机终端运行 lc web service install 完成一次授权",
	};
}

export function removeMacosWebAdminAuthorization(agentDir: string, interactive = false): void {
	if (process.platform !== "darwin") return;
	const uid = process.getuid?.() ?? userInfo().uid;
	const helperPath = join("/Library", "PrivilegedHelperTools", `com.lystar.web-service-admin.${uid}`);
	let result = run("/usr/bin/sudo", ["-n", helperPath, "uninstall-authorization"]);
	if (!result.ok && interactive) {
		const authorization = spawnSync("sudo", ["-v"], { stdio: "inherit" });
		if (!authorization.error && authorization.status === 0) {
			result = run("sudo", ["-n", "rm", "-f", helperPath, join("/etc", "sudoers.d", `lystar-web-service-${uid}`)]);
		}
	}
	if (!result.ok && result.stderr && !/no such file|not found/iu.test(result.stderr)) {
		throw new Error(`无法删除 macOS Web 管理员授权：${result.stderr}`);
	}
	rmSync(join(agentDir, "web", "bin", "sudo"), { force: true });
	rmSync(join(agentDir, "web", "bin", "git-credential-lystar"), { force: true });
	rmSync(join(agentDir, "web", "bin", "security"), { force: true });
	rmSync(join(agentDir, "web", "bin", "ssh"), { force: true });
	rmSync(join(agentDir, "web", "bin", "osascript"), { force: true });
	rmSync(join(agentDir, "web", "services", `web-service-admin-${uid}`), { force: true });
	rmSync(join(agentDir, "web", "services", `web-service-sudoers-${uid}`), { force: true });
	clearMacosGitCredentialAuthorization(agentDir);
}

function markerPath(agentDir: string): string {
	return join(agentDir, "web", "macos-permissions.json");
}

function gitCredentialAuthorizationPaths(agentDir: string): {
	helperPath: string;
	helperFingerprint: string;
	hosts: string;
} {
	const root = join(agentDir, "web", "git-keychain-authorization");
	return {
		helperPath: `${root}.helper`,
		helperFingerprint: `${root}.sha256`,
		hosts: `${root}.hosts`,
	};
}

function gitCredentialHelperFingerprint(helperPath: string): string | undefined {
	try {
		return createHash("sha256").update(readFileSync(helperPath)).digest("hex");
	} catch {
		return undefined;
	}
}

function readMacosGitCredentialAuthorization(agentDir: string): {
	valid: boolean;
	hosts: string[];
	reason?: "missing" | "helper_missing" | "helper_changed";
} {
	const paths = gitCredentialAuthorizationPaths(agentDir);
	let helperPath: string | undefined;
	let expectedFingerprint: string | undefined;
	let hosts: string[] = [];
	try {
		helperPath = readFileSync(paths.helperPath, "utf8").trim() || undefined;
		expectedFingerprint = readFileSync(paths.helperFingerprint, "utf8").trim() || undefined;
		hosts = readFileSync(paths.hosts, "utf8")
			.split(/\r?\n/u)
			.map((host) => host.trim().toLowerCase())
			.filter(Boolean);
	} catch {}
	if (!helperPath || !expectedFingerprint) return { valid: false, hosts, reason: "missing" };
	if (!existsSync(helperPath)) return { valid: false, hosts, reason: "helper_missing" };
	const currentFingerprint = gitCredentialHelperFingerprint(helperPath);
	return currentFingerprint === expectedFingerprint
		? { valid: true, hosts }
		: { valid: false, hosts, reason: "helper_changed" };
}

function writeMacosGitCredentialAuthorization(agentDir: string, helperPath: string, hosts: readonly string[]): void {
	const fingerprint = gitCredentialHelperFingerprint(helperPath);
	if (!fingerprint) throw new Error(`无法读取 Git 钥匙串 Helper：${helperPath}`);
	const paths = gitCredentialAuthorizationPaths(agentDir);
	mkdirSync(dirname(paths.helperPath), { recursive: true, mode: 0o700 });
	writeFileSync(paths.helperPath, `${helperPath}\n`, { encoding: "utf8", mode: 0o600 });
	writeFileSync(paths.helperFingerprint, `${fingerprint}\n`, { encoding: "utf8", mode: 0o600 });
	const normalizedHosts = [...new Set(hosts.map((host) => host.trim().toLowerCase()).filter(Boolean))].sort();
	writeFileSync(paths.hosts, normalizedHosts.length ? `${normalizedHosts.join("\n")}\n` : "", {
		encoding: "utf8",
		mode: 0o600,
	});
}

function clearMacosGitCredentialAuthorization(agentDir: string): void {
	for (const path of Object.values(gitCredentialAuthorizationPaths(agentDir))) rmSync(path, { force: true });
}

function readMarkers(agentDir: string): PermissionMarkers {
	try {
		const value: unknown = JSON.parse(readFileSync(markerPath(agentDir), "utf8"));
		if (!value || typeof value !== "object" || Array.isArray(value)) return {};
		const source = value as PermissionMarkers;
		const automationGrantedAt =
			typeof source.automationGrantedAt === "number" ? source.automationGrantedAt : undefined;
		const keychainInitializedAt =
			typeof source.keychainInitializedAt === "number" ? source.keychainInitializedAt : undefined;
		const keychainPendingHosts = Array.isArray(source.keychainPendingHosts)
			? source.keychainPendingHosts.filter(
					(host): host is string => typeof host === "string" && Boolean(host.trim()),
				)
			: undefined;
		const terminalApplication =
			typeof source.terminalApplication === "string" && source.terminalApplication.trim()
				? source.terminalApplication.trim()
				: undefined;
		const keychainProbeVersion =
			typeof source.keychainProbeVersion === "number" ? source.keychainProbeVersion : undefined;
		return {
			...(automationGrantedAt ? { automationGrantedAt } : {}),
			...(keychainInitializedAt ? { keychainInitializedAt } : {}),
			...(keychainPendingHosts?.length ? { keychainPendingHosts } : {}),
			...(keychainProbeVersion ? { keychainProbeVersion } : {}),
			...(terminalApplication ? { terminalApplication } : {}),
		};
	} catch {
		return {};
	}
}

function writeMarkers(agentDir: string, markers: PermissionMarkers): void {
	const path = markerPath(agentDir);
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	writeFileSync(path, `${JSON.stringify(markers, null, "\t")}\n`, { encoding: "utf8", mode: 0o600 });
}

function run(command: string, args: string[], timeout = 5_000): CommandResult {
	const result = spawnSync(command, args, {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		timeout,
		windowsHide: true,
	});
	return {
		ok: !result.error && result.status === 0,
		stdout: result.stdout?.trim() ?? "",
		stderr: result.error?.message ?? result.stderr?.trim() ?? "",
	};
}

function toolAvailable(command: string, args: string[]): boolean {
	return run(command, args).ok;
}

function shellSingleQuote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

function xml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&apos;");
}

function waitSynchronously(milliseconds: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function gitOsxKeychainHelperPath(): string | undefined {
	for (const gitCommand of ["/usr/bin/git", "git"]) {
		const execPath = run(gitCommand, ["--exec-path"]);
		if (!execPath.ok || !execPath.stdout) continue;
		const helperPath = join(execPath.stdout, "git-credential-osxkeychain");
		if (existsSync(helperPath)) return helperPath;
	}
	return undefined;
}

function loginKeychainPath(): string {
	const result = run("/usr/bin/security", ["login-keychain", "-d", "user"]);
	const configuredPath = result.stdout.match(/^"(.+)"$/u)?.[1];
	return configuredPath || join(homedir(), "Library", "Keychains", "login.keychain-db");
}

function securityQuotedValue(value: string): string {
	if (/[\0\r\n]/u.test(value)) throw new Error("钥匙串参数包含不支持的换行或空字符");
	return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function runSecurityInteractive(commands: readonly string[]): CommandResult {
	const result = spawnSync("/usr/bin/security", ["-i"], {
		encoding: "utf8",
		input: `${commands.join("\n")}\n`,
		stdio: ["pipe", "pipe", "pipe"],
		timeout: PERMISSION_REQUEST_TIMEOUT_MS * Math.max(commands.length, 1),
		windowsHide: true,
	});
	const stdout = result.stdout?.trim() ?? "";
	const stderr = result.error?.message ?? result.stderr?.trim() ?? "";
	return {
		ok: !result.error && result.status === 0 && !/security:\s+SecKeychain/iu.test(`${stdout}\n${stderr}`),
		stdout,
		stderr,
	};
}

function parseSecurityAttribute(block: string, attribute: string): string | undefined {
	const value = block.match(
		new RegExp(`"${attribute}"<[^>]+>=(?:0x[a-f\\d]+\\s+)?("(?:[^"\\\\]|\\\\.)*")`, "iu"),
	)?.[1];
	if (!value) return undefined;
	try {
		const parsed: unknown = JSON.parse(value);
		return typeof parsed === "string" ? parsed : undefined;
	} catch {
		return undefined;
	}
}

function internetPasswordTargets(hosts: readonly string[], keychainPath: string): MacosGitCredentialTarget[] {
	const result = run("/usr/bin/security", ["dump-keychain", keychainPath], PERMISSION_REQUEST_TIMEOUT_MS);
	if (!result.ok) return [];
	const registeredHosts = new Set(hosts);
	const targets = new Map<string, MacosGitCredentialTarget>();
	for (const block of `${result.stdout}\n${result.stderr}`.split(/\n(?=keychain:\s)/u)) {
		if (!/^class:\s+"inet"$/mu.test(block)) continue;
		const host = parseSecurityAttribute(block, "srvr")?.toLowerCase();
		const account = parseSecurityAttribute(block, "acct");
		const protocol = parseSecurityAttribute(block, "ptcl");
		if (!host || !account || protocol !== "htps" || !registeredHosts.has(host)) continue;
		const path = parseSecurityAttribute(block, "path");
		const authenticationType = parseSecurityAttribute(block, "atyp");
		const portHex = block.match(/"port"<uint32>=0x([a-f\d]+)/iu)?.[1];
		const port = portHex ? Number.parseInt(portHex, 16) : undefined;
		const target = {
			host,
			account,
			...(path !== undefined ? { path } : {}),
			...(port !== undefined ? { port } : {}),
			...(authenticationType !== undefined ? { authenticationType } : {}),
		};
		targets.set(JSON.stringify(target), target);
	}
	return [...targets.values()].sort((left, right) =>
		`${left.host}\0${left.account}\0${left.path ?? ""}`.localeCompare(
			`${right.host}\0${right.account}\0${right.path ?? ""}`,
		),
	);
}

function gitCredentialHelperPartition(helperPath: string): string | undefined {
	if (run("/usr/bin/codesign", ["--verify", "--strict", "-R=anchor apple", "--", helperPath]).ok) return "apple:";
	const signature = run("/usr/bin/codesign", ["--display", "--verbose=4", "--", helperPath]);
	if (!signature.ok) return undefined;
	const output = `${signature.stdout}\n${signature.stderr}`;
	const teamId = output.match(/^TeamIdentifier=(.+)$/mu)?.[1]?.trim();
	if (teamId && teamId !== "not set") return `teamid:${teamId}`;
	const cdHash = output.match(/^CDHash=([a-f\d]+)$/imu)?.[1]?.toLowerCase();
	return cdHash ? `cdhash:${cdHash}` : undefined;
}

function readHiddenTerminalInput(prompt: string, timeoutMs: number): Promise<string> {
	return new Promise((resolve, reject) => {
		const input = process.stdin;
		const output = process.stdout;
		const wasRaw = input.isRaw;
		const wasPaused = input.isPaused();
		let value = "";
		let settled = false;
		let timeout: NodeJS.Timeout | undefined;
		const cleanup = () => {
			if (timeout) clearTimeout(timeout);
			input.off("data", onData);
			input.setRawMode(wasRaw);
			if (wasPaused) input.pause();
			output.write("\n");
		};
		const finish = (error?: Error) => {
			if (settled) return;
			settled = true;
			cleanup();
			if (error) reject(error);
			else resolve(value);
		};
		const onData = (chunk: Buffer | string) => {
			const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
			for (const character of text) {
				if (character === "\r" || character === "\n") {
					finish();
					return;
				}
				if (character === "\u0003") {
					finish(new Error("已取消 macOS 钥匙串授权"));
					return;
				}
				if (character === "\u007f" || character === "\b") {
					value = Array.from(value).slice(0, -1).join("");
					continue;
				}
				if (character >= " ") value += character;
			}
		};
		output.write(prompt);
		try {
			input.setRawMode(true);
			input.resume();
			input.on("data", onData);
			timeout = setTimeout(
				() => finish(new Error(`等待 macOS 登录钥匙串密码超过 ${Math.ceil(timeoutMs / 1000)} 秒，已跳过授权步骤`)),
				timeoutMs,
			);
		} catch (error) {
			settled = true;
			if (timeout) clearTimeout(timeout);
			output.write("\n");
			reject(error);
		}
	});
}

function verifyRuntimeKeychainAccess(
	agentDir: string,
	helperPath: string,
	targets: readonly MacosGitCredentialTarget[],
): boolean {
	if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
	if (targets.length === 0) return true;
	const uid = process.getuid?.() ?? userInfo().uid;
	const id = randomUUID().replaceAll("-", "");
	const probeTargets = [...targets];
	const serviceDirectory = join(agentDir, "web", "services");
	const scriptPath = join(serviceDirectory, `keychain-probe-${id}.sh`);
	const plistPath = join(serviceDirectory, `keychain-probe-${id}.plist`);
	const resultPath = join(serviceDirectory, `keychain-probe-${id}.result`);
	const label = `com.lystar.keychain-probe.${uid}.${id}`;
	const target = `gui/${uid}/${label}`;
	mkdirSync(serviceDirectory, { recursive: true, mode: 0o700 });
	const checks = probeTargets
		.map((credential) => {
			const input = [
				"protocol=https",
				`host=${credential.host}`,
				`username=${credential.account}`,
				...(credential.path ? [`path=${credential.path}`] : []),
				"",
			]
				.map(shellSingleQuote)
				.join(" ");
			return `if ! printf '%s\\n' ${input} | ${shellSingleQuote(helperPath)} get | /usr/bin/awk -F= '\n$1 == "username" && length($2) > 0 { username = 1 }\n$1 == "password" && length($2) > 0 { password = 1 }\nEND { exit username && password ? 0 : 1 }\n'; then\n\tprintf '%s\\n' failed > ${shellSingleQuote(resultPath)}\n\texit 1\nfi`;
		})
		.join("\n");
	const script = `#!/bin/bash
set -o pipefail
export HOME=${shellSingleQuote(homedir())}
export PATH='/usr/bin:/bin:/usr/sbin:/sbin'
${checks}
printf '%s\n' ok > ${shellSingleQuote(resultPath)}
`;
	const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${xml(label)}</string>
<key>ProcessType</key><string>Background</string>
<key>ProgramArguments</key><array><string>/bin/bash</string><string>${xml(scriptPath)}</string></array>
<key>RunAtLoad</key><true/>
</dict></plist>
`;
	try {
		writeFileSync(scriptPath, script, { encoding: "utf8", mode: 0o700 });
		writeFileSync(plistPath, plist, { encoding: "utf8", mode: 0o600 });
		run("/bin/launchctl", ["bootout", target]);
		const bootstrap = run("/bin/launchctl", ["bootstrap", `gui/${uid}`, plistPath]);
		if (!bootstrap.ok) return false;
		const deadline = Date.now() + PERMISSION_REQUEST_TIMEOUT_MS * Math.max(probeTargets.length, 1) + 5_000;
		while (Date.now() < deadline && !existsSync(resultPath)) waitSynchronously(250);
		return existsSync(resultPath) && readFileSync(resultPath, "utf8").trim() === "ok";
	} finally {
		run("/bin/launchctl", ["bootout", target]);
		rmSync(scriptPath, { force: true });
		rmSync(plistPath, { force: true });
		rmSync(resultPath, { force: true });
	}
}

function gitHttpsHosts(cwd: string): string[] {
	const remotes = run("git", ["-C", cwd, "remote"]);
	if (!remotes.ok) return [];
	const hosts = new Set<string>();
	for (const remote of remotes.stdout.split(/\r?\n/u).filter(Boolean)) {
		const urls = run("git", ["-C", cwd, "remote", "get-url", "--all", remote]);
		if (!urls.ok) continue;
		for (const value of urls.stdout.split(/\r?\n/u)) {
			try {
				const url = new URL(value);
				if (url.protocol === "https:" && url.hostname) hosts.add(url.hostname.toLowerCase());
			} catch {}
		}
	}
	return [...hosts].sort();
}

function registeredGitHttpsHosts(agentDir: string): string[] {
	if (!toolAvailable("git", ["--version"])) return [];
	let projects: unknown;
	try {
		projects = JSON.parse(readFileSync(join(agentDir, "web", "projects.json"), "utf8"));
	} catch {
		return [];
	}
	if (!projects || typeof projects !== "object" || Array.isArray(projects)) return [];
	const entries = (projects as { projects?: unknown }).projects;
	if (!Array.isArray(entries)) return [];
	const hosts = new Set<string>();
	for (const entry of entries) {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
		const cwd = (entry as { cwd?: unknown }).cwd;
		if (typeof cwd !== "string" || !cwd.trim()) continue;
		for (const host of gitHttpsHosts(cwd)) hosts.add(host);
	}
	return [...hosts].sort();
}

export interface MacosGitKeychainRequirement {
	required: boolean;
	hosts: string[];
	message?: string;
}

export function getMacosGitKeychainRequirement(
	cwd: string,
	agentDir = join(homedir(), ".pi", "agent"),
): MacosGitKeychainRequirement {
	if (process.platform !== "darwin") return { required: false, hosts: [] };
	const hosts = gitHttpsHosts(cwd);
	if (hosts.length === 0) return { required: false, hosts };
	const authorization = readMacosGitCredentialAuthorization(agentDir);
	const authorizedHosts = new Set(authorization.hosts);
	const pendingHosts = hosts.filter((host) => !authorizedHosts.has(host));
	if (authorization.valid && pendingHosts.length === 0) return { required: false, hosts };
	const message =
		authorization.reason === "helper_changed" || authorization.reason === "helper_missing"
			? "Git 钥匙串 Helper 已变化或不可用，本次后台操作已停止。请在运行 LYStar Code Web 的 Mac 本机终端重新执行 lc web permissions setup，完成后回到 Web 重试。"
			: pendingHosts.length > 0
				? `以下 Git HTTPS 远端尚未完成后台钥匙串授权：${pendingHosts.join("、")}。本次后台操作已停止。请在运行 LYStar Code Web 的 Mac 本机终端执行 lc web permissions setup，完成后回到 Web 重试。`
				: "Git 钥匙串尚未完成后台授权，本次操作已停止。请在运行 LYStar Code Web 的 Mac 本机终端执行 lc web permissions setup，完成后回到 Web 重试。";
	return { required: true, hosts, message };
}

function prepareMacosGitKeychain(agentDir: string): MacosGitKeychainPlan {
	const gitAvailable = toolAvailable("git", ["--version"]);
	const keychainPath = loginKeychainPath();
	if (!gitAvailable) {
		return { gitAvailable, keychainPath, hosts: [], targets: [], pendingHosts: [] };
	}
	const hosts = registeredGitHttpsHosts(agentDir);
	const helperPath = gitOsxKeychainHelperPath();
	if (!helperPath) {
		return {
			gitAvailable,
			keychainPath,
			hosts,
			targets: [],
			pendingHosts: [...hosts],
			problem: "未找到 macOS 系统 git-credential-osxkeychain Helper",
		};
	}
	if (hosts.length === 0) {
		return { gitAvailable, helperPath, keychainPath, hosts, targets: [], pendingHosts: [] };
	}
	if (!toolAvailable("/usr/bin/security", ["list-keychains"])) {
		return {
			gitAvailable,
			helperPath,
			keychainPath,
			hosts,
			targets: [],
			pendingHosts: [...hosts],
			problem: "macOS security 工具不可用",
		};
	}
	const helperPartition = gitCredentialHelperPartition(helperPath);
	if (!helperPartition) {
		return {
			gitAvailable,
			helperPath,
			keychainPath,
			hosts,
			targets: [],
			pendingHosts: [...hosts],
			problem: `无法识别 Git 钥匙串 Helper 的代码签名：${helperPath}`,
		};
	}
	const targets = internetPasswordTargets(hosts, keychainPath);
	const targetHosts = new Set(targets.map((target) => target.host));
	const pendingHosts = hosts.filter((host) => !targetHosts.has(host));
	return { gitAvailable, helperPath, helperPartition, keychainPath, hosts, targets, pendingHosts };
}

function writeKeychainInitializationState(
	agentDir: string,
	initialized: boolean,
	pendingHosts: readonly string[],
): void {
	const markers = readMarkers(agentDir);
	writeMarkers(agentDir, {
		...markers,
		...(initialized
			? { keychainInitializedAt: Date.now(), keychainProbeVersion: KEYCHAIN_PROBE_VERSION }
			: { keychainInitializedAt: undefined, keychainProbeVersion: undefined }),
		...(pendingHosts.length > 0 ? { keychainPendingHosts: [...pendingHosts] } : { keychainPendingHosts: undefined }),
	});
}

function initializeKeychain(agentDir: string, plan: MacosGitKeychainPlan, password?: string): void {
	if (!plan.gitAvailable) {
		clearMacosGitCredentialAuthorization(agentDir);
		writeKeychainInitializationState(agentDir, true, []);
		return;
	}
	if (!plan.helperPath) {
		clearMacosGitCredentialAuthorization(agentDir);
		writeKeychainInitializationState(agentDir, false, plan.pendingHosts);
		throw new Error(plan.problem ?? "未找到 macOS 系统 Git 钥匙串 Helper");
	}
	if (plan.hosts.length === 0) {
		writeMacosGitCredentialAuthorization(agentDir, plan.helperPath, []);
		writeKeychainInitializationState(agentDir, true, []);
		return;
	}
	if (plan.problem || !plan.helperPartition) {
		clearMacosGitCredentialAuthorization(agentDir);
		writeKeychainInitializationState(agentDir, false, plan.pendingHosts);
		throw new Error(plan.problem ?? "无法准备 Git 钥匙串批量授权");
	}
	if (plan.pendingHosts.length > 0) {
		clearMacosGitCredentialAuthorization(agentDir);
		writeKeychainInitializationState(agentDir, false, plan.pendingHosts);
		throw new Error(
			`登录钥匙串中没有找到以下 Git HTTPS 凭据：${plan.pendingHosts.join("、")}。请先在 Mac 本机终端完成这些远端的 Git 登录，再重新执行 lc web permissions setup。`,
		);
	}
	if (!password) {
		clearMacosGitCredentialAuthorization(agentDir);
		writeKeychainInitializationState(agentDir, false, plan.hosts);
		throw new Error("macOS 登录钥匙串密码不能为空");
	}
	const quotedPassword = securityQuotedValue(password);
	const quotedKeychain = securityQuotedValue(plan.keychainPath);
	const partitionList = `apple-tool:,${plan.helperPartition}`;
	const commands = [
		`unlock-keychain -p ${quotedPassword} ${quotedKeychain}`,
		...plan.targets.map((target) => {
			const selectors = [
				`-a ${securityQuotedValue(target.account)}`,
				`-s ${securityQuotedValue(target.host)}`,
				"-r htps",
				...(target.path !== undefined ? [`-p ${securityQuotedValue(target.path)}`] : []),
				...(target.port !== undefined ? [`-P ${target.port}`] : []),
				...(target.authenticationType !== undefined
					? [`-t ${securityQuotedValue(target.authenticationType)}`]
					: []),
			];
			return `set-internet-password-partition-list ${selectors.join(" ")} -S ${securityQuotedValue(partitionList)} -k ${quotedPassword} ${quotedKeychain}`;
		}),
	];
	const authorization = runSecurityInteractive(commands);
	if (!authorization.ok) {
		clearMacosGitCredentialAuthorization(agentDir);
		writeKeychainInitializationState(agentDir, false, plan.hosts);
		throw new Error("无法批量授权 Git 钥匙串，请确认输入的是当前 macOS 登录钥匙串密码");
	}
	if (!verifyRuntimeKeychainAccess(agentDir, plan.helperPath, plan.targets)) {
		clearMacosGitCredentialAuthorization(agentDir);
		writeKeychainInitializationState(agentDir, false, plan.hosts);
		throw new Error("Git 钥匙串批量授权没有通过后台 Runtime 读回验证");
	}
	writeMacosGitCredentialAuthorization(agentDir, plan.helperPath, plan.hosts);
	writeKeychainInitializationState(agentDir, true, []);
}

function jxa(script: string, timeout = 5_000): CommandResult {
	return run("/usr/bin/osascript", ["-l", "JavaScript", "-e", script], timeout);
}

function booleanPermission(script: string): MacosPermissionState {
	const result = jxa(script);
	if (!result.ok) return "unknown";
	if (result.stdout === "true") return "granted";
	if (result.stdout === "false") return "required";
	return "unknown";
}

function accessibilityState(): MacosPermissionState {
	return booleanPermission("ObjC.import('ApplicationServices'); Boolean($.AXIsProcessTrusted())");
}

function screenRecordingState(): MacosPermissionState {
	return booleanPermission("ObjC.import('CoreGraphics'); Boolean($.CGPreflightScreenCaptureAccess())");
}

function openSettings(url: string): CommandResult {
	const uid = process.getuid?.();
	return uid === undefined
		? run("/usr/bin/open", [url])
		: run("/bin/launchctl", ["asuser", String(uid), "/usr/bin/open", url]);
}

function normalizedTerminalName(value: string): string | undefined {
	const name = value.trim().replace(/\.app$/u, "");
	if (!name) return undefined;
	if (name === "Apple_Terminal") return "Terminal";
	if (name === "WarpTerminal") return "Warp";
	if (name === "vscode") return "Visual Studio Code";
	return name;
}

function currentTerminalName(): string | undefined {
	const environmentName = process.env.TERM_PROGRAM;
	if (environmentName) return normalizedTerminalName(environmentName);
	let pid = process.ppid;
	for (let depth = 0; depth < 8 && pid > 1; depth += 1) {
		const command = run("/bin/ps", ["-p", String(pid), "-o", "command="]);
		if (!command.ok) break;
		const appPath = command.stdout.match(/\/(?:Applications|System\/Applications)\/(.+?\.app)\/Contents\//u)?.[1];
		if (appPath) return normalizedTerminalName(basename(appPath));
		const parent = run("/bin/ps", ["-p", String(pid), "-o", "ppid="]);
		if (!parent.ok) break;
		const nextPid = Number(parent.stdout.trim());
		if (!Number.isInteger(nextPid) || nextPid <= 1 || nextPid === pid) break;
		pid = nextPid;
	}
	return undefined;
}

function screenRecordingMessage(state: MacosPermissionState, markers: PermissionMarkers): string {
	if (state === "granted") return "屏幕录制已授权";
	if (state === "required") return "需要在系统设置中允许屏幕录制";
	const terminalName = markers.terminalApplication ?? currentTerminalName();
	return terminalName
		? `当前系统无法自动读取或登记命令行工具的屏幕录制权限，请在系统设置中点击“+”添加“${terminalName}”`
		: "当前系统无法自动读取或登记命令行工具的屏幕录制权限，且未识别到终端名称，请从本机终端重新运行授权向导";
}

function stateMessage(state: MacosPermissionState, granted: string, required: string): string {
	if (state === "granted") return granted;
	if (state === "required") return required;
	return "当前环境无法读取授权状态";
}

export function getMacosPermissionsStatus(agentDir = join(homedir(), ".pi", "agent")): MacosPermissionsStatus {
	if (process.platform !== "darwin") return { platform: process.platform, supported: false, permissions: [] };
	const admin = getMacosWebAdminStatus();
	const accessibility = accessibilityState();
	const screenRecording = screenRecordingState();
	const markers = readMarkers(agentDir);
	const gitAvailable = toolAvailable("git", ["--version"]);
	const sshAvailable = toolAvailable("ssh", ["-V"]);
	const securityAvailable = toolAvailable("/usr/bin/security", ["list-keychains"]);
	const keychainTools = [
		securityAvailable ? "系统钥匙串" : undefined,
		gitAvailable ? "Git" : undefined,
		sshAvailable ? "SSH" : undefined,
	].filter(Boolean);
	const pendingHosts = markers.keychainPendingHosts ?? [];
	const registeredHosts = gitAvailable ? registeredGitHttpsHosts(agentDir) : [];
	const authorization = readMacosGitCredentialAuthorization(agentDir);
	const authorizedHosts = new Set(authorization.hosts);
	const unregisteredHosts = registeredHosts.filter((host) => !authorizedHosts.has(host));
	const keychainProbeVerified = !gitAvailable || markers.keychainProbeVersion === KEYCHAIN_PROBE_VERSION;
	const keychainState: MacosPermissionState =
		!gitAvailable && !sshAvailable && !securityAvailable
			? "unsupported"
			: markers.keychainInitializedAt &&
					pendingHosts.length === 0 &&
					unregisteredHosts.length === 0 &&
					keychainProbeVerified &&
					(!gitAvailable || authorization.valid)
				? "granted"
				: "required";
	return {
		platform: process.platform,
		supported: true,
		permissions: [
			{
				id: "administrator",
				name: "管理员操作",
				state: admin.granted ? "granted" : "required",
				message: admin.message,
				canRequest: false,
			},
			{
				id: "keychain",
				name: "用户钥匙串",
				state: keychainState,
				message:
					keychainState === "unsupported"
						? "未检测到可用的钥匙串、Git 或 SSH 工具，已跳过初始化"
						: pendingHosts.length > 0
							? `以下 HTTPS 远端仍需在本机完成凭据授权：${pendingHosts.join("、")}`
							: unregisteredHosts.length > 0
								? `检测到新的 HTTPS 远端，需要在本机补充授权：${unregisteredHosts.join("、")}`
								: gitAvailable && !authorization.valid
									? authorization.reason === "helper_changed" || authorization.reason === "helper_missing"
										? "Git 钥匙串 Helper 已变化或不可用，请在本机终端重新运行 lc web permissions setup"
										: "Git 钥匙串尚未登记后台授权，请在本机终端运行 lc web permissions setup"
									: gitAvailable && !keychainProbeVerified
										? "后台 Runtime 尚未通过登录钥匙串读回验证，请在本机终端运行 lc web permissions setup"
										: `用户会话钥匙串已就绪；已检测工具：${keychainTools.join("、")}`,
				canRequest: keychainState !== "unsupported",
			},
			{
				id: "accessibility",
				name: "辅助功能",
				state: accessibility,
				message: stateMessage(accessibility, "辅助功能已授权", "需要在系统设置中允许辅助功能"),
				canRequest: true,
			},
			{
				id: "automation",
				name: "自动化",
				state: markers.automationGrantedAt ? "granted" : "required",
				message: markers.automationGrantedAt
					? "Finder 和 System Events 自动化初始化已完成"
					: "需要允许 osascript 控制 Finder 和 System Events",
				canRequest: true,
			},
			{
				id: "screen-recording",
				name: "屏幕录制",
				state: screenRecording,
				message: screenRecordingMessage(screenRecording, markers),
				canRequest: true,
			},
		],
	};
}

function waitForPermission(
	readState: () => MacosPermissionState,
	timeoutMs = PERMISSION_REQUEST_TIMEOUT_MS,
): Promise<boolean> {
	return new Promise((resolve) => {
		const deadline = Date.now() + timeoutMs;
		const check = () => {
			if (readState() === "granted") {
				resolve(true);
				return;
			}
			if (Date.now() >= deadline) {
				resolve(false);
				return;
			}
			setTimeout(check, PERMISSION_POLL_INTERVAL_MS);
		};
		check();
	});
}

export function requestMacosPermission(
	id: Exclude<MacosPermissionId, "administrator">,
	agentDir = join(homedir(), ".pi", "agent"),
): MacosPermissionsStatus {
	if (process.platform !== "darwin") throw new Error("系统授权设置只适用于 macOS");
	if (id === "keychain") {
		throw new Error("Git 钥匙串批量授权只允许在 Mac 本机终端执行：lc web permissions setup");
	} else if (id === "accessibility") {
		jxa(
			"ObjC.import('ApplicationServices'); const options=$.NSDictionary.dictionaryWithObjectForKey(true,$.kAXTrustedCheckOptionPrompt); Boolean($.AXIsProcessTrustedWithOptions(options))",
		);
		openSettings(ACCESSIBILITY_SETTINGS);
	} else if (id === "screen-recording") {
		const result = jxa(
			"ObjC.import('CoreGraphics'); Boolean($.CGRequestScreenCaptureAccess())",
			PERMISSION_REQUEST_TIMEOUT_MS,
		);
		if (!result.ok) openSettings(SCREEN_RECORDING_SETTINGS);
	} else {
		for (const script of [
			'tell application "Finder" to get name of startup disk',
			'tell application "System Events" to get name of first process',
		]) {
			const result = run("/usr/bin/osascript", ["-e", script], PERMISSION_REQUEST_TIMEOUT_MS);
			if (!result.ok) {
				openSettings(AUTOMATION_SETTINGS);
				throw new Error(result.stderr || "自动化授权没有完成");
			}
		}
		writeMarkers(agentDir, { ...readMarkers(agentDir), automationGrantedAt: Date.now() });
	}
	return getMacosPermissionsStatus(agentDir);
}

export async function runMacosPermissionsSetup(
	agentDir = join(homedir(), ".pi", "agent"),
	options: MacosPermissionsSetupOptions = {},
): Promise<MacosPermissionsStatus> {
	if (process.platform !== "darwin") return getMacosPermissionsStatus(agentDir);
	if (!process.stdin.isTTY || !process.stdout.isTTY) {
		throw new Error("macOS 系统授权需要在本机终端执行：lc web permissions setup");
	}
	const terminalName = currentTerminalName();
	if (terminalName) writeMarkers(agentDir, { ...readMarkers(agentDir), terminalApplication: terminalName });
	let status = getMacosPermissionsStatus(agentDir);
	const keychain = status.permissions.find((permission) => permission.id === "keychain");
	const forceKeychain = options.forceKeychain ?? true;
	if (keychain && keychain.state !== "unsupported" && (forceKeychain || keychain.state === "required")) {
		const plan = prepareMacosGitKeychain(agentDir);
		if (plan.targets.length > 0 && plan.pendingHosts.length === 0 && !plan.problem) {
			console.log(
				`\n即将批量授权 ${plan.targets.length} 个 Git HTTPS 凭据。终端只读取一次 macOS 登录钥匙串密码，输入内容不会显示。`,
			);
			const readPassword =
				options.readKeychainPassword ??
				(() =>
					readHiddenTerminalInput(
						"macOS 登录钥匙串密码：",
						options.keychainPasswordTimeoutMs ?? KEYCHAIN_PASSWORD_INPUT_TIMEOUT_MS,
					));
			let password = await readPassword();
			try {
				initializeKeychain(agentDir, plan, password);
			} finally {
				password = "";
			}
		} else {
			initializeKeychain(agentDir, plan);
		}
	}
	const accessibility = status.permissions.find((permission) => permission.id === "accessibility");
	if (accessibility?.state !== "granted") {
		console.log(
			"\n正在打开辅助功能授权。请在辅助功能设置中允许当前终端应用；macOS 27 中该页面显示为“设备控制与数据访问”。最多等待 30 秒。",
		);
		requestMacosPermission("accessibility", agentDir);
		if (!(await waitForPermission(accessibilityState))) return getMacosPermissionsStatus(agentDir);
	}
	status = getMacosPermissionsStatus(agentDir);
	const automation = status.permissions.find((permission) => permission.id === "automation");
	if (automation?.state !== "granted") {
		console.log("\n正在请求 Finder 和 System Events 自动化权限，请在系统弹窗中选择允许。");
		requestMacosPermission("automation", agentDir);
	}
	status = getMacosPermissionsStatus(agentDir);
	const screenRecording = status.permissions.find((permission) => permission.id === "screen-recording");
	if (screenRecording?.state !== "granted") {
		const requestedTerminalName = terminalName ?? "未识别的终端应用";
		console.log(
			`\n正在打开屏幕录制设置。系统未自动登记时，请点击“+”添加“${requestedTerminalName}”；该步骤不会阻断其他授权和 Web 服务。`,
		);
		requestMacosPermission("screen-recording", agentDir);
	}
	return getMacosPermissionsStatus(agentDir);
}
