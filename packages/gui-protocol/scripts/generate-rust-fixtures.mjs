import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { encodeClientMessage, encodeServerMessage, GUI_PROTOCOL_VERSION } from "../src/index.ts";

const fixtures = new Map([
	[
		"ts-client-hello.frame",
		encodeClientMessage({ type: "hello", version: GUI_PROTOCOL_VERSION, clientInstanceId: "rust-spike-client" }),
	],
	[
		"ts-server-hello.frame",
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
	],
]);
const directory = resolve(import.meta.dirname, "../../../crates/lystar-protocol/tests/fixtures");
mkdirSync(directory, { recursive: true });
for (const [name, bytes] of fixtures) {
	const path = resolve(directory, name);
	const content = Buffer.from(bytes);
	if (!Buffer.from(readFileSyncSafe(path)).equals(content)) writeFileSync(path, content);
}

function readFileSyncSafe(path) {
	try {
		return readFileSync(path);
	} catch {
		return Buffer.alloc(0);
	}
}
