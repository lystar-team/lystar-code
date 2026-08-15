import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { ClientMessageDecoder, encodeServerMessage } from "@lystar/code-gui-protocol";
import { GuiHostService } from "../packages/gui-host/src/service.ts";
import type { RuntimeAdapter } from "../packages/gui-host/src/types.ts";

const [binary, holdMsText = "1300"] = process.argv.slice(2);
if (!binary) throw new Error("Rust child path is required");
const holdMs = Number(holdMsText);
const agentDir = join(process.cwd(), ".artifacts", "rust-tui-spike", "rss-host-agent");
mkdirSync(agentDir, { recursive: true });
const adapter = { getAbout: () => ({ productVersion: "rust-b0-rss" }) } as RuntimeAdapter;
const service = new GuiHostService(adapter, { agentDir, journalPath: join(agentDir, "operations.jsonl") });
const child = spawn(binary, ["--pipe-handshake-hold", String(holdMs)], {
	cwd: process.cwd(),
	stdio: ["ignore", "ignore", "inherit", "pipe", "pipe"],
});
const toChild = child.stdio[3];
const fromChild = child.stdio[4];
if (!toChild || !fromChild) throw new Error("Rust child IPC descriptors are unavailable");
let ready = false;
let transportError: unknown;
let handling = Promise.resolve();
const connection = service.createConnection(async (message) => {
	if (!toChild.write(encodeServerMessage(message))) await once(toChild, "drain");
	if (message.type === "hello" && !ready) {
		ready = true;
		console.log("READY");
	}
});
const decoder = new ClientMessageDecoder();
fromChild.on("data", (chunk: Buffer) => {
	try {
		for (const message of decoder.push(chunk)) handling = handling.then(() => connection.handle(message));
	} catch (error) {
		transportError = error;
	}
});
const exitCode = await new Promise<number>((resolveExit, reject) => {
	child.once("error", reject);
	child.once("exit", (code) => resolveExit(code ?? 1));
});
await handling.catch((error) => {
	transportError = error;
});
await connection.close();
await service.dispose();
if (transportError) throw transportError;
if (!ready) throw new Error("Rust child did not complete the typed GUI handshake");
if (exitCode !== 0) process.exitCode = exitCode;
