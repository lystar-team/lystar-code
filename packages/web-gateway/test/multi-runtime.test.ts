import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { WebConfigStore } from "../src/config.ts";
import { runWebComponentAction } from "../src/gateway-service.ts";
import { scopedRuntimeClientId } from "../src/server.ts";

const tempDirs = new Set<string>();

afterEach(async () => {
	await Promise.all([...tempDirs].map((directory) => rm(directory, { recursive: true, force: true })));
	tempDirs.clear();
});

describe("Release 与 development Runtime 隔离", () => {
	it("按 Gateway Profile 隔离同一浏览器的 Runtime 客户端身份", () => {
		const browserClientId = "shared-browser-client";
		const releaseId = scopedRuntimeClientId(undefined, browserClientId);
		const explicitReleaseId = scopedRuntimeClientId("default", browserClientId);
		const developmentId = scopedRuntimeClientId("development", browserClientId);

		assert.equal(releaseId, explicitReleaseId);
		assert.notEqual(releaseId, developmentId);
		assert.match(releaseId, /^[a-f0-9]{64}$/u);
	});

	it("development 生命周期指向独立 Runtime Profile", async () => {
		const agentDir = await mkdtemp(join(tmpdir(), "lystar-development-runtime-"));
		tempDirs.add(agentDir);
		await new WebConfigStore(agentDir, join(agentDir, "web-dev-config.json")).save({
			host: "127.0.0.1",
			port: 25420,
			runtimePort: 25423,
			password: "development-password",
		});
		const invocation = { command: process.execPath, args: [], cwd: agentDir };

		const status = await runWebComponentAction({
			component: "runtime",
			action: "status",
			agentDir,
			configFileName: "web-dev-config.json",
			defaultPort: 2422,
			defaultRuntimePort: 2423,
			gatewayInvocation: invocation,
			runtimeInvocation: invocation,
		});

		assert.equal(status.kind, "runtime");
		assert.equal(status.profile, "development");
		assert.equal("endpoint" in status ? status.endpoint : undefined, "tcp://127.0.0.1:25423");
	});
});
