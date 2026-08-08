import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	type Component,
	Container,
	type Focusable,
	getKeybindings,
	matchesKey,
	truncateToWidth,
} from "@earendil-works/pi-tui";
import { parseMouseEvent } from "../mouse.ts";
import { theme } from "../theme/theme.ts";
import type { CustomEditor } from "./custom-editor.ts";

export class SubagentSessionViewComponent implements Component, Focusable {
	private _focused = false;
	private readonly transcript = new Container();
	private scrollTop = 0;
	private following = true;
	private lastTranscriptHeight = 0;
	private lastMaxScroll = 0;
	private status: string;
	private readonly options: {
		agent: string;
		status: string;
		readOnly: boolean;
		editor?: CustomEditor;
		getHeight: () => number;
		requestRender: () => void;
		renderMessages: (messages: AgentMessage[]) => Component[];
		onReturn: () => void;
		onAbort: () => void;
		overlayTop?: number;
	};

	constructor(options: {
		agent: string;
		status: string;
		readOnly: boolean;
		editor?: CustomEditor;
		getHeight: () => number;
		requestRender: () => void;
		renderMessages: (messages: AgentMessage[]) => Component[];
		onReturn: () => void;
		onAbort: () => void;
		overlayTop?: number;
	}) {
		this.options = options;
		this.status = options.status;
		if (options.editor) options.editor.onEscape = options.onReturn;
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		if (this.options.editor) this.options.editor.focused = value;
	}

	setStatus(status: string): void {
		this.status = status;
		this.options.requestRender();
	}

	setMessages(messages: AgentMessage[]): void {
		this.transcript.children = this.options.renderMessages(messages);
		this.options.requestRender();
	}

	invalidate(): void {
		this.transcript.invalidate();
		this.options.editor?.invalidate();
	}

	private scrollBy(lines: number): void {
		this.scrollTop = Math.max(0, Math.min(this.lastMaxScroll, this.scrollTop + lines));
		this.following = this.scrollTop >= this.lastMaxScroll;
		this.options.requestRender();
	}

	render(width: number): string[] {
		const height = Math.max(6, this.options.getHeight() - 2);
		const header = truncateToWidth(
			`${theme.fg("accent", "← 主会话")} · ${theme.bold(theme.fg("text", this.options.agent))} · ${theme.fg("muted", this.status)}`,
			width,
			"…",
		);
		const footer = this.options.readOnly
			? [truncateToWidth(theme.fg("muted", "旧记录没有独立 Session，只能查看历史内容"), width, "…")]
			: (this.options.editor?.render(width) ?? []);
		const transcriptHeight = Math.max(1, height - footer.length - 2);
		const transcriptLines = this.transcript.render(width);
		const maxScroll = Math.max(0, transcriptLines.length - transcriptHeight);
		this.lastMaxScroll = maxScroll;
		if (this.following || this.lastTranscriptHeight !== transcriptLines.length) {
			if (this.following) this.scrollTop = maxScroll;
			this.lastTranscriptHeight = transcriptLines.length;
		}
		this.scrollTop = Math.max(0, Math.min(this.scrollTop, maxScroll));
		const body = transcriptLines.slice(this.scrollTop, this.scrollTop + transcriptHeight);
		while (body.length < transcriptHeight) body.push("");
		return [header, theme.fg("dim", "─".repeat(Math.max(1, width))), ...body, ...footer].slice(0, height);
	}

	handleInput(data: string): void {
		const mouse = parseMouseEvent(data);
		if (mouse) {
			if (mouse.shift || mouse.released) return;
			if (mouse.button === "left" && mouse.row - (this.options.overlayTop ?? 1) === 0) {
				this.options.onReturn();
				return;
			}
			if (mouse.button === "wheel-up") {
				this.scrollBy(-3);
			} else if (mouse.button === "wheel-down") {
				this.scrollBy(3);
			}
			return;
		}

		if (matchesKey(data, "ctrl+c")) {
			this.options.onAbort();
			return;
		}
		const kb = getKeybindings();
		if (kb.matches(data, "tui.select.cancel")) {
			this.options.onReturn();
			return;
		}
		if (kb.matches(data, "tui.select.pageUp") || kb.matches(data, "tui.altScreen.pageUp")) {
			this.scrollBy(-Math.max(1, this.options.getHeight() - 6));
			return;
		}
		if (kb.matches(data, "tui.select.pageDown") || kb.matches(data, "tui.altScreen.pageDown")) {
			this.scrollBy(Math.max(1, this.options.getHeight() - 6));
			return;
		}
		if (kb.matches(data, "tui.altScreen.halfPageUp")) {
			this.scrollBy(-Math.max(1, Math.floor((this.options.getHeight() - 6) / 2)));
			return;
		}
		if (kb.matches(data, "tui.altScreen.halfPageDown")) {
			this.scrollBy(Math.max(1, Math.floor((this.options.getHeight() - 6) / 2)));
			return;
		}
		if (kb.matches(data, "tui.altScreen.top")) {
			this.scrollBy(-this.lastMaxScroll);
			return;
		}
		if (kb.matches(data, "tui.altScreen.bottom")) {
			this.scrollBy(this.lastMaxScroll);
			return;
		}
		this.options.editor?.handleInput(data);
	}
}
