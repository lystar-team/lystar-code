import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent/core";
import type { TranscriptItem } from "@lystar/code-web-protocol";
import { describe, expect, it } from "vitest";
import { EXTENSION_ACTIVITY_CUSTOM_TYPE } from "../src/extension-activity.ts";
import { CodingAgentRuntimeAdapter } from "../src/runtime-adapter.ts";
import { projectTranscriptBatch } from "../src/transcript-projection.ts";
import type { RuntimeEvent } from "../src/types.ts";

type StoredEntry = {
	type?: string;
	id?: string;
	customType?: string;
	data?: unknown;
};

describe("Extension Hook activity transcript", () => {
	it("persists lifecycle status and commits related custom entries as one activity group", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "web-hook-activity-"));
		const agentDir = join(tempDir, "agent");
		const cwd = join(tempDir, "project");
		const extensionPath = join(tempDir, "hook-activity.ts");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });
		writeFileSync(
			extensionPath,
			`export default pi => pi.on("user_bash", event => {
				if (event.command !== "record-hook-output") return;
				pi.appendEntry("hook-output", { decision: "context" });
				return { result: { output: "hook complete", exitCode: 0, cancelled: false, truncated: false } };
			});`,
		);
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ defaultProjectTrust: "always", extensions: [extensionPath] }),
		);

		let runtime: Awaited<ReturnType<CodingAgentRuntimeAdapter["createSession"]>> | undefined;
		try {
			runtime = await new CodingAgentRuntimeAdapter(agentDir).createSession(cwd, async () => ({ cancelled: true }));
			const events: RuntimeEvent[] = [];
			runtime.onEvent((event) => events.push(event));
			await expect(runtime.runBash("record-hook-output", true, () => {})).resolves.toMatchObject({
				output: "hook complete",
				exitCode: 0,
			});
			await new Promise<void>((resolve) => setImmediate(resolve));

			const entries = readFileSync(runtime.sessionPath, "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as StoredEntry);
			const activityStarts = entries.filter(
				(entry) => entry.type === "custom" && entry.customType === EXTENSION_ACTIVITY_CUSTOM_TYPE,
			);
			const start = activityStarts.find(
				(entry) => (entry.data as { phase?: string } | undefined)?.phase === "start",
			);
			const end = activityStarts.find((entry) => (entry.data as { phase?: string } | undefined)?.phase === "end");
			const output = entries.find((entry) => entry.type === "custom" && entry.customType === "hook-output");
			const endData = end?.data as { hook?: string; status?: string; relatedEntryIds?: string[] } | undefined;

			expect(start).toBeDefined();
			expect(endData).toMatchObject({ hook: "user_bash", status: "completed" });
			expect(endData?.relatedEntryIds).toContain(output?.id);

			const commits = events.flatMap((event) => {
				if (event.type !== "entry_committed") return [];
				const payload = event.payload as unknown as { items?: TranscriptItem[] };
				return [payload.items ?? []];
			});
			const groupedCommit = commits.find(
				(items) =>
					items.some((item) => item.entryId === start?.id) && items.some((item) => item.entryId === end?.id),
			);
			expect(groupedCommit).toBeDefined();
			for (const items of commits) {
				if (!items.some((item) => item.entryId === output?.id)) continue;
				expect(items.some((item) => item.entryId === start?.id)).toBe(true);
				expect(items.some((item) => item.entryId === end?.id)).toBe(true);
			}
			const projected = projectTranscriptBatch(groupedCommit ?? []);
			expect(projected).toHaveLength(1);
			expect(projected[0]?.view).toMatchObject({
				type: "extension_activity",
				hook: "user_bash",
				status: "completed",
				details: expect.stringContaining('"decision": "context"'),
			});

			const appendCustomEntry = SessionManager.prototype.appendCustomEntry;
			SessionManager.prototype.appendCustomEntry = function (customType, data) {
				if (customType === EXTENSION_ACTIVITY_CUSTOM_TYPE) throw new Error("activity marker write failed");
				return appendCustomEntry.call(this, customType, data);
			};
			try {
				await expect(runtime.runBash("record-hook-output", true, () => {})).resolves.toMatchObject({
					output: "hook complete",
					exitCode: 0,
				});
				await new Promise<void>((resolve) => setImmediate(resolve));
			} finally {
				SessionManager.prototype.appendCustomEntry = appendCustomEntry;
			}
			const persistedEntries = readFileSync(runtime.sessionPath, "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as StoredEntry);
			expect(persistedEntries.filter((entry) => entry.customType === "hook-output")).toHaveLength(2);
			expect(
				events.some((event) => {
					if (event.type !== "progress") return false;
					const payload = event.payload as unknown as { type?: unknown; error?: unknown };
					return payload.type === "extension_error" && payload.error === "activity marker write failed";
				}),
			).toBe(true);
		} finally {
			await runtime?.dispose();
			rmSync(tempDir, { recursive: true, force: true });
		}
	});
});
