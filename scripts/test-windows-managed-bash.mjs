import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { ensureManagedWindowsBash } from "../packages/coding-agent/dist/utils/tools-manager.js";

if (process.platform !== "win32") {
	throw new Error("This integration check must run on Windows");
}

const cwd = mkdtempSync(join(tmpdir(), "lystar-managed-bash-"));
const cliPath = join(import.meta.dirname, "..", "packages", "coding-agent", "dist", "cli.js");

function runBootstrap() {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [cliPath, "--ensure-windows-bash"], {
			cwd,
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
