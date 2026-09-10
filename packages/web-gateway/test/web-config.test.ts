import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { WebConfigStore, webConfigPath, webGatewaySettingsPath, webGatewayTokenPath } from "../src/config.ts";

test("WebConfigStore 将完整配置写入 agentDir 根目录", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "lystar-web-config-"));
	try {
		const store = new WebConfigStore(agentDir);
		const saved = await store.save({ host: "127.0.0.1", port: 1420, password: "web-password" });
		assert.deepEqual(saved, {
			version: 1,
			host: "127.0.0.1",
			allowedHosts: ["localhost", "127.0.0.1", "::1"],
			port: 1420,
			runtimePort: 1422,
			password: "web-password",
		});
		assert.deepEqual(await store.load(), saved);
		assert.deepEqual(JSON.parse(await readFile(webConfigPath(agentDir), "utf8")), saved);
	} finally {
		await rm(agentDir, { recursive: true, force: true });
	}
});

test("WebConfigStore 不让开发配置读取正式或旧 Gateway 配置", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "lystar-web-config-isolation-"));
	try {
		await new WebConfigStore(agentDir).save({ host: "127.0.0.1", port: 1420, password: "production-password" });
		await mkdir(join(agentDir, "web"), { recursive: true });
		await writeFile(webGatewaySettingsPath(agentDir), `${JSON.stringify({ host: "0.0.0.0", port: 2422 })}\n`);
		await writeFile(webGatewayTokenPath(agentDir), "legacy-password\n");
		const devStore = new WebConfigStore(agentDir, join(agentDir, "web-dev-config.json"));
		assert.equal(await devStore.loadOrMigrate(), undefined);
		await assert.rejects(readFile(join(agentDir, "web-dev-config.json"), "utf8"), { code: "ENOENT" });
	} finally {
		await rm(agentDir, { recursive: true, force: true });
	}
});

test("WebConfigStore 将旧 Gateway 配置迁移到 web-config.json", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "lystar-web-config-migrate-"));
	try {
		await mkdir(join(agentDir, "web"), { recursive: true });
		await writeFile(webGatewaySettingsPath(agentDir), `${JSON.stringify({ host: "0.0.0.0", port: 1422 })}\n`);
		await writeFile(webGatewayTokenPath(agentDir), "legacy-password\n");
		const migrated = await new WebConfigStore(agentDir).loadOrMigrate();
		assert.deepEqual(migrated, {
			version: 1,
			host: "0.0.0.0",
			allowedHosts: ["*"],
			port: 1422,
			runtimePort: 1422,
			password: "legacy-password",
		});
		assert.deepEqual(JSON.parse(await readFile(webConfigPath(agentDir), "utf8")), migrated);
		await assert.rejects(readFile(webGatewaySettingsPath(agentDir), "utf8"), { code: "ENOENT" });
		await assert.rejects(readFile(webGatewayTokenPath(agentDir), "utf8"), { code: "ENOENT" });
	} finally {
		await rm(agentDir, { recursive: true, force: true });
	}
});

test("WebConfigStore 保存独立 Runtime 端口和白名单", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "lystar-web-config-runtime-"));
	try {
		const saved = await new WebConfigStore(agentDir).save({
			host: "0.0.0.0",
			allowedHosts: ["127.0.0.1", "192.168.1.20"],
			port: 1420,
			runtimePort: 15422,
			password: "web-password",
		});
		assert.deepEqual(saved.allowedHosts, ["127.0.0.1", "192.168.1.20"]);
		assert.equal(saved.runtimePort, 15422);
	} finally {
		await rm(agentDir, { recursive: true, force: true });
	}
});
