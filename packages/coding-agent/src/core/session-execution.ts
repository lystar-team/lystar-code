import type { AgentSessionEvent } from "./agent-session.ts";

export interface SessionExecutionStatus {
	phase:
		| "preparing"
		| "waiting_model"
		| "thinking"
		| "responding"
		| "tool"
		| "compaction"
		| "retry"
		| "waiting_input"
		| "finishing"
		| "idle";
	startedAt?: number;
	phaseStartedAt: number;
	lastProgressAt: number;
	lastModelEventAt?: number;
	toolName?: string;
	retryAttempt?: number;
	retryMaxAttempts?: number;
	retryAt?: number;
}

/** 只消费真实运行事件。读取状态不会重置时间。 */
export class SessionExecutionTracker {
	private status?: SessionExecutionStatus;
	private readonly tools = new Map<string, string>();

	getStatus(): SessionExecutionStatus | undefined {
		return this.status;
	}

	apply(event: AgentSessionEvent): void {
		const now = event.type === "request_phase" ? event.at : Date.now();
		switch (event.type) {
			case "agent_start":
				this.tools.clear();
				this.status = {
					phase: "preparing",
					startedAt:
						this.status?.phase === "retry" || this.status?.phase === "compaction" ? this.status.startedAt : now,
					phaseStartedAt: now,
					lastProgressAt: now,
				};
				break;
			case "request_phase":
				this.advance(event.phase, now);
				break;
			case "message_start":
				if (
					event.message.role === "assistant" &&
					event.message.stopReason !== "error" &&
					event.message.stopReason !== "aborted"
				)
					this.advance("waiting_model", now, true);
				break;
			case "message_update": {
				const delta = event.assistantMessageEvent;
				switch (delta.type) {
					case "thinking_start":
					case "thinking_delta":
						this.advance("thinking", now, true);
						break;
					case "text_start":
					case "text_delta":
						this.advance("responding", now, true);
						break;
					case "websearch_start":
					case "websearch_update":
						this.advance("tool", now, true, { toolName: "web_search" });
						break;
					case "thinking_end":
					case "text_end":
					case "toolcall_start":
					case "toolcall_delta":
					case "toolcall_end":
					case "websearch_end":
						this.advance("waiting_model", now, true);
						break;
				}
				break;
			}
			case "message_end":
				if (event.message.role === "assistant") this.advance("finishing", now);
				break;
			case "tool_execution_start":
			case "tool_execution_update":
				this.tools.set(event.toolCallId, event.toolName);
				this.advance("tool", now, false, { toolName: event.toolName });
				break;
			case "tool_execution_end": {
				this.tools.delete(event.toolCallId);
				const toolName = this.tools.values().next().value;
				this.advance(
					toolName === undefined ? "finishing" : "tool",
					now,
					false,
					toolName === undefined ? {} : { toolName },
				);
				break;
			}
			case "compaction_start":
			case "summarization_retry_attempt_start":
				this.advance("compaction", now);
				break;
			case "compaction_end":
				this.advance(event.willRetry ? "preparing" : "idle", now);
				break;
			case "auto_retry_start":
			case "summarization_retry_scheduled":
				this.advance("retry", now, false, {
					retryAttempt: event.attempt,
					retryMaxAttempts: event.maxAttempts,
					retryAt: now + event.delayMs,
				});
				break;
			case "auto_retry_end":
				this.advance(event.success ? "finishing" : "idle", now);
				break;
			case "summarization_retry_finished":
				this.advance("idle", now);
				break;
			case "agent_end":
				if (!event.willRetry) this.advance("finishing", now);
				break;
			case "agent_settled":
				this.tools.clear();
				this.advance("idle", now);
				break;
		}
	}

	private advance(
		phase: SessionExecutionStatus["phase"],
		at: number,
		modelEvent = false,
		details: Pick<SessionExecutionStatus, "toolName" | "retryAttempt" | "retryMaxAttempts" | "retryAt"> = {},
	): void {
		const previous = this.status?.phase === "idle" && phase !== "idle" ? undefined : this.status;
		this.status = {
			phase,
			startedAt: previous?.startedAt ?? at,
			phaseStartedAt: previous?.phase === phase ? previous.phaseStartedAt : at,
			lastProgressAt: at,
			...(modelEvent
				? { lastModelEventAt: at }
				: previous?.lastModelEventAt === undefined
					? {}
					: { lastModelEventAt: previous.lastModelEventAt }),
			...details,
		};
	}
}
