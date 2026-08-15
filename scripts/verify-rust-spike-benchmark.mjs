import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { evaluate } from "./compare-rust-tui-spike.mjs";

function readJsonLines(path) {
	return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
}

export function verifyRustSpike({ artifact, report, exitCode }) {
	if (exitCode !== 0 && exitCode !== 2) throw new Error(`Rust B0 benchmark exited ${exitCode}`);
	const result = evaluate({
		ts: readJsonLines(resolve(artifact, "benchmark-ts.jsonl")),
		rust: readJsonLines(resolve(artifact, "benchmark-rust.jsonl")),
		rss: JSON.parse(readFileSync(resolve(artifact, "rss.json"), "utf8")),
		gate: JSON.parse(readFileSync(resolve(artifact, "gate.json"), "utf8")),
	});
	assert.equal(exitCode, result.developmentDecision === "go" ? 0 : 2, "Rust B0 development decision does not match benchmark exit code");
	const content = readFileSync(report, "utf8");
	assert.match(content, new RegExp(`developmentDecision: ${result.developmentDecision}`), "Rust B0 development decision does not match benchmark data");
	assert.match(content, new RegExp(`releaseDecision: ${result.releaseDecision}`), "Rust B0 release decision does not match benchmark data");
	return {
		developmentDecision: result.developmentDecision,
		releaseDecision: result.releaseDecision,
		developmentFailures: result.developmentFailures.length,
		releaseFailures: result.releaseFailures.length,
	};
}

export function runCli(argv = process.argv.slice(2)) {
	const options = {
		artifact: process.env.RUST_TUI_SPIKE_ARTIFACT ?? ".artifacts/rust-tui-spike",
		report: "docs/rust-tui-spike-report.md",
		exitCode: Number(process.env.RUST_SPIKE_EXIT_CODE),
	};
	for (let index = 0; index < argv.length; index++) {
		const argument = argv[index];
		const value = argv[index + 1];
		if (argument === "--artifact") options.artifact = value;
		else if (argument === "--report") options.report = value;
		else if (argument === "--exit-code") options.exitCode = Number(value);
		else throw new Error(`Unknown argument: ${argument}`);
		index++;
	}
	const result = verifyRustSpike({
		artifact: resolve(options.artifact),
		report: resolve(options.report),
		exitCode: options.exitCode,
	});
	process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runCli();
