import type {
	ToolFailure,
	ToolRecoveryAttemptDecision,
	ToolRecoveryController,
	ToolRecoveryObservation,
	ToolRecoveryPreflightContext,
	ToolRecoveryPreflightResult,
} from "@earendil-works/pi-agent-core";
import type { SessionManager } from "../session-manager.ts";
import { appendSessionRecoveryLedger, createRecoveryLedgerEntry } from "./ledger.ts";
import { findMatchingToolRecoveryLessons, recordDeterministicToolRecoveryCandidate } from "./lessons-store.ts";
import {
	applyToolRecoveryRefinerProposal,
	findToolRecoveryRefinerLessons,
	parseToolRecoveryRefinerProposal,
	sanitizeToolRecoveryUserCorrections,
	type ToolRecoveryRefiner,
	type ToolRecoveryRefinerFailure,
} from "./refiner.ts";
import {
	adaptToolRecoveryObservation,
	isTrustedBuiltinRecoveryError,
	isTrustedBuiltinTool,
	isTrustedReadOnlyBuiltinTool,
} from "./registry.ts";

const toolRecoveryHandlerSymbol = Symbol.for("pi.toolRecoveryHandler");
type ToolRecoveryResolution = Exclude<ToolRecoveryAttemptDecision["action"], { type: "retry_same_args" }>;
type ToolRecoveryHandler = (context: {
	signal?: AbortSignal;
}) => Promise<ToolRecoveryResolution | undefined> | ToolRecoveryResolution | undefined;

async function runToolRecoveryHandler(
	error: unknown,
	signal?: AbortSignal,
): Promise<ToolRecoveryResolution | undefined> {
	if (typeof error !== "object" || error === null) return undefined;
	const handler = (error as { [toolRecoveryHandlerSymbol]?: ToolRecoveryHandler })[toolRecoveryHandlerSymbol];
	return await handler?.({ signal });
}

const MAX_RECOVERY_RETRIES = 2;
const RETRYABLE_CODES = new Set(["TIMEOUT", "TRANSPORT_ERROR", "RATE_LIMITED"]);
const BLOCKED_MESSAGE = "已阻止重复失败，需修改参数、刷新状态、切换工具或请求用户决定。";

type RecoveryAction =
	| "observe"
	| "accept_as_success"
	| "retry_same_args"
	| "refresh_context"
	| "ask_model_to_rebuild"
	| "require_user"
	| "stop";
type Counter = Map<string, number>;
type AttemptState = { attempt: number; failure: ToolFailure };
type CircuitState = { attempt: number; failure: ToolFailure };

export interface ToolRecoveryDiagnostics {
	mode: "observe" | "assist";
	toolFailureTotal: Array<{ tool: string; code: string; count: number }>;
	toolRecoveryAttemptTotal: Array<{ tool: string; action: RecoveryAction; count: number }>;
	toolRecoverySuccessTotal: Array<{ tool: string; action: "retry_same_args"; count: number }>;
	toolRepeatBlockedTotal: Array<{ tool: string; code: string; count: number }>;
	toolUnsafeRetryBlockedTotal: Array<{ tool: string; count: number }>;
	lessonMatchTotal: Array<{ lesson: string; count: number }>;
	lessonRecoverySuccessTotal: Array<{ lesson: string; count: number }>;
	lessonSuspendedTotal: Array<{ lesson: string; count: number }>;
	duration: { count: number; totalMs: number; maxMs: number };
	activeCircuits: number;
}

class ToolRecoveryMetrics {
	private readonly failures: Counter = new Map();
	private readonly attempts: Counter = new Map();
	private readonly successes: Counter = new Map();
	private readonly repeatBlocked: Counter = new Map();
	private readonly unsafeRetryBlocked: Counter = new Map();
	private readonly lessonMatches: Counter = new Map();
	private readonly lessonRecoverySuccesses: Counter = new Map();
	private readonly lessonSuspended: Counter = new Map();
	private durationCount = 0;
	private durationTotalMs = 0;
	private durationMaxMs = 0;

	recordDuration(durationMs: number): void {
		this.durationCount++;
		this.durationTotalMs += durationMs;
		this.durationMaxMs = Math.max(this.durationMaxMs, durationMs);
	}

	recordFailure(failure: ToolFailure): void {
		increment(this.failures, `${failure.toolName}\u0000${failure.code}`);
	}

	recordAttempt(toolName: string, action: RecoveryAction): void {
		increment(this.attempts, `${toolName}\u0000${action}`);
	}

	recordSuccess(toolName: string): void {
		increment(this.successes, `${toolName}\u0000retry_same_args`);
	}

	recordRepeatBlocked(failure: ToolFailure): void {
		increment(this.repeatBlocked, `${failure.toolName}\u0000${failure.code}`);
	}

	recordUnsafeRetryBlocked(toolName: string): void {
		increment(this.unsafeRetryBlocked, toolName);
	}

	recordLessonMatch(lessonId: string): void {
		increment(this.lessonMatches, lessonId);
	}

	recordLessonRecoverySuccess(lessonId: string): void {
		increment(this.lessonRecoverySuccesses, lessonId);
	}

	recordLessonSuspended(lessonId: string): void {
		increment(this.lessonSuspended, lessonId);
	}

	snapshot(mode: ToolRecoveryDiagnostics["mode"], activeCircuits: number): ToolRecoveryDiagnostics {
		const unpack = (entries: Counter) =>
			Array.from(entries, ([key, count]) => {
				const [tool, code] = key.split("\u0000");
				return { tool: tool!, code: code!, count };
			}).sort((left, right) => left.tool.localeCompare(right.tool) || left.code.localeCompare(right.code));
		return {
			mode,
			toolFailureTotal: unpack(this.failures),
			toolRecoveryAttemptTotal: unpack(this.attempts).map(({ tool, code, count }) => ({
				tool,
				action: code as RecoveryAction,
				count,
			})),
			toolRecoverySuccessTotal: unpack(this.successes).map(({ tool, count }) => ({
				tool,
				action: "retry_same_args",
				count,
			})),
			toolRepeatBlockedTotal: unpack(this.repeatBlocked),
			toolUnsafeRetryBlockedTotal: Array.from(this.unsafeRetryBlocked, ([tool, count]) => ({ tool, count })).sort(
				(a, b) => a.tool.localeCompare(b.tool),
			),
			lessonMatchTotal: lessonEntries(this.lessonMatches),
			lessonRecoverySuccessTotal: lessonEntries(this.lessonRecoverySuccesses),
			lessonSuspendedTotal: lessonEntries(this.lessonSuspended),
			duration: { count: this.durationCount, totalMs: this.durationTotalMs, maxMs: this.durationMaxMs },
			activeCircuits,
		};
	}
}

function increment(counter: Counter, key: string): void {
	counter.set(key, (counter.get(key) ?? 0) + 1);
}

function lessonEntries(counter: Counter): Array<{ lesson: string; count: number }> {
	return Array.from(counter, ([lesson, count]) => ({ lesson, count })).sort((left, right) =>
		left.lesson.localeCompare(right.lesson),
	);
}

function attemptKey(toolCallId: string, failureFingerprint: string): string {
	return `${toolCallId}\u0000${failureFingerprint}`;
}

function circuitKey(callSignature: string, failureFingerprint: string): string {
	return `${callSignature}\u0000${failureFingerprint}`;
}

function isSafeRetry(observation: ToolRecoveryObservation): boolean {
	const failure = observation.failure;
	return Boolean(
		failure &&
			failure.sideEffect === "read_only" &&
			failure.retryable &&
			RETRYABLE_CODES.has(failure.code) &&
			isTrustedReadOnlyBuiltinTool(observation.toolName, observation.toolRuntimeContext),
	);
}

function retryDelayMs(attempt: number): number {
	return 100 * 2 ** (attempt - 1);
}

function defaultSleep(delayMs: number, signal?: AbortSignal): Promise<boolean> {
	if (signal?.aborted) return Promise.resolve(false);
	return new Promise((resolve) => {
		const timer = setTimeout(finish, delayMs);
		const onAbort = () => {
			clearTimeout(timer);
			finish(false);
		};
		function finish(value = true): void {
			signal?.removeEventListener("abort", onAbort);
			resolve(value);
		}
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

interface ControllerOptions {
	agentDir: string;
	sessionManager: SessionManager;
	getTurnId: () => string;
	scopeHash?: string;
	refiner?: ToolRecoveryRefiner;
	getUserCorrections?: () => readonly string[] | undefined;
	now?: () => number;
	sleep?: (delayMs: number, signal?: AbortSignal) => Promise<boolean>;
}

abstract class BaseToolRecoveryController implements ToolRecoveryController {
	protected readonly options: ControllerOptions;
	protected readonly metrics = new ToolRecoveryMetrics();
	private readonly refinerFailures: ToolRecoveryRefinerFailure[] = [];

	constructor(options: ControllerOptions) {
		this.options = options;
	}

	now(): number {
		return (this.options.now ?? Date.now)();
	}

	async waitForRetry(delayMs: number, signal?: AbortSignal): Promise<boolean> {
		return await (this.options.sleep ?? defaultSleep)(delayMs, signal);
	}

	protected async append(
		observation: ToolRecoveryObservation,
		failure: ToolFailure,
		attempt: number,
		action: RecoveryAction,
	): Promise<void> {
		const sessionFile = this.options.sessionManager.getSessionFile();
		if (!sessionFile) return;
		const outcome =
			observation.outcome === "success" || observation.outcome === "recovered"
				? "recovered"
				: observation.outcome === "needs_model"
					? "needs_model"
					: observation.outcome === "blocked"
						? "blocked"
						: observation.outcome === "cancelled"
							? "cancelled"
							: "failed";
		const receipt = await appendSessionRecoveryLedger(
			this.options.agentDir,
			sessionFile,
			createRecoveryLedgerEntry({
				sessionId: this.options.sessionManager.getSessionId(),
				turnId: this.options.getTurnId(),
				toolCallId: observation.toolCallId,
				toolName: observation.toolName,
				callSignature: observation.callSignature,
				failureFingerprint: failure.fingerprint,
				failureCode: failure.code,
				attempt,
				action,
				outcome,
				durationMs: observation.durationMs,
				createdAt: failure.occurredAt,
			}),
		);
		if (!receipt || !this.options.scopeHash) return;

		try {
			const candidate = await recordDeterministicToolRecoveryCandidate(this.options.agentDir, {
				scopeHash: this.options.scopeHash,
				receipt,
			});
			if (!candidate && this.options.refiner && outcome === "recovered") {
				this.refinerFailures.push({
					code: failure.code,
					category: failure.category,
					fingerprint: failure.fingerprint,
					action,
					outcome,
				});
			}
			if (outcome === "recovered") {
				const matches = await findMatchingToolRecoveryLessons(this.options.agentDir, {
					scopeHash: this.options.scopeHash,
					toolName: observation.toolName,
					failureCode: failure.code,
					failureFingerprint: failure.fingerprint,
				});
				for (const lesson of matches.lessons) this.metrics.recordLessonRecoverySuccess(lesson.id);
			}
		} catch {
			// Candidate 与 metrics 不能影响已经完成的 Tool recovery。
		}
	}

	recordLessonMatches(lessonIds: readonly string[]): void {
		for (const lessonId of new Set(lessonIds)) this.metrics.recordLessonMatch(lessonId);
	}

	recordSuspendedLessons(lessonIds: readonly string[]): void {
		for (const lessonId of new Set(lessonIds)) this.metrics.recordLessonSuspended(lessonId);
	}

	async refineTurn(): Promise<void> {
		if (!this.options.refiner || !this.options.scopeHash || this.refinerFailures.length === 0) return;
		const failures = this.refinerFailures.splice(0);
		try {
			const relatedLessons = await findToolRecoveryRefinerLessons(
				this.options.agentDir,
				this.options.scopeHash,
				failures,
			);
			const output = await this.options.refiner({
				scopeHash: this.options.scopeHash,
				failures,
				relatedLessons,
				userCorrections: sanitizeToolRecoveryUserCorrections(this.options.getUserCorrections?.()),
			});
			const proposal = parseToolRecoveryRefinerProposal(output);
			if (proposal) await applyToolRecoveryRefinerProposal(this.options.agentDir, this.options.scopeHash, proposal);
		} catch {
			// Refiner 是可选的离线建议，不得让 turn 失败或改变 Tool 结果。
		}
	}

	abstract preflight(
		context: ToolRecoveryPreflightContext,
		signal?: AbortSignal,
	): ToolRecoveryPreflightResult | undefined | Promise<ToolRecoveryPreflightResult | undefined>;
	abstract observe(observation: ToolRecoveryObservation, signal?: AbortSignal, error?: unknown): void | Promise<void>;
}

/** M3 compatibility controller. It never blocks or retries. */
export class ObserveOnlyToolRecoveryController extends BaseToolRecoveryController {
	private readonly observations = new Map<string, number>();

	preflight(): undefined {
		return undefined;
	}

	async observe(observation: ToolRecoveryObservation, signal?: AbortSignal, error?: unknown): Promise<void> {
		await adaptToolRecoveryObservation(observation, error, signal);
		this.metrics.recordDuration(observation.durationMs);
		const failure = observation.failure;
		if (!failure) return;
		this.metrics.recordFailure(failure);
		this.metrics.recordAttempt(observation.toolName, "observe");
		const key = attemptKey(observation.toolCallId, failure.fingerprint);
		const attempt = (this.observations.get(key) ?? 0) + 1;
		this.observations.set(key, attempt);
		await this.append(observation, failure, attempt, "observe");
	}

	getDiagnostics(): ToolRecoveryDiagnostics {
		return this.metrics.snapshot("observe", 0);
	}
}

/** M4 controller. State is owned by one AgentSession and never crosses Sessions. */
export class AssistToolRecoveryController extends BaseToolRecoveryController {
	private readonly circuits = new Map<string, CircuitState>();
	private readonly attempts = new Map<string, AttemptState>();
	private readonly recovered = new Map<string, AttemptState>();
	private readonly rebuiltFingerprints = new Map<string, number>();
	private readonly closedFingerprints = new Set<string>();
	private readonly refreshedFingerprints = new Set<string>();

	getFailureForToolCall(toolCallId: string): ToolFailure | undefined {
		return Array.from(this.attempts.entries()).find(([key]) => key.startsWith(`${toolCallId}\u0000`))?.[1].failure;
	}

	async preflight(context: ToolRecoveryPreflightContext): Promise<ToolRecoveryPreflightResult | undefined> {
		const circuit = Array.from(this.circuits.entries()).find(([key]) =>
			key.startsWith(`${context.callSignature}\u0000`),
		);
		if (!circuit) return;
		const [, state] = circuit;
		const observation: ToolRecoveryObservation = {
			...context,
			action: "stop",
			outcome: "blocked",
			durationMs: 0,
			failure: state.failure,
		};
		this.metrics.recordRepeatBlocked(state.failure);
		this.metrics.recordDuration(0);
		await this.append(observation, state.failure, state.attempt, "stop");
		return { blocked: true, failure: state.failure, message: BLOCKED_MESSAGE };
	}

	async decideAttempt(
		observation: ToolRecoveryObservation,
		signal?: AbortSignal,
		error?: unknown,
	): Promise<ToolRecoveryAttemptDecision> {
		await adaptToolRecoveryObservation(observation, error, signal);
		const failure = observation.failure!;
		this.metrics.recordDuration(observation.durationMs);
		this.metrics.recordFailure(failure);
		const key = attemptKey(observation.toolCallId, failure.fingerprint);
		const state = this.attempts.get(key) ?? { attempt: 0, failure };
		state.attempt++;
		state.failure = failure;
		this.attempts.set(key, state);

		if (failure.code === "CANCELLED") {
			observation.action = "stop";
			observation.outcome = "cancelled";
			this.metrics.recordAttempt(observation.toolName, "stop");
			await this.append(observation, failure, state.attempt, "stop");
			return { action: { type: "stop", reason: "cancelled" }, observation };
		}

		if (this.closedFingerprints.has(failure.fingerprint)) {
			observation.action = "stop";
			observation.outcome = "failure";
			this.metrics.recordAttempt(observation.toolName, "stop");
			this.circuits.set(circuitKey(observation.callSignature, failure.fingerprint), {
				attempt: state.attempt,
				failure,
			});
			await this.append(observation, failure, state.attempt, "stop");
			return { action: { type: "stop", reason: "rebuild budget exhausted" }, observation };
		}

		if (
			(isTrustedBuiltinTool(observation.toolName, observation.toolRuntimeContext) ||
				isTrustedBuiltinRecoveryError(observation.toolName, error)) &&
			!signal?.aborted
		) {
			const resolution = await runToolRecoveryHandler(error, signal);
			if (resolution) {
				const rebuildAttempt = this.rebuiltFingerprints.get(failure.fingerprint) ?? 0;
				const isRepeatRebuild = resolution.type === "ask_model_to_rebuild" && rebuildAttempt >= 1;
				const isRepeatRefresh =
					resolution.type === "refresh_context" && this.refreshedFingerprints.has(failure.fingerprint);
				if (isRepeatRebuild) {
					this.closedFingerprints.add(failure.fingerprint);
				} else if (!isRepeatRefresh) {
					if (resolution.type === "ask_model_to_rebuild") {
						this.rebuiltFingerprints.set(failure.fingerprint, rebuildAttempt + 1);
					}
					if (resolution.type === "refresh_context") this.refreshedFingerprints.add(failure.fingerprint);
					observation.action = resolution.type;
					observation.outcome = resolution.type === "accept_as_success" ? "recovered" : "needs_model";
					this.metrics.recordAttempt(observation.toolName, resolution.type);
					if (resolution.type !== "accept_as_success") {
						this.circuits.set(circuitKey(observation.callSignature, failure.fingerprint), {
							attempt: state.attempt,
							failure,
						});
					}
					await this.append(observation, failure, state.attempt, resolution.type);
					return { action: resolution, observation };
				}
			}
		}

		if (failure.code === "PATCH_ROLLBACK_FAILED") {
			const action = {
				type: "require_user" as const,
				reason: "补丁写入后的回滚失败，需人工检查已触碰文件。",
			};
			observation.action = action.type;
			observation.outcome = "blocked";
			this.metrics.recordAttempt(observation.toolName, action.type);
			this.circuits.set(circuitKey(observation.callSignature, failure.fingerprint), {
				attempt: state.attempt,
				failure,
			});
			await this.append(observation, failure, state.attempt, action.type);
			return { action, observation };
		}

		if (isSafeRetry(observation) && state.attempt <= MAX_RECOVERY_RETRIES) {
			observation.action = "retry_same_args";
			observation.outcome = "failure";
			(observation as ToolRecoveryObservation & { warning?: boolean }).warning = state.attempt === 2;
			this.recovered.set(observation.toolCallId, state);
			this.metrics.recordAttempt(observation.toolName, "retry_same_args");
			await this.append(observation, failure, state.attempt, "retry_same_args");
			return { action: { type: "retry_same_args", delayMs: retryDelayMs(state.attempt) }, observation };
		}

		observation.action = "stop";
		observation.outcome = "failure";
		this.metrics.recordAttempt(observation.toolName, "stop");
		if (!isSafeRetry(observation)) this.metrics.recordUnsafeRetryBlocked(observation.toolName);
		if (failure.code !== "POST_HOOK_FAILURE") {
			this.circuits.set(circuitKey(observation.callSignature, failure.fingerprint), {
				attempt: state.attempt,
				failure,
			});
		}
		await this.append(observation, failure, state.attempt, "stop");
		return { action: { type: "stop", reason: "retry policy denied" }, observation };
	}

	async observe(observation: ToolRecoveryObservation, signal?: AbortSignal, error?: unknown): Promise<void> {
		if (observation.outcome === "success") {
			const state = this.recovered.get(observation.toolCallId);
			this.metrics.recordDuration(observation.durationMs);
			if (!state) return;
			this.recovered.delete(observation.toolCallId);
			observation.action = "retry_same_args";
			observation.outcome = "recovered";
			observation.failure = state.failure;
			this.metrics.recordSuccess(observation.toolName);
			await this.append(observation, state.failure, state.attempt + 1, "retry_same_args");
			return;
		}

		await adaptToolRecoveryObservation(observation, error, signal);
		const failure = observation.failure;
		if (!failure) return;
		this.metrics.recordDuration(observation.durationMs);
		this.metrics.recordFailure(failure);
		observation.action = "stop";
		observation.outcome = failure.code === "CANCELLED" ? "cancelled" : "failure";
		this.metrics.recordAttempt(observation.toolName, "stop");
		const state = this.attempts.get(attemptKey(observation.toolCallId, failure.fingerprint));
		await this.append(observation, failure, state?.attempt ?? 1, "stop");
	}

	getDiagnostics(): ToolRecoveryDiagnostics {
		return this.metrics.snapshot("assist", this.circuits.size);
	}
}
