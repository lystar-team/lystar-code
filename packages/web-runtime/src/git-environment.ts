import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const MACOS_GIT_KEYCHAIN_AUTHORIZATION_MARKER = "LYSTAR_GIT_KEYCHAIN_AUTHORIZATION_REQUIRED";

export interface MacosGitCredentialAuthorization {
	configured: boolean;
	valid: boolean;
	helperPath?: string;
	hosts: string[];
	reason?: "missing" | "helper_missing" | "helper_changed";
}

function authorizationPaths(agentDir: string): {
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

function readAuthorizationValue(path: string): string | undefined {
	try {
		return readFileSync(path, "utf8").trim() || undefined;
	} catch {
		return undefined;
	}
}

export function macosGitCredentialHelperFingerprint(helperPath: string): string | undefined {
	try {
		return createHash("sha256").update(readFileSync(helperPath)).digest("hex");
	} catch {
		return undefined;
	}
}

export function readMacosGitCredentialAuthorization(agentDir: string): MacosGitCredentialAuthorization {
	const paths = authorizationPaths(agentDir);
	const helperPath = readAuthorizationValue(paths.helperPath);
	const expectedFingerprint = readAuthorizationValue(paths.helperFingerprint);
	const hosts = (readAuthorizationValue(paths.hosts) ?? "")
		.split(/\r?\n/u)
		.map((host) => host.trim().toLowerCase())
		.filter(Boolean);
	if (!helperPath || !expectedFingerprint) return { configured: false, valid: false, hosts, reason: "missing" };
	if (!existsSync(helperPath)) {
		return { configured: true, valid: false, helperPath, hosts, reason: "helper_missing" };
	}
	const currentFingerprint = macosGitCredentialHelperFingerprint(helperPath);
	if (!currentFingerprint || currentFingerprint !== expectedFingerprint) {
		return { configured: true, valid: false, helperPath, hosts, reason: "helper_changed" };
	}
	return { configured: true, valid: true, helperPath, hosts };
}

export function writeMacosGitCredentialAuthorization(
	agentDir: string,
	helperPath: string,
	hosts: readonly string[],
): void {
	const fingerprint = macosGitCredentialHelperFingerprint(helperPath);
	if (!fingerprint) throw new Error(`无法读取 Git 钥匙串 Helper：${helperPath}`);
	const paths = authorizationPaths(agentDir);
	mkdirSync(dirname(paths.helperPath), { recursive: true, mode: 0o700 });
	writeFileSync(paths.helperPath, `${helperPath}\n`, { encoding: "utf8", mode: 0o600 });
	writeFileSync(paths.helperFingerprint, `${fingerprint}\n`, { encoding: "utf8", mode: 0o600 });
	const normalizedHosts = [...new Set(hosts.map((host) => host.trim().toLowerCase()).filter(Boolean))].sort();
	writeFileSync(paths.hosts, normalizedHosts.length ? `${normalizedHosts.join("\n")}\n` : "", {
		encoding: "utf8",
		mode: 0o600,
	});
}

export function clearMacosGitCredentialAuthorization(agentDir: string): void {
	const paths = authorizationPaths(agentDir);
	for (const path of Object.values(paths)) rmSync(path, { force: true });
}

function shellSingleQuote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function makeMacosGitCredentialWrapper(agentDir: string): string {
	const paths = authorizationPaths(agentDir);
	return `#!/bin/bash
set -u
helper_file=${shellSingleQuote(paths.helperPath)}
fingerprint_file=${shellSingleQuote(paths.helperFingerprint)}
hosts_file=${shellSingleQuote(paths.hosts)}
marker=${shellSingleQuote(MACOS_GIT_KEYCHAIN_AUTHORIZATION_MARKER)}
input="$(/bin/cat)"
host="$(/usr/bin/printf '%s\n' "$input" | /usr/bin/awk -F= '$1 == "host" { print substr($0, 6); exit }' | /usr/bin/tr '[:upper:]' '[:lower:]')"
fail_authorization() {
	/usr/bin/printf '%s: %s\n' "$marker" "$1" >&2
	exit 78
}
[[ -n "$host" ]] || fail_authorization 'Git HTTPS 请求缺少远端域名，请在运行 LYStar Code Web 的 Mac 本机终端执行 lc web permissions setup'
[[ -r "$helper_file" && -r "$fingerprint_file" && -r "$hosts_file" ]] || fail_authorization 'Git 钥匙串尚未完成后台授权，请在运行 LYStar Code Web 的 Mac 本机终端执行 lc web permissions setup'
helper="$(/bin/cat "$helper_file")"
expected_fingerprint="$(/bin/cat "$fingerprint_file")"
[[ -x "$helper" ]] || fail_authorization '已登记的 Git 钥匙串 Helper 不存在，请在运行 LYStar Code Web 的 Mac 本机终端重新执行 lc web permissions setup'
current_fingerprint="$(/usr/bin/shasum -a 256 "$helper" 2>/dev/null | /usr/bin/awk '{ print $1 }')"
[[ -n "$current_fingerprint" && "$current_fingerprint" == "$expected_fingerprint" ]] || fail_authorization 'Git 钥匙串 Helper 已变化，请在运行 LYStar Code Web 的 Mac 本机终端重新执行 lc web permissions setup'
/usr/bin/grep -Fqx "$host" "$hosts_file" || fail_authorization "远端 $host 尚未完成后台钥匙串授权，请在运行 LYStar Code Web 的 Mac 本机终端执行 lc web permissions setup"
"$helper" "$@" < <(/usr/bin/printf '%s\n' "$input") &
child=$!
(
	/bin/sleep 8
	/bin/kill -TERM "$child" 2>/dev/null || true
	/bin/sleep 1
	/bin/kill -KILL "$child" 2>/dev/null || true
) &
watchdog=$!
wait "$child"
status=$?
/bin/kill "$watchdog" 2>/dev/null || true
wait "$watchdog" 2>/dev/null || true
if [[ "$status" -eq 143 || "$status" -eq 137 ]]; then
	fail_authorization "远端 $host 的钥匙串访问需要本机确认，后台请求已停止；请在运行 LYStar Code Web 的 Mac 本机终端执行 lc web permissions setup"
fi
exit "$status"
`;
}

export function webGitArguments(
	cwd: string,
	args: readonly string[],
	platform: NodeJS.Platform = process.platform,
): string[] {
	return [
		"-C",
		cwd,
		...(platform === "darwin" ? ["-c", "credential.helper=", "-c", "credential.helper=lystar"] : []),
		...args,
	];
}

export function macosGitCredentialError(
	output: string,
	platform: NodeJS.Platform = process.platform,
): { code: "git_credentials_required"; message: string } | undefined {
	if (platform !== "darwin") return undefined;
	if (
		!new RegExp(
			`${MACOS_GIT_KEYCHAIN_AUTHORIZATION_MARKER}|terminal prompts disabled|could not read (?:Username|Password)|authentication failed|credential-osxkeychain`,
			"iu",
		).test(output)
	)
		return undefined;
	return {
		code: "git_credentials_required",
		message:
			"Git 需要访问这台 Mac 的登录钥匙串，本次后台操作已停止。请在运行 LYStar Code Web 的 Mac 本机终端执行 lc web permissions setup，在终端隐藏输入一次登录钥匙串密码完成批量授权，完成后回到 Web 重试。",
	};
}
