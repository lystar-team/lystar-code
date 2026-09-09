#!/usr/bin/env node
import { runWebRuntimeCli } from "./cli-runner.ts";

try {
	await runWebRuntimeCli();
} catch (error) {
	const value = error as Error & { code?: string; status?: unknown };
	process.stderr.write(`${JSON.stringify({ error: value.message, code: value.code, status: value.status })}\n`);
	process.exitCode = 1;
}
