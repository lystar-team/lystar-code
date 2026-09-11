import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { Server as HttpServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { WebGatewayServer } from "../src/index.ts";

const TEST_TOKEN = "branding-test-token";
const VALID_LOGO =
	"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

interface ServerInternals {
	server: HttpServer;
}

interface ErrorResponse {
	error: {
		code: string;
		message: string;
	};
}

interface ProductBrandingResponse {
	name: string;
	logo?: string;
}

async function startGateway() {
	const agentDir = await mkdtemp(join(tmpdir(), "lystar-web-branding-route-"));
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

async function postBranding(baseUrl: string, body: Record<string, unknown>, token = TEST_TOKEN): Promise<Response> {
	return fetch(`${baseUrl}/api/branding`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(body),
	});
}

test("GET /api/branding 允许未认证读取品牌", async () => {
	const { agentDir, server, baseUrl } = await startGateway();
	try {
		await writeFile(join(agentDir, "lystar.json"), JSON.stringify({ altScreen: false, mouse: true }), "utf8");
		const response = await fetch(`${baseUrl}/api/branding`);
		assert.equal(response.status, 200);
		assert.deepEqual(await readJson<ProductBrandingResponse>(response), { name: "LYStar Code" });
	} finally {
		await server.close();
		await rm(agentDir, { recursive: true, force: true });
	}
});

test("POST /api/branding 需要认证并保留其他配置", async () => {
	const { agentDir, server, baseUrl } = await startGateway();
	try {
		await writeFile(join(agentDir, "lystar.json"), JSON.stringify({ altScreen: false, mouse: true }), "utf8");
		const unauthorized = await postBranding(baseUrl, { name: "未授权" }, "wrong-token");
		assert.equal(unauthorized.status, 401);
		assert.equal((await readJson<ErrorResponse>(unauthorized)).error.code, "unauthorized");

		const response = await postBranding(baseUrl, { name: "自定义品牌", logo: VALID_LOGO });
		assert.equal(response.status, 200);
		assert.deepEqual(await readJson<ProductBrandingResponse>(response), { name: "自定义品牌", logo: VALID_LOGO });
		assert.deepEqual(JSON.parse(await readFile(join(agentDir, "lystar.json"), "utf8")), {
			altScreen: false,
			mouse: true,
			branding: { name: "自定义品牌", logo: VALID_LOGO },
		});
	} finally {
		await server.close();
		await rm(agentDir, { recursive: true, force: true });
	}
});

test("POST /api/branding 拒绝非法 Logo", async () => {
	const { agentDir, server, baseUrl } = await startGateway();
	try {
		const response = await postBranding(baseUrl, { name: "非法品牌", logo: "data:image/svg+xml;base64,AAAA" });
		assert.equal(response.status, 400);
		assert.equal((await readJson<ErrorResponse>(response)).error.code, "branding_invalid");
		assert.equal(await readFile(join(agentDir, "lystar.json"), "utf8").catch(() => undefined), undefined);
	} finally {
		await server.close();
		await rm(agentDir, { recursive: true, force: true });
	}
});

test("并发 POST /api/branding 串行写入且保持配置文件有效", async () => {
	const { agentDir, server, baseUrl } = await startGateway();
	try {
		await writeFile(join(agentDir, "lystar.json"), JSON.stringify({ altScreen: true }), "utf8");
		const names = Array.from({ length: 12 }, (_, index) => `并发品牌-${index}`);
		const responses = await Promise.all(names.map((name) => postBranding(baseUrl, { name })));
		assert.ok(responses.every((response) => response.status === 200));
		const config = JSON.parse(await readFile(join(agentDir, "lystar.json"), "utf8")) as {
			altScreen: boolean;
			branding: ProductBrandingResponse;
		};
		assert.equal(config.altScreen, true);
		assert.ok(names.includes(config.branding.name));
		const response = await fetch(`${baseUrl}/api/branding`);
		assert.equal(response.status, 200);
		assert.deepEqual(await readJson<ProductBrandingResponse>(response), config.branding);
	} finally {
		await server.close();
		await rm(agentDir, { recursive: true, force: true });
	}
});
