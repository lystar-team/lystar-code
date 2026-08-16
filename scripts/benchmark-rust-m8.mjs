import { spawn } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();
const artifact = resolve(root, ".artifacts/rust-tui-m8");
mkdirSync(artifact, { recursive: true });
rmSync(resolve(artifact, "benchmark.jsonl"), { force: true });

await run("cargo", ["build", "--release", "-p", "lystar-tui", "--example", "m8_benchmark"]);
await run(resolve(root, "target/release/examples/m8_benchmark"), ["--out", resolve(artifact, "benchmark.jsonl")]);
await run(process.execPath, ["scripts/verify-rust-m8-benchmark.mjs", "--artifact", artifact]);

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
