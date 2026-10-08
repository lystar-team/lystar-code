import type { TranscriptCodemodeCall } from "@lystar/code-web-protocol";
import type { ToolBatchTool } from "../types.ts";

const CODEMODE_CALL_STATES = {
	running: "input-available",
	ok: "output-available",
	error: "output-error",
	cancelled: "output-cancelled",
} as const satisfies Record<TranscriptCodemodeCall["status"], ToolBatchTool["state"]>;

export function toCodemodeToolViewModel(call: TranscriptCodemodeCall): ToolBatchTool {
	return {
		id: call.id,
		name: call.name,
		summary: call.summary ?? call.args,
		state: CODEMODE_CALL_STATES[call.status],
		detail: call.status === "error" ? call.error ?? call.result ?? call.progress : call.result ?? call.progress ?? call.error,
		progress: call.progress,
		diff: call.diff,
	};
}
