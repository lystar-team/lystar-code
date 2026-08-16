import { spawn } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();
const argv = process.argv.slice(2);
const smoke = argv.length === 1 && argv[0] === "--smoke";
if (!smoke && argv.length > 0) throw new Error(`Unknown argument: ${argv.join(" ")}`);

const artifact = resolve(
	root,
	smoke ? ".artifacts/rust-tui-extension-component-storm-smoke" : ".artifacts/rust-tui-extension-component-storm",
);
rmSync(artifact, { recursive: true, force: true });
mkdirSync(artifact, { recursive: true });
const benchmark = resolve(artifact, "benchmark.jsonl");

await run("npm", [
	"--workspace",
	"@lystar/code-gui-host",
	"exec",
	"vitest",
	"--",
	"--run",
	"test/rust-tui-e2e.test.ts",
	"--testNamePattern",
	"benchmarks real Extension Component invalidate storms",
], {
	LYSTAR_EXTENSION_COMPONENT_STORM_ARTIFACT: benchmark,
	...(smoke ? { LYSTAR_EXTENSION_COMPONENT_STORM_SMOKE: "1" } : {}),
});
await run(process.execPath, ["scripts/verify-rust-extension-component-storm.mjs", "--artifact", artifact, ...(smoke ? ["--smoke"] : [])]);

function run(command, args, extraEnv = {}) {
	return new Promise((resolveRun, reject) => {
		const child = spawn(command, args, {
			cwd: root,
			env: { ...process.env, ...extraEnv },
			stdio: "inherit",
		});
		child.once("error", reject);
		child.once("exit", (code) => {
			if (code === 0) resolveRun();
			else reject(new Error(`${command} exited ${code}`));
		});
	});
}
