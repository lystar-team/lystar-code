import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { resolve } from "node:path";

const root = process.cwd();
const artifact = resolve(root, ".artifacts/rust-tui-spike");
mkdirSync(artifact, { recursive: true });
rmSync(resolve(artifact, "benchmark-ts.jsonl"), { force: true });
rmSync(resolve(artifact, "benchmark-rust.jsonl"), { force: true });
await run("cargo", ["build", "--release", "-p", "lystar-tui", "--example", "benchmark"]);
const ts = spawn(process.execPath, ["--import", "tsx", "packages/tui/test/render-churn-bench.ts", "--out", resolve(artifact, "benchmark-ts.jsonl")], { cwd: root, stdio: "inherit" });
const rust = spawn(resolve(root, "target/release/examples/benchmark"), ["--out", resolve(artifact, "benchmark-rust.jsonl")], { cwd: root, stdio: "inherit" });
let combinedPeak = 0;
const sample = setInterval(() => { combinedPeak = Math.max(combinedPeak, rss(ts.pid) + rss(rust.pid)); }, 20);
const [tsCode, rustCode] = await Promise.all([wait(ts), wait(rust)]);
clearInterval(sample);
if (tsCode !== 0 || rustCode !== 0) process.exitCode = 1;
writeFileSync(resolve(artifact, "combined-rss.json"), `${JSON.stringify({ combinedRssBytes: combinedPeak })}\n`);
await run(process.execPath, ["scripts/compare-rust-tui-spike.mjs"], [0, 2]);

function rss(pid) {
	if (!pid) return 0;
	try {
		const line = readFileSync(`/proc/${pid}/status`, "utf8").split("\n").find((value) => value.startsWith("VmRSS:"));
		return Number(line?.match(/\d+/)?.[0] ?? 0) * 1024;
	} catch { return 0; }
}
function wait(child) { return new Promise((resolveExit) => child.once("exit", (code) => resolveExit(code ?? 1))); }
function run(command, args, accepted = [0]) {
	return new Promise((resolveRun, reject) => {
		const child = spawn(command, args, { cwd: root, stdio: "inherit" });
		child.once("exit", (code) => accepted.includes(code ?? 1) ? resolveRun() : reject(new Error(`${command} exited ${code}`)));
	});
}
