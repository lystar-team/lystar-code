import { visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it } from "vitest";
import type { AppKeybinding } from "../src/core/keybindings.ts";
import {
	WorkspaceShortcutBar,
	type WorkspaceShortcutState,
} from "../src/modes/interactive/components/workspace-shortcut-bar.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const keys: Partial<Record<AppKeybinding, string>> = {
	"app.interrupt": "Escape",
	"app.thinking.cycle": "Shift+Tab",
	"app.tools.expand": "Ctrl+O",
	"app.viewport.bottom": "End",
};

function createBar(state: WorkspaceShortcutState): WorkspaceShortcutBar {
	return new WorkspaceShortcutBar({
		getState: () => state,
		getKeyText: (keybinding) => keys[keybinding] ?? keybinding,
	});
}

describe("WorkspaceShortcutBar", () => {
	beforeAll(() => initTheme("dark"));

	it("shows idle actions without an inactive cancel hint", () => {
		const line = stripAnsi(createBar({ streaming: false, bashRunning: false, following: true }).render(100)[0]);

		expect(line).toContain("Shift+Tab 思考强度");
		expect(line).toContain("Ctrl+O 展开");
		expect(line).toContain("/ 命令");
		expect(line).not.toContain("取消");
	});

	it("prioritizes cancel while the agent is running", () => {
		const line = stripAnsi(createBar({ streaming: true, bashRunning: false, following: true }).render(100)[0]);

		expect(line).toContain("Esc 取消");
		expect(line).toContain("Ctrl+O 展开");
		expect(line).not.toContain("思考强度");
	});

	it("keeps the return-to-bottom action first and never wraps", () => {
		const line = createBar({ streaming: true, bashRunning: false, following: false }).render(18)[0];

		expect(stripAnsi(line)).toContain("End 回到底部");
		expect(visibleWidth(line)).toBeLessThanOrEqual(18);
		expect(line).not.toContain("\n");
	});
});
