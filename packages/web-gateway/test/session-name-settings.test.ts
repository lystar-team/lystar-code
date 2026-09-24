import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { Server as HttpServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { WebGatewayServer } from "../src/index.ts";

const TEST_TOKEN = "session-name-settings-test-token";

interface ServerInternals {
	server: HttpServer;
}

interface ErrorResponse {
	error: {
		code: string;
		message: string;
	};
}

interface SessionNameSettingsResponse {
	model?: string;
	thinkingLevel: string;
}

async function startGateway() {
	const agentDir = await mkdtemp(join(tmpdir(), "lystar-web-session-name-settings-"));
	const server = new WebGatewayServer({
		host: "127.0.0.1",
		port: 0,
		agentDir,
		runtimeEndpoint: join(agentDir, "runtime.sock"),
		token: TEST_TOKEN,
		allowedHosts: ["127.0.0.1"],
		staticDir: agentDir,
		manageRuntime: false,
	});
	await server.listen();
	const address = (server as unknown as ServerInternals).server.address();
	if (!address || typeof address === "string") throw new Error("Gateway 测试服务没有绑定 TCP 端口");
	return { agentDir, server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function readJson<T>(response: Response): Promise<T> {
	return JSON.parse(await response.text()) as T;
}

async function getSettings(baseUrl: string, token = TEST_TOKEN): Promise<Response> {
	return fetch(`${baseUrl}/api/session-name-settings`, {
		headers: { Authorization: `Bearer ${token}` },
	});
}

async function saveSettings(baseUrl: string, body: Record<string, unknown>, token = TEST_TOKEN): Promise<Response> {
	return fetch(`${baseUrl}/api/session-name-settings`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(body),
	});
}

test("session name settings require authentication and preserve unrelated LYStar config", async () => {
	const { agentDir, server, baseUrl } = await startGateway();
	try {
		const path = join(agentDir, "lystar.json");
		await writeFile(path, JSON.stringify({ altScreen: false, branding: { name: "LYStar Code" } }), "utf8");

		const unauthorized = await getSettings(baseUrl, "wrong-token");
		assert.equal(unauthorized.status, 401);
		assert.equal((await readJson<ErrorResponse>(unauthorized)).error.code, "unauthorized");

		const initial = await getSettings(baseUrl);
		assert.equal(initial.status, 200);
		assert.deepEqual(await readJson<SessionNameSettingsResponse>(initial), { thinkingLevel: "low" });

		const saved = await saveSettings(baseUrl, {
			model: "upstream/gpt-5.6-luna",
			thinkingLevel: "medium",
		});
		assert.equal(saved.status, 200);
		assert.deepEqual(await readJson<SessionNameSettingsResponse>(saved), {
			model: "upstream/gpt-5.6-luna",
			thinkingLevel: "medium",
		});
		assert.deepEqual(JSON.parse(await readFile(path, "utf8")), {
			altScreen: false,
			branding: { name: "LYStar Code" },
			sessionName: { model: "upstream/gpt-5.6-luna", thinkingLevel: "medium" },
		});

		const followCurrentModel = await saveSettings(baseUrl, { thinkingLevel: "off" });
		assert.equal(followCurrentModel.status, 200);
		assert.deepEqual(await readJson<SessionNameSettingsResponse>(followCurrentModel), { thinkingLevel: "off" });
		assert.deepEqual(JSON.parse(await readFile(path, "utf8")), {
			altScreen: false,
			branding: { name: "LYStar Code" },
			sessionName: { thinkingLevel: "off" },
		});
	} finally {
		await server.close();
		await rm(agentDir, { recursive: true, force: true });
	}
});

test("session name settings reject unknown thinking levels", async () => {
	const { agentDir, server, baseUrl } = await startGateway();
	try {
		const response = await saveSettings(baseUrl, { thinkingLevel: "unknown" });
		assert.equal(response.status, 400);
		assert.equal((await readJson<ErrorResponse>(response)).error.code, "session_name_settings_invalid");
		await assert.rejects(readFile(join(agentDir, "lystar.json"), "utf8"), { code: "ENOENT" });
	} finally {
		await server.close();
		await rm(agentDir, { recursive: true, force: true });
	}
});
