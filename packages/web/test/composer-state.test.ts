import { describe, expect, it } from "vitest";
import { composerStateEqual } from "../src/components/workbench/composer.tsx";
import type { WorkbenchState } from "../src/state/use-workbench.ts";

function composerState(): WorkbenchState {
	return {
		composerMode: "prompt",
		connected: true,
		currentProjectId: "project-1",
		hiddenModelProviders: [],
		liveTools: {},
		liveTurnActive: true,
		models: [],
		providers: [],
		queuedUserPrompts: [],
		readOnly: false,
		session: { id: "session-1" },
		sessionId: "session-1",
		sessionReady: true,
	} as WorkbenchState;
}

describe("composer render state", () => {
	it("运行态字段变化时不会复用旧停止按钮", () => {
		const current = composerState();
		expect(composerStateEqual(current, { ...current, liveTurnActive: false })).toBe(false);
		expect(
			composerStateEqual(current, {
				...current,
				liveTools: {
					tool: {
						id: "tool",
						name: "bash",
						batchId: "batch",
						summary: "pwd",
						state: "running",
						status: "running",
					},
				},
			}),
		).toBe(false);
		expect(
			composerStateEqual(current, {
				...current,
				liveCompaction: { status: "running", summaryCountAtStart: 0 },
			}),
		).toBe(false);
	});
});
