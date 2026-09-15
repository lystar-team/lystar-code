import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ProductUpdateController, productUpdateProgressFromLog } from "../src/product-update.ts";

async function createInstalledLayout(root: string): Promise<void> {
	const executable = join(root, "current", "lc");
	await mkdir(join(root, "current"), { recursive: true });
	await writeFile(executable, "#!/usr/bin/env bash\n", { mode: 0o700 });
}

test("安装器日志映射为更新阶段和进度", () => {
	assert.deepEqual(productUpdateProgressFromLog("[2/6] 下载并校验发行包"), {
		stage: "downloading",
		progress: 34,
		message: "正在下载更新",
	});
	assert.deepEqual(productUpdateProgressFromLog("正在把 Web Gateway 和 Web Runtime 服务切换到 1.0.0"), {
		stage: "restarting",
		progress: 94,
		message: "正在重启 Web 服务",
	});
});

test("macOS Web 更新在管理员静默通道缺失时不可启动", async (t) => {
	const root = join(tmpdir(), `lystar-product-update-macos-auth-${process.pid}-${Date.now()}`);
	t.after(() => rm(root, { recursive: true, force: true }));
	const installRoot = join(root, "install");
	await createInstalledLayout(installRoot);
	const originalPlatform = process.platform;
	Object.defineProperty(process, "platform", { configurable: true, value: "darwin" });
	try {
		const controller = new ProductUpdateController(join(root, "agent"), { installRoot, development: false });
		const availability = await controller.availability("lystar-team/lystar-code");
		assert.equal(availability.enabled, false);
		assert.match(availability.reason, /lc web service install/u);
	} finally {
		Object.defineProperty(process, "platform", { configurable: true, value: originalPlatform });
	}
});

test("更新任务保留进度并在 Runtime 切换版本后完成", async (t) => {
	const root = join(tmpdir(), `lystar-product-update-${process.pid}-${Date.now()}`);
	await mkdir(root, { recursive: true });
	t.after(() => rm(root, { recursive: true, force: true }));
	const installRoot = join(root, "install");
	const agentDir = join(root, "agent");
	await createInstalledLayout(installRoot);
	let now = 100;
	let spawnedEnv: NodeJS.ProcessEnv | undefined;
	const completion = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(() => {});
	const controller = new ProductUpdateController(agentDir, {
		installRoot,
		development: false,
		now: () => now++,
		isProcessAlive: () => true,
		spawnUpdate: async (_executable, _args, options) => {
			spawnedEnv = options.env;
			return { pid: 321, completion };
		},
	});

	const started = await controller.start("0.85.1-lystar.6", "0.85.2-lystar.1");
	assert.equal(started.status, "running");
	assert.equal(started.pid, 321);
	assert.equal(spawnedEnv?.LYSTAR_WEB_SERVICE_TARGET_VERSION, "0.85.2-lystar.1");
	assert.equal(spawnedEnv?.LYSTAR_WEB_PREVIOUS_SERVICE_VERSION, "0.85.1-lystar.6");
	assert.equal(spawnedEnv?.LYSTAR_WEB_SERVICE_VERSION, undefined);
	await writeFile(join(agentDir, "web", "product-update.log"), "[3/6] 解压并检查发行包\n");
	const running = await controller.status("0.85.1-lystar.6");
	assert.equal(running?.stage, "verifying");
	assert.equal(running?.progress, 54);

	const completed = await controller.status("0.85.2-lystar.1");
	assert.equal(completed?.status, "completed");
	assert.equal(completed?.progress, 100);
});

test("更新进程退出但版本未切换时记录失败", async (t) => {
	const root = join(tmpdir(), `lystar-product-update-failed-${process.pid}-${Date.now()}`);
	t.after(() => rm(root, { recursive: true, force: true }));
	const installRoot = join(root, "install");
	const agentDir = join(root, "agent");
	await createInstalledLayout(installRoot);
	const completion = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(() => {});
	const controller = new ProductUpdateController(agentDir, {
		installRoot,
		development: false,
		isProcessAlive: () => false,
		spawnUpdate: async () => ({ pid: 654, completion }),
	});

	await controller.start("0.85.1-lystar.6", "0.85.2-lystar.1");
	await writeFile(join(agentDir, "web", "product-update.log"), "下载失败：HTTP 503\nError: bash 退出码：1\n");
	const failed = await controller.status("0.85.1-lystar.6");
	assert.equal(failed?.status, "failed");
	assert.equal(failed?.message, "下载失败：HTTP 503");
});
