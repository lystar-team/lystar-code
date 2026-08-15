import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { closeSync, constants, mkdtempSync, openSync, readSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ClientMessageDecoder, encodeServerMessage, type ServerMessage } from "@lystar/code-gui-protocol";
import { afterEach, describe, it } from "vitest";
import { GuiHostService } from "../src/service.ts";
import type { RuntimeAdapter } from "../src/types.ts";

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const sockets = new Set<string>();
const directories = new Set<string>();

function run(command: string, args: string[]): void {
	const result = spawnSync(command, args, { cwd: repositoryRoot, encoding: "utf8" });
	assert.equal(result.status, 0, result.stderr);
}

afterEach(() => {
	for (const socket of sockets) spawnSync("tmux", ["-L", socket, "kill-server"]);
	sockets.clear();
	for (const directory of directories) rmSync(directory, { recursive: true, force: true });
	directories.clear();
});

function waitFor(predicate: () => boolean, message: string, timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	return new Promise((resolve, reject) => {
		const poll = () => {
			if (predicate()) return resolve();
			if (Date.now() >= deadline) return reject(new Error(message));
			setTimeout(poll, 10);
		};
		poll();
	});
}

function writeAll(fd: number, frame: Uint8Array): void {
	let offset = 0;
	while (offset < frame.length) offset += writeSync(fd, frame, offset, frame.length - offset);
}

function sessionEntries(rounds: number): string {
	const entries: object[] = [
		{ type: "session", version: 3, id: "m7-session", timestamp: "2026-08-15T00:00:00Z", cwd: "/tmp" },
	];
	let parentId: string | null = null;
	for (let index = 0; index < rounds; index++) {
		const assistant = `assistant-${index}`;
		const result = `result-${index}`;
		entries.push({
			type: "message",
			id: assistant,
			parentId,
			timestamp: "2026-08-15T00:00:00Z",
			message: {
				role: "assistant",
				content: [{ type: "toolCall", id: `call-${index}`, name: "read", arguments: { path: `src/${index}.ts` } }],
				stopReason: "toolUse",
				timestamp: index,
			},
		});
		entries.push({
			type: "message",
			id: result,
			parentId: assistant,
			timestamp: "2026-08-15T00:00:00Z",
			message: {
				role: "toolResult",
				toolCallId: `call-${index}`,
				toolName: "read",
				content: [{ type: "text", text: `needle ${index}` }],
				isError: false,
				timestamp: index,
			},
		});
		parentId = result;
	}
	return `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
}

describe("Rust read-only TUI fd bridge", () => {
	it("uses the Node Host for hello, the initial page, and protocol EOF", async () => {
		run("cargo", ["build", "-p", "lystar-tui"]);
		const directory = mkdtempSync(join(tmpdir(), "lystar-rust-m7-e2e-"));
		directories.add(directory);
		const sessionPath = join(directory, "session.jsonl");
		const toRust = join(directory, "to-rust.fifo");
		const fromRust = join(directory, "from-rust.fifo");
		writeFileSync(sessionPath, sessionEntries(240));
		run("/usr/bin/mkfifo", [toRust, fromRust]);
		const incomingReader = openSync(toRust, constants.O_RDONLY | constants.O_NONBLOCK);
		const incomingWriter = openSync(toRust, constants.O_WRONLY);
		const outgoingProbe = openSync(fromRust, constants.O_RDONLY | constants.O_NONBLOCK);
		const outgoingWriter = openSync(fromRust, constants.O_WRONLY | constants.O_NONBLOCK);
		const outgoingReader = outgoingProbe;
		const input = incomingWriter;
		const socket = `lystar-m7-e2e-${process.pid}-${Date.now()}`;
		sockets.add(socket);
		const command = `exec 3<${toRust} 4>${fromRust}; exec ${join(repositoryRoot, "target/debug/lystar-tui")} --run ${sessionPath}`;
		run("tmux", ["-L", socket, "new-session", "-d", "-s", "tui", "-x", "120", "-y", "36", command]);
		closeSync(incomingReader);
		closeSync(outgoingWriter);

		const service = new GuiHostService(
			{ getAbout: () => ({ productVersion: "m7-test" }) } as unknown as RuntimeAdapter,
			{ agentDir: directory },
		);
		const requests: string[] = [];
		let initialPage: ServerMessage | undefined;
		const connection = service.createConnection(async (message: ServerMessage) => {
			if (message.type === "response" && message.ok && message.id.startsWith("initial-")) initialPage = message;
			writeAll(input, encodeServerMessage(message));
		});
		const decoder = new ClientMessageDecoder();
		const outputBuffer = Buffer.allocUnsafe(64 * 1024);
		const outputPoller = setInterval(() => {
			try {
				const bytesRead = readSync(outgoingReader, outputBuffer);
				if (bytesRead === 0) return;
				for (const message of decoder.push(outputBuffer.subarray(0, bytesRead))) {
					if (message.type === "request") requests.push(message.request.command);
					void connection.handle(message);
				}
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EAGAIN") throw error;
			}
		}, 5);

		await waitFor(
			() => requests.includes("read_transcript") && initialPage !== undefined,
			"Rust did not request the initial transcript page",
		);
		closeSync(incomingWriter);
		await waitFor(
			() => spawnSync("tmux", ["-L", socket, "has-session", "-t", "tui"]).status !== 0,
			"Rust TUI did not exit after protocol EOF",
		);
		clearInterval(outputPoller);
		closeSync(outgoingReader);
		await connection.close();
		await service.dispose();
	}, 30_000);
});
