import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	type Component,
	Container,
	type Focusable,
	getKeybindings,
	matchesKey,
	truncateToWidth,
} from "@earendil-works/pi-tui";
import { parseMouseEvent, WheelScrollNormalizer } from "../mouse.ts";
import { theme } from "../theme/theme.ts";
import type { CustomEditor } from "./custom-editor.ts";
import { activateInteractiveCard, resolveInteractiveCardAction, visitInteractiveCards } from "./interactive-card.ts";
import type { WorkspaceComposer } from "./lystar-workspace.ts";
import type { SubagentRunTarget } from "./subagent-run.ts";

interface TranscriptComponentRange {
	component: Component;
	start: number;
	end: number;
}

export class SubagentSessionViewComponent implements Component, Focusable {
	private _focused = false;
	private readonly transcript = new Container();
	private scrollTop = 0;
	private following = true;
	private lastTranscriptHeight = 0;
	private lastMaxScroll = 0;
	private lastBodyStart = 0;
	private lastBodyHeight = 0;
	private componentRanges: TranscriptComponentRange[] = [];
	private readonly cardExpansion = new Map<string, boolean>();
	private readonly wheelScroll = new WheelScrollNormalizer();
	private pendingCardClick: { row: number; column: number; component: Component; componentRow: number } | undefined;
	private pendingLinkClick: { row: number; column: number } | undefined;
	private status: string;
	private readonly options: {
		agent: string;
		status: string;
		readOnly: boolean;
		editor?: CustomEditor;
		composer?: WorkspaceComposer;
		getHeight: () => number;
		requestRender: () => void;
		renderMessages: (messages: AgentMessage[]) => Component[];
		onOpenSubagent: (target: SubagentRunTarget) => void;
		getLinkAtScreenPosition: (row: number, column: number) => string | undefined;
		openLinkAtScreenPosition: (row: number, column: number) => boolean;
		onReturn: () => void;
		onAbort: () => void;
		overlayTop?: number;
	};

	constructor(options: {
		agent: string;
		status: string;
		readOnly: boolean;
		editor?: CustomEditor;
		composer?: WorkspaceComposer;
		getHeight: () => number;
		requestRender: () => void;
		renderMessages: (messages: AgentMessage[]) => Component[];
		onOpenSubagent: (target: SubagentRunTarget) => void;
		getLinkAtScreenPosition: (row: number, column: number) => string | undefined;
		openLinkAtScreenPosition: (row: number, column: number) => boolean;
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
		this.captureCardExpansion(this.transcript.children);
		const components = this.options.renderMessages(messages);
		visitInteractiveCards(components, (card) => {
			const key = card.getCardStateKey?.();
			if (key !== undefined && this.cardExpansion.has(key)) card.setExpanded(this.cardExpansion.get(key)!);
		});
		this.transcript.children = components;
		this.options.requestRender();
	}

	private captureCardExpansion(components: readonly Component[]): void {
		visitInteractiveCards(components, (card) => {
			const key = card.getCardStateKey?.();
			if (key !== undefined) this.cardExpansion.set(key, card.isExpanded());
		});
	}

	invalidate(): void {
		this.transcript.invalidate();
		this.options.composer?.invalidate();
		if (!this.options.composer) this.options.editor?.invalidate();
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
			: (this.options.composer?.render(width) ?? this.options.editor?.render(width) ?? []);
		const transcriptHeight = Math.max(1, height - footer.length - 2);
		const transcriptLines: string[] = [];
		this.componentRanges = [];
		for (const component of this.transcript.children) {
			const lines = component.render(width);
			if (lines.length === 0) continue;
			const start = transcriptLines.length;
			transcriptLines.push(...lines);
			this.componentRanges.push({ component, start, end: transcriptLines.length });
		}
		const maxScroll = Math.max(0, transcriptLines.length - transcriptHeight);
		this.lastMaxScroll = maxScroll;
		if (this.following || this.lastTranscriptHeight !== transcriptLines.length) {
			if (this.following) this.scrollTop = maxScroll;
			this.lastTranscriptHeight = transcriptLines.length;
		}
		this.scrollTop = Math.max(0, Math.min(this.scrollTop, maxScroll));
		const body = transcriptLines.slice(this.scrollTop, this.scrollTop + transcriptHeight);
		while (body.length < transcriptHeight) body.push("");
		this.lastBodyStart = (this.options.overlayTop ?? 1) + 2;
		this.lastBodyHeight = transcriptHeight;
		return [header, theme.fg("dim", "─".repeat(Math.max(1, width))), ...body, ...footer].slice(0, height);
	}

	handleInput(data: string): void {
		const mouse = parseMouseEvent(data);
		if (mouse) {
			if (mouse.shift) {
				this.pendingCardClick = undefined;
				this.pendingLinkClick = undefined;
				return;
			}
			if (mouse.button === "left" && mouse.motion) {
				this.pendingCardClick = undefined;
				this.pendingLinkClick = undefined;
				return;
			}
			if (mouse.button === "left" && mouse.released) {
				const pendingLink = this.pendingLinkClick;
				const pendingCard = this.pendingCardClick;
				this.pendingLinkClick = undefined;
				this.pendingCardClick = undefined;
				if (pendingLink && pendingLink.row === mouse.row && pendingLink.column === mouse.column) {
					this.options.openLinkAtScreenPosition(mouse.row, mouse.column);
					return;
				}
				if (pendingCard && pendingCard.row === mouse.row && pendingCard.column === mouse.column) {
					const action = activateInteractiveCard(
						pendingCard.component,
						pendingCard.componentRow,
						this.options.onOpenSubagent,
					);
					if (action?.type === "toggle") {
						const key = action.component.getCardStateKey?.();
						if (key !== undefined) this.cardExpansion.set(key, action.component.isExpanded());
						this.options.requestRender();
					}
				}
				return;
			}
			if (mouse.button === "left" && mouse.row - (this.options.overlayTop ?? 1) === 0) {
				this.options.onReturn();
				return;
			}
			if (mouse.button === "left" && this.options.getLinkAtScreenPosition(mouse.row, mouse.column)) {
				this.pendingLinkClick = { row: mouse.row, column: mouse.column };
				return;
			}
			if (
				mouse.button === "left" &&
				mouse.row >= this.lastBodyStart &&
				mouse.row < this.lastBodyStart + this.lastBodyHeight
			) {
				const transcriptRow = this.scrollTop + mouse.row - this.lastBodyStart;
				const range = this.componentRanges.find(
					(componentRange) => transcriptRow >= componentRange.start && transcriptRow < componentRange.end,
				);
				const componentRow = range ? transcriptRow - range.start : -1;
				if (range && resolveInteractiveCardAction(range.component, componentRow)) {
					this.pendingCardClick = {
						row: mouse.row,
						column: mouse.column,
						component: range.component,
						componentRow,
					};
				}
				return;
			}
			if (mouse.button === "wheel-up" || mouse.button === "wheel-down") {
				this.pendingCardClick = undefined;
				this.pendingLinkClick = undefined;
				this.scrollBy(this.wheelScroll.getDelta(mouse.button === "wheel-up" ? -1 : 1));
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
