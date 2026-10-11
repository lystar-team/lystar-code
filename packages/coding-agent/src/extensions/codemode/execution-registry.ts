import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { raceWithAbortSignal } from "../../utils/abort.ts";
import type { CodemodeToolDetails } from "./tool.ts";

interface CodemodeExecutionEntry {
	parentToolCallId: string;
	result: Promise<AgentToolResult<CodemodeToolDetails | undefined>>;
	cancel: (reason: string) => Promise<void>;
	snapshot: () => CodemodeToolDetails;
	waiting: boolean;
}

export interface CollectedCodemodeExecution {
	executionId: string;
	parentToolCallId: string;
	status: "running" | "completed" | "failed";
	result: AgentToolResult<CodemodeToolDetails | undefined>;
}

export class CodemodeExecutionRegistry {
	private readonly sessions = new Map<string, Map<string, CodemodeExecutionEntry>>();
	private readonly runSignals = new Map<string, { signal: AbortSignal; onAbort: () => void }>();

	register(
		sessionId: string,
		executionId: string,
		parentToolCallId: string,
		result: Promise<AgentToolResult<CodemodeToolDetails | undefined>>,
		cancel: (reason: string) => Promise<void>,
		snapshot: () => CodemodeToolDetails,
	): AgentToolResult<CodemodeToolDetails> {
		let executions = this.sessions.get(sessionId);
		if (!executions) {
			executions = new Map();
			this.sessions.set(sessionId, executions);
		}
		if (executions.has(executionId)) throw new Error(`Codemode execution "${executionId}" is already registered`);
		// 后台格式化失败也交付一次错误结果，并保留原调用记录的关联。
		const observed = result.catch(
			(error: unknown): AgentToolResult<CodemodeToolDetails> => ({
				content: [
					{
						type: "text",
						text: `Codemode result failed: ${error instanceof Error ? error.message : String(error)}`,
					},
				],
				details: snapshot(),
				isError: true,
			}),
		);
		const entry: CodemodeExecutionEntry = { parentToolCallId, result: observed, cancel, snapshot, waiting: false };
		executions.set(executionId, entry);
		return this.runningResult(executionId, entry);
	}

	async take(
		sessionId: string,
		executionId: string,
		signal: AbortSignal | undefined,
		steeringSignal: AbortSignal | undefined,
	): Promise<CollectedCodemodeExecution> {
		const executions = this.sessions.get(sessionId);
		const entry = executions?.get(executionId);
		if (!entry) throw new Error(`Unknown or already collected codemode execution "${executionId}"`);
		if (entry.waiting) throw new Error(`Codemode execution "${executionId}" is already being collected`);
		entry.waiting = true;
		const waitSignal =
			signal && steeringSignal ? AbortSignal.any([signal, steeringSignal]) : (signal ?? steeringSignal);
		try {
			const result = await raceWithAbortSignal(entry.result, waitSignal);
			this.remove(sessionId, executionId, entry);
			return {
				executionId,
				parentToolCallId: entry.parentToolCallId,
				status: result.isError ? "failed" : "completed",
				result,
			};
		} catch (error) {
			if (signal?.aborted) throw error;
			if (!steeringSignal?.aborted) throw error;
			return {
				executionId,
				parentToolCallId: entry.parentToolCallId,
				status: "running",
				result: this.runningResult(executionId, entry),
			};
		} finally {
			entry.waiting = false;
		}
	}

	startRun(sessionId: string, signal: AbortSignal | undefined): void {
		this.endRun(sessionId);
		if (!signal) return;
		const onAbort = () => {
			void this.clearSession(sessionId, "Codemode run stopped");
		};
		this.runSignals.set(sessionId, { signal, onAbort });
		if (signal.aborted) onAbort();
		else signal.addEventListener("abort", onAbort, { once: true });
	}

	endRun(sessionId: string): void {
		const run = this.runSignals.get(sessionId);
		if (!run) return;
		run.signal.removeEventListener("abort", run.onAbort);
		this.runSignals.delete(sessionId);
	}

	async clearSession(sessionId: string, reason = "Codemode session ended"): Promise<void> {
		this.endRun(sessionId);
		const executions = this.sessions.get(sessionId);
		if (!executions) return;
		this.sessions.delete(sessionId);
		await Promise.all(
			[...executions.values()].map(async (entry) => {
				await entry.cancel(reason);
				await entry.result;
			}),
		);
	}

	private runningResult(executionId: string, entry: CodemodeExecutionEntry): AgentToolResult<CodemodeToolDetails> {
		const details = entry.snapshot();
		const running = details.calls.filter((call) => call.status === "running").map((call) => call.name);
		return {
			content: [
				{
					type: "text",
					text: `Script yielded after Steer. Execution ID: ${executionId}.\nThe script continues in the background. Nested calls still running: ${running.join(", ") || "none"}.\nCall codemode_wait with {"executionId":"${executionId}"} to collect the final result. Do not repeat the script.`,
				},
			],
			details: { ...details, executionId, status: "running", parentToolCallId: entry.parentToolCallId },
		};
	}

	private remove(sessionId: string, executionId: string, entry: CodemodeExecutionEntry): void {
		const executions = this.sessions.get(sessionId);
		if (executions?.get(executionId) !== entry) return;
		executions.delete(executionId);
		if (executions.size === 0) this.sessions.delete(sessionId);
	}
}
