import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { discoverAndLoadExtensions } from "../src/core/extensions/loader.ts";
import { type ExtensionActivityEvent, ExtensionRunner } from "../src/core/extensions/runner.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { createInMemoryModelRegistry } from "./model-runtime-test-utils.ts";

describe("ExtensionRunner Hook activity", () => {
	let tempDir: string;
	let extensionsDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-hook-activity-test-"));
		extensionsDir = join(tempDir, "extensions");
		mkdirSync(extensionsDir);
	});

	afterEach(() => rmSync(tempDir, { recursive: true, force: true }));

	async function createRunner(source: string): Promise<ExtensionRunner> {
		writeFileSync(join(extensionsDir, "activity.ts"), source);
		const loaded = await discoverAndLoadExtensions([], tempDir, tempDir);
		const modelRegistry = await createInMemoryModelRegistry(AuthStorage.inMemory());
		return new ExtensionRunner(loaded.extensions, loaded.runtime, tempDir, SessionManager.inMemory(), modelRegistry);
	}

	const settledTurn = {
		turnId: "turn-1",
		inputId: "input-1",
		origin: { type: "user" as const, channel: "interactive" as const },
		rootOrigin: "user" as const,
	};

	it("reports successful Hook invocation start and completion", async () => {
		const runner = await createRunner('export default pi => pi.on("agent_settled", async () => {});');
		const activities: ExtensionActivityEvent[] = [];
		runner.onActivity((activity) => activities.push(activity));

		await runner.emit({ type: "agent_settled", turn: settledTurn });

		expect(activities).toHaveLength(2);
		expect(activities[0]).toMatchObject({ phase: "start", hook: "agent_settled" });
		expect(activities[1]).toMatchObject({
			phase: "end",
			activityId: activities[0]?.activityId,
			status: "completed",
		});
	});

	it("reports a thrown Hook failure without changing runner error handling", async () => {
		const runner = await createRunner(
			'export default pi => pi.on("agent_settled", async () => { throw new Error("hook failed"); });',
		);
		const activities: ExtensionActivityEvent[] = [];
		runner.onActivity((activity) => activities.push(activity));

		await runner.emit({ type: "agent_settled", turn: settledTurn });

		expect(activities).toHaveLength(2);
		expect(activities[1]).toMatchObject({ phase: "end", status: "failed", error: "hook failed" });
	});
});
