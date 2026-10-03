import assert from "node:assert/strict";
import { test } from "node:test";
import { calculateCpuUsage } from "../src/host-diagnostics.ts";

test("CPU 采样可以计算使用率并限制在 0 到 100", () => {
	assert.equal(calculateCpuUsage({ idle: 20, total: 100 }, { idle: 40, total: 200 }), 80);
	assert.equal(calculateCpuUsage(undefined, { idle: 40, total: 200 }), undefined);
	assert.equal(calculateCpuUsage({ idle: 50, total: 100 }, { idle: 40, total: 90 }), undefined);
});
