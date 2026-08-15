import { createFailureFingerprint, createToolCallFingerprint, type ToolCallFingerprint } from "./fingerprint.ts";
import { ToolExecutionError, type ToolFailure, type ToolSideEffect } from "./types.ts";

export interface ToolRecoveryPreflightContext extends ToolCallFingerprint {
	toolCallId: string;
	toolName: string;
	sideEffect: ToolSideEffect;
}

export interface ToolRecoveryObservation extends ToolRecoveryPreflightContext {
	action: "observe";
	outcome: "success" | "failure";
	durationMs: number;
	failure?: ToolFailure;
}

export interface ToolRecoveryController {
	preflight(context: ToolRecoveryPreflightContext, signal?: AbortSignal): void | Promise<void>;
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

	preflight(_context: ToolRecoveryPreflightContext, _signal?: AbortSignal): void {}

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
): Promise<ToolRecoveryCall> {
	return {
		toolCallId,
		toolName,
		sideEffect,
		...(await createToolCallFingerprint(toolName, args)),
		startedAt: Date.now(),
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
		if (/api[_-]?key|authorization|cookie|credential|password|secret|token|pid|time|requestid|traceid/i.test(key)) {
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
			targetHash: call.targetHash,
			constraint: details,
		}),
		callSignature: call.callSignature,
		...(call.targetHash ? { targetHash: call.targetHash } : {}),
		evidence: await createEvidence(details),
		occurredAt: new Date().toISOString(),
	};
}

export async function createToolRecoveryObservation(input: {
	call: ToolRecoveryCall;
	isError: boolean;
	error?: unknown;
	phase?: "execution" | "post_hook";
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
		durationMs: Math.max(0, Date.now() - input.call.startedAt),
		...(failure ? { failure } : {}),
	};
}
