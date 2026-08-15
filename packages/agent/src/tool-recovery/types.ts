export type ToolFailureCategory =
	| "arguments"
	| "precondition"
	| "stale_state"
	| "resource"
	| "transient"
	| "permission"
	| "cancelled"
	| "execution"
	| "unknown";

export type ToolSideEffect =
	| "read_only"
	| "idempotent_write"
	| "conditional_write"
	| "non_idempotent_write"
	| "external_side_effect"
	| "unknown";

export interface ToolFailure {
	schema: 1;
	toolName: string;
	toolVersion?: string;
	code: string;
	category: ToolFailureCategory;
	sideEffect: ToolSideEffect;
	retryable: boolean;
	fingerprint: string;
	callSignature: string;
	targetHash?: string;
	evidence: Record<string, string | number | boolean>;
	occurredAt: string;
}

export type RecoveryAction =
	| { type: "accept_as_success"; verification: string }
	| { type: "retry_same_args"; delayMs: number }
	| { type: "refresh_context"; adapter: string }
	| { type: "ask_model_to_rebuild"; guidance: string }
	| { type: "suggest_alternative_tool"; toolName: string }
	| { type: "require_user"; reason: string }
	| { type: "stop"; reason: string };

export interface ToolExecutionErrorOptions {
	code: string;
	category: ToolFailureCategory;
	retryable: boolean;
	details?: Record<string, unknown>;
	cause?: Error;
}

export class ToolExecutionError extends Error {
	public readonly code: string;
	public readonly category: ToolFailureCategory;
	public readonly retryable: boolean;
	public readonly details?: Record<string, unknown>;

	constructor(message: string, options: ToolExecutionErrorOptions) {
		super(message, options.cause === undefined ? undefined : { cause: options.cause });
		this.name = "ToolExecutionError";
		this.code = options.code;
		this.category = options.category;
		this.retryable = options.retryable;
		this.details = options.details;
	}
}
