import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { AppKeybinding } from "../../../core/keybindings.ts";
import { theme } from "../theme/theme.ts";

export interface WorkspaceShortcutState {
	streaming: boolean;
	bashRunning: boolean;
	following: boolean;
}

export interface WorkspaceShortcutBarOptions {
	getState: () => WorkspaceShortcutState;
	getKeyText: (keybinding: AppKeybinding) => string;
}

export class WorkspaceShortcutBar implements Component {
	private readonly options: WorkspaceShortcutBarOptions;

	constructor(options: WorkspaceShortcutBarOptions) {
		this.options = options;
	}

	invalidate(): void {}

	render(width: number): string[] {
		if (width <= 0) return [];
		const state = this.options.getState();
		const items: string[] = [];
		if (!state.following) {
			items.push(this.formatKey("app.viewport.bottom", "回到底部"));
		}
		if (state.streaming || state.bashRunning) {
			items.push(this.formatKey("app.interrupt", "取消"));
		} else {
			items.push(this.formatKey("app.thinking.cycle", "思考强度"));
		}
		items.push(this.formatKey("app.tools.expand", "展开"));
		if (!state.streaming && !state.bashRunning && state.following) {
			items.push(`${theme.bold(theme.fg("text", "/"))}${theme.fg("dim", " 命令")}`);
		}

		const separator = theme.fg("dim", " │ ");
		const visible: string[] = [];
		for (const item of items) {
			const candidate = visible.length === 0 ? item : `${visible.join(separator)}${separator}${item}`;
			if (visibleWidth(candidate) > width) break;
			visible.push(item);
		}
		const line = visible.length > 0 ? visible.join(separator) : (items[0] ?? "");
		return [truncateToWidth(line, width, "")];
	}

	private formatKey(keybinding: AppKeybinding, label: string): string {
		const key = this.options.getKeyText(keybinding).replaceAll("Escape", "Esc");
		return `${theme.bold(theme.fg("text", key))}${theme.fg("dim", ` ${label}`)}`;
	}
}
