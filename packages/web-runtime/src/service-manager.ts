import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

export type WebServiceKind = "gateway" | "runtime";
export type WebServiceManager = "systemd-user" | "launch-daemon" | "windows-service" | "scheduled-task" | "detached";

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
		`$arguments = @(${args.map(powershellString).join(",")})`,
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
	if (interactive) return run(command, args);
	return run(command, ["-n", ...args]);
}

function profileSuffix(profile: string | undefined): string {
	if (!profile || profile === "default") return "";
	const normalized = profile.replace(/[^A-Za-z0-9_.-]+/gu, "-").replace(/^-+|-+$/gu, "");
	return normalized ? `-${normalized}` : "";
}

export function webServiceUnitName(kind: WebServiceKind, profile?: string): string {
	return `lystar-web-${kind}${profileSuffix(profile)}`;
}

export function webServiceWindowsName(kind: WebServiceKind, profile?: string): string {
	const suffix = profileSuffix(profile);
	return `LYStar Web ${kind === "gateway" ? "Gateway" : "Runtime"}${suffix ? ` ${suffix.slice(1)}` : ""}`;
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
	values.LYSTAR_WEB_SERVICE_CHILD = "1";
	return values;
}

function systemdEscape(value: string): string {
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
	return `LYStar Code Web ${spec.kind === "gateway" ? "Gateway" : "Runtime"}${profileSuffix(spec.profile)}`;
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
		`WorkingDirectory=${systemdEscape(spec.invocation.cwd)}`,
		`ExecStart=${[spec.invocation.program, ...spec.invocation.args].map(systemdEscape).join(" ")}`,
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
	if (!user) throw new Error("无法确定 macOS 后台运行用户");
	const logPath = defaultLogPath(spec);
	return [
		'<?xml version="1.0" encoding="UTF-8"?>',
		'<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
		'<plist version="1.0"><dict>',
		`<key>Label</key><string>${xml(launchDaemonLabel(spec.kind, spec.profile))}</string>`,
		`<key>UserName</key><string>${xml(user)}</string>`,
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
	const stableHost = join(spec.agentDir, "web", "services", "lystar-web-service.exe");
	if (existsSync(stableHost)) return stableHost;
	const launcherDirectory = dirname(spec.invocation.program);
	let currentVersionHost: string | undefined;
	try {
		const currentVersion = readFileSync(join(launcherDirectory, "..", "current"), "utf8").trim();
		if (currentVersion)
			currentVersionHost = join(launcherDirectory, "..", "versions", currentVersion, "lystar-web-service.exe");
	} catch {}
	const candidates = [
		join(launcherDirectory, "lystar-web-service.exe"),
		join(dirname(process.execPath), "lystar-web-service.exe"),
		...(currentVersionHost ? [currentVersionHost] : []),
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
		const result = run("launchctl", ["print", `system/${launchDaemonLabel(spec.kind, spec.profile)}`]);
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
		const path = launchDaemonPath(spec);
		const loaded = run("launchctl", ["print", `system/${launchDaemonLabel(spec.kind, spec.profile)}`]).ok;
		const pid = servicePid(spec);
		return {
			kind: spec.kind,
			...(spec.profile ? { profile: spec.profile } : {}),
			serviceName,
			installed: existsSync(path),
			running: loaded,
			persistent: loaded,
			manager: existsSync(path) ? "launch-daemon" : "detached",
			...(pid !== undefined ? { pid } : {}),
			servicePath: path,
			...(!existsSync(path)
				? { message: "macOS 后台服务尚未安装", remedy: "运行 lc web service install 并完成管理员授权" }
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
	const stagingPath = launchDaemonStagingPath(spec);
	const targetPath = launchDaemonPath(spec);
	writeAtomic(stagingPath, makeLaunchDaemon(spec), 0o600);
	const install = runAdmin(
		"sudo",
		["install", "-o", "root", "-g", "wheel", "-m", "0644", stagingPath, targetPath],
		interactiveAdmin,
	);
	if (!install.ok) throw new Error(`无法安装 macOS LaunchDaemon：${install.stderr || install.stdout}`);
	runAdmin("sudo", ["launchctl", "bootout", `system/${launchDaemonLabel(spec.kind, spec.profile)}`], interactiveAdmin);
	const bootstrap = runAdmin("sudo", ["launchctl", "bootstrap", "system", targetPath], interactiveAdmin);
	if (!bootstrap.ok) throw new Error(`无法启动 macOS LaunchDaemon：${bootstrap.stderr || bootstrap.stdout}`);
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
		if (!stop.ok && !/not started|未启动/iu.test(`${stop.stdout}\n${stop.stderr}`)) {
			throw new Error(`无法停止旧 Windows Service：${stop.stderr || stop.stdout}`);
		}
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
		const result = runAdmin(
			"sudo",
			["launchctl", "bootstrap", "system", launchDaemonPath(spec)],
			options.interactiveAdmin ?? false,
		);
		if (!result.ok) throw new Error(`无法启动 macOS LaunchDaemon：${result.stderr || result.stdout}`);
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
		const result = run("systemctl", ["--user", "stop", webServiceUnitName(spec.kind, spec.profile)]);
		if (!result.ok && status.running) throw new Error(`无法停止 systemd 用户服务：${result.stderr || result.stdout}`);
	} else if (process.platform === "darwin") {
		const result = runAdmin(
			"sudo",
			["launchctl", "bootout", `system/${launchDaemonLabel(spec.kind, spec.profile)}`],
			options.interactiveAdmin ?? false,
		);
		if (!result.ok && status.running)
			throw new Error(`无法停止 macOS LaunchDaemon：${result.stderr || result.stdout}`);
	} else {
		const result = runWindowsServiceCommand(["stop", webServiceWindowsName(spec.kind, spec.profile)]);
		if (!result.ok && status.running && !/not started|未启动/iu.test(`${result.stdout}\n${result.stderr}`))
			throw new Error(`无法停止 Windows Service：${result.stderr || result.stdout}`);
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
		const bootout = runAdmin(
			"sudo",
			["launchctl", "bootout", `system/${launchDaemonLabel(spec.kind, spec.profile)}`],
			options.interactiveAdmin ?? false,
		);
		if (
			!bootout.ok &&
			!/could not find service|找不到服务|no such process/iu.test(`${bootout.stdout}\n${bootout.stderr}`)
		) {
			throw new Error(`无法停止 macOS LaunchDaemon：${bootout.stderr || bootout.stdout}`);
		}
		const targetPath = launchDaemonPath(spec);
		if (existsSync(targetPath)) {
			const remove = runAdmin("sudo", ["rm", "-f", targetPath], options.interactiveAdmin ?? false);
			if (!remove.ok) throw new Error(`无法删除 macOS LaunchDaemon：${remove.stderr || remove.stdout}`);
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
		const result = run("launchctl", ["print", `system/${launchDaemonLabel(spec.kind, spec.profile)}`]);
		return result.ok
			? result.stdout
			: readIfExists(launchDaemonPath(spec), `后台服务尚未安装：${launchDaemonPath(spec)}`);
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
