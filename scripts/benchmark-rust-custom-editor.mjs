import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { rustCustomEditorBenchmarkConfigFromEnvironment } from "./rust-custom-editor-manifest.mjs";

const root = process.cwd();
const bun = process.env.LYSTAR_BUN ?? "bun";
const expectedBunVersion = "1.3.9";
const bunVersion = spawnSync(bun, ["--version"], { encoding: "utf8" });
if (bunVersion.error || bunVersion.status !== 0 || bunVersion.stdout.trim() !== expectedBunVersion) {
	throw new Error(
		`Rust CustomEditor benchmark requires Bun ${expectedBunVersion}; ${bun} reported ${bunVersion.stdout.trim() || bunVersion.stderr.trim() || bunVersion.error?.message || "no version"}`,
	);
}
const argv = process.argv.slice(2);
let smoke = false;
for (const argument of argv) {
	if (argument === "--smoke") smoke = true;
	else throw new Error(`Unknown argument: ${argument}`);
}
const config = rustCustomEditorBenchmarkConfigFromEnvironment({
	...process.env,
	...(smoke ? { LYSTAR_RUST_CUSTOM_EDITOR_SMOKE: "1" } : {}),
});
const artifact = resolve(
	root,
	smoke ? ".artifacts/rust-tui-custom-editor-smoke" : ".artifacts/rust-tui-custom-editor",
);
rmSync(artifact, { recursive: true, force: true });
mkdirSync(artifact, { recursive: true });
const benchmark = resolve(artifact, "benchmark.jsonl");

await run(bun, ["scripts/benchmark-rust-custom-editor-runner.ts"], {
	LYSTAR_RUST_CUSTOM_EDITOR_ARTIFACT: benchmark,
	LYSTAR_RUST_CUSTOM_EDITOR_BENCHMARK_CONFIG: JSON.stringify(config),
	LYSTAR_RUST_CUSTOM_EDITOR_ROOT: root,
});
await run(process.execPath, [
	"scripts/verify-rust-custom-editor-benchmark.mjs",
	"--artifact",
	artifact,
	...(smoke ? ["--smoke"] : []),
	...(process.env.LYSTAR_RUST_CUSTOM_EDITOR_SCENARIOS
		? ["--scenarios", process.env.LYSTAR_RUST_CUSTOM_EDITOR_SCENARIOS]
		: []),
	...(process.env.LYSTAR_RUST_CUSTOM_EDITOR_SIZES ? ["--sizes", process.env.LYSTAR_RUST_CUSTOM_EDITOR_SIZES] : []),
]);

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
