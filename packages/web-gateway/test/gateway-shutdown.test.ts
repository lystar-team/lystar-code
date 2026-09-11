import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import type { Server } from "node:http";
import { type AddressInfo, connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { WebGatewayServer } from "../src/server.ts";

test(
	"Gateway restart completes its response and releases a port held by an incomplete HTTP request",
	{ timeout: 5_000 },
	async () => {
		const agentDir = await mkdtemp(join(tmpdir(), "lystar-gateway-shutdown-"));
		const config = {
			host: "127.0.0.1",
			port: 0,
			agentDir,
			runtimeEndpoint: join(agentDir, "runtime.sock"),
			token: "test-password",
			allowedHosts: ["127.0.0.1"],
			staticDir: agentDir,
			manageRuntime: false,
		};
		const gateway = new WebGatewayServer(config);
		let replacement: WebGatewayServer | undefined;
		let pending: Socket | undefined;
		try {
			await gateway.listen();
			const server = (gateway as unknown as { server: Server }).server;
			const port = (server.address() as AddressInfo).port;
			const restarted = new Promise<void>((resolve, reject) => {
				gateway.setRestartHandler(() => {
					const closing = gateway.close();
					assert.equal(gateway.close(), closing);
					void closing
						.then(async () => {
							replacement = new WebGatewayServer({ ...config, port });
							await replacement.listen();
						})
						.then(resolve, reject);
				});
			});
			pending = connect({ host: config.host, port });
			pending.on("error", () => {});
			await once(pending, "connect");
			pending.write(
				`POST /api/security-settings HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer test-password\r\nContent-Length: 100\r\n\r\n{`,
			);
			await new Promise((resolve) => setTimeout(resolve, 20));
			const response = await fetch(`http://127.0.0.1:${port}/api/diagnostics/actions`, {
				method: "POST",
				headers: { Authorization: "Bearer test-password", "Content-Type": "application/json" },
				body: JSON.stringify({ action: "restart-gateway" }),
				signal: AbortSignal.timeout(2_000),
			});
			assert.equal(response.status, 202);
			assert.deepEqual(await response.json(), { accepted: true, service: "gateway" });
			await restarted;
			const check = await fetch(`http://127.0.0.1:${port}/missing.js`, { signal: AbortSignal.timeout(1_000) });
			assert.equal(check.status, 404);
			await check.text();
		} finally {
			pending?.destroy();
			await replacement?.close();
			await gateway.close();
			await rm(agentDir, { recursive: true, force: true });
		}
	},
);
