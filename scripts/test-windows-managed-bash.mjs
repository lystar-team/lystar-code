import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { ensureManagedWindowsBash } from "../packages/coding-agent/dist/utils/tools-manager.js";

if (process.platform !== "win32") {
	throw new Error("This integration check must run on Windows");
}

const cwd = mkdtempSync(join(tmpdir(), "lystar-managed-bash-"));
const cliPath = join(import.meta.dirname, "..", "packages", "coding-agent", "dist", "cli.js");
const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === "path") ?? "PATH";
const pathWithoutSystemGit = (process.env[pathKey] ?? "")
	.split(delimiter)
	.filter((entry) => !/[\\/]git[\\/]/i.test(entry))
	.join(delimiter);

function runBootstrap() {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [cliPath, "--ensure-windows-bash"], {
			cwd,
			env: { ...process.env, [pathKey]: pathWithoutSystemGit },
			stdio: "pipe",
			windowsHide: true,
		});
		let output = "";
		child.stdout.on("data", (data) => (output += data));
		child.stderr.on("data", (data) => (output += data));
		child.once("error", reject);
		child.once("close", (code) => {
			if (code === 0) resolve();
			else reject(new Error(`Bootstrap exited with ${code}: ${output}`));
		});
	});
}

try {
	await Promise.all([runBootstrap(), runBootstrap()]);
	const bashPath = await ensureManagedWindowsBash(false);
	if (!bashPath) throw new Error("Managed MinGit Bash was not installed");
	const managedRoot = resolve(dirname(bashPath), "..", "..");
	const whereGit = spawnSync("where.exe", ["git.exe"], { encoding: "utf8", windowsHide: true });
	const firstGit = whereGit.stdout?.trim().split(/\r?\n/)[0];
	if (whereGit.status !== 0 || !firstGit?.toLowerCase().startsWith(`${managedRoot.toLowerCase()}\\`)) {
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

	const secondPath = await ensureManagedWindowsBash(true);
	if (secondPath !== bashPath) throw new Error("Managed Bash path changed on the second check");
	console.log(`Managed MinGit Bash integration passed: ${bashPath}`);
} finally {
	rmSync(cwd, { recursive: true, force: true });
}
