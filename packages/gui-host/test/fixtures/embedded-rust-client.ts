import { readFileSync } from "node:fs";
import { createConnection } from "node:net";
import { encodeClientMessage, type ServerMessage, ServerMessageDecoder } from "@lystar/code-gui-protocol";

const endpoint = process.env.PI_RUST_TUI_HOST_ENDPOINT;
const runIndex = process.argv.indexOf("--run");
const sessionPath = runIndex >= 0 ? process.argv[runIndex + 1] : undefined;
if (!endpoint || !sessionPath) process.exit(2);

const socket = createConnection(endpoint);
const decoder = new ServerMessageDecoder();
const messages: ServerMessage[] = [];
const waiters = new Set<() => void>();
socket.on("data", (chunk) => {
	messages.push(...decoder.push(chunk));
	for (const wake of waiters) wake();
	waiters.clear();
});

function waitFor(predicate: (message: ServerMessage) => boolean): Promise<ServerMessage> {
	return new Promise((resolve, reject) => {
		const deadline = Date.now() + 10_000;
		const check = () => {
			const message = messages.find(predicate);
			if (message) {
				resolve(message);
				return;
			}
			if (Date.now() >= deadline) {
				reject(new Error(`Timed out waiting for Host response: ${JSON.stringify(messages)}`));
				return;
			}
			waiters.add(check);
			setTimeout(check, 25).unref?.();
		};
		check();
	});
}

await new Promise<void>((resolve, reject) => {
	socket.once("connect", resolve);
	socket.once("error", reject);
});
socket.write(encodeClientMessage({ type: "hello", version: 1, clientInstanceId: "embedded-rust-test" }));
await waitFor((message) => message.type === "hello");
socket.write(
	encodeClientMessage({
		type: "request",
		id: "acquire",
		request: {
			command: "acquire_session",
			sessionPath,
			clientInstanceId: "embedded-rust-test",
		},
	}),
);
const response = await waitFor((message) => message.type === "response" && message.id === "acquire");
if (response.type !== "response" || !response.ok) process.exit(3);
const expectedStartupPath = process.env.PI_EMBEDDED_STARTUP_EXPECTED_PATH;
if (expectedStartupPath) {
	const expected = JSON.parse(readFileSync(expectedStartupPath, "utf8"));
	const actual =
		response.result && typeof response.result === "object" && !Array.isArray(response.result)
			? response.result.startupInput
			: undefined;
	if (JSON.stringify(actual) !== JSON.stringify(expected)) process.exit(4);
}
socket.end();
