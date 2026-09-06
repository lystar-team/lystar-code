import { createFailureFingerprint, createToolCallFingerprint, type ToolCallFingerprint } from "./fingerprint.ts";
import {
	type RecoveryAction,
	ToolExecutionError,
	type ToolFailure,
	type ToolRecoveryResolution,
	type ToolSideEffect,
} from "./types.ts";

export interface ToolRecoveryPreflightContext extends ToolCallFingerprint {
	toolCallId: string;
	toolName: string;
	sideEffect: ToolSideEffect;
	/** 当前执行 Tool 的仅进程内身份，禁止持久化或透传到事件。 */
	toolRuntimeContext?: unknown;
}

export type ToolRecoveryEventAction = "observe" | RecoveryAction["type"];
export type ToolRecoveryEventOutcome = "success" | "failure" | "recovered" | "needs_model" | "blocked" | "cancelled";
export type ToolRecoveryModelRecoveryAction = Extract<
	RecoveryAction,
	{ type: "refresh_context" | "ask_model_to_rebuild" }
>["type"];

export interface ToolRecoveryObservation extends ToolRecoveryPreflightContext {
	action: ToolRecoveryEventAction;
	outcome: ToolRecoveryEventOutcome;
	durationMs: number;
	/** 第二次相同内部失败进入 warning，但不会改变 logical Tool 生命周期。 */
	warning?: boolean;
	failure?: ToolFailure;
}

export interface ToolRecoveryPreflightResult {
	blocked: true;
	failure: ToolFailure;
	message: string;
}

export interface ToolRecoveryAttemptDecision {
	action: RecoveryAction;
	observation: ToolRecoveryObservation;
}

export interface ToolRecoveryHandlerContext {
	signal?: AbortSignal;
}

export type ToolRecoveryHandler = (
	context: ToolRecoveryHandlerContext,
) => ToolRecoveryResolution | undefined | Promise<ToolRecoveryResolution | undefined>;

const recoveryHandlers = new WeakMap<ToolExecutionError, ToolRecoveryHandler>();

/** 仅为当前失败保留不可持久化的恢复验证入口。 */
export function attachToolRecoveryHandler(error: ToolExecutionError, handler: ToolRecoveryHandler): ToolExecutionError {
	recoveryHandlers.set(error, handler);
	return error;
}

export async function runToolRecoveryHandler(
	error: unknown,
	context: ToolRecoveryHandlerContext,
): Promise<ToolRecoveryResolution | undefined> {
	if (!(error instanceof ToolExecutionError)) return undefined;
	return await recoveryHandlers.get(error)?.(context);
}

export interface ToolRecoveryController {
	/** 新用户任务开始时清理上一任务的电路、待归因状态和进展代次。 */
	beginTask?(): void;
	preflight(
		context: ToolRecoveryPreflightContext,
		signal?: AbortSignal,
	): ToolRecoveryPreflightResult | undefined | Promise<ToolRecoveryPreflightResult | undefined>;
	/** 只有 auto controller 实现；未实现时保持 observe/assist 行为。 */
	decideAttempt?(
		observation: ToolRecoveryObservation,
		signal?: AbortSignal,
		error?: unknown,
	): ToolRecoveryAttemptDecision | undefined | Promise<ToolRecoveryAttemptDecision | undefined>;
	/** auto controller 的退避实现必须可被取消，且不遗留后台 timer。 */
	waitForRetry?(delayMs: number, signal?: AbortSignal): boolean | Promise<boolean>;
	/** 注入时钟供有界 retry 的测试和 duration 计算使用。 */
	now?(): number;
	/** `error` 仅供当前进程内的 adapter 分类，禁止写入 Agent event、Session 或 ledger。 */
	observe(observation: ToolRecoveryObservation, signal?: AbortSignal, error?: unknown): void | Promise<void>;
}

/** 默认观察控制器，不改变 Tool 执行和最终结果。 */
export class ObserveToolRecoveryController implements ToolRecoveryController {
	private readonly onObserve?: (
		observation: ToolRecoveryObservation,
		signal?: AbortSignal,
		error?: unknown,
	) => void | Promise<void>;

	constructor(
		onObserve?: (observation: ToolRecoveryObservation, signal?: AbortSignal, error?: unknown) => void | Promise<void>,
	) {
		this.onObserve = onObserve;
	}

	preflight(_context: ToolRecoveryPreflightContext, _signal?: AbortSignal): undefined {
		return undefined;
	}

	observe(observation: ToolRecoveryObservation, signal?: AbortSignal, error?: unknown): void | Promise<void> {
		return this.onObserve?.(observation, signal, error);
	}
}

export interface ToolRecoveryCall extends ToolRecoveryPreflightContext {
	startedAt: number;
}

export async function createToolRecoveryCall(
	toolCallId: string,
	toolName: string,
	args: unknown,
	sideEffect: ToolSideEffect = "unknown",
	toolRuntimeContext?: unknown,
	now: () => number = Date.now,
): Promise<ToolRecoveryCall> {
	return {
		toolCallId,
		toolName,
		sideEffect,
		...(toolRuntimeContext === undefined ? {} : { toolRuntimeContext }),
		...(await createToolCallFingerprint(toolName, args)),
		startedAt: now(),
	};
}

function isEvidenceValue(value: unknown): value is string | number | boolean {
	return (
		typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))
	);
}

async function createEvidence(
	details: Record<string, unknown> | undefined,
): Promise<Record<string, string | number | boolean>> {
	if (!details) return {};
	const evidence: Record<string, string | number | boolean> = {};
	for (const key of Object.keys(details).sort()) {
		if (
			/api[_-]?key|authorization|cookie|credential|password|secret|token|pid|time|requestid|traceid|path|patch|content|evidence/i.test(
				key,
			)
		) {
			continue;
		}
		const value = details[key];
		if (typeof value === "string") {
			evidence[key] =
				`sha256:${await createFailureFingerprint({ toolName: "evidence", code: key, constraint: value })}`;
		} else if (isEvidenceValue(value)) {
			evidence[key] = value;
		}
	}
	return evidence;
}

async function createFailure(
	call: ToolRecoveryCall,
	error: unknown,
	phase: "execution" | "post_hook",
): Promise<ToolFailure> {
	const executionError = error instanceof ToolExecutionError ? error : undefined;
	const code = phase === "post_hook" ? "POST_HOOK_FAILURE" : (executionError?.code ?? "UNCLASSIFIED");
	const category = phase === "post_hook" ? "execution" : (executionError?.category ?? "unknown");
	const retryable = phase === "execution" && (executionError?.retryable ?? false);
	const details = executionError?.details;
	const targetHash = executionError?.failureTargetHash ?? call.targetHash;
	return {
		schema: 1,
		toolName: call.toolName,
		code,
		category,
		sideEffect: call.sideEffect,
		retryable,
		fingerprint: await createFailureFingerprint({
			toolName: call.toolName,
			code,
			targetHash,
			constraint: executionError?.fingerprintConstraint,
		}),
		callSignature: call.callSignature,
		...(targetHash ? { targetHash } : {}),
		evidence: await createEvidence(details),
		occurredAt: new Date().toISOString(),
	};
}

export async function createToolRecoveryObservation(input: {
	call: ToolRecoveryCall;
	isError: boolean;
	error?: unknown;
	phase?: "execution" | "post_hook";
	now?: () => number;
}): Promise<ToolRecoveryObservation> {
	const failure = input.isError ? await createFailure(input.call, input.error, input.phase ?? "execution") : undefined;
	return {
		toolCallId: input.call.toolCallId,
		toolName: input.call.toolName,
		callSignature: input.call.callSignature,
		...(input.call.targetHash ? { targetHash: input.call.targetHash } : {}),
		sideEffect: input.call.sideEffect,
		action: "observe",
		outcome: failure ? "failure" : "success",
		durationMs: Math.max(0, (input.now ?? Date.now)() - input.call.startedAt),
		...(failure ? { failure } : {}),
	};
}
