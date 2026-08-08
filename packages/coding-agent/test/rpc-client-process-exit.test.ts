import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { RpcClient } from "../src/modes/rpc/rpc-client.ts";

const tempDirs: string[] = [];

function writeChildScript(contents: string): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-rpc-client-exit-"));
	tempDirs.push(dir);
	const path = join(dir, "child.mjs");
	writeFileSync(path, contents);
	return path;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("RpcClient child process failures", () => {
	test("rejects an in-flight request when the child process exits", async () => {
		const client = new RpcClient({
			cliPath: writeChildScript(`
process.stdin.once("data", () => {
	process.exit(43);
});
process.stdin.resume();
`),
		});

		await client.start();

		await expect(client.getCommands()).rejects.toThrow(/Agent process exited \(code=43 signal=null\)/);
	});

	test("passes commandArgs before RPC mode and client args", async () => {
		const argsFile = join(mkdtempSync(join(tmpdir(), "pi-rpc-client-args-")), "args.json");
		tempDirs.push(dirname(argsFile));
		const client = new RpcClient({
			command: process.execPath,
			commandArgs: [
				writeChildScript(`
import { writeFileSync } from "node:fs";
writeFileSync(process.env.ARGS_FILE, JSON.stringify(process.argv.slice(2)));
setInterval(() => {}, 1000);
`),
				"--launcher-arg",
			],
			args: ["--no-session"],
			env: { ARGS_FILE: argsFile },
		});

		await client.start();
		expect(JSON.parse(readFileSync(argsFile, "utf8"))).toEqual(["--launcher-arg", "--mode", "rpc", "--no-session"]);
		await client.stop();
	});
});
