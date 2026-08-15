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
	| { type: "accept_as_success"; verification: string; replacementResult: ToolRecoveryReplacementResult }
	| { type: "retry_same_args"; delayMs: number }
	| { type: "refresh_context"; adapter: string; replacementResult: ToolRecoveryReplacementResult }
	| { type: "ask_model_to_rebuild"; guidance: string; replacementResult: ToolRecoveryReplacementResult }
	| { type: "require_user"; reason: string; replacementResult?: ToolRecoveryReplacementResult }
	| { type: "stop"; reason: string; replacementResult?: ToolRecoveryReplacementResult };

export interface ToolRecoveryReplacementResult {
	content: Array<{ type: "text"; text: string }>;
	details: Record<string, unknown>;
	terminate?: boolean;
}

export type ToolRecoveryResolution =
	| { type: "accept_as_success"; verification: string; replacementResult: ToolRecoveryReplacementResult }
	| { type: "refresh_context"; adapter: string; replacementResult: ToolRecoveryReplacementResult }
	| { type: "ask_model_to_rebuild"; guidance: string; replacementResult: ToolRecoveryReplacementResult }
	| { type: "require_user"; reason: string; replacementResult?: ToolRecoveryReplacementResult }
	| { type: "stop"; reason: string; replacementResult?: ToolRecoveryReplacementResult };

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
