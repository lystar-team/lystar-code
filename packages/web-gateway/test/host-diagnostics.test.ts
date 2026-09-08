import assert from "node:assert/strict";
import { test } from "node:test";
import {
	calculateCpuUsage,
	diskUsage,
	hostCpu,
	hostMemory,
	hostNetworkAddresses,
	readCpuSnapshot,
} from "../src/host-diagnostics.ts";

test("CPU 采样可以计算使用率并限制在 0 到 100", () => {
	assert.equal(calculateCpuUsage({ idle: 20, total: 100 }, { idle: 40, total: 200 }), 80);
	assert.equal(calculateCpuUsage(undefined, { idle: 40, total: 200 }), undefined);
	assert.equal(calculateCpuUsage({ idle: 50, total: 100 }, { idle: 40, total: 90 }), undefined);
});

test("主机诊断可以读取 CPU、内存和网络信息", () => {
	const snapshot = readCpuSnapshot();
	const memory = hostMemory();
	const cpu = hostCpu(12.3);
	assert.ok(snapshot.total > 0);
	assert.ok(memory.totalBytes > 0);
	assert.equal(memory.totalBytes, memory.freeBytes + memory.usedBytes);
	assert.equal(cpu.usagePercent, 12.3);
	assert.ok(cpu.cores > 0);
	assert.ok(Array.isArray(hostNetworkAddresses()));
});

test("磁盘诊断返回指定路径的容量信息", async () => {
	const disk = await diskUsage(process.cwd());
	assert.equal(disk.path, process.cwd());
	assert.equal(disk.available, true);
	assert.ok((disk.totalBytes ?? 0) > 0);
	assert.ok((disk.freeBytes ?? 0) >= 0);
});
