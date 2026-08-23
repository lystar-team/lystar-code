import { type Component, Markdown, sliceByColumn, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { extractAnsiCode } from "../../../utils/ansi.ts";
import { getMarkdownTheme, theme } from "../theme/theme.ts";
import { uiGlyphs } from "../ui-glyphs.ts";

export type WorkspaceActivityPhase =
	| "thinking"
	| "runningTool"
	| "waiting"
	| "retrying"
	| "compacting"
	| "summarizing"
	| "cancelled";

export interface WorkspaceActivityState {
	phase: WorkspaceActivityPhase;
	action?: string;
	subject?: string;
	startedAt: number;
	completedTools: number;
	knownTools: number;
	queueCount: number;
	runningTools?: number;
	thinking?: string;
}

function formatDuration(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	return `${Math.floor(seconds / 60)}m${seconds % 60}s`;
}

function phaseLabel(state: WorkspaceActivityState): string {
	switch (state.phase) {
		case "thinking":
			return state.thinking || "正在思考";
		case "runningTool":
			if ((state.runningTools ?? 0) > 1) return `${state.runningTools} 个操作并行`;
			return [state.action, state.subject].filter(Boolean).join(" ") || "正在执行";
		case "waiting":
			return "等待下一步";
		case "retrying":
			return state.action || "正在重试";
		case "compacting":
			return "正在压缩上下文";
		case "summarizing":
			return "正在生成摘要";
		case "cancelled":
			return "正在取消";
	}
}

function truncateFromStart(text: string, width: number, ellipsis = "…"): string {
	if (visibleWidth(text) <= width) return text;
	if (width <= 1) return truncateToWidth(ellipsis, width, "");
	return `${ellipsis}${sliceByColumn(text, visibleWidth(text) - width + 1, width - 1, true)}`;
}

const ACTIVITY_REFRESH_MS = 1000;
const SHIMMER_REFRESH_MS = 100;
const SHIMMER_CYCLE_MS = 2000;
const SHIMMER_BAND_HALF_WIDTH = 6;
const SHIMMER_EDGE_PADDING = SHIMMER_BAND_HALF_WIDTH;
const SHIMMER_MIN_INTENSITY = 0.12;
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

interface AnsiStyleState {
	foreground: string;
	bold: boolean;
}

function updateAnsiStyleState(code: string, state: AnsiStyleState): void {
	const match = /^\x1b\[([0-9;]*)m$/.exec(code);
	if (!match) return;

	const params = match[1] === "" ? [0] : match[1].split(";").map(Number);
	for (let index = 0; index < params.length; index++) {
		const parameter = params[index];
		if (parameter === 0) {
			state.foreground = "\x1b[39m";
			state.bold = false;
		} else if (parameter === 1) {
			state.bold = true;
		} else if (parameter === 22) {
			state.bold = false;
		} else if (parameter === 39) {
			state.foreground = "\x1b[39m";
		} else if ((parameter >= 30 && parameter <= 37) || (parameter >= 90 && parameter <= 97)) {
			state.foreground = `\x1b[${parameter}m`;
		} else if (parameter === 38) {
			const mode = params[index + 1];
			if (mode === 5 && params[index + 2] !== undefined) {
				state.foreground = `\x1b[38;5;${params[index + 2]}m`;
				index += 2;
			} else if (
				mode === 2 &&
				params[index + 2] !== undefined &&
				params[index + 3] !== undefined &&
				params[index + 4] !== undefined
			) {
				state.foreground = `\x1b[38;2;${params[index + 2]};${params[index + 3]};${params[index + 4]}m`;
				index += 4;
			}
		}
	}
}

export class WorkspaceActivityBar implements Component {
	private state: WorkspaceActivityState | undefined;
	private timer: ReturnType<typeof setInterval> | undefined;
	private timerIntervalMs: number | undefined;
	private shimmerStartedAt: number | undefined;
	private readonly requestRender: () => void;
	private readonly isMotionReduced: () => boolean;
	private readonly inlineMarkdown = new Markdown("", 0, 0, getMarkdownTheme(), {
		color: (text) => theme.fg("text", text),
	});

	constructor(requestRender: () => void, isMotionReduced: () => boolean = () => false) {
		this.requestRender = requestRender;
		this.isMotionReduced = isMotionReduced;
	}

	setState(state: WorkspaceActivityState | undefined): void {
		const wasThinking = this.isThinkingState(this.state);
		this.state = state;
		const isThinking = this.isThinkingState(state);
		if (isThinking && !wasThinking) {
			this.shimmerStartedAt = Date.now();
		} else if (!isThinking) {
			this.shimmerStartedAt = undefined;
		}
		this.syncTimer();
	}

	dispose(): void {
		this.clearTimer();
		this.state = undefined;
		this.shimmerStartedAt = undefined;
	}

	invalidate(): void {}

	private readonly onTimer = (): void => {
		this.syncTimer();
		this.requestRender();
	};

	private isThinkingState(state: WorkspaceActivityState | undefined): boolean {
		return state?.phase === "thinking" && Boolean(state.thinking);
	}

	private isShimmerActive(state: WorkspaceActivityState | undefined): boolean {
		return this.isThinkingState(state) && !this.isMotionReduced();
	}

	private syncTimer(): void {
		const intervalMs =
			!this.state || this.state.phase === "waiting"
				? undefined
				: this.isShimmerActive(this.state)
					? SHIMMER_REFRESH_MS
					: ACTIVITY_REFRESH_MS;
		if (intervalMs === this.timerIntervalMs) return;

		this.clearTimer();
		this.timerIntervalMs = intervalMs;
		if (intervalMs !== undefined) {
			this.timer = setInterval(this.onTimer, intervalMs);
		}
	}

	private clearTimer(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
		this.timerIntervalMs = undefined;
	}

	/** 在已渲染的 ANSI 文本上叠加分级扫光，保留 Markdown 原有前景色和样式。 */
	private renderThinkingShimmer(text: string): string {
		const textWidth = visibleWidth(text);
		if (textWidth === 0) return text;

		const startedAt = this.shimmerStartedAt ?? Date.now();
		const elapsed = Math.max(0, Date.now() - startedAt);
		const travelWidth = textWidth + SHIMMER_EDGE_PADDING * 2;
		const centerColumn = ((elapsed % SHIMMER_CYCLE_MS) / SHIMMER_CYCLE_MS) * travelWidth;
		return this.applyShimmerStyles(text, centerColumn);
	}

	private applyShimmerStyles(text: string, centerColumn: number): string {
		const backgroundAnsi = theme.getBgAnsi("searchMatchBg");
		const accentAnsi = theme.getFgAnsi("accent");
		const style = { foreground: "\x1b[39m", bold: false } satisfies AnsiStyleState;
		let result = "";
		let currentColumn = 0;
		let position = 0;

		while (position < text.length) {
			const ansi = extractAnsiCode(text, position);
			if (ansi) {
				result += ansi.code;
				updateAnsiStyleState(ansi.code, style);
				position += ansi.length;
				continue;
			}

			let textEnd = position;
			while (textEnd < text.length && !extractAnsiCode(text, textEnd)) textEnd++;
			for (const { segment } of graphemeSegmenter.segment(text.slice(position, textEnd))) {
				const segmentWidth = visibleWidth(segment);
				const segmentCenter = currentColumn + segmentWidth / 2;
				const distance = Math.abs(segmentCenter - centerColumn);
				const normalizedDistance = distance / SHIMMER_BAND_HALF_WIDTH;
				const intensity =
					segmentWidth > 0 && normalizedDistance < 1 ? 0.5 * (1 + Math.cos(Math.PI * normalizedDistance)) : 0;

				if (intensity >= SHIMMER_MIN_INTENSITY) {
					const addBold = intensity >= 0.55 && !style.bold;
					const addAccent = intensity >= 0.78;
					result += backgroundAnsi;
					if (addBold) result += "\x1b[1m";
					if (addAccent) result += accentAnsi;
					result += segment;
					if (addAccent) result += style.foreground;
					if (addBold) result += "\x1b[22m";
					result += "\x1b[49m";
				} else {
					result += segment;
				}
				currentColumn += segmentWidth;
			}
			position = textEnd;
		}

		return result;
	}

	render(width: number): string[] {
		if (!this.state || width <= 0 || this.state.phase === "waiting") return [];
		const state = this.state;
		const prefixGlyph = state.phase === "runningTool" ? uiGlyphs.running : uiGlyphs.list;
		const prefix = theme.bold(theme.fg(state.phase === "cancelled" ? "warning" : "accent", prefixGlyph));
		const labelText = phaseLabel(state);
		const labelColor = state.phase === "retrying" || state.phase === "cancelled" ? "warning" : "text";
		const progress =
			state.knownTools > 0
				? theme.fg("muted", `已完成 ${Math.min(state.completedTools, state.knownTools)}/${state.knownTools}`)
				: undefined;
		const queue = state.queueCount > 0 ? theme.fg("muted", `队列 ${state.queueCount}`) : undefined;
		const elapsed = theme.fg("dim", formatDuration(Date.now() - state.startedAt));
		const separator = theme.fg("dim", "  ·  ");
		const fullSuffix = [progress, queue, elapsed].filter((part): part is string => Boolean(part)).join(separator);
		const suffix = width - visibleWidth(fullSuffix) >= 16 ? fullSuffix : elapsed;
		const renderMain = (maxWidth: number): string => {
			const prefixText = `${prefix} `;
			if (maxWidth <= visibleWidth(prefixText)) return truncateToWidth(prefix, maxWidth, "");
			const labelWidth = Math.max(1, maxWidth - visibleWidth(prefixText));
			if (state.phase === "thinking" && state.thinking) {
				const label = this.inlineMarkdown.renderInline(labelText);
				const truncatedLabel = truncateFromStart(label, labelWidth, theme.fg("text", "…"));
				const renderedLabel = this.isShimmerActive(state)
					? this.renderThinkingShimmer(truncatedLabel)
					: truncatedLabel;
				return `${prefixText}${renderedLabel}`;
			}
			return `${prefixText}${theme.fg(labelColor, truncateToWidth(labelText, labelWidth, "…"))}`;
		};
		if (!suffix || visibleWidth(suffix) + 2 >= width) return [renderMain(width)];
		const main = renderMain(Math.max(1, width - visibleWidth(suffix) - 1));
		const gap = " ".repeat(Math.max(1, width - visibleWidth(main) - visibleWidth(suffix)));
		return [`${main}${gap}${suffix}`];
	}
}
