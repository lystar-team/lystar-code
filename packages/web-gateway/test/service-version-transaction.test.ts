import assert from "node:assert/strict";
import { test } from "node:test";
import { runServiceVersionTransaction } from "../src/service-version-transaction.ts";

test("服务版本事务在目标服务健康后提交目标版本", async () => {
	const applied: Array<string | undefined> = [];
	let committed: string | undefined;

	await runServiceVersionTransaction({
		targetVersion: "0.85.2-lystar.1",
		previousVersion: "0.85.1-lystar.1",
		apply: async (version) => {
			applied.push(version);
		},
		commit: (version) => {
			committed = version;
		},
	});

	assert.deepEqual(applied, ["0.85.2-lystar.1"]);
	assert.equal(committed, "0.85.2-lystar.1");
});

test("目标服务失败时只恢复服务版本", async () => {
	const applied: Array<string | undefined> = [];
	let committed: string | undefined;

	const result = await runServiceVersionTransaction({
		targetVersion: "0.85.2-lystar.1",
		previousVersion: "0.85.1-lystar.1",
		apply: async (version) => {
			applied.push(version);
			if (version === "0.85.2-lystar.1") throw new Error("target failed");
		},
		commit: (version) => {
			committed = version;
		},
	});

	assert.deepEqual(result, {
		serviceVersion: "0.85.1-lystar.1",
		recovered: {
			targetVersion: "0.85.2-lystar.1",
			serviceVersion: "0.85.1-lystar.1",
			reason: "target failed",
		},
	});
	assert.deepEqual(applied, ["0.85.2-lystar.1", "0.85.1-lystar.1"]);
	assert.equal(committed, "0.85.1-lystar.1");
});

test("Runtime 忙碌时不重装旧版本或提交服务状态", async () => {
	const applied: Array<string | undefined> = [];
	await assert.rejects(
		runServiceVersionTransaction({
			targetVersion: "0.85.1-lystar.5",
			previousVersion: "0.85.1-lystar.1",
			apply: async (version) => {
				applied.push(version);
				throw Object.assign(new Error("busy"), { code: "host_busy" });
			},
			commit: () => {
				assert.fail("busy Runtime must not commit");
			},
		}),
		{ code: "host_busy" },
	);
	assert.deepEqual(applied, ["0.85.1-lystar.5"]);
});

test("目标服务和恢复服务均失败时保留两个错误", async () => {
	await assert.rejects(
		runServiceVersionTransaction({
			targetVersion: "0.85.2-lystar.1",
			previousVersion: "0.85.1-lystar.1",
			apply: async (version) => {
				throw new Error(`${version} failed`);
			},
			commit: () => {},
		}),
		(error: unknown) =>
			error instanceof Error &&
			(error as Error & { code?: string }).code === "web_service_recovery_failed" &&
			error.message.includes("0.85.2-lystar.1 failed") &&
			error.message.includes("0.85.1-lystar.1 failed"),
	);
});
