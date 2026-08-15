import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NodeExecutionEnv } from "../../src/harness/env/nodejs.ts";
import { getOrThrow } from "../../src/harness/types.ts";
import { createTempDir } from "./session-test-utils.ts";

function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout?: () => void): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timeoutId = setTimeout(() => {
			onTimeout?.();
			reject(new Error(`Timed out after ${ms}ms`));
		}, ms);
		promise.then(
			(value) => {
				clearTimeout(timeoutId);
				resolve(value);
			},
			(error: unknown) => {
				clearTimeout(timeoutId);
				reject(error);
			},
		);
	});
}

function toBashSingleQuotedArg(value: string): string {
	return `'${value.replace(/\\/g, "/").replace(/'/g, `'"'"'`)}'`;
}

function createInheritedStdioCommand(pidFile: string): string {
	return (
		'node -e "' +
		"const fs=require('fs');" +
		"const {spawn}=require('child_process');" +
		"const child=spawn(process.execPath,['-e','setTimeout(()=>{},60000)'],{stdio:'inherit',detached:true});" +
		"fs.writeFileSync(process.argv[1], String(child.pid));" +
		"child.unref();" +
		"console.log('child-exiting');" +
		'" ' +
		toBashSingleQuotedArg(pidFile)
	);
}

function cleanupDetachedChild(pidFile: string): void {
	if (!existsSync(pidFile)) return;
	const pid = Number.parseInt(readFileSync(pidFile, "utf8").trim(), 10);
	if (!Number.isFinite(pid) || pid <= 0) return;
	try {
		execFileSync("taskkill", ["/F", "/T", "/PID", String(pid)], { stdio: "ignore" });
	} catch {}
}

if (process.platform === "win32") {
	describe("NodeExecutionEnv Windows", () => {
		it("settles after the shell exits when a detached descendant retains inherited stdio", async () => {
			const root = createTempDir();
			const pidFile = join(root, "grandchild.pid");
			const env = new NodeExecutionEnv({ cwd: root });
			const controller = new AbortController();
			try {
				const result = getOrThrow(
					await withTimeout(
						env.exec(createInheritedStdioCommand(pidFile), { abortSignal: controller.signal }),
						3000,
						() => controller.abort(),
					),
				);
				expect(result.stdout).toContain("child-exiting");
			} finally {
				controller.abort();
				cleanupDetachedChild(pidFile);
			}
		});
	});
}
