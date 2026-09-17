import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { basename, dirname, join } from "node:path";
import { makeMacosGitCredentialWrapper } from "./git-environment.ts";

export type WebServiceKind = "frontend" | "gateway" | "runtime";
export type WebServiceManager =
	| "systemd-user"
	| "launch-daemon"
	| "launch-agent"
	| "windows-service"
	| "scheduled-task"
	| "detached";

export interface WebServiceInvocation {
	program: string;
	args: string[];
	cwd: string;
}

export interface WebServiceSpec {
	kind: WebServiceKind;
	profile?: string;
	agentDir: string;
	invocation: WebServiceInvocation;
	environment?: Record<string, string | undefined>;
	logPath?: string;
	macosSession?: "system" | "gui";
}

export interface WebServiceStatus {
	kind: WebServiceKind;
	profile?: string;
	serviceName: string;
	installed: boolean;
	running: boolean;
	persistent: boolean;
	manager: WebServiceManager;
	pid?: number;
	servicePath?: string;
	message?: string;
	remedy?: string;
}

interface CommandResult {
	ok: boolean;
	status: number | null;
	stdout: string;
	stderr: string;
}

function run(command: string, args: string[]): CommandResult {
	const result = spawnSync(command, args, {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		windowsHide: true,
	});
	return {
		ok: !result.error && result.status === 0,
		status: result.status,
		stdout: result.stdout?.trim() ?? "",
		stderr: result.error?.message ?? result.stderr?.trim() ?? "",
	};
}

function isAccessDenied(result: CommandResult): boolean {
	return result.status === 5 || /access is denied|拒绝访问/iu.test(`${result.stdout}\n${result.stderr}`);
}

function powershellString(value: string): string {
	return `'${value.replaceAll("'", "''")}'`;
}

function runElevatedWindows(command: string, args: string[]): CommandResult {
	const scriptPath = join(tmpdir(), `lystar-web-service-${process.pid}-${randomUUID()}.ps1`);
	const script = [
		"$ErrorActionPreference = 'Stop'",
		`$arguments = ${powershellString(args.map(commandLineArgument).join(" "))}`,
		`$process = Start-Process -FilePath ${powershellString(command)} -ArgumentList $arguments -Verb RunAs -Wait -PassThru`,
		"exit $process.ExitCode",
		"",
	].join("\n");
	try {
		writeFileSync(scriptPath, `\uFEFF${script}`, { encoding: "utf8", mode: 0o600 });
		return run("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath]);
	} finally {
		rmSync(scriptPath, { force: true });
	}
}

function runWindowsServiceCommand(args: string[]): CommandResult {
	const direct = run("sc.exe", args);
	if (direct.ok || !isAccessDenied(direct)) return direct;
	return runElevatedWindows("sc.exe", args);
}

function runWindowsTaskCommand(args: string[]): CommandResult {
	const direct = run("schtasks.exe", args);
	if (direct.ok || !isAccessDenied(direct)) return direct;
	return runElevatedWindows("schtasks.exe", args);
}

function runAdmin(command: string, args: string[], interactive: boolean): CommandResult {
	if (interactive) {
		const authorization = spawnSync(command, ["-v"], { stdio: "inherit" });
		if (authorization.error || authorization.status !== 0) {
			return {
				ok: false,
				status: authorization.status,
				stdout: "",
				stderr: authorization.error?.message ?? "管理员授权失败",
			};
		}
	}
	return run(command, ["-n", ...args]);
}

function macosAdminUid(): number {
	return process.getuid?.() ?? userInfo().uid;
}

function macosAdminHelperPath(): string {
	return join("/Library", "PrivilegedHelperTools", `com.lystar.web-service-admin.${macosAdminUid()}`);
}

function macosAdminSudoersPath(): string {
	return join("/etc", "sudoers.d", `lystar-web-service-${macosAdminUid()}`);
}

function macosAdminHelperStagingPath(spec: WebServiceSpec): string {
	return join(spec.agentDir, "web", "services", `web-service-admin-${macosAdminUid()}`);
}

function macosAdminSudoersStagingPath(spec: WebServiceSpec): string {
	return join(spec.agentDir, "web", "services", `web-service-sudoers-${macosAdminUid()}`);
}

function macosWebBinPath(spec: WebServiceSpec): string {
	return join(spec.agentDir, "web", "bin");
}

function shellSingleQuote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

function makeMacosAdminHelper(spec: WebServiceSpec): string {
	const uid = macosAdminUid();
	const agentDir = shellSingleQuote(spec.agentDir);
	return `#!/bin/bash
set -euo pipefail
expected_uid=${uid}
agent_dir=${agentDir}

invalid_path() {
	[[ "$1" == *".."* || "$1" == *$'\\n'* || "$1" == *$'\\r'* ]]
}

valid_source() {
	invalid_path "$1" && return 1
	case "$1" in
		"$agent_dir"/web/services/com.lystar.web-frontend*."$expected_uid".plist|"$agent_dir"/web/services/com.lystar.web-gateway*."$expected_uid".plist|"$agent_dir"/web/services/com.lystar.web-runtime*."$expected_uid".plist) return 0 ;;
		*) return 1 ;;
	esac
}

valid_target() {
	invalid_path "$1" && return 1
	case "$1" in
		/Library/LaunchDaemons/com.lystar.web-frontend*."$expected_uid".plist|/Library/LaunchDaemons/com.lystar.web-gateway*."$expected_uid".plist|/Library/LaunchDaemons/com.lystar.web-runtime*."$expected_uid".plist) return 0 ;;
		*) return 1 ;;
	esac
}

valid_label() {
	invalid_path "$1" && return 1
	case "$1" in
		system/com.lystar.web-frontend*."$expected_uid"|system/com.lystar.web-gateway*."$expected_uid"|system/com.lystar.web-runtime*."$expected_uid") return 0 ;;
		*) return 1 ;;
	esac
}

valid_admin_source() {
	invalid_path "$1" && return 1
	case "$1" in
		"$agent_dir"/web/services/web-service-admin-"$expected_uid"|"$agent_dir"/web/services/web-service-sudoers-"$expected_uid") return 0 ;;
		*) return 1 ;;
	esac
}

action="\${1:-}"
shift || true
case "$action" in
	status)
		exit 0
		;;
	upgrade)
		[[ $# -eq 2 ]] && valid_admin_source "$1" && valid_admin_source "$2" || exit 64
		[[ "$(/usr/bin/basename "$1")" == "web-service-admin-$expected_uid" ]] || exit 64
		[[ "$(/usr/bin/basename "$2")" == "web-service-sudoers-$expected_uid" ]] || exit 64
		/usr/bin/install -o root -g wheel -m 0755 "$1" ${shellSingleQuote(macosAdminHelperPath())}
		exec /usr/bin/install -o root -g wheel -m 0440 "$2" ${shellSingleQuote(macosAdminSudoersPath())}
		;;
	uninstall-authorization)
		[[ $# -eq 0 ]] || exit 64
		/bin/rm -f ${shellSingleQuote(macosAdminSudoersPath())}
		exec /bin/rm -f "$0"
		;;
	install)
		[[ $# -eq 2 ]] && valid_source "$1" && valid_target "$2" || exit 64
		[[ "$(/usr/bin/basename "$1")" == "$(/usr/bin/basename "$2")" ]] || exit 64
		exec /usr/bin/install -o root -g wheel -m 0644 "$1" "$2"
		;;
	bootstrap)
		[[ $# -eq 1 ]] && valid_target "$1" || exit 64
		exec /bin/launchctl bootstrap system "$1"
		;;
	kickstart)
		[[ $# -eq 1 ]] && valid_label "$1" || exit 64
		exec /bin/launchctl kickstart "$1"
		;;
	bootout)
		[[ $# -eq 1 ]] && valid_label "$1" || exit 64
		exec /bin/launchctl bootout "$1"
		;;
	remove)
		[[ $# -eq 1 ]] && valid_target "$1" || exit 64
		exec /bin/rm -f "$1"
		;;
	sudo)
		[[ $# -gt 0 ]] || exit 64
		exec /usr/bin/sudo -n "$@"
		;;
	*)
		exit 64
		;;
esac
`;
}

function makeMacosSudoers(): string {
	const username = userInfo().username;
	if (!/^[A-Za-z0-9._-]+$/u.test(username)) throw new Error("macOS 用户名无法写入 Web 管理员授权规则");
	return `${username} ALL=(root) NOPASSWD: ${macosAdminHelperPath()}\n`;
}

function makeMacosSudoWrapper(): string {
	return `#!/bin/bash\nexec /usr/bin/sudo -n ${shellSingleQuote(macosAdminHelperPath())} sudo "$@"\n`;
}

function makeMacosSecurityWrapper(): string {
	return `#!/bin/bash
if [[ ! -x /usr/bin/security ]]; then
	printf '%s\\n' '当前 macOS 没有可用的 security 工具。' >&2
	exit 127
fi
exec 3<&0
/usr/bin/security "$@" <&3 &
child=$!
exec 3<&-
(
	/bin/sleep 30
	/bin/kill -TERM "$child" 2>/dev/null || true
	/bin/sleep 2
	/bin/kill -KILL "$child" 2>/dev/null || true
) &
watchdog=$!
wait "$child"
status=$?
/bin/kill "$watchdog" 2>/dev/null || true
wait "$watchdog" 2>/dev/null || true
if [[ "$status" -eq 143 || "$status" -eq 137 ]]; then
	printf '%s\\n' 'security 等待钥匙串授权超过 30 秒，任务已终止。请在设置的“系统授权”页面完成授权。' >&2
	exit 78
fi
exit "$status"
`;
}

function makeMacosSshWrapper(): string {
	return `#!/bin/bash
if [[ ! -x /usr/bin/ssh ]]; then
	printf '%s\\n' '当前 macOS 没有安装 SSH。' >&2
	exit 127
fi
exec /usr/bin/ssh -oBatchMode=yes "$@"
`;
}

function makeMacosOsascriptWrapper(): string {
	return `#!/bin/bash
script="$*"
if printf '%s' "$script" | /usr/bin/grep -Eiq 'with[[:space:]]+administrator[[:space:]]+privileges'; then
	printf '%s\\n' 'LYStar Code Web 不执行 macOS 图形管理员弹窗。请把管理员命令改为 sudo 执行。' >&2
	exit 77
fi
exec 3<&0
/usr/bin/osascript "$@" <&3 &
child=$!
exec 3<&-
(
	/bin/sleep 30
	/bin/kill -TERM "$child" 2>/dev/null || true
) &
watchdog=$!
wait "$child"
status=$?
/bin/kill "$watchdog" 2>/dev/null || true
wait "$watchdog" 2>/dev/null || true
if [[ "$status" -eq 143 ]]; then
	printf '%s\\n' 'osascript 等待系统授权超过 30 秒，任务已终止。请在设置的“系统授权”页面完成授权。' >&2
	exit 78
fi
exit "$status"
`;
}

function installMacosAdminHelper(spec: WebServiceSpec, interactive: boolean): CommandResult {
	const helperStaging = macosAdminHelperStagingPath(spec);
	const sudoersStaging = macosAdminSudoersStagingPath(spec);
	writeAtomic(helperStaging, makeMacosAdminHelper(spec), 0o700);
	writeAtomic(sudoersStaging, makeMacosSudoers(), 0o600);
	const validate = run("/usr/sbin/visudo", ["-cf", sudoersStaging]);
	if (!validate.ok) return validate;
	const current = run("/usr/bin/sudo", ["-n", macosAdminHelperPath(), "status"]);
	if (current.ok) {
		const upgrade = run("/usr/bin/sudo", ["-n", macosAdminHelperPath(), "upgrade", helperStaging, sudoersStaging]);
		if (!upgrade.ok) return upgrade;
	} else {
		const helperInstall = runAdmin(
			"sudo",
			["install", "-o", "root", "-g", "wheel", "-m", "0755", helperStaging, macosAdminHelperPath()],
			interactive,
		);
		if (!helperInstall.ok) return helperInstall;
		const sudoersInstall = runAdmin(
			"sudo",
			["install", "-o", "root", "-g", "wheel", "-m", "0440", sudoersStaging, macosAdminSudoersPath()],
			interactive,
		);
		if (!sudoersInstall.ok) return sudoersInstall;
	}
	writeAtomic(join(macosWebBinPath(spec), "sudo"), makeMacosSudoWrapper(), 0o700);
	writeAtomic(
		join(macosWebBinPath(spec), "git-credential-lystar"),
		makeMacosGitCredentialWrapper(spec.agentDir),
		0o700,
	);
	writeAtomic(join(macosWebBinPath(spec), "security"), makeMacosSecurityWrapper(), 0o700);
	writeAtomic(join(macosWebBinPath(spec), "ssh"), makeMacosSshWrapper(), 0o700);
	writeAtomic(join(macosWebBinPath(spec), "osascript"), makeMacosOsascriptWrapper(), 0o700);
	return run("/usr/bin/sudo", ["-n", macosAdminHelperPath(), "status"]);
}

function runMacosAdmin(
	spec: WebServiceSpec,
	action: "install" | "bootstrap" | "kickstart" | "bootout" | "remove",
	args: string[],
	interactive: boolean,
): CommandResult {
	let status = run("/usr/bin/sudo", ["-n", macosAdminHelperPath(), "status"]);
	if (!status.ok && interactive) status = installMacosAdminHelper(spec, true);
	if (!status.ok) {
		return {
			ok: false,
			status: status.status,
			stdout: status.stdout,
			stderr: "macOS Web 管理员授权尚未初始化，请在本机终端运行 lc web service install",
		};
	}
	return run("/usr/bin/sudo", ["-n", macosAdminHelperPath(), action, ...args]);
}

export interface MacosWebAdminStatus {
	supported: boolean;
	granted: boolean;
	helperPath?: string;
	message: string;
}

export function getMacosWebAdminStatus(): MacosWebAdminStatus {
	if (process.platform !== "darwin") return { supported: false, granted: false, message: "当前系统不是 macOS" };
	const helperPath = macosAdminHelperPath();
	const result = run("/usr/bin/sudo", ["-n", helperPath, "status"]);
	return {
		supported: true,
		granted: result.ok,
		helperPath,
		message: result.ok ? "管理员静默执行通道可用" : "请在本机终端运行 lc web service install 完成一次授权",
	};
}

export function removeMacosWebAdminAuthorization(agentDir: string, interactive = false): void {
	if (process.platform !== "darwin") return;
	const helperPath = macosAdminHelperPath();
	let result = run("/usr/bin/sudo", ["-n", helperPath, "uninstall-authorization"]);
	if (!result.ok && interactive) {
		result = runAdmin("sudo", ["rm", "-f", helperPath, macosAdminSudoersPath()], true);
	}
	if (!result.ok && existsSync(helperPath)) {
		throw new Error(`无法删除 macOS Web 管理员授权：${result.stderr || result.stdout}`);
	}
	rmSync(join(agentDir, "web", "bin", "sudo"), { force: true });
	rmSync(join(agentDir, "web", "bin", "git-credential-lystar"), { force: true });
	rmSync(join(agentDir, "web", "bin", "security"), { force: true });
	rmSync(join(agentDir, "web", "bin", "ssh"), { force: true });
	rmSync(join(agentDir, "web", "bin", "osascript"), { force: true });
	rmSync(join(agentDir, "web", "services", `web-service-admin-${macosAdminUid()}`), { force: true });
	rmSync(join(agentDir, "web", "services", `web-service-sudoers-${macosAdminUid()}`), { force: true });
}

function profileSuffix(profile: string | undefined): string {
	if (!profile || profile === "default") return "";
	const normalized = profile.replace(/[^A-Za-z0-9_.-]+/gu, "-").replace(/^-+|-+$/gu, "");
	return normalized ? `-${normalized}` : "";
}

export function webServiceUnitName(kind: WebServiceKind, profile?: string): string {
	return `lystar-web-${kind}${profileSuffix(profile)}`;
}

function serviceKindLabel(kind: WebServiceKind): string {
	if (kind === "frontend") return "Frontend";
	return kind === "gateway" ? "Gateway" : "Runtime";
}

export function webServiceWindowsName(kind: WebServiceKind, profile?: string): string {
	const suffix = profileSuffix(profile);
	return `LYStar Web ${serviceKindLabel(kind)}${suffix ? ` ${suffix.slice(1)}` : ""}`;
}

function launchDaemonLabel(kind: WebServiceKind, profile?: string): string {
	const uid = process.getuid?.() ?? 0;
	const suffix = profileSuffix(profile).replace(/^-/u, ".");
	return `com.lystar.web-${kind}${suffix}.${uid}`;
}

function systemdUnitPath(spec: WebServiceSpec): string {
	return join(homedir(), ".config", "systemd", "user", `${webServiceUnitName(spec.kind, spec.profile)}.service`);
}

function launchDaemonPath(spec: WebServiceSpec): string {
	return join("/Library", "LaunchDaemons", `${launchDaemonLabel(spec.kind, spec.profile)}.plist`);
}

function launchAgentPath(spec: WebServiceSpec): string {
	return join(homedir(), "Library", "LaunchAgents", `${launchDaemonLabel(spec.kind, spec.profile)}.plist`);
}

function launchdPath(spec: WebServiceSpec): string {
	return spec.macosSession === "gui" ? launchAgentPath(spec) : launchDaemonPath(spec);
}

function launchdDomain(spec: WebServiceSpec): string {
	return spec.macosSession === "gui" ? `gui/${macosAdminUid()}` : "system";
}

function launchdTarget(spec: WebServiceSpec): string {
	return `${launchdDomain(spec)}/${launchDaemonLabel(spec.kind, spec.profile)}`;
}

function runMacosUserLaunchctl(args: string[]): CommandResult {
	const direct = run("/bin/launchctl", args);
	if (direct.ok) return direct;
	return run("/usr/bin/sudo", [
		"-n",
		macosAdminHelperPath(),
		"sudo",
		"/bin/launchctl",
		"asuser",
		String(macosAdminUid()),
		"/bin/launchctl",
		...args,
	]);
}

function launchDaemonStagingPath(spec: WebServiceSpec): string {
	return join(spec.agentDir, "web", "services", `${launchDaemonLabel(spec.kind, spec.profile)}.plist`);
}

function windowsServiceConfigPath(spec: WebServiceSpec): string {
	return join(spec.agentDir, "web", "services", `${webServiceUnitName(spec.kind, spec.profile)}.ini`);
}

function defaultLogPath(spec: WebServiceSpec): string {
	return spec.logPath ?? join(spec.agentDir, "web", `${spec.kind}.service.log`);
}

function serviceEnvironment(spec: WebServiceSpec): Record<string, string> {
	const values: Record<string, string> = {};
	for (const [key, value] of Object.entries(spec.environment ?? {})) {
		if (value !== undefined) values[key] = value;
	}
	if (process.platform === "darwin") {
		const currentPath = values.PATH ?? process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
		values.LYSTAR_WEB_COMMAND_BIN = macosWebBinPath(spec);
		values.PATH = `${macosWebBinPath(spec)}:${currentPath}`;
		values.GIT_CONFIG_COUNT = "2";
		values.GIT_CONFIG_KEY_0 = "credential.helper";
		values.GIT_CONFIG_VALUE_0 = "";
		values.GIT_CONFIG_KEY_1 = "credential.helper";
		values.GIT_CONFIG_VALUE_1 = "lystar";
		values.GIT_TERMINAL_PROMPT = "0";
		values.GIT_ASKPASS = "/usr/bin/false";
		values.SSH_ASKPASS = "/usr/bin/false";
		values.GCM_INTERACTIVE = "never";
	}
	values.LYSTAR_WEB_SERVICE_CHILD = "1";
	return values;
}

function systemdEscape(value: string): string {
	value = value.replaceAll("%", "%%");
	return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n")}"`;
}

function commandLineArgument(value: string): string {
	if (value.length === 0) return '""';
	if (!/[\s"\\]/u.test(value)) return value;
	let result = '"';
	let backslashes = 0;
	for (const character of value) {
		if (character === "\\") {
			backslashes++;
			continue;
		}
		if (character === '"') {
			result += "\\".repeat(backslashes * 2 + 1);
			result += '"';
			backslashes = 0;
			continue;
		}
		result += "\\".repeat(backslashes);
		backslashes = 0;
		result += character;
	}
	result += "\\".repeat(backslashes * 2);
	return `${result}"`;
}

function xml(value: string): string {
	return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function plistArguments(spec: WebServiceSpec): string {
	return [spec.invocation.program, ...spec.invocation.args]
		.map((argument) => `<string>${xml(argument)}</string>`)
		.join("");
}

function serviceDescription(spec: WebServiceSpec): string {
	return `LYStar Code Web ${serviceKindLabel(spec.kind)}${profileSuffix(spec.profile)}`;
}

function makeSystemdUnit(spec: WebServiceSpec): string {
	const environment = Object.entries(serviceEnvironment(spec))
		.map(([key, value]) => `Environment=${systemdEscape(`${key}=${value}`)}`)
		.join("\n");
	return [
		"[Unit]",
		`Description=${serviceDescription(spec)}`,
		"After=network-online.target",
		"Wants=network-online.target",
		"StartLimitIntervalSec=60",
		"StartLimitBurst=5",
		"",
		"[Service]",
		"Type=simple",
		`WorkingDirectory=${spec.invocation.cwd.replaceAll("%", "%%")}`,
		`ExecStart=${[spec.invocation.program, ...spec.invocation.args].map((value) => systemdEscape(value.replaceAll("$", "$$"))).join(" ")}`,
		environment,
		"Restart=on-failure",
		"RestartSec=2",
		"KillMode=mixed",
		"",
		"[Install]",
		"WantedBy=default.target",
		"",
	]
		.filter((line) => line !== "")
		.join("\n");
}

function makeLaunchDaemon(spec: WebServiceSpec): string {
	const environment = Object.entries(serviceEnvironment(spec))
		.map(([key, value]) => `<key>${xml(key)}</key><string>${xml(value)}</string>`)
		.join("");
	const user = process.env.USER ?? process.env.LOGNAME ?? "";
	if (spec.macosSession !== "gui" && !user) throw new Error("无法确定 macOS 后台运行用户");
	const identity = spec.macosSession === "gui" ? "" : `<key>UserName</key><string>${xml(user)}</string>`;
	const logPath = defaultLogPath(spec);
	return [
		'<?xml version="1.0" encoding="UTF-8"?>',
		'<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
		'<plist version="1.0"><dict>',
		`<key>Label</key><string>${xml(launchDaemonLabel(spec.kind, spec.profile))}</string>`,
		identity,
		`<key>ProgramArguments</key><array>${plistArguments(spec)}</array>`,
		`<key>WorkingDirectory</key><string>${xml(spec.invocation.cwd)}</string>`,
		`<key>EnvironmentVariables</key><dict>${environment}</dict>`,
		"<key>RunAtLoad</key><true/>",
		"<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>",
		"<key>ThrottleInterval</key><integer>2</integer>",
		"<key>ProcessType</key><string>Background</string>",
		`<key>StandardOutPath</key><string>${xml(logPath)}</string>`,
		`<key>StandardErrorPath</key><string>${xml(`${logPath}.error`)}</string>`,
		"</dict></plist>",
		"",
	].join("\n");
}

function makeWindowsServiceConfig(spec: WebServiceSpec): string {
	const environment = Object.entries(serviceEnvironment(spec))
		.map(([key, value]) => `${key}=${value}`)
		.join("\n");
	return [
		"[service]",
		`program=${spec.invocation.program}`,
		`workingDirectory=${spec.invocation.cwd}`,
		`arguments=${spec.invocation.args.map(commandLineArgument).join(" ")}`,
		`logPath=${defaultLogPath(spec)}`,
		"",
		"[environment]",
		environment,
		"",
	].join("\n");
}

function windowsServiceHostPath(spec: WebServiceSpec): string {
	const version = spec.environment?.LYSTAR_WEB_SERVICE_VERSION;
	const stableHost = join(
		spec.agentDir,
		"web",
		"services",
		version ? `lystar-web-service-${version}.exe` : "lystar-web-service.exe",
	);
	if (existsSync(stableHost)) return stableHost;
	const launcherDirectory = dirname(spec.invocation.program);
	let currentVersionHost: string | undefined;
	try {
		const currentVersion = version ?? readFileSync(join(launcherDirectory, "..", "current"), "utf8").trim();
		if (currentVersion)
			currentVersionHost = join(launcherDirectory, "..", "versions", currentVersion, "lystar-web-service.exe");
	} catch {}
	const candidates = [
		...(currentVersionHost ? [currentVersionHost] : []),
		join(launcherDirectory, "lystar-web-service.exe"),
		join(dirname(process.execPath), "lystar-web-service.exe"),
	];
	const source = candidates.find((candidate) => existsSync(candidate));
	if (!source) {
		throw new Error(
			`Windows Service Host 不存在。请使用包含 lystar-web-service.exe 的 LYStar Code 发行包，或重新运行安装器。查找路径：${candidates.join("、")}`,
		);
	}
	mkdirSync(dirname(stableHost), { recursive: true, mode: 0o700 });
	copyFileSync(source, stableHost);
	return stableHost;
}

function writeAtomic(path: string, content: string, mode = 0o600): void {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
	try {
		writeFileSync(temporaryPath, content, { encoding: "utf8", mode });
		renameSync(temporaryPath, path);
	} finally {
		rmSync(temporaryPath, { force: true });
	}
}

function parsePid(value: string): number | undefined {
	const pid = Number.parseInt(value, 10);
	return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

function servicePid(spec: WebServiceSpec): number | undefined {
	if (process.platform === "linux") {
		const result = run("systemctl", [
			"--user",
			"show",
			webServiceUnitName(spec.kind, spec.profile),
			"--property=MainPID",
			"--value",
		]);
		return result.ok ? parsePid(result.stdout) : undefined;
	}
	if (process.platform === "darwin") {
		const result = run("launchctl", ["print", launchdTarget(spec)]);
		const match = /\bpid\s*=\s*(\d+)/u.exec(result.stdout);
		return match ? parsePid(match[1]!) : undefined;
	}
	const result = run("sc.exe", ["queryex", webServiceWindowsName(spec.kind, spec.profile)]);
	const match = /\bPID\s*:\s*(\d+)/iu.exec(result.stdout);
	return match ? parsePid(match[1]!) : undefined;
}

function legacyWindowsTaskName(spec: WebServiceSpec): string | undefined {
	return spec.kind === "runtime" && !profileSuffix(spec.profile) ? "LYStar Web Runtime" : undefined;
}

function queryLegacyWindowsTask(spec: WebServiceSpec): CommandResult | undefined {
	const name = legacyWindowsTaskName(spec);
	return name ? run("schtasks.exe", ["/Query", "/TN", name, "/FO", "LIST"]) : undefined;
}

export function getWebServiceStatus(spec: WebServiceSpec): WebServiceStatus {
	const serviceName =
		process.platform === "win32"
			? webServiceWindowsName(spec.kind, spec.profile)
			: webServiceUnitName(spec.kind, spec.profile);
	if (process.platform === "linux") {
		const path = systemdUnitPath(spec);
		const active = run("systemctl", [
			"--user",
			"is-active",
			"--quiet",
			webServiceUnitName(spec.kind, spec.profile),
		]).ok;
		const user = process.env.USER ?? process.env.LOGNAME ?? "";
		const lingerEnabled = user !== "" && existsSync(join("/var/lib/systemd/linger", user));
		const pid = servicePid(spec);
		return {
			kind: spec.kind,
			...(spec.profile ? { profile: spec.profile } : {}),
			serviceName,
			installed: existsSync(path),
			running: active,
			persistent: active && lingerEnabled,
			manager: existsSync(path) ? "systemd-user" : "detached",
			...(pid !== undefined ? { pid } : {}),
			servicePath: path,
			...(existsSync(path) && !lingerEnabled && user
				? {
						message: "用户 lingering 尚未启用，退出登录后服务可能停止",
						remedy: `sudo loginctl enable-linger ${user}`,
					}
				: {}),
		};
	}
	if (process.platform === "darwin") {
		const path = launchdPath(spec);
		const loaded = run("launchctl", ["print", launchdTarget(spec)]).ok;
		const pid = servicePid(spec);
		return {
			kind: spec.kind,
			...(spec.profile ? { profile: spec.profile } : {}),
			serviceName,
			installed: existsSync(path),
			running: loaded && pid !== undefined,
			persistent: loaded,
			manager: existsSync(path) ? (spec.macosSession === "gui" ? "launch-agent" : "launch-daemon") : "detached",
			...(pid !== undefined ? { pid } : {}),
			servicePath: path,
			...(!existsSync(path)
				? { message: "macOS 后台服务尚未安装", remedy: "运行 lc web service install 并完成管理员授权" }
				: spec.macosSession === "gui" && !loaded
					? { message: "macOS 用户会话服务未运行", remedy: "登录 macOS 用户会话后运行 lc web service start" }
					: {}),
		};
	}
	const service = run("sc.exe", ["query", serviceName]);
	if (service.ok) {
		return {
			kind: spec.kind,
			...(spec.profile ? { profile: spec.profile } : {}),
			serviceName,
			installed: true,
			running: /STATE\s*:\s*4\b|RUNNING/iu.test(service.stdout),
			persistent: true,
			manager: "windows-service",
			...(servicePid(spec) ? { pid: servicePid(spec) } : {}),
			servicePath: windowsServiceConfigPath(spec),
		};
	}
	const legacyTask = queryLegacyWindowsTask(spec);
	if (legacyTask?.ok) {
		return {
			kind: spec.kind,
			...(spec.profile ? { profile: spec.profile } : {}),
			serviceName,
			installed: true,
			running: /Running|正在运行/iu.test(legacyTask.stdout),
			persistent: true,
			manager: "scheduled-task",
			servicePath: legacyWindowsTaskName(spec),
		};
	}
	return {
		kind: spec.kind,
		...(spec.profile ? { profile: spec.profile } : {}),
		serviceName,
		installed: false,
		running: false,
		persistent: false,
		manager: "detached",
		servicePath: windowsServiceConfigPath(spec),
	};
}

function installLinux(spec: WebServiceSpec): void {
	const unitPath = systemdUnitPath(spec);
	writeAtomic(unitPath, makeSystemdUnit(spec));
	const reload = run("systemctl", ["--user", "daemon-reload"]);
	if (!reload.ok) throw new Error(`无法刷新 systemd 用户服务：${reload.stderr || reload.stdout}`);
	const enable = run("systemctl", ["--user", "enable", webServiceUnitName(spec.kind, spec.profile)]);
	if (!enable.ok) throw new Error(`无法启用 systemd 用户服务：${enable.stderr || enable.stdout}`);
	const restart = run("systemctl", ["--user", "restart", webServiceUnitName(spec.kind, spec.profile)]);
	if (!restart.ok) throw new Error(`无法启动 systemd 用户服务：${restart.stderr || restart.stdout}`);
}

function installMac(spec: WebServiceSpec, interactiveAdmin: boolean): void {
	const authorization = installMacosAdminHelper(spec, interactiveAdmin);
	if (!authorization.ok)
		throw new Error(`无法初始化 macOS Web 管理员授权：${authorization.stderr || authorization.stdout}`);
	if (spec.macosSession === "gui") {
		const legacyPath = launchDaemonPath(spec);
		const legacyTarget = `system/${launchDaemonLabel(spec.kind, spec.profile)}`;
		if (existsSync(legacyPath) || run("launchctl", ["print", legacyTarget]).ok) {
			runMacosAdmin(spec, "bootout", [legacyTarget], false);
			if (existsSync(legacyPath)) runMacosAdmin(spec, "remove", [legacyPath], false);
		}
		const targetPath = launchAgentPath(spec);
		writeAtomic(targetPath, makeLaunchDaemon(spec), 0o600);
		runMacosUserLaunchctl(["bootout", launchdTarget(spec)]);
		const bootstrap = runMacosUserLaunchctl(["bootstrap", launchdDomain(spec), targetPath]);
		if (!bootstrap.ok) throw new Error(`无法启动 macOS LaunchAgent：${bootstrap.stderr || bootstrap.stdout}`);
		return;
	}
	const stagingPath = launchDaemonStagingPath(spec);
	const targetPath = launchDaemonPath(spec);
	writeAtomic(stagingPath, makeLaunchDaemon(spec), 0o600);
	const install = runMacosAdmin(spec, "install", [stagingPath, targetPath], false);
	if (!install.ok) throw new Error(`无法安装 macOS LaunchDaemon：${install.stderr || install.stdout}`);
	runMacosAdmin(spec, "bootout", [launchdTarget(spec)], false);
	const bootstrap = runMacosAdmin(spec, "bootstrap", [targetPath], false);
	if (!bootstrap.ok) throw new Error(`无法启动 macOS LaunchDaemon：${bootstrap.stderr || bootstrap.stdout}`);
}

function waitForWindowsServiceStopped(name: string): void {
	const deadline = Date.now() + 15_000;
	const wait = new Int32Array(new SharedArrayBuffer(4));
	while (Date.now() < deadline) {
		const result = run("sc.exe", ["query", name]);
		if (result.ok && /STATE\s*:\s*1\b|STOPPED/iu.test(result.stdout)) return;
		if (!result.ok) throw new Error(`无法查询 Windows Service：${result.stderr || result.stdout}`);
		Atomics.wait(wait, 0, 0, 100);
	}
	throw new Error(`Windows Service 停止超时：${name}`);
}

function installWindows(spec: WebServiceSpec): void {
	const name = webServiceWindowsName(spec.kind, spec.profile);
	const configPath = windowsServiceConfigPath(spec);
	const hostPath = windowsServiceHostPath(spec);
	writeAtomic(configPath, makeWindowsServiceConfig(spec));
	const legacyTask = queryLegacyWindowsTask(spec);
	if (legacyTask?.ok) {
		const taskName = legacyWindowsTaskName(spec);
		if (taskName) {
			runWindowsTaskCommand(["/End", "/TN", taskName]);
			runWindowsTaskCommand(["/Delete", "/TN", taskName, "/F"]);
		}
	}
	const binPath = `${commandLineArgument(hostPath)} --service-name ${commandLineArgument(name)} --config ${commandLineArgument(configPath)}`;
	const existing = run("sc.exe", ["query", name]).ok;
	if (existing) {
		const stop = runWindowsServiceCommand(["stop", name]);
		if (!stop.ok && !/1062|not started|未启动/iu.test(`${stop.stdout}\n${stop.stderr}`)) {
			throw new Error(`无法停止旧 Windows Service：${stop.stderr || stop.stdout}`);
		}
		waitForWindowsServiceStopped(name);
	}
	const configure = runWindowsServiceCommand(
		existing
			? [
					"config",
					name,
					"binPath=",
					binPath,
					"start=",
					"auto",
					"obj=",
					"LocalSystem",
					"DisplayName=",
					serviceDescription(spec),
				]
			: [
					"create",
					name,
					"binPath=",
					binPath,
					"start=",
					"auto",
					"obj=",
					"LocalSystem",
					"DisplayName=",
					serviceDescription(spec),
				],
	);
	if (!configure.ok) throw new Error(`无法配置 Windows Service：${configure.stderr || configure.stdout}`);
	const failure = runWindowsServiceCommand([
		"failure",
		name,
		"reset=",
		"86400",
		"actions=",
		"restart/2000/restart/5000/restart/15000",
	]);
	if (!failure.ok) throw new Error(`无法配置 Windows Service 自动重启：${failure.stderr || failure.stdout}`);
	const failureFlag = runWindowsServiceCommand(["failureflag", name, "1"]);
	if (!failureFlag.ok)
		throw new Error(`无法启用 Windows Service 失败动作：${failureFlag.stderr || failureFlag.stdout}`);
	const start = runWindowsServiceCommand(["start", name]);
	if (!start.ok && !/already been started|已启动/iu.test(`${start.stdout}\n${start.stderr}`)) {
		throw new Error(`无法启动 Windows Service：${start.stderr || start.stdout}`);
	}
}

export function installWebService(
	spec: WebServiceSpec,
	options: { interactiveAdmin?: boolean } = {},
): WebServiceStatus {
	mkdirSync(spec.invocation.cwd, { recursive: true, mode: 0o700 });
	mkdirSync(dirname(defaultLogPath(spec)), { recursive: true, mode: 0o700 });
	if (process.platform === "linux") installLinux(spec);
	else if (process.platform === "darwin") installMac(spec, options.interactiveAdmin ?? false);
	else if (process.platform === "win32") installWindows(spec);
	else throw new Error(`不支持的后台托管平台：${process.platform}`);
	return getWebServiceStatus(spec);
}

export function ensureWebService(spec: WebServiceSpec, options: { interactiveAdmin?: boolean } = {}): WebServiceStatus {
	const status = getWebServiceStatus(spec);
	if (!status.installed || status.manager === "scheduled-task") return installWebService(spec, options);
	if (status.running) return status;
	if (process.platform === "linux") {
		const result = run("systemctl", ["--user", "start", webServiceUnitName(spec.kind, spec.profile)]);
		if (!result.ok) throw new Error(`无法启动 Web Service：${result.stderr || result.stdout}`);
	} else if (process.platform === "darwin") {
		const target = launchdTarget(spec);
		const loaded = run("launchctl", ["print", target]).ok;
		const result =
			spec.macosSession === "gui"
				? runMacosUserLaunchctl(
						loaded ? ["kickstart", target] : ["bootstrap", launchdDomain(spec), launchdPath(spec)],
					)
				: runMacosAdmin(
						spec,
						loaded ? "kickstart" : "bootstrap",
						[loaded ? target : launchdPath(spec)],
						options.interactiveAdmin ?? false,
					);
		if (!result.ok)
			throw new Error(
				`无法启动 macOS ${spec.macosSession === "gui" ? "LaunchAgent" : "LaunchDaemon"}：${result.stderr || result.stdout}`,
			);
	} else {
		const result = runWindowsServiceCommand(["start", webServiceWindowsName(spec.kind, spec.profile)]);
		if (!result.ok && !/already been started|已启动/iu.test(`${result.stdout}\n${result.stderr}`))
			throw new Error(`无法启动 Windows Service：${result.stderr || result.stdout}`);
	}
	return getWebServiceStatus(spec);
}

export function stopWebService(
	spec: WebServiceSpec,
	force = false,
	options: { interactiveAdmin?: boolean; detachedPid?: number } = {},
): WebServiceStatus {
	const status = getWebServiceStatus(spec);
	if (!status.installed || status.manager === "detached") {
		if (options.detachedPid) {
			try {
				process.kill(options.detachedPid, force ? "SIGKILL" : "SIGTERM");
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
			}
		}
		return getWebServiceStatus(spec);
	}
	if (status.manager === "scheduled-task") {
		const taskName = legacyWindowsTaskName(spec);
		if (taskName) {
			runWindowsTaskCommand(["/End", "/TN", taskName]);
			if (force) runWindowsTaskCommand(["/Delete", "/TN", taskName, "/F"]);
		}
		return getWebServiceStatus(spec);
	}
	if (process.platform === "linux") {
		const unit = webServiceUnitName(spec.kind, spec.profile);
		if (force) {
			const kill = run("systemctl", ["--user", "kill", "--kill-whom=all", "--signal=SIGKILL", unit]);
			if (!kill.ok && status.running)
				throw new Error(`无法强制停止 systemd 用户服务：${kill.stderr || kill.stdout}`);
		}
		const result = run("systemctl", ["--user", "stop", "--no-block", unit]);
		if (!result.ok && status.running) throw new Error(`无法停止 systemd 用户服务：${result.stderr || result.stdout}`);
	} else if (process.platform === "darwin") {
		const result =
			spec.macosSession === "gui"
				? runMacosUserLaunchctl(["bootout", launchdTarget(spec)])
				: runMacosAdmin(spec, "bootout", [launchdTarget(spec)], options.interactiveAdmin ?? false);
		if (!result.ok && status.running)
			throw new Error(
				`无法停止 macOS ${spec.macosSession === "gui" ? "LaunchAgent" : "LaunchDaemon"}：${result.stderr || result.stdout}`,
			);
	} else {
		const result = runWindowsServiceCommand(["stop", webServiceWindowsName(spec.kind, spec.profile)]);
		if (!result.ok && status.running && !/1062|not started|未启动/iu.test(`${result.stdout}\n${result.stderr}`))
			throw new Error(`无法停止 Windows Service：${result.stderr || result.stdout}`);
		waitForWindowsServiceStopped(webServiceWindowsName(spec.kind, spec.profile));
	}
	return getWebServiceStatus(spec);
}

export function removeWebService(spec: WebServiceSpec, options: { interactiveAdmin?: boolean } = {}): void {
	if (process.platform === "linux") {
		run("systemctl", ["--user", "disable", "--now", webServiceUnitName(spec.kind, spec.profile)]);
		rmSync(systemdUnitPath(spec), { force: true });
		run("systemctl", ["--user", "daemon-reload"]);
		return;
	}
	if (process.platform === "darwin") {
		const targetPath = launchdPath(spec);
		const target = launchdTarget(spec);
		const legacyPath = spec.macosSession === "gui" ? launchDaemonPath(spec) : undefined;
		const legacyTarget =
			spec.macosSession === "gui" ? `system/${launchDaemonLabel(spec.kind, spec.profile)}` : undefined;
		const currentLoaded = run("launchctl", ["print", target]).ok;
		const legacyLoaded = legacyTarget ? run("launchctl", ["print", legacyTarget]).ok : false;
		if (!existsSync(targetPath) && !currentLoaded && !legacyLoaded && (!legacyPath || !existsSync(legacyPath))) {
			rmSync(launchDaemonStagingPath(spec), { force: true });
			return;
		}
		if (existsSync(targetPath) || currentLoaded) {
			const bootout =
				spec.macosSession === "gui"
					? runMacosUserLaunchctl(["bootout", target])
					: runMacosAdmin(spec, "bootout", [target], options.interactiveAdmin ?? false);
			if (
				!bootout.ok &&
				!/could not find service|找不到服务|no such process/iu.test(`${bootout.stdout}\n${bootout.stderr}`)
			) {
				throw new Error(
					`无法停止 macOS ${spec.macosSession === "gui" ? "LaunchAgent" : "LaunchDaemon"}：${bootout.stderr || bootout.stdout}`,
				);
			}
			if (existsSync(targetPath)) {
				if (spec.macosSession === "gui") rmSync(targetPath, { force: true });
				else {
					const remove = runMacosAdmin(spec, "remove", [targetPath], options.interactiveAdmin ?? false);
					if (!remove.ok) throw new Error(`无法删除 macOS LaunchDaemon：${remove.stderr || remove.stdout}`);
				}
			}
		}
		if (legacyTarget && legacyPath && (legacyLoaded || existsSync(legacyPath))) {
			const bootout = runMacosAdmin(spec, "bootout", [legacyTarget], options.interactiveAdmin ?? false);
			if (
				!bootout.ok &&
				!/could not find service|找不到服务|no such process/iu.test(`${bootout.stdout}\n${bootout.stderr}`)
			) {
				throw new Error(`无法停止旧 macOS Runtime LaunchDaemon：${bootout.stderr || bootout.stdout}`);
			}
			if (existsSync(legacyPath)) {
				const remove = runMacosAdmin(spec, "remove", [legacyPath], options.interactiveAdmin ?? false);
				if (!remove.ok) throw new Error(`无法删除旧 macOS Runtime LaunchDaemon：${remove.stderr || remove.stdout}`);
			}
		}
		rmSync(launchDaemonStagingPath(spec), { force: true });
		return;
	}
	const name = webServiceWindowsName(spec.kind, spec.profile);
	const stop = runWindowsServiceCommand(["stop", name]);
	if (!stop.ok && !/not started|未启动|does not exist|不存在|1060|1062/iu.test(`${stop.stdout}\n${stop.stderr}`)) {
		throw new Error(`无法停止 Windows Service：${stop.stderr || stop.stdout}`);
	}
	const remove = runWindowsServiceCommand(["delete", name]);
	if (!remove.ok && !/does not exist|不存在|1060/iu.test(`${remove.stdout}\n${remove.stderr}`)) {
		throw new Error(`无法删除 Windows Service：${remove.stderr || remove.stdout}`);
	}
	const taskName = legacyWindowsTaskName(spec);
	if (taskName) runWindowsTaskCommand(["/Delete", "/TN", taskName, "/F"]);
	rmSync(windowsServiceConfigPath(spec), { force: true });
}

export function webServiceDiagnostic(spec: WebServiceSpec): string {
	if (process.platform === "linux") {
		const result = run("systemctl", ["--user", "cat", webServiceUnitName(spec.kind, spec.profile)]);
		return result.ok
			? result.stdout
			: readIfExists(systemdUnitPath(spec), `后台服务尚未安装：${systemdUnitPath(spec)}`);
	}
	if (process.platform === "darwin") {
		const result = run("launchctl", ["print", launchdTarget(spec)]);
		return result.ok ? result.stdout : readIfExists(launchdPath(spec), `后台服务尚未安装：${launchdPath(spec)}`);
	}
	const result = run("sc.exe", ["qc", webServiceWindowsName(spec.kind, spec.profile)]);
	return result.ok ? result.stdout : readIfExists(windowsServiceConfigPath(spec), "Windows Service 尚未安装");
}

function readIfExists(path: string, fallback: string): string {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return fallback;
	}
}

export function currentProcessInvocation(): WebServiceInvocation {
	const entry = process.argv[1];
	if (entry && existsSync(entry) && basename(process.execPath).startsWith("node")) {
		return { program: process.execPath, args: [entry], cwd: process.cwd() };
	}
	return { program: process.execPath, args: [], cwd: process.cwd() };
}
