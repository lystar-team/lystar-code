import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { ClientMessageDecoder, encodeServerMessage, GUI_PROTOCOL_VERSION } from "../src/index.ts";

const child = spawn("target/debug/lystar-tui", ["--pipe-handshake"], {
	cwd: new URL("../../../", import.meta.url),
	stdio: ["ignore", "ignore", "inherit", "pipe", "pipe"],
});
const decoder = new ClientMessageDecoder();
let receivedHello = false;
child.stdio[4].on("data", (chunk) => {
	for (const message of decoder.push(chunk)) {
		if (message.type !== "hello") continue;
		receivedHello = true;
		child.stdio[3].write(
			encodeServerMessage({
				type: "hello",
				version: GUI_PROTOCOL_VERSION,
				productVersion: "rust-spike",
				protocolVersion: GUI_PROTOCOL_VERSION,
				serverInstanceId: "node-host",
				hostInstanceId: "node-host",
				hostStartedAt: 0,
				capabilities: ["session-paging"],
			}),
		);
		child.stdio[3].end();
	}
});
const [code] = await once(child, "exit");
assert.equal(receivedHello, true);
assert.equal(code, 0);
