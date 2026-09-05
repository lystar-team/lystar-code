import {
	type AgentTool,
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
	EDIT_OVERLAP: { category: "precondition", retryable: false },
	NO_CHANGE: { category: "precondition", retryable: false },
	PATCH_PARSE_ERROR: { category: "arguments", retryable: false },
	PATCH_TARGET_NOT_FOUND: { category: "precondition", retryable: false },
	PATCH_MATCH_NOT_FOUND: { category: "precondition", retryable: false },
	PATCH_MATCH_AMBIGUOUS: { category: "precondition", retryable: false },
	PATCH_NO_CHANGE: { category: "precondition", retryable: false },
	PATCH_WRITE_CONFLICT: { category: "stale_state", retryable: false },
	PATCH_WRITE_FAILED: { category: "execution", retryable: false },
	PATCH_ROLLBACK_FAILED: { category: "execution", retryable: false },
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

type BuiltInToolIdentity = {
	name: string;
	sideEffect: ToolSideEffect;
};

const BUILT_IN_SIDE_EFFECTS: Readonly<Record<string, ToolSideEffect>> = {
	read: "read_only",
	grep: "read_only",
	find: "read_only",
	ls: "read_only",
	edit: "conditional_write",
	write: "conditional_write",
	apply_patch: "conditional_write",
	bash: "unknown",
};
const builtInToolIdentities = new WeakMap<object, BuiltInToolIdentity>();
const builtInRecoveryErrors = new WeakMap<object, string>();
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

/** 将当前运行时生成的内置 Tool 实例标记为可信，扩展无法通过名称伪造该身份。 */
export function registerBuiltInToolIdentity(tool: AgentTool): void {
	const sideEffect = BUILT_IN_SIDE_EFFECTS[tool.name];
	if (sideEffect === undefined) return;
	const runtimeContext = {};
	builtInToolIdentities.set(runtimeContext, { name: tool.name, sideEffect });
	tool.runtimeContext = runtimeContext;
}

function getBuiltInToolIdentity(runtimeContext: unknown): BuiltInToolIdentity | undefined {
	return typeof runtimeContext === "object" && runtimeContext !== null
		? builtInToolIdentities.get(runtimeContext)
		: undefined;
}

export function getToolSideEffect(runtimeContext?: unknown): ToolSideEffect {
	return getBuiltInToolIdentity(runtimeContext)?.sideEffect ?? "unknown";
}

export function isTrustedBuiltinTool(toolName: string, runtimeContext?: unknown): boolean {
	return getBuiltInToolIdentity(runtimeContext)?.name === toolName;
}

/** 运行中保留内置 Tool 产生错误的来源身份，避免请求上下文重建时丢失 runtimeContext。 */
export function registerBuiltInRecoveryError(toolName: string, error: ToolExecutionError): ToolExecutionError {
	if (BUILT_IN_SIDE_EFFECTS[toolName] !== undefined) builtInRecoveryErrors.set(error, toolName);
	return error;
}

export function isTrustedBuiltinRecoveryError(toolName: string, error: unknown): boolean {
	return typeof error === "object" && error !== null && builtInRecoveryErrors.get(error) === toolName;
}

/** 自动重试只信任运行时登记过的内置只读 Tool，名称相同的 Extension 不具备该资格。 */
export function isTrustedReadOnlyBuiltinTool(toolName: string, runtimeContext?: unknown): boolean {
	const identity = getBuiltInToolIdentity(runtimeContext);
	return (
		identity?.name === toolName &&
		identity.sideEffect === "read_only" &&
		(toolName === "read" || toolName === "grep" || toolName === "find" || toolName === "ls")
	);
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
	identity: BuiltInToolIdentity | undefined,
	signal: AbortSignal | undefined,
): ClassifiedFailure {
	const sideEffect = identity?.sideEffect ?? "unknown";
	if (error instanceof ToolExecutionError && isStableFailureCode(error.code)) {
		return classifyStable(error.code, sideEffect, error.retryable);
	}

	if (signal?.aborted || errorName(error) === "AbortError" || errorCode(error) === "ABORT_ERR") {
		return classifyStable("CANCELLED", sideEffect);
	}

	// 名称不是身份。只有实际注册过的内置 Tool 才能将底层错误映射为稳定分类。
	if (!identity) return classifyStable("UNCLASSIFIED", sideEffect);

	const code = errorCode(error);
	if (code && isStableFailureCode(code)) return classifyStable(code, sideEffect);
	if (code && PERMISSION_CODES.has(code)) return classifyStable("PERMISSION_DENIED", sideEffect);
	if (code && TIMEOUT_CODES.has(code)) return classifyStable("TIMEOUT", sideEffect);
	if (code && TRANSPORT_CODES.has(code)) return classifyStable("TRANSPORT_ERROR", sideEffect);
	if (code && RESOURCE_CODES.has(code)) return classifyStable("RESOURCE_EXHAUSTED", sideEffect);
	if (identity.name === "bash") return classifyBashError(error) ?? classifyStable("UNCLASSIFIED", sideEffect);
	return classifyStable("UNCLASSIFIED", sideEffect);
}

export async function adaptToolRecoveryObservation(
	observation: ToolRecoveryObservation,
	error: unknown,
	signal?: AbortSignal,
): Promise<void> {
	const identity = getBuiltInToolIdentity(observation.toolRuntimeContext);
	const sideEffect = identity?.sideEffect ?? "unknown";
	observation.sideEffect = sideEffect;
	const failure = observation.failure;
	if (!failure) return;

	// Agent core 已经对非 UNCLASSIFIED 的稳定错误完成归一化。adapter 不读取错误文本覆盖它。
	if (failure.code !== "UNCLASSIFIED" && isStableFailureCode(failure.code)) {
		failure.sideEffect = sideEffect;
		if (failure.code === "POST_HOOK_FAILURE") failure.retryable = false;
		return;
	}

	const classified = classifyError(error, identity, signal);
	failure.code = classified.code;
	failure.category = classified.category;
	failure.sideEffect = sideEffect;
	failure.retryable = classified.retryable;
	const failureTargetHash = failure.targetHash ?? observation.targetHash;
	failure.fingerprint = await createFailureFingerprint({
		toolName: observation.toolName,
		code: classified.code,
		targetHash: failureTargetHash,
		constraint: error instanceof ToolExecutionError ? error.fingerprintConstraint : undefined,
	});
	if (failureTargetHash) failure.targetHash = failureTargetHash;
}

export function classifyToolFailureForTest(input: {
	toolName: string;
	error: unknown;
	signal?: AbortSignal;
	runtimeContext?: unknown;
}): Pick<ToolFailure, "code" | "category" | "retryable" | "sideEffect"> {
	const identity = getBuiltInToolIdentity(input.runtimeContext);
	const classified = classifyError(input.error, identity, input.signal);
	return { ...classified, sideEffect: identity?.sideEffect ?? "unknown" };
}
