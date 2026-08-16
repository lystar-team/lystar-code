import type { ScrollViewScrollbar } from "@earendil-works/pi-tui";
import {
	type Component,
	Container,
	Input,
	type SelectItem,
	SelectList,
	type SelectListLayoutOptions,
	type SettingItem,
	SettingsList,
	Spacer,
	Text,
} from "@earendil-works/pi-tui";
import {
	getLystarSetting,
	getLystarSettingsForUi,
	type LystarSettingDefinition,
	type LystarSettingValue,
} from "../../../core/lystar-settings-catalog.ts";
import type { SettingsManager } from "../../../core/settings-manager.ts";
import {
	getSelectListTheme,
	getSettingsListTheme,
	parseAutoThemeSetting,
	type TerminalTheme,
	theme,
} from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";

const SETTINGS_SUBMENU_SELECT_LIST_LAYOUT: SelectListLayoutOptions = {
	minPrimaryColumnWidth: 12,
	maxPrimaryColumnWidth: 32,
};

const WARNING_SETTING_IDS = new Set(["anthropic-extra-usage"]);

export interface SettingsConfig {
	settingsManager: SettingsManager;
	autoCompact: boolean;
	steeringMode: "all" | "one-at-a-time";
	followUpMode: "all" | "one-at-a-time";
	currentTheme: string;
	terminalTheme: TerminalTheme;
	availableThemes: string[];
	tuiMode: "regular" | "fullscreen";
	fullscreenExitOutput: "transcript" | "resume-hint";
	fullscreenScrollbar: ScrollViewScrollbar;
}

export interface SettingsCallbacks {
	onSettingChange: (id: string, value: LystarSettingValue) => void;
	onBeforeSettingChange?: (id: string, value: LystarSettingValue) => boolean;
	onThemePreview?: (theme: string) => void;
	onCancel: () => void;
}

class SelectSubmenu extends Container {
	private selectList: SelectList;

	constructor(
		title: string,
		description: string,
		options: SelectItem[],
		currentValue: string,
		onSelect: (value: string) => void,
		onCancel: () => void,
		onSelectionChange?: (value: string) => void,
	) {
		super();
		this.addChild(new Text(theme.bold(theme.fg("accent", title)), 0, 0));
		if (description) {
			this.addChild(new Spacer(1));
			this.addChild(new Text(theme.fg("muted", description), 0, 0));
		}
		this.addChild(new Spacer(1));
		this.selectList = new SelectList(
			options,
			Math.min(options.length, 10),
			getSelectListTheme(),
			SETTINGS_SUBMENU_SELECT_LIST_LAYOUT,
		);
		const currentIndex = options.findIndex((option) => option.value === currentValue);
		if (currentIndex !== -1) this.selectList.setSelectedIndex(currentIndex);
		this.selectList.onSelect = (item) => onSelect(item.value);
		this.selectList.onCancel = onCancel;
		if (onSelectionChange) this.selectList.onSelectionChange = (item) => onSelectionChange(item.value);
		this.addChild(this.selectList);
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("dim", "  Enter 选择 · Esc 返回"), 0, 0));
	}

	handleInput(data: string): void {
		this.selectList.handleInput(data);
	}
}

class ValueInputSubmenu implements Component {
	private readonly input: Input;
	private readonly setting: LystarSettingDefinition;
	private readonly onSelect: (value: LystarSettingValue) => boolean;
	private error?: string;

	constructor(
		setting: LystarSettingDefinition,
		currentValue: LystarSettingValue,
		onSelect: (value: LystarSettingValue) => boolean,
		onCancel: () => void,
	) {
		this.setting = setting;
		this.onSelect = onSelect;
		this.input = new Input("值：");
		this.input.setValue(String(currentValue));
		this.input.onEscape = onCancel;
		this.input.onSubmit = (raw) => {
			try {
				const value = parseInputValue(this.setting, raw);
				if (this.onSelect(value)) return;
				this.error = "当前状态不允许修改该设置";
			} catch (error) {
				this.error = error instanceof Error ? error.message : String(error);
			}
		};
	}

	render(width: number): string[] {
		const lines = [
			theme.bold(theme.fg("accent", this.setting.label)),
			"",
			theme.fg("muted", this.setting.description),
			...(this.setting.range
				? [theme.fg("muted", `允许范围：${this.setting.range.min} - ${this.setting.range.max}`)]
				: []),
			"",
			...this.input.render(width),
		];
		if (this.error) lines.push(theme.fg("error", this.error));
		lines.push("", theme.fg("dim", "  Enter 保存 · Esc 返回"));
		return lines;
	}

	invalidate(): void {}

	handleInput(data: string): void {
		this.input.handleInput(data);
	}
}

function parseInputValue(setting: LystarSettingDefinition, raw: string): LystarSettingValue {
	if (setting.kind === "integer") {
		if (!/^(?:0|[1-9]\d*)$/.test(raw)) throw new Error("请输入非负整数");
		const value = Number(raw);
		if (!Number.isSafeInteger(value)) throw new Error("整数超出安全范围");
		return value;
	}
	return raw;
}

function serializeValue(value: LystarSettingValue): string {
	return String(value);
}

function parseChoiceValue(setting: LystarSettingDefinition, value: string): LystarSettingValue {
	if (setting.kind === "boolean") return value === "true";
	if (setting.kind === "integer") return Number(value);
	return value;
}

function themeItems(availableThemes: string[]): SelectItem[] {
	return availableThemes.map((name) => ({ value: name, label: name }));
}

const AUTOMATIC_THEME_VALUE = "/";

function singleModeThemeItems(availableThemes: string[]): SelectItem[] {
	return [
		{ value: AUTOMATIC_THEME_VALUE, label: "自动", description: "根据终端浅色或深色外观切换主题" },
		...themeItems(availableThemes),
	];
}

function preferredTheme(availableThemes: string[], preferred: string | undefined, fallback: string): string {
	if (preferred && availableThemes.includes(preferred)) return preferred;
	if (availableThemes.includes(fallback)) return fallback;
	return availableThemes[0] ?? fallback;
}

function defaultAutomaticThemes(
	currentThemeSetting: string,
	availableThemes: string[],
): { lightTheme: string; darkTheme: string } {
	const autoTheme = parseAutoThemeSetting(currentThemeSetting);
	if (autoTheme) return autoTheme;
	const fixedTheme = currentThemeSetting.includes("/") ? undefined : currentThemeSetting;
	const themeName = preferredTheme(availableThemes, fixedTheme, "dark");
	return { lightTheme: themeName, darkTheme: themeName };
}

class ThemeSubmenu extends Container {
	private inputComponent: Component | undefined;
	private readonly currentThemeSetting: string;
	private readonly terminalTheme: TerminalTheme;
	private readonly availableThemes: string[];
	private readonly onPreview: (theme: string) => void;
	private readonly onDone: (selectedValue?: string) => void;
	private mode: "single" | "automatic";
	private singleTheme: string;
	private lightTheme: string;
	private darkTheme: string;

	constructor(
		currentThemeSetting: string,
		terminalTheme: TerminalTheme,
		availableThemes: string[],
		onPreview: (theme: string) => void,
		onDone: (selectedValue?: string) => void,
	) {
		super();
		this.currentThemeSetting = currentThemeSetting;
		this.terminalTheme = terminalTheme;
		this.availableThemes = availableThemes;
		this.onPreview = onPreview;
		this.onDone = onDone;
		const autoTheme = parseAutoThemeSetting(currentThemeSetting);
		const automaticThemes = defaultAutomaticThemes(currentThemeSetting, availableThemes);
		const fixedTheme = autoTheme || currentThemeSetting.includes("/") ? undefined : currentThemeSetting;
		this.mode = autoTheme ? "automatic" : "single";
		this.lightTheme = automaticThemes.lightTheme;
		this.darkTheme = automaticThemes.darkTheme;
		this.singleTheme = preferredTheme(
			availableThemes,
			fixedTheme ?? (autoTheme ? this.getActiveAutomaticTheme() : undefined),
			"dark",
		);
		if (this.mode === "automatic") this.showAutomaticMenu();
		else this.showSingleMenu();
	}

	handleInput(data: string): void {
		this.inputComponent?.handleInput?.(data);
	}

	private setContent(component: Component, inputComponent: Component = component): void {
		this.clear();
		this.addChild(component);
		this.inputComponent = inputComponent;
	}

	private showSingleMenu(): void {
		this.mode = "single";
		this.setContent(
			new SelectSubmenu(
				"主题",
				"选择主题，或使用“自动”跟随终端外观。",
				singleModeThemeItems(this.availableThemes),
				this.singleTheme,
				(value) => {
					if (value === AUTOMATIC_THEME_VALUE) {
						this.mode = "automatic";
						this.onPreview(this.getThemeSetting());
						this.showAutomaticMenu();
						return;
					}
					this.singleTheme = value;
					this.onDone(value);
				},
				() => this.cancel(),
				(value) => this.onPreview(value === AUTOMATIC_THEME_VALUE ? this.getAutomaticThemeSetting() : value),
			),
		);
	}

	private showAutomaticMenu(): void {
		this.mode = "automatic";
		const content = new Container();
		content.addChild(new Text(theme.bold(theme.fg("accent", "自动主题")), 0, 0));
		content.addChild(new Spacer(1));
		content.addChild(new Text(theme.fg("muted", "分别选择终端浅色和深色外观使用的主题。"), 0, 0));
		content.addChild(new Spacer(1));
		const items: SettingItem[] = [
			{
				id: "light-theme",
				label: "浅色主题",
				description: "终端为浅色外观时使用的主题",
				currentValue: this.lightTheme,
				submenu: (currentValue, done) =>
					this.createThemeSelect("浅色主题", currentValue, done, (value) => {
						this.lightTheme = value;
						this.onPreview(this.getThemeSetting());
						done(value);
					}),
			},
			{
				id: "dark-theme",
				label: "深色主题",
				description: "终端为深色外观时使用的主题",
				currentValue: this.darkTheme,
				submenu: (currentValue, done) =>
					this.createThemeSelect("深色主题", currentValue, done, (value) => {
						this.darkTheme = value;
						this.onPreview(this.getThemeSetting());
						done(value);
					}),
			},
			{
				id: "apply",
				label: "应用",
				description: "保存主题设置并返回",
				currentValue: "保存并返回",
				values: ["保存并返回"],
			},
			{
				id: "single-mode",
				label: "主题模式",
				description: "切换为固定主题",
				currentValue: "使用固定主题",
				values: ["使用固定主题"],
			},
		];
		const settingsList = new SettingsList(
			items,
			Math.min(items.length, 10),
			getSettingsListTheme(),
			(id) => {
				if (id === "single-mode") {
					this.mode = "single";
					this.singleTheme = this.getActiveAutomaticTheme();
					this.onPreview(this.singleTheme);
					this.showSingleMenu();
				} else if (id === "apply") {
					this.onDone(this.getAutomaticThemeSetting());
				}
			},
			() => this.cancel(),
		);
		content.addChild(settingsList);
		this.setContent(content, settingsList);
	}

	private createThemeSelect(
		title: string,
		currentValue: string,
		done: (selectedValue?: string) => void,
		onSelect: (value: string) => void,
	): SelectSubmenu {
		return new SelectSubmenu(
			title,
			"选择主题",
			themeItems(this.availableThemes),
			currentValue,
			onSelect,
			() => {
				this.onPreview(this.getThemeSetting());
				done();
			},
			(value) => this.onPreview(value),
		);
	}

	private getThemeSetting(): string {
		return this.mode === "automatic" ? this.getAutomaticThemeSetting() : this.singleTheme;
	}

	private getActiveAutomaticTheme(): string {
		return this.terminalTheme === "light" ? this.lightTheme : this.darkTheme;
	}

	private getAutomaticThemeSetting(): string {
		return `${this.lightTheme}/${this.darkTheme}`;
	}

	private cancel(): void {
		this.onPreview(this.currentThemeSetting);
		this.onDone();
	}
}

export class SettingsSelectorComponent extends Container {
	private readonly settingsList: SettingsList;
	private readonly values = new Map<string, LystarSettingValue>();
	private readonly config: SettingsConfig;
	private readonly callbacks: SettingsCallbacks;

	constructor(config: SettingsConfig, callbacks: SettingsCallbacks) {
		super();
		this.config = config;
		this.callbacks = callbacks;
		for (const setting of getLystarSettingsForUi()) this.values.set(setting.id, setting.get(config.settingsManager));
		this.values.set("autocompact", config.autoCompact);
		this.values.set("steering-mode", config.steeringMode);
		this.values.set("follow-up-mode", config.followUpMode);
		this.values.set("theme", config.currentTheme);
		this.values.set("tui-mode", config.tuiMode);
		this.values.set("fullscreen-exit-output", config.fullscreenExitOutput);
		this.values.set("fullscreen-scrollbar", config.fullscreenScrollbar);

		const items = this.createItems();
		this.addChild(new DynamicBorder());
		this.settingsList = new SettingsList(
			items,
			10,
			getSettingsListTheme(),
			(id, rawValue) => this.changeSetting(id, rawValue),
			callbacks.onCancel,
			{ enableSearch: true },
		);
		this.addChild(this.settingsList);
		this.addChild(new DynamicBorder());
	}

	getSettingsList(): SettingsList {
		return this.settingsList;
	}

	getPersistentSettingIds(): string[] {
		return getLystarSettingsForUi().map((setting) => setting.id);
	}

	private createItems(): SettingItem[] {
		const items: SettingItem[] = [];
		for (const setting of getLystarSettingsForUi()) {
			if (WARNING_SETTING_IDS.has(setting.id)) continue;
			items.push(this.createItem(setting));
		}
		const warnings = [...WARNING_SETTING_IDS]
			.map((id) => getLystarSetting(id))
			.filter((setting): setting is LystarSettingDefinition => setting !== undefined);
		if (warnings.length > 0) {
			items.splice(2, 0, {
				id: "warnings",
				label: "警告设置",
				description: "配置运行时警告。",
				currentValue: "",
				submenu: (_currentValue, done) => this.createWarningsSubmenu(warnings, () => done()),
			});
		}
		return items;
	}

	private createItem(setting: LystarSettingDefinition): SettingItem {
		const currentValue = this.currentValue(setting);
		if (setting.id === "theme") {
			return {
				id: setting.id,
				label: setting.label,
				description: setting.description,
				currentValue: serializeValue(currentValue),
				formatValue: (value) => value,
				submenu: (value, done) =>
					new ThemeSubmenu(
						value,
						this.config.terminalTheme,
						this.config.availableThemes,
						(themeName) => this.callbacks.onThemePreview?.(themeName),
						(nextValue) => {
							if (nextValue !== undefined && this.commit(setting, nextValue)) done(nextValue);
							else done();
						},
					),
			};
		}
		if (setting.kind === "integer" || setting.kind === "string") {
			return {
				id: setting.id,
				label: setting.label,
				description: setting.description,
				currentValue: serializeValue(currentValue),
				formatValue: (value) => setting.format(parseInputValue(setting, value)),
				submenu: (_value, done) =>
					new ValueInputSubmenu(
						setting,
						this.currentValue(setting),
						(value) => {
							if (!this.commit(setting, value)) return false;
							done(serializeValue(value));
							return true;
						},
						() => done(),
					),
			};
		}
		return {
			id: setting.id,
			label: setting.label,
			description: setting.description,
			currentValue: serializeValue(currentValue),
			values: (setting.options ?? []).map(serializeValue),
			formatValue: (value) => setting.format(parseChoiceValue(setting, value)),
		};
	}

	private createWarningsSubmenu(settings: readonly LystarSettingDefinition[], onCancel: () => void): Component {
		const items = settings.map((setting) => ({
			id: setting.id,
			label: setting.label,
			description: setting.description,
			currentValue: serializeValue(this.currentValue(setting)),
			values: (setting.options ?? []).map(serializeValue),
			formatValue: (value: string) => setting.format(parseChoiceValue(setting, value)),
		}));
		return new SettingsList(
			items,
			Math.min(items.length, 10),
			getSettingsListTheme(),
			(id, value) => this.changeSetting(id, value),
			onCancel,
		);
	}

	private changeSetting(id: string, rawValue: string): void {
		const setting = getLystarSetting(id);
		if (!setting) return;
		const value = parseChoiceValue(setting, rawValue);
		if (this.commit(setting, value)) return;
		this.settingsList.updateValue(id, serializeValue(this.currentValue(setting)));
	}

	private currentValue(setting: LystarSettingDefinition): LystarSettingValue {
		return this.values.get(setting.id) ?? setting.get(this.config.settingsManager);
	}

	private commit(setting: LystarSettingDefinition, value: LystarSettingValue): boolean {
		if (this.callbacks.onBeforeSettingChange?.(setting.id, value) === false) return false;
		setting.set(this.config.settingsManager, value);
		this.values.set(setting.id, value);
		this.callbacks.onSettingChange(setting.id, value);
		return true;
	}
}
