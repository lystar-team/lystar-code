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

test("Web Gateway 默认端口固定为 1422", () => {
	assert.equal(DEFAULT_WEB_GATEWAY_PORT, 1422);
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
