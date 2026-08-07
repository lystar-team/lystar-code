import {
	type Component,
	type Focusable,
	getKeybindings,
	Markdown,
	type MarkdownTheme,
	truncateToWidth,
} from "@earendil-works/pi-tui";
import { parseMouseEvent } from "../mouse.ts";
import { theme } from "../theme/theme.ts";
import { keyText } from "./keybinding-hints.ts";

export class ChangelogViewerComponent implements Component, Focusable {
	private _focused = false;
	private scrollTop = 0;
	private readonly markdown: Markdown;
	private readonly getHeight: () => number;
	private readonly requestRender: () => void;
	private readonly onCancel: () => void;

	constructor(options: {
		markdown: string;
		markdownTheme: MarkdownTheme;
		getHeight: () => number;
		requestRender: () => void;
		onCancel: () => void;
	}) {
		this.markdown = new Markdown(options.markdown, 0, 0, options.markdownTheme);
		this.getHeight = options.getHeight;
		this.requestRender = options.requestRender;
		this.onCancel = options.onCancel;
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
	}

	invalidate(): void {
		this.markdown.invalidate();
	}

	render(width: number): string[] {
		const height = Math.max(4, this.getHeight() - 2);
		const bodyHeight = Math.max(1, height - 2);
		const body = this.markdown.render(width);
		const maxScroll = Math.max(0, body.length - bodyHeight);
		this.scrollTop = Math.min(this.scrollTop, maxScroll);
		const lines = [theme.bold(theme.fg("accent", "更新内容"))];
		for (const line of body.slice(this.scrollTop, this.scrollTop + bodyHeight)) {
			lines.push(truncateToWidth(line, width, "", true));
		}
		while (lines.length < height - 1) lines.push("");
		lines.push(
			truncateToWidth(
				theme.fg(
					"dim",
					`${keyText("tui.select.up")}/${keyText("tui.select.down")} 滚动 · ${keyText("tui.select.pageUp")}/${keyText("tui.select.pageDown")} 翻页 · ${keyText("tui.select.cancel")} 返回`,
				),
				width,
				"…",
			),
		);
		return lines.slice(0, height);
	}

	handleInput(data: string): void {
		const mouse = parseMouseEvent(data);
		if (mouse) {
			if (mouse.shift) return;
			if (mouse.button === "wheel-up") this.scrollTop = Math.max(0, this.scrollTop - 3);
			else if (mouse.button === "wheel-down") this.scrollTop += 3;
			this.requestRender();
			return;
		}
		const kb = getKeybindings();
		if (kb.matches(data, "tui.select.cancel")) {
			this.onCancel();
			return;
		}
		if (kb.matches(data, "tui.select.up")) this.scrollTop = Math.max(0, this.scrollTop - 1);
		else if (kb.matches(data, "tui.select.down")) this.scrollTop += 1;
		else if (kb.matches(data, "tui.select.pageUp"))
			this.scrollTop = Math.max(0, this.scrollTop - Math.max(1, this.getHeight() - 6));
		else if (kb.matches(data, "tui.select.pageDown")) this.scrollTop += Math.max(1, this.getHeight() - 6);
		this.requestRender();
	}
}
