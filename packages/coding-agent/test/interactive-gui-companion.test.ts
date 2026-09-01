import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

const guiCompanionMock = vi.hoisted(() => ({
	instances: [] as unknown[],
	startError: undefined as Error | undefined,
}));

vi.mock("../src/core/gui-companion.ts", () => ({
	GuiCompanionServer: class {
		constructor() {
			guiCompanionMock.instances.push(this);
		}

		async start(): Promise<void> {
			if (guiCompanionMock.startError) throw guiCompanionMock.startError;
		}

		async dispose(): Promise<void> {}
	},
}));

function createMode(sessionPath: string, showWarning: (message: string) => void): InteractiveMode {
	const sessionManager = { getSessionFile: () => sessionPath };
	const session = { sessionFile: sessionPath, sessionManager } as unknown as AgentSession;
	return Object.assign(Object.create(InteractiveMode.prototype), {
		runtimeHost: { session },
		guiCompanion: undefined,
		guiCompanionSessionPath: undefined,
		isShuttingDown: false,
		showWarning,
	}) as InteractiveMode;
}

function ensureGuiCompanion(mode: InteractiveMode): Promise<boolean> {
	return (
		InteractiveMode.prototype as unknown as {
			ensureGuiCompanion(this: InteractiveMode): Promise<boolean>;
		}
	).ensureGuiCompanion.call(mode);
}

beforeEach(() => {
	guiCompanionMock.instances.length = 0;
	guiCompanionMock.startError = undefined;
});

describe("InteractiveMode GUI companion coordination", () => {
	it("coalesces concurrent startup requests", async () => {
		const directory = mkdtempSync(join(tmpdir(), "lystar-gui-coordination-"));
		const sessionPath = join(directory, "session.jsonl");
		writeFileSync(sessionPath, "{}\n");
		const warnings: string[] = [];
		const mode = createMode(sessionPath, (message) => warnings.push(message));

		try {
			const results = await Promise.all([ensureGuiCompanion(mode), ensureGuiCompanion(mode)]);

			expect(results).toEqual([true, true]);
			expect(guiCompanionMock.instances).toHaveLength(1);
			expect(warnings).toEqual([]);
			expect((mode as unknown as { guiCompanion?: unknown }).guiCompanion).toBe(guiCompanionMock.instances[0]);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("deduplicates repeated active-owner warnings", async () => {
		const directory = mkdtempSync(join(tmpdir(), "lystar-gui-coordination-"));
		const sessionPath = join(directory, "session.jsonl");
		writeFileSync(sessionPath, "{}\n");
		const warnings: string[] = [];
		const mode = createMode(sessionPath, (message) => warnings.push(message));
		guiCompanionMock.startError = new Error("GUI companion is already running at endpoint");

		try {
			expect(await ensureGuiCompanion(mode)).toBe(false);
			expect(await ensureGuiCompanion(mode)).toBe(false);
			expect(guiCompanionMock.instances).toHaveLength(1);
			expect(warnings).toEqual(["GUI 共享通道启动失败：GUI companion is already running at endpoint"]);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
