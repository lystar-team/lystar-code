import { mergeWebSearchProgress, type SessionProgress, webSearchProgressSummary } from "@lystar/code-web-protocol";

export type WebSessionProgressEvent = {
	type: "session_progress";
	sessionId: string;
	progress: SessionProgress;
};

export function progressCoalescingKey(event: WebSessionProgressEvent): string | undefined {
	switch (event.progress.type) {
		case "assistant_delta":
		case "thinking_delta":
			return `${event.sessionId}:${event.progress.type}:${event.progress.stepId ?? ""}`;
		case "phase":
		case "queue_update":
		case "status":
		case "usage":
			return `${event.sessionId}:${event.progress.type}`;
		case "tool_update":
			return `${event.sessionId}:${event.progress.type}:${event.progress.toolCallId}`;
		case "tool_state":
			return `${event.sessionId}:${event.progress.type}:${event.progress.activity.toolCallId}`;
		default:
			return undefined;
	}
}

export function shouldSendProgressImmediately(progress: SessionProgress): boolean {
	if (progress.type === "tool_start" || progress.type === "tool_end") return true;
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
			progress.activity.output === undefined &&
			progress.activity.error === undefined) ||
		["success", "error", "cancelled", "interrupted"].includes(progress.activity.state)
	);
}

export function mergeProgress(left: SessionProgress, right: SessionProgress): SessionProgress {
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
	if (left.type === "assistant_delta" && right.type === "assistant_delta")
		return {
			type: "assistant_delta",
			text: left.text + right.text,
			...((right.stepId ?? left.stepId) ? { stepId: right.stepId ?? left.stepId } : {}),
		};
	if (left.type === "thinking_delta" && right.type === "thinking_delta")
		return {
			type: "thinking_delta",
			text: left.text + right.text,
			...((right.stepId ?? left.stepId) ? { stepId: right.stepId ?? left.stepId } : {}),
		};
	return right;
}
