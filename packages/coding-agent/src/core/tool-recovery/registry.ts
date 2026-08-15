import {
	createFailureFingerprint,
	ToolExecutionError,
	type ToolFailure,
	type ToolFailureCategory,
	type ToolRecoveryObservation,
	type ToolSideEffect,
} from "@earendil-works/pi-agent-core";

const STABLE_FAILURES = {
	ARGUMENTS_SCHEMA_INVALID: { category: "arguments", retryable: false },
	TOOL_UNAVAILABLE: { category: "resource", retryable: false },
	TARGET_NOT_FOUND: { category: "precondition", retryable: false },
	MATCH_NOT_FOUND: { category: "precondition", retryable: false },
	MATCH_AMBIGUOUS: { category: "precondition", retryable: false },
	NO_CHANGE: { category: "precondition", retryable: false },
	STALE_CONTEXT: { category: "stale_state", retryable: false },
	WRITE_CONFLICT: { category: "stale_state", retryable: false },
	PERMISSION_DENIED: { category: "permission", retryable: false },
	RATE_LIMITED: { category: "transient", retryable: true },
	TIMEOUT: { category: "transient", retryable: true },
	TRANSPORT_ERROR: { category: "transient", retryable: true },
	PROCESS_EXIT_NONZERO: { category: "execution", retryable: false },
	POST_HOOK_FAILURE: { category: "execution", retryable: false },
	CANCELLED: { category: "cancelled", retryable: false },
	RESOURCE_EXHAUSTED: { category: "resource", retryable: false },
	UNCLASSIFIED: { category: "unknown", retryable: false },
} as const satisfies Record<string, { category: ToolFailureCategory; retryable: boolean }>;

type StableFailureCode = keyof typeof STABLE_FAILURES;

type ClassifiedFailure = {
	code: StableFailureCode;
	category: ToolFailureCategory;
	retryable: boolean;
};

const READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls"]);
const CONDITIONAL_WRITE_TOOLS = new Set(["edit", "write", "apply_patch"]);
const PERMISSION_CODES = new Set(["EACCES", "EPERM"]);
const TIMEOUT_CODES = new Set(["ETIMEDOUT", "ETIME"]);
const TRANSPORT_CODES = new Set([
	"ECONNABORTED",
	"ECONNREFUSED",
	"ECONNRESET",
	"EHOSTUNREACH",
	"EAI_AGAIN",
	"ENETDOWN",
	"ENETUNREACH",
]);
const RESOURCE_CODES = new Set(["EDQUOT", "EFBIG", "EMFILE", "ENFILE", "ENOMEM", "ENOSPC"]);

export function getToolSideEffect(toolName: string): ToolSideEffect {
	if (READ_ONLY_TOOLS.has(toolName)) return "read_only";
	if (CONDITIONAL_WRITE_TOOLS.has(toolName)) return "conditional_write";
	return "unknown";
}

export function isStableFailureCode(code: string): code is StableFailureCode {
	return Object.hasOwn(STABLE_FAILURES, code);
}

function errorCode(error: unknown): string | undefined {
	if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
	const code = (error as { code?: unknown }).code;
	return typeof code === "string" ? code : undefined;
}

function errorName(error: unknown): string | undefined {
	return error instanceof Error ? error.name : undefined;
}

function classifyStable(code: StableFailureCode, sideEffect: ToolSideEffect, retryable?: boolean): ClassifiedFailure {
	const stable = STABLE_FAILURES[code];
	return {
		code,
		category: stable.category,
		retryable: Boolean(retryable ?? stable.retryable) && sideEffect === "read_only",
	};
}

function classifyBashError(error: unknown): ClassifiedFailure | undefined {
	if (!(error instanceof Error)) return undefined;
	if (/(?:^|\n\n)Command aborted$/.test(error.message)) {
		return classifyStable("CANCELLED", "unknown");
	}
	if (/(?:^|\n\n)Command timed out after \d+(?:\.\d+)? seconds$/.test(error.message)) {
		return classifyStable("TIMEOUT", "unknown");
	}
	if (/(?:^|\n\n)Command exited with code -?\d+$/.test(error.message)) {
		return classifyStable("PROCESS_EXIT_NONZERO", "unknown");
	}
	return undefined;
}

function classifyError(
	error: unknown,
	sideEffect: ToolSideEffect,
	toolName: string,
	signal: AbortSignal | undefined,
): ClassifiedFailure {
	if (error instanceof ToolExecutionError && isStableFailureCode(error.code)) {
		return classifyStable(error.code, sideEffect, error.retryable);
	}

	if (signal?.aborted || errorName(error) === "AbortError" || errorCode(error) === "ABORT_ERR") {
		return classifyStable("CANCELLED", sideEffect);
	}

	const code = errorCode(error);
	if (code && isStableFailureCode(code)) return classifyStable(code, sideEffect);
	if (code && PERMISSION_CODES.has(code)) return classifyStable("PERMISSION_DENIED", sideEffect);
	if (code && TIMEOUT_CODES.has(code)) return classifyStable("TIMEOUT", sideEffect);
	if (code && TRANSPORT_CODES.has(code)) return classifyStable("TRANSPORT_ERROR", sideEffect);
	if (code && RESOURCE_CODES.has(code)) return classifyStable("RESOURCE_EXHAUSTED", sideEffect);
	if (toolName === "bash") return classifyBashError(error) ?? classifyStable("UNCLASSIFIED", sideEffect);
	return classifyStable("UNCLASSIFIED", sideEffect);
}

export async function adaptToolRecoveryObservation(
	observation: ToolRecoveryObservation,
	error: unknown,
	signal?: AbortSignal,
): Promise<void> {
	const sideEffect = getToolSideEffect(observation.toolName);
	observation.sideEffect = sideEffect;
	const failure = observation.failure;
	if (!failure) return;

	const classified = classifyError(error, sideEffect, observation.toolName, signal);
	failure.code = classified.code;
	failure.category = classified.category;
	failure.sideEffect = sideEffect;
	failure.retryable = classified.retryable;
	failure.fingerprint = await createFailureFingerprint({
		toolName: observation.toolName,
		code: classified.code,
		targetHash: observation.targetHash,
		constraint: failure.evidence,
	});
}

export function classifyToolFailureForTest(input: {
	toolName: string;
	error: unknown;
	signal?: AbortSignal;
}): Pick<ToolFailure, "code" | "category" | "retryable" | "sideEffect"> {
	const sideEffect = getToolSideEffect(input.toolName);
	const classified = classifyError(input.error, sideEffect, input.toolName, input.signal);
	return { ...classified, sideEffect };
}
