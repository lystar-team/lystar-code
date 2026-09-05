import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { GatewayAlreadyRunningError, GatewayInstanceLock } from "../src/instance-lock.ts";

test("Web Gateway 同一 Agent 目录只允许一个实例持有锁", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "lystar-web-gateway-lock-"));
	let first: GatewayInstanceLock | undefined;
	let second: GatewayInstanceLock | undefined;
	try {
		first = await GatewayInstanceLock.acquire(agentDir);
		await assert.rejects(
			() => GatewayInstanceLock.acquire(agentDir),
			(error: unknown) => error instanceof GatewayAlreadyRunningError && error.pid === process.pid,
		);

		await first.release();
		second = await GatewayInstanceLock.acquire(agentDir);
	} finally {
		await second?.release();
		await first?.release();
		await rm(agentDir, { recursive: true, force: true });
	}
});
