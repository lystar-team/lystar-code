import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";
import { loadWebGatewaySettings, WebGatewayServer, webConfigPath, webGatewayTokenPath } from "../src/index.ts";

interface RouteInternals {
	handleApi(request: IncomingMessage, response: ServerResponse, url: URL, context: never): Promise<void>;
}

function captureResponse(): {
	response: ServerResponse;
	getStatus: () => number;
	getBody: () => string;
} {
	let status = 0;
	let body = "";
	const response = Object.assign(new EventEmitter(), {
		writeHead(code: number) {
			status = code;
		},
		end(value?: string) {
			body = value ?? "";
			response.emit("finish");
		},
	});
	return {
		response: response as unknown as ServerResponse,
		getStatus: () => status,
		getBody: () => body,
	};
}

test("Web 安全设置保存后重启 Gateway，Runtime 会话保持运行", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "lystar-web-security-settings-"));
	const server = new WebGatewayServer({
		host: "127.0.0.1",
		port: 1422,
		agentDir,
		runtimeEndpoint: join(agentDir, "host.sock"),
		token: "current-web-token",
		tokenPath: webGatewayTokenPath(agentDir),
		allowedHosts: ["127.0.0.1"],
		staticDir: agentDir,
		manageRuntime: true,
	});
	let restartCount = 0;
	server.setRestartHandler(() => {
		restartCount += 1;
	});

	try {
		const routes = server as unknown as RouteInternals;
		const request = Readable.from([
			Buffer.from(
				JSON.stringify({
					host: "192.168.2.35",
					allowedHosts: ["127.0.0.1", "192.168.2.35"],
					port: 15432,
					runtimePort: 15433,
					password: "new-web-password",
				}),
			),
		]) as unknown as IncomingMessage;
		request.method = "POST";
		request.headers = {};
		const capture = captureResponse();

		await routes.handleApi(
			request,
			capture.response,
			new URL("http://127.0.0.1/api/security-settings"),
			undefined as never,
		);

		assert.equal(capture.getStatus(), 202);
		assert.deepEqual(JSON.parse(capture.getBody()), {
			host: "192.168.2.35",
			allowedHosts: ["127.0.0.1", "192.168.2.35"],
			port: 15432,
			runtimePort: 15433,
			passwordConfigured: true,
			editable: { host: true, allowedHosts: true, port: true, runtimePort: true, password: true },
			accepted: true,
			passwordChanged: true,
			restartPending: true,
			runtimePreserved: true,
		});
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.equal(restartCount, 1);
		assert.deepEqual(await loadWebGatewaySettings(agentDir), { host: "192.168.2.35", port: 15432 });
		assert.deepEqual(JSON.parse(await readFile(webConfigPath(agentDir), "utf8")), {
			version: 1,
			host: "192.168.2.35",
			allowedHosts: ["127.0.0.1", "192.168.2.35"],
			port: 15432,
			runtimePort: 15433,
			password: "new-web-password",
		});
	} finally {
		await server.close();
		await rm(agentDir, { recursive: true, force: true });
	}
});
