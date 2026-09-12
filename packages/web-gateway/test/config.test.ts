import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	DEFAULT_RUNTIME_HOST,
	DEFAULT_RUNTIME_PORT,
	DEFAULT_WEB_GATEWAY_PORT,
	hostMatches,
	loadWebGatewayConfig,
	WebConfigStore,
} from "../src/config.ts";

test("源码 Web Gateway 默认端口固定为 2422", () => {
	assert.equal(DEFAULT_WEB_GATEWAY_PORT, 2422);
});

test("源码 Gateway 使用独立 development Runtime", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "lystar-web-dev-config-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const previousRuntimePort = process.env.PI_WEB_RUNTIME_PORT;
	const previousRuntimeEndpoint = process.env.PI_WEB_RUNTIME_ENDPOINT;
	try {
		const production = await new WebConfigStore(agentDir).save({
			host: "127.0.0.1",
			port: 1420,
			runtimePort: 15222,
			password: "production-password",
		});
		process.env.PI_CODING_AGENT_DIR = agentDir;
		process.env.PI_WEB_RUNTIME_PORT = "25243";
		process.env.PI_WEB_RUNTIME_ENDPOINT = join(agentDir, "ignored-development.sock");
		const config = await loadWebGatewayConfig({
			defaultPort: 2422,
			defaultRuntimePort: 2423,
			configFileName: "web-dev-config.json",
			runtimeInvocation: { command: process.execPath, args: ["web-runtime", "serve"], cwd: agentDir },
		});
		assert.equal(config.port, 2422);
		assert.equal(config.serviceProfile, "development");
		assert.equal(config.runtimePort, 25243);
		assert.equal(config.runtimeEndpoint, `tcp://${DEFAULT_RUNTIME_HOST}:25243`);
		assert.equal(config.manageRuntime, true);

		const overridden = await loadWebGatewayConfig({
			defaultPort: 2422,
			defaultRuntimePort: 2423,
			configFileName: "web-dev-config.json",
			runtimeInvocation: { command: process.execPath, args: ["web-runtime", "serve"], cwd: agentDir },
			allowRuntimeEndpointOverride: true,
		});
		assert.equal(overridden.runtimeEndpoint, join(agentDir, "ignored-development.sock"));
		assert.equal(config.configPath, join(agentDir, "web-dev-config.json"));
		assert.notEqual(config.token, production.password);
		assert.deepEqual(await new WebConfigStore(agentDir).load(), production);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		if (previousRuntimePort === undefined) delete process.env.PI_WEB_RUNTIME_PORT;
		else process.env.PI_WEB_RUNTIME_PORT = previousRuntimePort;
		if (previousRuntimeEndpoint === undefined) delete process.env.PI_WEB_RUNTIME_ENDPOINT;
		else process.env.PI_WEB_RUNTIME_ENDPOINT = previousRuntimeEndpoint;
		await rm(agentDir, { recursive: true, force: true });
	}
});

test("Web Gateway Host 白名单支持通配符 *", () => {
	assert.equal(hostMatches("127.0.0.1", ["*"]), true);
	assert.equal(hostMatches("192.168.2.35", ["*"]), true);
	assert.equal(hostMatches("yean-debian-pc", ["*"]), true);
});

test("bundled Gateway 忽略 Socket 覆盖并使用配置中的 Runtime TCP 端口", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "lystar-web-runtime-config-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const previousEndpoint = process.env.PI_WEB_RUNTIME_ENDPOINT;
	try {
		await new WebConfigStore(agentDir).save({
			host: "0.0.0.0",
			allowedHosts: ["*"],
			port: 15420,
			runtimePort: 15422,
			password: "web-password",
		});
		process.env.PI_CODING_AGENT_DIR = agentDir;
		process.env.PI_WEB_RUNTIME_ENDPOINT = join(agentDir, "host.sock");
		const config = await loadWebGatewayConfig({
			runtimeInvocation: { command: process.execPath, args: ["web-runtime", "serve"], cwd: agentDir },
		});
		assert.equal(config.runtimePort, 15422);
		assert.equal(config.serviceProfile, undefined);
		assert.equal(config.runtimeEndpoint, `tcp://${DEFAULT_RUNTIME_HOST}:15422`);
		assert.equal(DEFAULT_RUNTIME_PORT, 1422);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		if (previousEndpoint === undefined) delete process.env.PI_WEB_RUNTIME_ENDPOINT;
		else process.env.PI_WEB_RUNTIME_ENDPOINT = previousEndpoint;
		await rm(agentDir, { recursive: true, force: true });
	}
});
