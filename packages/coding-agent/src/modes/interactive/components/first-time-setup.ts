import { Container, getKeybindings, Spacer, Text } from "@earendil-works/pi-tui";
import { t } from "../../../locales/zh-CN.ts";
import { type TerminalTheme, theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { keyHint, rawKeyHint } from "./keybinding-hints.ts";

export interface FirstTimeSetupResult {
	theme: TerminalTheme;
	shareAnalytics: boolean;
}

export interface FirstTimeSetupOptions {
	detectedTheme: TerminalTheme;
	onThemePreview: (themeName: TerminalTheme) => void;
	onSubmit: (result: FirstTimeSetupResult) => void;
	onCancel: () => void;
}

const THEME_OPTIONS: Array<{ value: TerminalTheme; label: string }> = [
	{ value: "dark", label: t("setup.dark") },
	{ value: "light", label: t("setup.light") },
];

const SETUP_LOGO_LINES = ["██████", "██  ██", "████  ██", "██    ██"];

/** First-time setup dialog for selecting the terminal theme. */
export class FirstTimeSetupComponent extends Container {
	private themeIndex: number;
	private readonly options: FirstTimeSetupOptions;

	constructor(options: FirstTimeSetupOptions) {
		super();
		this.options = options;
		this.themeIndex = Math.max(
			0,
			THEME_OPTIONS.findIndex((option) => option.value === options.detectedTheme),
		);
		this.update();
	}

	private update(): void {
		this.clear();
		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("accent", SETUP_LOGO_LINES.join("\n")), 1, 0));
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("accent", theme.bold(t("setup.welcome"))), 1, 0));
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("text", t("setup.pickTheme")), 1, 0));
		this.addChild(new Text(theme.fg("muted", t("setup.detectedTheme", { theme: this.options.detectedTheme })), 1, 0));
		this.addChild(new Spacer(1));
		this.addOptionList();
		this.addChild(new Spacer(1));
		this.addChild(
			new Text(
				rawKeyHint("↑↓", t("setup.navigate")) +
					"  " +
					keyHint("tui.select.confirm", t("setup.continue")) +
					"  " +
					keyHint("tui.select.cancel", t("setup.skip")),
				1,
				0,
			),
		);
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());
	}

	private addOptionList(): void {
		for (let i = 0; i < THEME_OPTIONS.length; i++) {
			const isSelected = i === this.themeIndex;
			const prefix = isSelected ? theme.fg("accent", "→ ") : "  ";
			const label = isSelected
				? theme.fg("accent", THEME_OPTIONS[i].label)
				: theme.fg("text", THEME_OPTIONS[i].label);
			this.addChild(new Text(`${prefix}${label}`, 1, 0));
		}
	}

	private moveSelection(delta: number): void {
		const next = Math.max(0, Math.min(THEME_OPTIONS.length - 1, this.themeIndex + delta));
		if (next !== this.themeIndex) {
			this.themeIndex = next;
			this.options.onThemePreview(THEME_OPTIONS[this.themeIndex].value);
		}
		this.update();
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		if (kb.matches(keyData, "tui.select.up") || keyData === "k") {
			this.moveSelection(-1);
		} else if (kb.matches(keyData, "tui.select.down") || keyData === "j") {
			this.moveSelection(1);
		} else if (kb.matches(keyData, "tui.select.confirm") || keyData === "\n") {
			this.options.onSubmit({ theme: THEME_OPTIONS[this.themeIndex].value, shareAnalytics: false });
		} else if (kb.matches(keyData, "tui.select.cancel")) {
			this.options.onCancel();
		}
	}
}
