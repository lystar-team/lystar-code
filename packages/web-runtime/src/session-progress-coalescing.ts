import type { SessionProgress } from "@lystar/code-web-protocol";
import { mergeWebSearchProgress, webSearchProgressSummary } from "./web-search-progress.ts";

export function sessionProgressKey(progress: SessionProgress): string | undefined {
	switch (progress.type) {
		case "assistant_delta":
		case "thinking_delta":
			return `${progress.type}:${progress.stepId ?? ""}:${progress.blockId ?? ""}`;
		case "phase":
		case "queue_update":
		case "status":
			return progress.type;
		case "usage":
			return progress.usage.outputSpeed !== undefined ? "output_speed" : progress.type;
		case "tool_update":
			return `${progress.type}:${progress.toolCallId}`;
		case "tool_state":
			return `${progress.type}:${progress.activity.activityEpoch}:${progress.activity.toolCallId}`;
		default:
			return undefined;
	}
}

export function shouldSendProgressImmediately(progress: SessionProgress): boolean {
	if (progress.type === "usage" && progress.usage.outputSpeed !== undefined && !progress.usage.outputSpeed?.streaming)
		return true;
	if (progress.type === "agent_step" || progress.type === "tool_start" || progress.type === "tool_end") return true;
	if (
		progress.type === "tool_update" &&
		progress.name === "web_search" &&
		(progress.webSearch?.query || progress.webSearch?.url || progress.webSearch?.sources.length)
	)
		return true;
	if (progress.type !== "tool_state") return false;
	return (
		(progress.activity.state === "running" &&
			progress.activity.progress === undefined &&
			progress.activity.codemode === undefined &&
			progress.activity.output === undefined &&
			progress.activity.error === undefined) ||
		["success", "error", "cancelled", "interrupted"].includes(progress.activity.state)
	);
}

export function mergeSessionProgress(left: SessionProgress, right: SessionProgress): SessionProgress {
	if (
		left.type === "tool_update" &&
		right.type === "tool_update" &&
		left.toolCallId === right.toolCallId &&
		left.name === right.name
	) {
		const webSearch = mergeWebSearchProgress(left.webSearch, right.webSearch);
		return {
			...right,
			...(webSearch ? { webSearch } : {}),
			...(right.name === "web_search" && webSearch ? { summary: webSearchProgressSummary(webSearch) } : {}),
		};
	}
	if (
		left.type === "assistant_delta" &&
		right.type === "assistant_delta" &&
		(left.blockId ?? "") === (right.blockId ?? "")
	)
		return {
			type: "assistant_delta",
			text: left.text + right.text,
			...((right.stepId ?? left.stepId) ? { stepId: right.stepId ?? left.stepId } : {}),
			...((right.blockId ?? left.blockId) ? { blockId: right.blockId ?? left.blockId } : {}),
		};
	if (
		left.type === "thinking_delta" &&
		right.type === "thinking_delta" &&
		(left.blockId ?? "") === (right.blockId ?? "")
	)
		return {
			type: "thinking_delta",
			text: left.text + right.text,
			...((right.stepId ?? left.stepId) ? { stepId: right.stepId ?? left.stepId } : {}),
			...((right.blockId ?? left.blockId) ? { blockId: right.blockId ?? left.blockId } : {}),
		};
	return right;
}

export class SessionProgressCoalescer {
	private readonly emit: (progress: SessionProgress) => void;
	private readonly pending: Array<{ key?: string; progress: SessionProgress }> = [];
	private timer?: ReturnType<typeof setTimeout>;

	constructor(emit: (progress: SessionProgress) => void) {
		this.emit = emit;
	}

	push(progress: SessionProgress): void {
		if (shouldSendProgressImmediately(progress)) {
			this.flush();
			this.emit(progress);
			return;
		}
		const key = sessionProgressKey(progress);
		const textDelta = progress.type === "assistant_delta" || progress.type === "thinking_delta";
		const previousIndex = key
			? textDelta
				? this.pending.length - 1
				: this.pending.findIndex((entry) => entry.key === key)
			: -1;
		const previous = this.pending[previousIndex];
		if (key && previous?.key === key) {
			this.pending.splice(previousIndex, 1);
			this.pending.push({ key, progress: mergeSessionProgress(previous.progress, progress) });
		} else {
			this.pending.push({ key, progress });
		}
		const latest = this.pending.at(-1)?.progress;
		if (this.pending.length >= 64 || (textDelta && latest && "text" in latest && latest.text.length >= 16 * 1024)) {
			this.flush();
			return;
		}
		if (this.timer) return;
		this.timer = setTimeout(() => this.flush(), 50);
		this.timer.unref?.();
	}

	flush(): void {
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
		for (const entry of this.pending.splice(0)) this.emit(entry.progress);
	}

	clear(): void {
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
		this.pending.length = 0;
	}
}
