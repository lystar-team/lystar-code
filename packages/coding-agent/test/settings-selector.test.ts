import { setKeybindings } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import {
	type SettingsCallbacks,
	type SettingsConfig,
	SettingsSelectorComponent,
} from "../src/modes/interactive/components/settings-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

describe("SettingsSelectorComponent", () => {
	beforeAll(() => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
	});

	it("cycles through fullscreen settings", () => {
		const onExitOutputChange = vi.fn();
		const onScrollbarChange = vi.fn();
		const config = {
			fullscreenExitOutput: "transcript",
			fullscreenScrollbar: "auto",
			warnings: {},
			availableThinkingLevels: [],
			availableThemes: [],
		} as unknown as SettingsConfig;
		const callbacks = {
			onFullscreenExitOutputChange: onExitOutputChange,
			onFullscreenScrollbarChange: onScrollbarChange,
		} as unknown as SettingsCallbacks;

		const cycle = (label: string, count: number) => {
			const list = new SettingsSelectorComponent(config, callbacks).getSettingsList();
			for (const character of label) list.handleInput(character);
			for (let i = 0; i < count; i++) list.handleInput("\r");
		};

		cycle("全屏退出输出", 2);
		expect(onExitOutputChange.mock.calls.flat()).toEqual(["resume-hint", "transcript"]);
		cycle("全屏滚动条", 3);
		expect(onScrollbarChange.mock.calls.flat()).toEqual(["always", "hidden", "auto"]);
	});

	it("cycles through thinking display locations", () => {
		const onChange = vi.fn();
		const selector = new SettingsSelectorComponent(
			{
				thinkingDisplayMode: "activity",
				warnings: {},
				availableThinkingLevels: [],
				availableThemes: [],
			} as unknown as SettingsConfig,
			{ onThinkingDisplayModeChange: onChange } as unknown as SettingsCallbacks,
		);
		const settingsList = selector.getSettingsList();

		for (const character of "思考内容位置") settingsList.handleInput(character);
		settingsList.handleInput("\r");
		settingsList.handleInput("\r");

		expect(onChange.mock.calls.flat()).toEqual(["transcript", "activity"]);
	});
});
