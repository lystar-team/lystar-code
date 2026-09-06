import type {
	RecoveryAction as CoreRecoveryAction,
	ToolFailure,
	ToolRecoveryAttemptDecision,
	ToolRecoveryController,
	ToolRecoveryModelRecoveryAction,
	ToolRecoveryObservation,
	ToolRecoveryPreflightContext,
	ToolRecoveryPreflightResult,
} from "@earendil-works/pi-agent-core";
import type { ToolRecoveryMode } from "../../config.ts";
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
const MAX_MODEL_RECOVERY_ROUNDS = 2;
const REFINER_TIMEOUT_MS = 15_000;
const RETRYABLE_CODES = new Set(["TIMEOUT", "TRANSPORT_ERROR", "RATE_LIMITED"]);
const TRUSTED_READ_ONLY_TOOL_NAMES = new Set(["read", "grep", "find", "ls"]);
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
type CircuitState = { attempt: number; failure: ToolFailure; targetHash?: string; revision: number };

export interface ToolRecoveryDiagnostics {
	mode: ToolRecoveryMode;
	toolFailureTotal: Array<{ tool: string; code: string; count: number }>;
	toolRecoveryAttemptTotal: Array<{ tool: string; action: RecoveryAction; count: number }>;
	toolRecoverySuccessTotal: Array<{ tool: string; action: CoreRecoveryAction["type"]; count: number }>;
	toolRepeatBlockedTotal: Array<{ tool: string; code: string; count: number }>;
	toolUnsafeRetryBlockedTotal: Array<{ tool: string; count: number }>;
	lessonMatchTotal: Array<{ lesson: string; count: number }>;
	lessonRecoverySuccessTotal: Array<{ lesson: string; count: number }>;
	lessonSuspendedTotal: Array<{ lesson: string; count: number }>;
	duration: { count: number; totalMs: number; maxMs: number };
	activeCircuits: number;
}

export function createEmptyToolRecoveryDiagnostics(mode: ToolRecoveryMode): ToolRecoveryDiagnostics {
	return {
		mode,
		toolFailureTotal: [],
		toolRecoveryAttemptTotal: [],
		toolRecoverySuccessTotal: [],
		toolRepeatBlockedTotal: [],
		toolUnsafeRetryBlockedTotal: [],
		lessonMatchTotal: [],
		lessonRecoverySuccessTotal: [],
		lessonSuspendedTotal: [],
		duration: { count: 0, totalMs: 0, maxMs: 0 },
		activeCircuits: 0,
	};
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

	recordSuccess(toolName: string, action: CoreRecoveryAction["type"]): void {
		increment(this.successes, `${toolName}\u0000${action}`);
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
			toolRecoverySuccessTotal: unpack(this.successes).map(({ tool, code, count }) => ({
				tool,
				action: code as CoreRecoveryAction["type"],
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

function isWithinModelRecoveryTurnWindow(previousTurnId: string, currentTurnId: string): boolean {
	if (previousTurnId === currentTurnId) return true;
	const previous = Number(previousTurnId);
	const current = Number(currentTurnId);
	return (
		Number.isSafeInteger(previous) &&
		Number.isSafeInteger(current) &&
		current >= previous &&
		current - previous <= MODEL_RECOVERY_MAX_TURN_GAP
	);
}

function isSafeRetry(observation: ToolRecoveryObservation, error?: unknown): boolean {
	const failure = observation.failure;
	if (!failure) return false;
	return (
		failure.retryable &&
		RETRYABLE_CODES.has(failure.code) &&
		(isTrustedReadOnlyBuiltinTool(observation.toolName, observation.toolRuntimeContext) ||
			(TRUSTED_READ_ONLY_TOOL_NAMES.has(observation.toolName) &&
				isTrustedBuiltinRecoveryError(observation.toolName, error)))
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

interface PendingModelRecovery {
	toolName: string;
	failure: ToolFailure;
	attempt: number;
	callSignature: string;
	targetHash?: string;
	turnId: string;
	action: ToolRecoveryModelRecoveryAction;
	createdAt: number;
}

const MODEL_RECOVERY_MAX_AGE_MS = 5 * 60 * 1000;
const MODEL_RECOVERY_MAX_TURN_GAP = 2;
const MAX_PENDING_MODEL_RECOVERIES_PER_FAILURE = 4;

abstract class BaseToolRecoveryController implements ToolRecoveryController {
	protected readonly options: ControllerOptions;
	protected readonly metrics = new ToolRecoveryMetrics();
	private readonly refinerFailures: ToolRecoveryRefinerFailure[] = [];
	private readonly refinerFailureKeys = new Set<string>();
	private readonly pendingModelRecoveries = new Map<string, PendingModelRecovery[]>();
	private readonly progressRevisions = new Map<string, number>();
	private refinerInFlight?: Promise<void>;
	private refinerAbortController?: AbortController;
	protected taskContinuesRecovery = false;

	constructor(options: ControllerOptions) {
		this.options = options;
	}

	beginTask(): void {
		this.refinerAbortController?.abort();
		this.taskContinuesRecovery = this.pendingModelRecoveries.size > 0;
		this.pendingModelRecoveries.clear();
		this.progressRevisions.clear();
	}

	now(): number {
		return (this.options.now ?? Date.now)();
	}

	async waitForRetry(delayMs: number, signal?: AbortSignal): Promise<boolean> {
		return await (this.options.sleep ?? defaultSleep)(delayMs, signal);
	}

	protected currentProgressRevision(targetHash: string | undefined): number {
		return targetHash === undefined ? 0 : (this.progressRevisions.get(targetHash) ?? 0);
	}

	protected noteProgress(observation: ToolRecoveryObservation): void {
		if (observation.outcome !== "success" && observation.outcome !== "recovered") return;
		if (observation.targetHash === undefined) return;
		this.progressRevisions.set(observation.targetHash, this.currentProgressRevision(observation.targetHash) + 1);
	}

	protected circuitCanBlock(context: ToolRecoveryPreflightContext, state: CircuitState): boolean {
		if (state.targetHash !== context.targetHash) return false;
		if (state.targetHash !== undefined && state.revision !== this.currentProgressRevision(state.targetHash))
			return false;
		return (
			state.targetHash !== undefined || isTrustedReadOnlyBuiltinTool(context.toolName, context.toolRuntimeContext)
		);
	}

	protected createCircuitState(
		observation: Pick<ToolRecoveryObservation, "targetHash">,
		failure: ToolFailure,
		attempt: number,
	): CircuitState {
		return {
			attempt,
			failure,
			...(observation.targetHash ? { targetHash: observation.targetHash } : {}),
			revision: this.currentProgressRevision(observation.targetHash),
		};
	}

	protected async appendRefinerFailure(
		failure: ToolFailure,
		action: RecoveryAction,
		outcome: "recovered" | "failed" | "blocked" | "cancelled" | "needs_model",
	): Promise<void> {
		if (!this.options.refiner) return;
		const refinerFailure: ToolRecoveryRefinerFailure = {
			toolName: failure.toolName,
			code: failure.code,
			category: failure.category,
			fingerprint: failure.fingerprint,
			action,
			outcome,
			...(failure.targetHash ? { targetHash: failure.targetHash } : {}),
		};
		const key = `${refinerFailure.toolName}\u0000${refinerFailure.code}\u0000${refinerFailure.fingerprint}`;
		const existingIndex = this.refinerFailures.findIndex(
			(candidate) =>
				candidate.toolName === refinerFailure.toolName &&
				candidate.code === refinerFailure.code &&
				candidate.fingerprint === refinerFailure.fingerprint,
		);
		if (existingIndex >= 0) {
			this.refinerFailures[existingIndex] = refinerFailure;
			return;
		}
		if (this.refinerFailureKeys.has(key)) return;
		this.refinerFailureKeys.add(key);
		this.refinerFailures.push(refinerFailure);
	}

	private async runRefinement(): Promise<void> {
		const batch = this.refinerFailures.slice(0, 3);
		if (!this.options.refiner || !this.options.scopeHash || batch.length === 0) return;
		const controller = new AbortController();
		this.refinerAbortController = controller;
		let completed = false;
		try {
			const relatedLessons = await findToolRecoveryRefinerLessons(
				this.options.agentDir,
				this.options.scopeHash,
				batch,
			);
			let timeout: ReturnType<typeof setTimeout> | undefined;
			let output: unknown;
			try {
				output = await Promise.race([
					Promise.resolve(
						this.options.refiner({
							scopeHash: this.options.scopeHash,
							failures: batch,
							relatedLessons,
							userCorrections: sanitizeToolRecoveryUserCorrections(this.options.getUserCorrections?.()).slice(
								0,
								3,
							),
							signal: controller.signal,
						}),
					),
					new Promise<undefined>((resolve) => {
						timeout = setTimeout(() => {
							controller.abort();
							resolve(undefined);
						}, REFINER_TIMEOUT_MS);
					}),
				]);
			} finally {
				if (timeout) clearTimeout(timeout);
			}
			if (output === undefined) throw new Error("refiner returned no output");
			const proposal = parseToolRecoveryRefinerProposal(output);
			if (!proposal) throw new Error("refiner returned no valid proposal");
			if (proposal.type !== "none") {
				await applyToolRecoveryRefinerProposal(this.options.agentDir, this.options.scopeHash, proposal);
			}
			completed = true;
		} catch {
			// 提炼失败保留案例，下一轮可以重试；不能改变已完成的 Tool 结果。
		}
		if (!completed) return;
		const completedKeys = new Set(
			batch.map((failure) => `${failure.toolName}\u0000${failure.code}\u0000${failure.fingerprint}`),
		);
		const completedEntries = new Set(batch);
		for (let index = this.refinerFailures.length - 1; index >= 0; index--) {
			if (completedEntries.has(this.refinerFailures[index]!)) this.refinerFailures.splice(index, 1);
		}
		for (const key of completedKeys) {
			if (
				!this.refinerFailures.some(
					(failure) => `${failure.toolName}\u0000${failure.code}\u0000${failure.fingerprint}` === key,
				)
			) {
				this.refinerFailureKeys.delete(key);
			}
		}
	}

	async refineTurn(): Promise<void> {
		if (this.refinerInFlight) return this.refinerInFlight;
		this.refinerInFlight = this.runRefinement().finally(() => {
			this.refinerInFlight = undefined;
		});
		return this.refinerInFlight;
	}

	protected registerPendingModelRecovery(
		observation: ToolRecoveryObservation,
		failure: ToolFailure,
		attempt: number,
		action: ToolRecoveryModelRecoveryAction,
	): void {
		const key = `${failure.toolName}\u0000${failure.fingerprint}`;
		const pending = this.pendingModelRecoveries.get(key) ?? [];
		pending.push({
			toolName: observation.toolName,
			failure,
			attempt,
			callSignature: observation.callSignature,
			...(observation.targetHash ? { targetHash: observation.targetHash } : {}),
			turnId: this.options.getTurnId(),
			action,
			createdAt: this.now(),
		});
		if (pending.length > MAX_PENDING_MODEL_RECOVERIES_PER_FAILURE) pending.shift();
		this.pendingModelRecoveries.set(key, pending);
	}

	protected async recordPendingModelRecoverySuccess(observation: ToolRecoveryObservation): Promise<boolean> {
		if (observation.outcome !== "success") return false;
		const now = this.now();
		for (const [key, pending] of this.pendingModelRecoveries) {
			while (pending.length > 0 && now - pending[0]!.createdAt > MODEL_RECOVERY_MAX_AGE_MS) pending.shift();
			const index = pending.findIndex(
				(candidate) =>
					isWithinModelRecoveryTurnWindow(candidate.turnId, this.options.getTurnId()) &&
					candidate.toolName === observation.toolName &&
					candidate.targetHash === observation.targetHash &&
					now - candidate.createdAt <= MODEL_RECOVERY_MAX_AGE_MS &&
					candidate.callSignature !== observation.callSignature,
			);
			if (index === -1) {
				if (pending.length === 0) this.pendingModelRecoveries.delete(key);
				continue;
			}
			const [candidate] = pending.splice(index, 1);
			if (pending.length === 0) this.pendingModelRecoveries.delete(key);
			if (!candidate) continue;
			observation.action = candidate.action;
			observation.outcome = "recovered";
			observation.failure = candidate.failure;
			this.metrics.recordSuccess(observation.toolName, candidate.action);
			await this.append(observation, candidate.failure, candidate.attempt + 1, candidate.action);
			return true;
		}
		return false;
	}

	protected discardPendingModelRecoveries(observation: ToolRecoveryObservation): void {
		for (const [key, pending] of this.pendingModelRecoveries) {
			const remaining = pending.filter(
				(candidate) =>
					candidate.toolName !== observation.toolName || candidate.targetHash !== observation.targetHash,
			);
			if (remaining.length === 0) this.pendingModelRecoveries.delete(key);
			else this.pendingModelRecoveries.set(key, remaining);
		}
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
			await this.appendRefinerFailure(failure, action, outcome);
			await recordDeterministicToolRecoveryCandidate(this.options.agentDir, {
				scopeHash: this.options.scopeHash,
				receipt,
				autoVerify: true,
			});
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

	getFailureForToolCall(_toolCallId: string): ToolFailure | undefined {
		return undefined;
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

/** assist 只把确定可恢复的错误转换为模型 guidance，不在 Tool 内部执行恢复动作。 */
export class AssistToolRecoveryController extends BaseToolRecoveryController {
	private readonly circuits = new Map<string, CircuitState>();
	private readonly attempts = new Map<string, AttemptState>();
	private readonly rebuiltFingerprints = new Map<string, number>();
	private readonly closedFingerprints = new Set<string>();

	beginTask(): void {
		super.beginTask();
		this.circuits.clear();
		this.attempts.clear();
		if (!this.taskContinuesRecovery) {
			this.rebuiltFingerprints.clear();
			this.closedFingerprints.clear();
		}
	}

	getFailureForToolCall(toolCallId: string): ToolFailure | undefined {
		return Array.from(this.attempts.entries()).find(([key]) => key.startsWith(`${toolCallId}\u0000`))?.[1].failure;
	}

	async preflight(context: ToolRecoveryPreflightContext): Promise<ToolRecoveryPreflightResult | undefined> {
		const circuit = Array.from(this.circuits.entries()).find(
			([key, state]) => key.startsWith(`${context.callSignature}\u0000`) && this.circuitCanBlock(context, state),
		);
		for (const [key, state] of this.circuits) {
			if (key.startsWith(`${context.callSignature}\u0000`) && !this.circuitCanBlock(context, state)) {
				this.circuits.delete(key);
			}
		}
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
		this.discardPendingModelRecoveries(observation);
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

		let action: ToolRecoveryResolution | undefined;
		if (
			(isTrustedBuiltinTool(observation.toolName, observation.toolRuntimeContext) ||
				isTrustedBuiltinRecoveryError(observation.toolName, error)) &&
			!signal?.aborted
		) {
			const resolution = await runToolRecoveryHandler(error, signal);
			if (resolution?.type === "ask_model_to_rebuild") {
				const rebuildAttempt = this.rebuiltFingerprints.get(failure.fingerprint) ?? 0;
				if (rebuildAttempt >= MAX_MODEL_RECOVERY_ROUNDS) {
					this.closedFingerprints.add(failure.fingerprint);
				} else {
					this.rebuiltFingerprints.set(failure.fingerprint, rebuildAttempt + 1);
					action = resolution;
				}
			}
		}
		if (this.closedFingerprints.has(failure.fingerprint)) {
			observation.action = "stop";
			observation.outcome = "failure";
			this.metrics.recordAttempt(observation.toolName, "stop");
			this.circuits.set(
				circuitKey(observation.callSignature, failure.fingerprint),
				this.createCircuitState(observation, failure, state.attempt),
			);
			await this.append(observation, failure, state.attempt, "stop");
			return { action: { type: "stop", reason: "model recovery budget exhausted" }, observation };
		}
		if (!action && isSafeRetry(observation, error)) {
			const rebuildAttempt = this.rebuiltFingerprints.get(failure.fingerprint) ?? 0;
			if (rebuildAttempt < MAX_MODEL_RECOVERY_ROUNDS) {
				this.rebuiltFingerprints.set(failure.fingerprint, rebuildAttempt + 1);
				const guidance =
					"该只读 Tool 遇到暂时性错误。请在改变参数、刷新状态或改用其他工具后再继续，不要原样重复调用。";
				action = {
					type: "ask_model_to_rebuild",
					guidance,
					replacementResult: { content: [{ type: "text", text: guidance }], details: {} },
				};
			}
		}

		if (action) {
			observation.action = action.type;
			observation.outcome = "needs_model";
			this.metrics.recordAttempt(observation.toolName, action.type);
			if (action.type === "ask_model_to_rebuild" || action.type === "refresh_context") {
				this.registerPendingModelRecovery(observation, failure, state.attempt, action.type);
			}
			this.circuits.set(
				circuitKey(observation.callSignature, failure.fingerprint),
				this.createCircuitState(observation, failure, state.attempt),
			);
			await this.append(observation, failure, state.attempt, action.type);
			return { action, observation };
		}

		observation.action = "stop";
		observation.outcome = "failure";
		this.metrics.recordAttempt(observation.toolName, "stop");
		if (!isSafeRetry(observation, error)) this.metrics.recordUnsafeRetryBlocked(observation.toolName);
		if (failure.code !== "POST_HOOK_FAILURE") {
			this.circuits.set(
				circuitKey(observation.callSignature, failure.fingerprint),
				this.createCircuitState(observation, failure, state.attempt),
			);
		}
		await this.append(observation, failure, state.attempt, "stop");
		return { action: { type: "stop", reason: "automatic recovery disabled" }, observation };
	}

	async observe(observation: ToolRecoveryObservation, signal?: AbortSignal, error?: unknown): Promise<void> {
		this.metrics.recordDuration(observation.durationMs);
		await adaptToolRecoveryObservation(observation, error, signal);
		this.noteProgress(observation);
		if (await this.recordPendingModelRecoverySuccess(observation)) return;
		if (!observation.failure) return;
		const failure = observation.failure;
		if (!failure) return;
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

/** auto 在 assist 语义之上执行白名单内的安全恢复动作。 */
export class AutoToolRecoveryController extends BaseToolRecoveryController {
	private readonly circuits = new Map<string, CircuitState>();
	private readonly attempts = new Map<string, AttemptState>();
	private readonly recovered = new Map<string, AttemptState>();
	private readonly rebuiltFingerprints = new Map<string, number>();
	private readonly closedFingerprints = new Set<string>();
	private readonly refreshedFingerprints = new Set<string>();

	beginTask(): void {
		super.beginTask();
		this.circuits.clear();
		this.attempts.clear();
		this.recovered.clear();
		if (!this.taskContinuesRecovery) {
			this.rebuiltFingerprints.clear();
			this.closedFingerprints.clear();
			this.refreshedFingerprints.clear();
		}
	}

	getFailureForToolCall(toolCallId: string): ToolFailure | undefined {
		return Array.from(this.attempts.entries()).find(([key]) => key.startsWith(`${toolCallId}\u0000`))?.[1].failure;
	}

	async preflight(context: ToolRecoveryPreflightContext): Promise<ToolRecoveryPreflightResult | undefined> {
		const circuit = Array.from(this.circuits.entries()).find(
			([key, state]) => key.startsWith(`${context.callSignature}\u0000`) && this.circuitCanBlock(context, state),
		);
		for (const [key, state] of this.circuits) {
			if (key.startsWith(`${context.callSignature}\u0000`) && !this.circuitCanBlock(context, state)) {
				this.circuits.delete(key);
			}
		}
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
		this.discardPendingModelRecoveries(observation);
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
			this.circuits.set(
				circuitKey(observation.callSignature, failure.fingerprint),
				this.createCircuitState(observation, failure, state.attempt),
			);
			await this.append(observation, failure, state.attempt, "stop");
			return { action: { type: "stop", reason: "model recovery budget exhausted" }, observation };
		}

		if (
			(isTrustedBuiltinTool(observation.toolName, observation.toolRuntimeContext) ||
				isTrustedBuiltinRecoveryError(observation.toolName, error)) &&
			!signal?.aborted
		) {
			const resolution = await runToolRecoveryHandler(error, signal);
			if (resolution) {
				const rebuildAttempt = this.rebuiltFingerprints.get(failure.fingerprint) ?? 0;
				const isRepeatRebuild =
					resolution.type === "ask_model_to_rebuild" && rebuildAttempt >= MAX_MODEL_RECOVERY_ROUNDS;
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
					if (resolution.type === "ask_model_to_rebuild" || resolution.type === "refresh_context") {
						this.registerPendingModelRecovery(observation, failure, state.attempt, resolution.type);
					}
					if (resolution.type !== "accept_as_success") {
						this.circuits.set(
							circuitKey(observation.callSignature, failure.fingerprint),
							this.createCircuitState(observation, failure, state.attempt),
						);
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
			this.circuits.set(
				circuitKey(observation.callSignature, failure.fingerprint),
				this.createCircuitState(observation, failure, state.attempt),
			);
			await this.append(observation, failure, state.attempt, action.type);
			return { action, observation };
		}

		if (isSafeRetry(observation, error) && state.attempt <= MAX_RECOVERY_RETRIES) {
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
		if (!isSafeRetry(observation, error)) this.metrics.recordUnsafeRetryBlocked(observation.toolName);
		if (failure.code !== "POST_HOOK_FAILURE") {
			this.circuits.set(
				circuitKey(observation.callSignature, failure.fingerprint),
				this.createCircuitState(observation, failure, state.attempt),
			);
		}
		await this.append(observation, failure, state.attempt, "stop");
		return { action: { type: "stop", reason: "retry policy denied" }, observation };
	}

	async observe(observation: ToolRecoveryObservation, signal?: AbortSignal, error?: unknown): Promise<void> {
		this.metrics.recordDuration(observation.durationMs);
		this.noteProgress(observation);
		if (await this.recordPendingModelRecoverySuccess(observation)) return;
		if (observation.outcome === "success") {
			const state = this.recovered.get(observation.toolCallId);
			if (!state) return;
			this.recovered.delete(observation.toolCallId);
			observation.action = "retry_same_args";
			observation.outcome = "recovered";
			observation.failure = state.failure;
			this.metrics.recordSuccess(observation.toolName, "retry_same_args");
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
		return this.metrics.snapshot("auto", this.circuits.size);
	}
}
