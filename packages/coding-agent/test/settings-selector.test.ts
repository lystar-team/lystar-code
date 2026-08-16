import { setKeybindings } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { SETTINGS_SELECTOR_PERSISTENT_IDS } from "../src/core/lystar-settings-catalog.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import {
	type SettingsCallbacks,
	type SettingsConfig,
	SettingsSelectorComponent,
} from "../src/modes/interactive/components/settings-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

function createSelector() {
	const settingsManager = SettingsManager.inMemory();
	const onSettingChange = vi.fn();
	const selector = new SettingsSelectorComponent(
		{
			settingsManager,
			autoCompact: settingsManager.getCompactionEnabled(),
			steeringMode: settingsManager.getSteeringMode(),
			followUpMode: settingsManager.getFollowUpMode(),
			currentTheme: settingsManager.getThemeSetting() ?? "dark",
			terminalTheme: "dark",
			availableThemes: ["dark", "light"],
			tuiMode: settingsManager.getTuiMode(),
			fullscreenExitOutput: settingsManager.getFullscreenExitOutput(),
			fullscreenScrollbar: settingsManager.getFullscreenScrollbar(),
		} satisfies SettingsConfig,
		{
			onSettingChange,
			onCancel: vi.fn(),
		} satisfies SettingsCallbacks,
	);
	return { settingsManager, selector, onSettingChange };
}

describe("SettingsSelectorComponent", () => {
	beforeAll(() => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
	});

	it("uses the catalog UI-visible IDs as its complete persistent leaf set", () => {
		const { selector } = createSelector();
		expect(selector.getPersistentSettingIds()).toEqual(SETTINGS_SELECTOR_PERSISTENT_IDS);
		expect(selector.getPersistentSettingIds()).not.toContain("apply");
		expect(selector.getPersistentSettingIds()).not.toContain("single-mode");
		expect(selector.getPersistentSettingIds()).not.toContain("warnings");
	});

	it("converts generic catalog choices before persisting and invoking runtime callbacks", () => {
		const { settingsManager, selector, onSettingChange } = createSelector();
		const settingsList = selector.getSettingsList();
		for (const character of "思考内容位置") settingsList.handleInput(character);
		settingsList.handleInput("\r");
		expect(settingsManager.getThinkingDisplayMode()).toBe("transcript");
		expect(onSettingChange).toHaveBeenLastCalledWith("thinking-display", "transcript");

		const {
			settingsManager: compactSettings,
			selector: compactSelector,
			onSettingChange: compactChanges,
		} = createSelector();
		const compactList = compactSelector.getSettingsList();
		for (const character of "自动压缩上下文") compactList.handleInput(character);
		compactList.handleInput("\r");
		expect(compactSettings.getCompactionEnabled()).toBe(false);
		expect(compactChanges).toHaveBeenLastCalledWith("autocompact", false);
	});
});
