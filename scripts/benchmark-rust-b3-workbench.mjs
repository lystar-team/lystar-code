import { spawn } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();
const artifact = resolve(root, ".artifacts/rust-tui-b3-workbench");
mkdirSync(artifact, { recursive: true });
rmSync(resolve(artifact, "benchmark.jsonl"), { force: true });

await run("cargo", ["build", "--release", "-p", "lystar-tui", "--example", "b3_workbench_benchmark"]);
await run(resolve(root, "target/release/examples/b3_workbench_benchmark"), ["--out", resolve(artifact, "benchmark.jsonl")]);
await run(process.execPath, ["scripts/verify-rust-b3-workbench-benchmark.mjs", "--artifact", artifact]);

function run(command, args) {
	return new Promise((resolveRun, reject) => {
		const child = spawn(command, args, { cwd: root, stdio: "inherit" });
		child.once("error", reject);
		child.once("exit", (code) => {
			if (code === 0) resolveRun();
			else reject(new Error(`${command} exited ${code}`));
		});
	});
}
