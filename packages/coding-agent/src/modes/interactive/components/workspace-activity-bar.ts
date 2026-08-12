import { type Component, Markdown, sliceByColumn, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
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

export class WorkspaceActivityBar implements Component {
	private state: WorkspaceActivityState | undefined;
	private timer: ReturnType<typeof setInterval> | undefined;
	private readonly requestRender: () => void;
	private readonly inlineMarkdown = new Markdown("", 0, 0, getMarkdownTheme(), {
		color: (text) => theme.fg("text", text),
	});

	constructor(requestRender: () => void) {
		this.requestRender = requestRender;
	}

	setState(state: WorkspaceActivityState | undefined): void {
		this.state = state;
		const shouldTick = state !== undefined && state.phase !== "waiting";
		if (shouldTick && !this.timer) {
			this.timer = setInterval(this.requestRender, 1000);
		} else if (!shouldTick && this.timer) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
	}

	dispose(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
		this.state = undefined;
	}

	invalidate(): void {}

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
				return `${prefixText}${truncateFromStart(label, labelWidth, theme.fg("text", "…"))}`;
			}
			return `${prefixText}${theme.fg(labelColor, truncateToWidth(labelText, labelWidth, "…"))}`;
		};
		if (!suffix || visibleWidth(suffix) + 2 >= width) return [renderMain(width)];
		const main = renderMain(Math.max(1, width - visibleWidth(suffix) - 1));
		const gap = " ".repeat(Math.max(1, width - visibleWidth(main) - visibleWidth(suffix)));
		return [`${main}${gap}${suffix}`];
	}
}
