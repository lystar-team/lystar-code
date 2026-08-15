import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();
const artifact = resolve(root, ".artifacts/rust-tui-spike");
const HOLD_MS = 1_600;
const STEADY_MS = 1_000;
const SAMPLE_MS = 5;
mkdirSync(artifact, { recursive: true });
for (const file of ["benchmark-ts.jsonl", "benchmark-rust.jsonl", "rss.json"]) rmSync(resolve(artifact, file), { force: true });
await run("cargo", ["build", "--release", "-p", "lystar-tui", "--example", "benchmark"]);
await run("cargo", ["build", "--release", "-p", "lystar-tui"]);
const rustBenchmark = resolve(root, "target/release/examples/benchmark");
const rustTui = resolve(root, "target/release/lystar-tui");
const rss = {
	ts: await measure("ts", process.execPath, ["--import", "tsx", "packages/tui/test/render-churn-bench.ts", "--rss-hold-ms", String(HOLD_MS)]),
	rust: await measure("rust", rustBenchmark, ["--rss-hold-ms", String(HOLD_MS)]),
	combined: await measure("combined", process.execPath, ["--import", "tsx", "scripts/rust-b0-combined-rss.ts", rustTui, String(HOLD_MS)]),
};
writeFileSync(resolve(artifact, "rss.json"), `${JSON.stringify(rss)}\n`);
await run(process.execPath, ["--import", "tsx", "packages/tui/test/render-churn-bench.ts", "--out", resolve(artifact, "benchmark-ts.jsonl")]);
await run(rustBenchmark, ["--out", resolve(artifact, "benchmark-rust.jsonl")]);
const compareCode = await run(process.execPath, ["scripts/compare-rust-tui-spike.mjs"], [0, 2]);
if (compareCode !== 0) process.exitCode = compareCode;

async function measure(name, command, args) {
	const child = spawn(command, args, { cwd: root, stdio: ["ignore", "pipe", "inherit"] });
	const ready = waitForReady(child, name);
	await ready;
	const samples = [];
	const started = performance.now();
	let deadline = started;
	while (performance.now() - started < STEADY_MS) {
		const now = performance.now();
		if (now < deadline) sleep(deadline - now);
		samples.push({ atMs: performance.now() - started, bytes: rssTree(child.pid) });
		deadline += SAMPLE_MS;
	}
	const code = await wait(child);
	assert.equal(code, 0, `${name} RSS worker exited ${code}`);
	assert(samples.length >= 100, `${name} RSS steady sample count is below one second at 10ms`);
	assert(
		samples.slice(1).every((sample, index) => sample.atMs - samples[index].atMs <= 10),
		`${name} RSS sampling exceeded 10ms`,
	);
	const values = samples.map((sample) => sample.bytes);
	assert(values.every((value) => value > 0), `${name} RSS includes an empty process tree sample`);
	return {
		samples,
		p50Bytes: percentile(values, 0.5),
		p95Bytes: percentile(values, 0.95),
		maxBytes: Math.max(...values),
	};
}

function waitForReady(child, name) {
	return new Promise((resolveReady, reject) => {
		let output = "";
		const timeout = setTimeout(() => finish(new Error(`${name} RSS worker did not reach steady state`)), 10_000);
		const finish = (error) => {
			clearTimeout(timeout);
			child.stdout?.off("data", onData);
			child.off("exit", onExit);
			error ? reject(error) : resolveReady();
		};
		const onData = (chunk) => {
			output += chunk;
			if (output.includes("READY\n")) finish();
		};
		const onExit = (code) => finish(new Error(`${name} RSS worker exited before READY (${code})`));
		child.stdout?.on("data", onData);
		child.once("exit", onExit);
	});
}

function wait(child) {
	return new Promise((resolveExit, reject) => {
		child.once("error", reject);
		child.once("exit", (code) => resolveExit(code ?? 1));
	});
}

function rssTree(pid) {
	if (!pid) return 0;
	const seen = new Set();
	const visit = (current) => {
		if (!current || seen.has(current)) return 0;
		seen.add(current);
		let total = rssPid(current);
		try {
			for (const child of readFileSync(`/proc/${current}/task/${current}/children`, "utf8").trim().split(/\s+/)) total += visit(Number(child));
		} catch {}
		return total;
	};
	return visit(pid);
}

function rssPid(pid) {
	try {
		const line = readFileSync(`/proc/${pid}/status`, "utf8").split("\n").find((value) => value.startsWith("VmRSS:"));
		return Number(line?.match(/\d+/)?.[0] ?? 0) * 1024;
	} catch {
		return 0;
	}
}

function percentile(values, q) {
	const sorted = [...values].sort((left, right) => left - right);
	return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * q) - 1)];
}

function sleep(milliseconds) {
	if (milliseconds <= 0) return;
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function run(command, args, accepted = [0]) {
	return new Promise((resolveRun, reject) => {
		const child = spawn(command, args, { cwd: root, stdio: "inherit" });
		child.once("error", reject);
		child.once("exit", (code) => accepted.includes(code ?? 1) ? resolveRun(code ?? 1) : reject(new Error(`${command} exited ${code}`)));
	});
}
