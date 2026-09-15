import { spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
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

const ACCESSIBILITY_SETTINGS = "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility";
const AUTOMATION_SETTINGS = "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation";
const SCREEN_RECORDING_SETTINGS = "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture";
const PERMISSION_REQUEST_TIMEOUT_MS = 30_000;
const PERMISSION_POLL_INTERVAL_MS = 500;
const KEYCHAIN_PROBE_VERSION = 2;

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
}

function markerPath(agentDir: string): string {
	return join(agentDir, "web", "macos-permissions.json");
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

function gitCredentialEnvironment(agentDir: string): NodeJS.ProcessEnv {
	const commandBin = join(agentDir, "web", "bin");
	return {
		...process.env,
		GIT_TERMINAL_PROMPT: "0",
		PATH: `${commandBin}:${process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin"}`,
	};
}

function verifyRuntimeKeychainAccess(agentDir: string): boolean {
	const helperPath = join(agentDir, "web", "bin", "git-credential-lystar");
	if (!existsSync(helperPath) || !process.stdin.isTTY || !process.stdout.isTTY) return false;
	const uid = process.getuid?.() ?? userInfo().uid;
	const id = randomUUID().replaceAll("-", "");
	const host = `lystar-keychain-probe-${id}.invalid`;
	const username = "lystar-keychain-probe";
	const password = randomBytes(24).toString("hex");
	const credential = `protocol=https\nhost=${host}\nusername=${username}\npassword=${password}\n\n`;
	const credentialEnvironment = gitCredentialEnvironment(agentDir);
	const store = spawnSync(
		"/usr/bin/git",
		["-c", "credential.helper=", "-c", "credential.helper=lystar", "credential", "approve"],
		{
			encoding: "utf8",
			env: credentialEnvironment,
			input: credential,
			stdio: ["pipe", "ignore", "pipe"],
			timeout: PERMISSION_REQUEST_TIMEOUT_MS + 5_000,
			windowsHide: true,
		},
	);
	if (store.error || store.status !== 0) {
		const keychainPath = join(homedir(), "Library", "Keychains", "login.keychain-db");
		run("/usr/bin/security", ["delete-internet-password", "-s", host, keychainPath]);
		return false;
	}
	const serviceDirectory = join(agentDir, "web", "services");
	const scriptPath = join(serviceDirectory, `keychain-probe-${id}.sh`);
	const plistPath = join(serviceDirectory, `keychain-probe-${id}.plist`);
	const resultPath = join(serviceDirectory, `keychain-probe-${id}.result`);
	const label = `com.lystar.keychain-probe.${uid}.${id}`;
	const target = `gui/${uid}/${label}`;
	mkdirSync(serviceDirectory, { recursive: true, mode: 0o700 });
	const script = `#!/bin/bash
set -o pipefail
export HOME=${shellSingleQuote(homedir())}
export PATH=${shellSingleQuote(`${dirname(helperPath)}:/usr/bin:/bin:/usr/sbin:/sbin`)}
if printf '%s\\n' 'protocol=https' 'host=${host}' '' | /usr/bin/git -c credential.helper= -c credential.helper=lystar credential fill | /usr/bin/awk -F= -v expected=${shellSingleQuote(username)} '
$1 == "username" && $2 == expected { username = 1 }
$1 == "password" && length($2) > 0 { password = 1 }
END { exit username && password ? 0 : 1 }
'; then
	printf '%s\\n' ok > ${shellSingleQuote(resultPath)}
else
	printf '%s\\n' failed > ${shellSingleQuote(resultPath)}
fi
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
		const deadline = Date.now() + PERMISSION_REQUEST_TIMEOUT_MS + 5_000;
		while (Date.now() < deadline && !existsSync(resultPath)) waitSynchronously(250);
		return existsSync(resultPath) && readFileSync(resultPath, "utf8").trim() === "ok";
	} finally {
		run("/bin/launchctl", ["bootout", target]);
		rmSync(scriptPath, { force: true });
		rmSync(plistPath, { force: true });
		rmSync(resultPath, { force: true });
		const keychainPath = join(homedir(), "Library", "Keychains", "login.keychain-db");
		const remove = run("/usr/bin/security", ["delete-internet-password", "-s", host, keychainPath]);
		if (!remove.ok) {
			spawnSync(
				"/usr/bin/git",
				["-c", "credential.helper=", "-c", "credential.helper=lystar", "credential", "reject"],
				{
					encoding: "utf8",
					env: credentialEnvironment,
					input: credential,
					stdio: ["pipe", "ignore", "ignore"],
					timeout: PERMISSION_REQUEST_TIMEOUT_MS + 5_000,
					windowsHide: true,
				},
			);
		}
	}
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
		const remotes = run("git", ["-C", cwd, "remote"]);
		if (!remotes.ok) continue;
		for (const remote of remotes.stdout.split(/\r?\n/u).filter(Boolean)) {
			const urls = run("git", ["-C", cwd, "remote", "get-url", "--all", remote]);
			if (!urls.ok) continue;
			for (const value of urls.stdout.split(/\r?\n/u)) {
				try {
					const url = new URL(value);
					if (url.protocol === "https:" && url.hostname) hosts.add(url.hostname);
				} catch {}
			}
		}
	}
	return [...hosts].sort();
}

function initializeKeychain(agentDir: string): void {
	const gitAvailable = toolAvailable("git", ["--version"]);
	const sshAvailable = toolAvailable("ssh", ["-V"]);
	const securityAvailable = toolAvailable("/usr/bin/security", ["list-keychains"]);
	const hosts = gitAvailable ? registeredGitHttpsHosts(agentDir) : [];
	const pendingHosts: string[] = [];
	const credentialEnvironment = gitCredentialEnvironment(agentDir);
	for (const host of hosts) {
		const result = spawnSync(
			"/usr/bin/git",
			["-c", "credential.helper=", "-c", "credential.helper=lystar", "credential", "fill"],
			{
				encoding: "utf8",
				env: credentialEnvironment,
				input: `protocol=https\nhost=${host}\n\n`,
				stdio: ["pipe", "ignore", "pipe"],
				timeout: PERMISSION_REQUEST_TIMEOUT_MS,
				windowsHide: true,
			},
		);
		if (result.error || result.status !== 0) pendingHosts.push(host);
	}
	const runtimeAccessVerified = !gitAvailable || verifyRuntimeKeychainAccess(agentDir);
	const initialized = pendingHosts.length === 0 && runtimeAccessVerified;
	const markers = readMarkers(agentDir);
	writeMarkers(agentDir, {
		...markers,
		...((!gitAvailable && !sshAvailable && !securityAvailable) || initialized
			? { keychainInitializedAt: Date.now(), keychainProbeVersion: KEYCHAIN_PROBE_VERSION }
			: { keychainInitializedAt: undefined, keychainProbeVersion: undefined }),
		...(pendingHosts.length > 0 ? { keychainPendingHosts: pendingHosts } : { keychainPendingHosts: undefined }),
	});
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
	const keychainProbeVerified = !gitAvailable || markers.keychainProbeVersion === KEYCHAIN_PROBE_VERSION;
	const keychainState: MacosPermissionState =
		!gitAvailable && !sshAvailable && !securityAvailable
			? "unsupported"
			: markers.keychainInitializedAt && pendingHosts.length === 0 && keychainProbeVerified
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
		initializeKeychain(agentDir);
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
): Promise<MacosPermissionsStatus> {
	if (process.platform !== "darwin") return getMacosPermissionsStatus(agentDir);
	if (!process.stdin.isTTY || !process.stdout.isTTY) {
		throw new Error("macOS 系统授权需要在本机终端执行：lc web permissions setup");
	}
	const terminalName = currentTerminalName();
	if (terminalName) writeMarkers(agentDir, { ...readMarkers(agentDir), terminalApplication: terminalName });
	let status = getMacosPermissionsStatus(agentDir);
	const keychain = status.permissions.find((permission) => permission.id === "keychain");
	if (keychain?.state === "required") {
		console.log("\n正在检查已登记项目的 Git HTTPS 凭据。系统要求时，请在钥匙串窗口选择始终允许。");
		requestMacosPermission("keychain", agentDir);
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
