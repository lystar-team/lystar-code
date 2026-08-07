import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";
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
}

function formatDuration(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	return `${Math.floor(seconds / 60)}m${seconds % 60}s`;
}

function phaseLabel(state: WorkspaceActivityState): string {
	switch (state.phase) {
		case "thinking":
			return "正在思考";
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

export class WorkspaceActivityBar implements Component {
	private state: WorkspaceActivityState | undefined;
	private timer: ReturnType<typeof setInterval> | undefined;
	private readonly requestRender: () => void;

	constructor(requestRender: () => void) {
		this.requestRender = requestRender;
	}

	setState(state: WorkspaceActivityState | undefined): void {
		this.state = state;
		if (state && !this.timer) {
			this.timer = setInterval(this.requestRender, 1000);
		} else if (!state && this.timer) {
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
		if (!this.state || width <= 0) return [];
		const state = this.state;
		const prefix = theme.bold(theme.fg(state.phase === "cancelled" ? "warning" : "accent", uiGlyphs.tool));
		const label = theme.fg(
			state.phase === "retrying" || state.phase === "cancelled" ? "warning" : "text",
			phaseLabel(state),
		);
		const progress =
			state.knownTools > 0
				? theme.fg("muted", `已完成 ${Math.min(state.completedTools, state.knownTools)}/${state.knownTools}`)
				: undefined;
		const queue = state.queueCount > 0 ? theme.fg("muted", `队列 ${state.queueCount}`) : undefined;
		const elapsed = theme.fg("dim", formatDuration(Date.now() - state.startedAt));
		const separator = theme.fg("dim", "  ·  ");
		const main = `${prefix} ${label}`;
		const suffix = [progress, queue, elapsed].filter((part): part is string => Boolean(part)).join(separator);
		if (!suffix) return [truncateToWidth(main, width, "")];
		if (visibleWidth(main) + visibleWidth(suffix) + 2 <= width) {
			return [`${main}${" ".repeat(width - visibleWidth(main) - visibleWidth(suffix))}${suffix}`];
		}
		const compact = [main, elapsed].join(separator);
		return [truncateToWidth(compact, width, "…")];
	}
}
