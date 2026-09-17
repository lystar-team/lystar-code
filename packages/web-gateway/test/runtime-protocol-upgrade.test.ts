import assert from "node:assert/strict";
import { type ChildProcessByStdio, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { RUNTIME_PROTOCOL_VERSION } from "@lystar/code-web-protocol";
import { probeIpcRuntime, stopRuntimeService } from "@lystar/code-web-runtime";
import type { WebGatewayConfig } from "../src/config.ts";
import { connectRuntimeClient } from "../src/runtime-client.ts";

type LegacyRuntimeProcess = ChildProcessByStdio<null, Readable, Readable>;
const children = new Set<LegacyRuntimeProcess>();
const tempDirs = new Set<string>();
const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const tsxImport = import.meta.resolve("tsx");
const runtimeCli = fileURLToPath(new URL("../../web-runtime/src/cli.ts", import.meta.url));
const protocolModule = fileURLToPath(new URL("../../web-protocol/src/index.ts", import.meta.url));

const legacyRuntimeScript = String.raw`
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname } from "node:path";
const { ClientMessageDecoder, encodeTrustedServerMessage } = await import(process.env.PROTOCOL_MODULE);
const endpoint = process.env.RUNTIME_ENDPOINT;
const busySession = process.env.LEGACY_BUSY_SESSION === "1";
mkdirSync(dirname(endpoint), { recursive: true, mode: 0o700 });
const server = createServer((socket) => {
  const decoder = new ClientMessageDecoder();
  socket.on("data", (bytes) => {
    for (const message of decoder.push(bytes)) {
      if (message.type === "hello") {
        if (message.version !== 2) {
          socket.write(encodeTrustedServerMessage({
            type: "hello_error",
            error: {
              code: "version",
              message: "Web Runtime Protocol " + message.version + " is unsupported; Host requires 2",
              retryable: false,
            },
          }));
          continue;
        }
        socket.write(encodeTrustedServerMessage({
          type: "hello",
          version: 2,
          protocolVersion: 2,
          productVersion: "legacy-runtime",
          serverInstanceId: "legacy-server",
          hostInstanceId: "legacy-host",
          hostStartedAt: Date.now(),
          capabilities: [],
        }));
        continue;
      }
      if (message.type === "request" && message.request.command === "get_snapshot") {
        socket.write(encodeTrustedServerMessage({
          type: "response",
          id: message.id,
          ok: true,
          result: {
            sessions: busySession
              ? [{
                  id: "busy-session",
                  path: endpoint + ".session.jsonl",
                  cwd: dirname(endpoint),
                  createdAt: Date.now(),
                  updatedAt: Date.now(),
                  phase: "turn",
                  activity: "running",
                  attached: true,
                  writeAccess: "owned",
                  revision: 1,
                  leafId: null,
                  queuedSteerCount: 0,
                  queuedFollowUpCount: 0,
                  thinkingLevel: "off",
                  transcriptGeneration: "busy-session",
                  transcriptRevision: 0,
                  toolActivityEpoch: "busy-session",
                  toolActivityRevision: 0,
                  toolActivities: [],
                }]
              : [],
            operations: [],
            pendingUiRequests: [],
          },
        }));
      }
    }
  });
});
server.listen(endpoint, () => {
  chmodSync(endpoint, 0o600);
  writeFileSync(endpoint + ".pid", String(process.pid) + "\n", { mode: 0o600 });
  process.stderr.write("ready\n");
});
`;

function waitForReady(child: LegacyRuntimeProcess): Promise<void> {
	return new Promise((resolve, reject) => {
		let stderr = "";
		const timeout = setTimeout(() => reject(new Error(`旧 Runtime 启动超时：${stderr}`)), 10_000);
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk: string) => {
			stderr += chunk;
			if (!stderr.includes("ready")) return;
			clearTimeout(timeout);
			resolve();
		});
		child.once("exit", (code, signal) => {
			clearTimeout(timeout);
			reject(new Error(`旧 Runtime 提前退出：${code ?? signal ?? "unknown"} ${stderr}`));
		});
	});
}

async function waitUntilUnreachable(endpoint: string): Promise<void> {
	const deadline = Date.now() + 5_000;
	while (Date.now() < deadline) {
		if (!(await probeIpcRuntime(endpoint)).reachable) return;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error("Runtime 未停止");
}

afterEach(async () => {
	for (const child of children) {
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
	}
	await Promise.all(
		[...children].map(
			(child) =>
				new Promise<void>((resolve) => {
					if (child.exitCode !== null || child.signalCode !== null) return resolve();
					child.once("exit", () => resolve());
				}),
		),
	);
	children.clear();
	for (const directory of tempDirs) rmSync(directory, { recursive: true, force: true });
	tempDirs.clear();
});

describe("Web Gateway Runtime 协议升级", () => {
	it("旧 Runtime 存在活跃会话时拒绝强制升级", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "web-runtime-busy-upgrade-"));
		tempDirs.add(agentDir);
		const endpoint = join(agentDir, "host.sock");
		const legacy = spawn(
			process.execPath,
			["--import", tsxImport, "--input-type=module", "--eval", legacyRuntimeScript],
			{
				cwd: repositoryRoot,
				env: {
					...process.env,
					PROTOCOL_MODULE: protocolModule,
					RUNTIME_ENDPOINT: endpoint,
					LEGACY_BUSY_SESSION: "1",
				},
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
		children.add(legacy);
		await waitForReady(legacy);
		const config: WebGatewayConfig = {
			host: "127.0.0.1",
			port: 0,
			agentDir,
			runtimeEndpoint: endpoint,
			token: "test-token",
			allowedHosts: ["127.0.0.1"],
			staticDir: agentDir,
			manageRuntime: true,
			serviceProfile: "protocol-upgrade-busy-test",
			runtimeInvocation: {
				command: process.execPath,
				args: ["--import", tsxImport, runtimeCli, "serve"],
				cwd: repositoryRoot,
			},
		};

		try {
			await assert.rejects(
				connectRuntimeClient(
					config,
					"busy-upgrade-client",
					() => {},
					() => {},
				),
				(error: Error & { code?: string; retryable?: boolean }) =>
					error.code === "version" && error.retryable === true && error.message.includes("仍有运行任务"),
			);
			assert.equal(legacy.exitCode, null);
			assert.equal(legacy.signalCode, null);
		} finally {
			await stopRuntimeService(endpoint, true, config.serviceProfile, undefined, false, agentDir);
			await waitUntilUnreachable(endpoint);
		}
	});

	it("旧 Runtime 空闲时停止旧进程并连接当前协议", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "web-runtime-upgrade-"));
		tempDirs.add(agentDir);
		const endpoint = join(agentDir, "host.sock");
		const legacy = spawn(
			process.execPath,
			["--import", tsxImport, "--input-type=module", "--eval", legacyRuntimeScript],
			{
				cwd: repositoryRoot,
				env: { ...process.env, PROTOCOL_MODULE: protocolModule, RUNTIME_ENDPOINT: endpoint },
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
		children.add(legacy);
		await waitForReady(legacy);

		const config: WebGatewayConfig = {
			host: "127.0.0.1",
			port: 0,
			agentDir,
			runtimeEndpoint: endpoint,
			token: "test-token",
			allowedHosts: ["127.0.0.1"],
			staticDir: agentDir,
			manageRuntime: true,
			serviceProfile: "protocol-upgrade-test",
			runtimeInvocation: {
				command: process.execPath,
				args: ["--import", tsxImport, runtimeCli, "serve"],
				cwd: repositoryRoot,
			},
		};

		const connected = await connectRuntimeClient(
			config,
			"upgrade-client",
			() => {},
			() => {},
		);
		try {
			assert.equal(connected.client.getSnapshot().hello?.protocolVersion, RUNTIME_PROTOCOL_VERSION);
			assert.equal(RUNTIME_PROTOCOL_VERSION, 9);
			assert.equal(legacy.exitCode === null && legacy.signalCode === null, false);
			children.delete(legacy);
		} finally {
			await connected.client.close();
			await stopRuntimeService(endpoint, true, config.serviceProfile, undefined, false, agentDir);
			await waitUntilUnreachable(endpoint);
		}
	});
});
