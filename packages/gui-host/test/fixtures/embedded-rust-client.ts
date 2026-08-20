import { readFileSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { encodeClientMessage, type ServerMessage, ServerMessageDecoder } from "@lystar/code-gui-protocol";

const endpoint = process.env.PI_RUST_TUI_HOST_ENDPOINT;
const runIndex = process.argv.indexOf("--run");
const sessionPath = runIndex >= 0 ? process.argv[runIndex + 1] : undefined;
if (!endpoint || !sessionPath) process.exit(2);
const mode = process.env.PI_EMBEDDED_CLIENT_MODE ?? "normal";
const endpointCapturePath = process.env.PI_EMBEDDED_ENDPOINT_CAPTURE_PATH;
if (endpointCapturePath) writeFileSync(endpointCapturePath, endpoint);
if (mode === "pre-acquire-exit-7") process.exit(7);

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
if (mode === "malformed-frame") {
	socket.end(Buffer.from([0, 0, 0, 1, 0xff]));
	await new Promise((resolve) => setTimeout(resolve, 50));
	process.exit(9);
}

socket.write(
	encodeClientMessage({
		type: "hello",
		version: mode === "hello-version" ? 999 : 1,
		clientInstanceId: "embedded-rust-test",
	}),
);
if (mode === "hello-version") {
	await waitFor((message) => message.type === "hello_error");
	socket.end();
	process.exit(8);
}
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
const lease = (response.result as { lease?: { leaseId?: unknown } }).lease;
if (!lease || typeof lease.leaseId !== "string") process.exit(5);
const expectedStartupPath = process.env.PI_EMBEDDED_STARTUP_EXPECTED_PATH;
if (expectedStartupPath) {
	const expected = JSON.parse(readFileSync(expectedStartupPath, "utf8"));
	const actual =
		response.result && typeof response.result === "object" && !Array.isArray(response.result)
			? response.result.startupInput
			: undefined;
	if (JSON.stringify(actual) !== JSON.stringify(expected)) process.exit(4);
}
if (mode === "acquire-exit-17") process.exit(17);
if (mode === "acquire-sigterm") {
	process.kill(process.pid, "SIGTERM");
	await new Promise(() => {});
}
if (mode === "run-bash-disconnect") {
	const markerPath = process.env.PI_EMBEDDED_OPERATION_MARKER_PATH;
	if (!markerPath) process.exit(6);
	const quotedMarker = `'${markerPath.replaceAll("'", `'"'"'`)}'`;
	const request = {
		type: "request" as const,
		id: "bash",
		request: {
			command: "run_bash" as const,
			sessionPath,
			leaseId: lease.leaseId,
			clientInstanceId: "embedded-rust-test",
			clientRequestId: "embedded-bash-once",
			commandText: `printf 'once\\n' >> ${quotedMarker}; sleep 5`,
			excludeFromContext: true,
		},
	};
	socket.write(encodeClientMessage(request));
	const accepted = await waitFor((message) => message.type === "response" && message.id === "bash");
	if (accepted.type !== "response" || !accepted.ok) process.exit(7);
	socket.write(encodeClientMessage({ ...request, id: "bash-retry" }));
	const duplicate = await waitFor((message) => message.type === "response" && message.id === "bash-retry");
	if (duplicate.type !== "response" || !duplicate.ok) process.exit(7);
	socket.destroy();
	await new Promise((resolve) => setTimeout(resolve, 25));
	process.exit(0);
}
socket.end();
