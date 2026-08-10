import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { NodeExecutionEnv } from "../packages/agent/dist/harness/env/nodejs.js";
import { resolveConfigValueUncached } from "../packages/coding-agent/dist/core/resolve-config-value.js";
import { createLocalBashOperations } from "../packages/coding-agent/dist/core/tools/bash.js";
import { getGitRuntime, getShellConfig, getShellEnv } from "../packages/coding-agent/dist/utils/shell.js";
import {
	ensureManagedWindowsBash,
	getManagedWindowsEnv,
	getManagedWindowsGitPath,
} from "../packages/coding-agent/dist/utils/tools-manager.js";

if (process.platform !== "win32") {
	throw new Error("This integration check must run on Windows");
}

const cwd = mkdtempSync(join(tmpdir(), "lystar-managed-bash-"));
const cliPath = join(import.meta.dirname, "..", "packages", "coding-agent", "dist", "cli.js");
const standaloneDir = process.env.LYSTAR_STANDALONE_DIR;
const cliCommand = standaloneDir ? join(standaloneDir, "lc.exe") : process.execPath;
const cliPrefix = standaloneDir ? [] : [cliPath];
const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === "path") ?? "PATH";
const pathWithoutSystemGit = (process.env[pathKey] ?? "")
	.split(delimiter)
	.filter((entry) => !/[\\/]git[\\/]/i.test(entry))
	.join(delimiter);

function runCli(args, extraEnv = {}) {
	return new Promise((resolve, reject) => {
		const child = spawn(cliCommand, [...cliPrefix, ...args], {
			cwd,
			env: { ...process.env, [pathKey]: pathWithoutSystemGit, ...extraEnv },
			stdio: "pipe",
			windowsHide: true,
		});
		let output = "";
		child.stdout.on("data", (data) => (output += data));
		child.stderr.on("data", (data) => (output += data));
		child.once("error", reject);
		child.once("close", (code) => {
			if (code === 0) resolve(output);
			else reject(new Error(`CLI exited with ${code}: ${output}`));
		});
	});
}

try {
	await Promise.all([runCli(["--ensure-windows-bash"]), runCli(["--ensure-windows-bash"])]);
	const bashPath = await ensureManagedWindowsBash(false);
	if (!bashPath) throw new Error("Managed MinGit Bash was not installed");
	const managedRoot = resolve(dirname(bashPath), "..", "..");
	const managedEnv = getManagedWindowsEnv({ ...process.env, [pathKey]: pathWithoutSystemGit });
	const whereGit = spawnSync("where.exe", ["git.exe"], { encoding: "utf8", env: managedEnv, windowsHide: true });
	const firstGit = whereGit.stdout?.trim().split(/\r?\n/)[0];
	const expectedGit = join(managedRoot, "cmd", "git.exe");
	const resolvedFirstGit = firstGit && existsSync(firstGit) ? realpathSync.native(firstGit).toLowerCase() : "";
	const resolvedExpectedGit = existsSync(expectedGit) ? realpathSync.native(expectedGit).toLowerCase() : "";
	if (whereGit.status !== 0 || resolvedFirstGit !== resolvedExpectedGit) {
		throw new Error(`git.exe did not resolve from managed MinGit first: ${whereGit.stdout || whereGit.stderr}`);
	}

	const command = [
		'[[ -n "$BASH_VERSION" ]]',
		"printf 'hello\\n' > '中文 文件.txt'",
		"test -f '中文 文件.txt'",
		"grep hello '中文 文件.txt' | sed 's/hello/world/' | awk '{ print $1 }'",
		"git --version",
		"find . -name '中文 文件.txt' >/dev/null",
	].join(" && ");
	const result = spawnSync(bashPath, ["--noprofile", "--norc", "-c", command], {
		cwd,
		encoding: "utf8",
		windowsHide: true,
	});
	if (result.error || result.status !== 0) {
		throw new Error(result.error?.message || result.stderr || `Bash exited with ${result.status}`);
	}
	if (!result.stdout.includes("world") || !result.stdout.includes("git version")) {
		throw new Error(`Unexpected Bash output: ${result.stdout}`);
	}

	const shell = getShellConfig();
	if (shell.shell !== bashPath || !shell.args.includes("--noprofile") || !shell.args.includes("--norc")) {
		throw new Error(`Shell runtime did not select managed Bash: ${JSON.stringify(shell)}`);
	}
	const managedGit = getManagedWindowsGitPath();
	const gitRuntime = getGitRuntime();
	if (!managedGit || gitRuntime.command !== managedGit) throw new Error("Git runtime did not select managed git.exe");
	if (resolveConfigValueUncached("!printf config-ok") !== "config-ok") {
		throw new Error("!command config resolution did not use the managed shell runtime");
	}

	const operationChunks = [];
	const operations = createLocalBashOperations();
	const operationResult = await operations.exec("git --version && printf operation-ok", cwd, {
		onData: (data) => operationChunks.push(data),
	});
	if (operationResult.exitCode !== 0 || !Buffer.concat(operationChunks).toString("utf8").includes("operation-ok")) {
		throw new Error("Extension/local Bash operations did not use managed MinGit");
	}

	const harnessEnv = new NodeExecutionEnv({ cwd, shellPath: bashPath, shellEnv: getShellEnv(managedEnv) });
	const harnessResult = await harnessEnv.exec("git --version && printf harness-ok");
	if (!harnessResult.ok || harnessResult.value.exitCode !== 0 || !harnessResult.value.stdout.includes("harness-ok")) {
		throw new Error("Agent harness did not use the injected managed shell runtime");
	}
	await harnessEnv.cleanup();

	const archivePath = join(cwd, "MinGit-2.55.0.3-64-bit.zip");
	if (process.env.LYSTAR_MINGIT_ARCHIVE) {
		copyFileSync(process.env.LYSTAR_MINGIT_ARCHIVE, archivePath);
	} else {
		const archiveResponse = await fetch(
			"https://registry.npmmirror.com/-/binary/git-for-windows/v2.55.0.windows.3/MinGit-2.55.0.3-64-bit.zip",
		);
		if (!archiveResponse.ok) throw new Error(`Unable to prepare MinGit offline archive: ${archiveResponse.status}`);
		writeFileSync(archivePath, Buffer.from(await archiveResponse.arrayBuffer()));
	}
	await runCli(["--ensure-windows-bash", "--archive", archivePath, "--offline"], {
		PI_CODING_AGENT_DIR: join(cwd, "offline-agent"),
		PI_OFFLINE: "1",
	});

	const secondPath = await ensureManagedWindowsBash(true);
	if (secondPath !== bashPath) throw new Error("Managed Bash path changed on the second check");
	console.log(`Managed MinGit Bash integration passed: ${bashPath}`);
} finally {
	rmSync(cwd, { recursive: true, force: true });
}
