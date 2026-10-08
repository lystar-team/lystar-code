/**
 * AgentSession - Core abstraction for agent lifecycle and session management.
 *
 * This class is shared between all run modes (interactive, print, rpc).
 * It encapsulates:
 * - Agent state access
 * - Event subscription with automatic session persistence
 * - Model and thinking level management
 * - Compaction (manual and auto)
 * - Bash execution
 * - Session switching and branching
 *
 * Modes use this class and add their own I/O layer on top.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import {
	type AfterToolCallContext,
	type AfterToolCallResult,
	type Agent,
	type AgentContext,
	type AgentEvent,
	type AgentMessage,
	type AgentState,
	type AgentTool,
	type AgentToolCallOutcome,
	type BeforeToolCallContext,
	type BeforeToolCallResult,
	type PrepareNextTurnContext,
	runToolCall,
	type ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import {
	type ContextUsageEstimate,
	contentText,
	estimateContextTokensUpperBound,
	estimateTextTokens,
	getCurrentSystemMessage,
	retryDelayMs,
} from "@earendil-works/pi-ai";
import type {
	Api,
	AssistantMessage,
	AuthResult,
	ImageContent,
	Model,
	ProviderHeaders,
	SystemMessage,
	TextContent,
	ToolResultMessage,
	Usage,
} from "@earendil-works/pi-ai/compat";
import {
	clampThinkingLevel,
	cleanupSessionResources,
	getSupportedThinkingLevels,
	isContextOverflow,
	isRecoverableLength,
	isRetryableAssistantError,
	modelsAreEqual,
	type RetryCallbacks,
	resetApiProviders,
	streamSimple,
} from "@earendil-works/pi-ai/compat";
import { getAgentDir, getToolRecoveryMode, type ToolRecoveryMode } from "../config.ts";
import { getThemeByName, theme } from "../modes/interactive/theme/theme.ts";
import { raceWithAbortSignal } from "../utils/abort.ts";
import { stripFrontmatter } from "../utils/frontmatter.ts";
import { processImage } from "../utils/image-process.ts";
import { sleep } from "../utils/sleep.ts";
import { normalizeToolResultImages } from "../utils/tool-result-images.ts";
import { formatNoApiKeyFoundMessage, formatNoModelSelectedMessage } from "./auth-guidance.ts";
import { type BashResult, executeBashWithOperations } from "./bash-executor.ts";
import { generateBugReportSummary } from "./bug-report.ts";
import { type CacheWasteTotals, computeCacheWaste } from "./cache-stats.ts";
import type { CacheWarmer, CacheWarmingStatus } from "./cache-warmer.ts";
import {
	type CompactionPreparation,
	type CompactionResult,
	calculateContextTokens,
	collectEntriesForBranchSummary,
	compact,
	estimateContextTokens,
	estimateProjectedContextTokens,
	estimateTokens,
	generateBranchSummary,
	prepareCompaction,
	shouldCompact,
} from "./compaction/index.ts";
import { DEFAULT_THINKING_LEVEL, THINKING_LEVEL_OPTIONS } from "./defaults.ts";
import { exportSessionToHtml, type ToolHtmlRenderer } from "./export-html/index.ts";
import { createToolHtmlRenderer } from "./export-html/tool-renderer.ts";
import {
	type AgentActivityOutcome,
	type BoundaryContextPreview,
	type ContextUsage,
	type ExecuteToolOptions,
	type ExtensionCommandContextActions,
	type ExtensionErrorListener,
	type ExtensionMode,
	ExtensionRunner,
	type ExtensionUIContext,
	type InputSource,
	type MessageEndEvent,
	type MessageStartEvent,
	type MessageUpdateEvent,
	type ReplacedSessionContext,
	type SessionBeforeCompactResult,
	type SessionBeforeTreeResult,
	type SessionBoundaryDraft,
	type SessionCompactFailedEvent,
	type SessionShutdownEvent,
	type SessionStartEvent,
	type ShutdownHandler,
	type ToolDefinition,
	type ToolExecutionEndEvent,
	type ToolExecutionStartEvent,
	type ToolExecutionUpdateEvent,
	type ToolExposure,
	type ToolInfo,
	type ToolLoadout,
	type ToolResultEvent,
	type TreePreparation,
	type TurnStartEvent,
	wrapRegisteredTools,
} from "./extensions/index.ts";
import { supportsFastMode } from "./fast-mode.ts";
import {
	type AgentCapabilityLease,
	type AgentInputOrigin,
	type AgentTurnContext,
	type AgentTurnResult,
	rootOriginOf,
} from "./input-origin.ts";
import { createToolNameMatcher, isMcpToolName } from "./mcp-servers.ts";
import { type BashExecutionMessage, type CustomMessage, convertToLlm } from "./messages.ts";
import { ModelRegistry } from "./model-registry.ts";
import type { ModelRuntime } from "./model-runtime.ts";
import { NestedToolCallRunner } from "./nested-tool-calls.ts";
import { expandPromptTemplate, type PromptTemplate } from "./prompt-templates.ts";
import type { ResourceExtensionPaths, ResourceLoader } from "./resource-loader.ts";
import { exportSessionToJsonl } from "./session-export.ts";
import {
	type BranchSummaryEntry,
	type CompactionEntry,
	type ContextEditEntry,
	getLatestCompactionEntry,
	type SessionEntry,
	SessionManager,
	type SessionProjection,
} from "./session-manager.ts";
import { type CacheWarmingMode, DEFAULT_TOOL_NAMES, type SettingsManager } from "./settings-manager.ts";
import { BUILTIN_SLASH_COMMANDS, type SlashCommandInfo } from "./slash-commands.ts";
import { BUILTIN_PATH_PREFIX, createSyntheticSourceInfo, isSyntheticPath, type SourceInfo } from "./source-info.ts";
import {
	buildSystemPrompt,
	buildSystemPromptSections,
	diffSystemPromptSections,
	type NormalizedBuildSystemPromptOptions,
	normalizeBuildSystemPromptOptions,
} from "./system-prompt.ts";
import { type ToolActivitySnapshot, ToolActivityTracker } from "./tool-activity.ts";
import { loadToolRecoveryConfig } from "./tool-recovery/config.ts";
import {
	findMatchingToolRecoveryLessons,
	findRelevantToolRecoveryLessons,
	hashToolRecoveryLessonScope,
	reconcileToolRecoveryLessons,
	recordToolRecoveryLessonUsage,
} from "./tool-recovery/lessons-store.ts";
import {
	AssistToolRecoveryController,
	AutoToolRecoveryController,
	createEmptyToolRecoveryDiagnostics,
	ObserveOnlyToolRecoveryController,
	type ToolRecoveryDiagnostics,
} from "./tool-recovery/policies.ts";
import { createModelBackedToolRecoveryRefiner, type ToolRecoveryRefiner } from "./tool-recovery/refiner.ts";
import { registerBuiltInToolIdentity } from "./tool-recovery/registry.ts";
import {
	createToolRecoverySafeRefreshRegistry,
	type ToolRecoverySafeRefreshRegistry,
} from "./tool-recovery/safe-refresh.ts";
import { type BashOperations, createLocalBashOperations } from "./tools/bash.ts";
import { createAllToolDefinitions } from "./tools/index.ts";
import { createToolDefinitionFromAgentTool } from "./tools/tool-definition-wrapper.ts";
import type { UsageCostBreakdownEntry } from "./usage-totals.ts";
import { addUsageToTotals, combineUsage, createUsageTotals, getUsageCostBreakdown } from "./usage-totals.ts";

function resolveCapabilityPath(cwd: string, candidate: string): string {
	const resolved = resolve(cwd, candidate);
	let existing = resolved;
	while (!existsSync(existing) && dirname(existing) !== existing) existing = dirname(existing);
	if (!existsSync(existing)) return resolved;
	return join(realpathSync(existing), relative(existing, resolved));
}

const TOOL_RECOVERY_GUIDANCE_PREFIX = "[LYSTAR_TOOL_RECOVERY_GUIDANCE]";

import {
	findLatestResponse,
	getBranchSelection,
	getVirtualModelState,
	isVirtualModel,
	VIRTUAL_MODEL_STATE_ENTRY,
	type VirtualModelStateData,
} from "./virtual-models.ts";

// ============================================================================
// Skill Block Parsing
// ============================================================================

/** Parsed skill block from a user message */
export interface ParsedSkillBlock {
	name: string;
	location: string;
	content: string;
	userMessage: string | undefined;
}

export type AgentSessionCompletionKind = "file" | "directory" | "command" | "extension" | "prompt" | "skill";

export interface AgentSessionCompletionItem {
	value: string;
	label: string;
	description?: string;
	kind: AgentSessionCompletionKind;
}

export interface AgentSessionCompletionResult {
	prefixStart: number;
	prefixEnd: number;
	items: AgentSessionCompletionItem[];
}

/**
 * Parse a skill block from message text.
 * Returns null if the text doesn't contain a skill block.
 */
export function parseSkillBlock(text: string): ParsedSkillBlock | null {
	const match = text.match(/^<skill name="([^"]+)" location="([^"]+)">\n([\s\S]*?)\n<\/skill>(?:\n\n([\s\S]+))?$/);
	if (!match) return null;
	return {
		name: match[1],
		location: match[2],
		content: match[3],
		userMessage: match[4]?.trim() || undefined,
	};
}

/** Tool execution events of calls a tool made through `ctx.executeTool()` carry `parentToolCallId`. */
type WithParentToolCallId<E> = E extends {
	type: "tool_execution_start" | "tool_execution_update" | "tool_execution_end";
}
	? E & { parentToolCallId?: string }
	: E;

/** Session-specific events that extend the core AgentEvent */
export type AgentSessionEvent =
	| WithParentToolCallId<Exclude<AgentEvent, { type: "agent_end" | "message_start" }>>
	| {
			type: "message_start";
			message: AgentMessage;
			queueId?: string;
	  }
	| {
			type: "agent_end";
			messages: AgentMessage[];
			willRetry: boolean;
	  }
	| { type: "agent_settled"; turn: AgentTurnContext }
	| {
			type: "queue_update";
			steering: readonly string[];
			followUp: readonly string[];
	  }
	| { type: "compaction_start"; reason: "manual" | "threshold" | "overflow" }
	| { type: "entry_appended"; entry: SessionEntry }
	| { type: "session_info_changed"; name: string | undefined }
	| { type: "thinking_level_changed"; level: ThinkingLevel }
	| {
			type: "compaction_end";
			reason: "manual" | "threshold" | "overflow";
			result: CompactionResult | undefined;
			aborted: boolean;
			willRetry: boolean;
			errorMessage?: string;
	  }
	| { type: "auto_retry_start"; attempt: number; maxAttempts: number; delayMs: number; errorMessage: string }
	| { type: "auto_retry_end"; success: boolean; attempt: number; finalError?: string }
	| {
			type: "summarization_retry_scheduled";
			attempt: number;
			maxAttempts: number;
			delayMs: number;
			errorMessage: string;
	  }
	| { type: "summarization_retry_attempt_start"; source: "branchSummary" }
	| {
			type: "summarization_retry_attempt_start";
			source: "compaction";
			reason: "manual" | "threshold" | "overflow";
	  }
	| { type: "summarization_retry_finished" }
	| { type: "bash_execution_update"; id?: string; delta: string }
	| { type: "tool_activity"; activity: ToolActivitySnapshot };

/** Listener function for agent session events */
export type AgentSessionEventListener = (event: AgentSessionEvent) => void;

// ============================================================================
// Types
// ============================================================================

function withoutDeletedHeaders(headers: ProviderHeaders | undefined): Record<string, string> | undefined {
	return headers
		? Object.fromEntries(Object.entries(headers).filter((entry): entry is [string, string] => entry[1] !== null))
		: undefined;
}

export interface AgentSessionConfig {
	agent: Agent;
	sessionManager: SessionManager;
	settingsManager: SettingsManager;
	cwd: string;
	/** Models to cycle through with Ctrl+P (from --models flag) */
	scopedModels?: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>;
	/** Resource loader for extensions, skills, prompts, themes, context files, and system prompt */
	resourceLoader: ResourceLoader;
	/** SDK custom tools registered outside extensions */
	customTools?: ToolDefinition[];
	/** Canonical model/auth runtime used by coding-agent internals. */
	modelRuntime: ModelRuntime;
	/** Keeps the prompt cache entry of the last session request warm. */
	cacheWarmer?: Pick<CacheWarmer, "cancel" | "status" | "onAgentSettled" | "onModeChanged" | "onWarmed">;
	/** Initial active built-in tool names. Default: [read, bash, edit, write] */
	initialActiveToolNames?: string[];
	/**
	 * Whether the initial tools come from the `defaultTools` setting. When true, reload activates
	 * tools newly added to the setting. Tools removed from it stay active.
	 */
	usesDefaultTools?: boolean;
	/**
	 * Optional allowlist of tool names or patterns (`*` matches any characters). When provided, only
	 * matching tools are exposed. A non-empty list without `mcp__` entries also keeps MCP tools
	 * registered for codemode and tool_search; only tool_search can declare them. An empty list
	 * exposes no tools.
	 */
	allowedToolNames?: string[];
	/** Optional denylist of tool names or patterns. When provided, matching tools are not exposed. */
	excludedToolNames?: string[];
	/**
	 * Override base tools (useful for custom runtimes).
	 *
	 * These are synthesized into minimal ToolDefinitions internally so AgentSession can keep
	 * a definition-first registry even when callers provide plain AgentTool instances.
	 */
	baseToolsOverride?: Record<string, AgentTool>;
	/** Mutable ref used by Agent to access the current ExtensionRunner */
	extensionRunnerRef?: { current?: ExtensionRunner };
	/** Session start event metadata emitted when extensions bind to this runtime. */
	sessionStartEvent?: SessionStartEvent;
	/** Defer startup and shutdown extension events until a non-Room client uses the session. */
	deferExtensionLifecycle?: boolean;
	/** Global config directory used by local recovery diagnostics and ledger storage. */
	agentDir?: string;
	/** Optional refiner override; assist/auto use the current model when omitted. */
	toolRecoveryRefiner?: ToolRecoveryRefiner;
	/** Explicit caller-provided user corrections for the optional refiner. */
	getToolRecoveryUserCorrections?: () => readonly string[] | undefined;
	/** Registry of code-registered read-only handlers for safe_refresh lessons. */
	toolRecoverySafeRefreshRegistry?: ToolRecoverySafeRefreshRegistry;
}

export interface ExtensionBindings {
	uiContext?: ExtensionUIContext;
	mode?: ExtensionMode;
	commandContextActions?: ExtensionCommandContextActions;
	abortHandler?: () => void;
	shutdownHandler?: ShutdownHandler;
	onError?: ExtensionErrorListener;
}

export type QueuedInputDisposition = "handled" | "queued";
export type PromptDisposition = QueuedInputDisposition | "started";

/** Options for AgentSession.prompt() */
export interface PromptOptions {
	/** Whether to dispatch extension commands and expand skill commands and prompt templates (default: true) */
	expandPromptTemplates?: boolean;
	/** Image attachments */
	images?: ImageContent[];
	/** When streaming, how to queue the message: "steer" (interrupt) or "followUp" (wait). Required if streaming. */
	streamingBehavior?: "steer" | "followUp";
	/** Stable queue identifier when a streaming prompt is admitted as steer or follow-up. */
	queueId?: string;
	/** Source of input for extension input event handlers. Defaults to "interactive". */
	source?: InputSource;
	/** Structured task origin. User callers omit this; Room and extension callers provide it. */
	origin?: AgentInputOrigin;
	/** Stable identifier supplied by structured callers, such as a Room message ID. */
	inputId?: string;
	/** Per-turn tool lease. When present, it is enforced after extension prompt handlers. */
	activeToolNames?: readonly string[];
	/** Per-turn capability lease enforced before tool execution. */
	capabilities?: AgentCapabilityLease;
	/** Internal hook used by RPC mode to observe how an accepted prompt was dispatched. */
	preflightResult?: (disposition: PromptDisposition) => void;
}

/** Options for model/thinking mutations. */
export interface ModelMutationOptions {
	/** Persist the new value to global defaults. Defaults to session-only. */
	persist?: boolean;
}

/** Result from cycleModel() */
export interface ModelCycleResult {
	model: Model<any>;
	thinkingLevel: ThinkingLevel;
	/** Whether cycling through scoped models (--models flag) or all available */
	isScoped: boolean;
}

/** Session statistics for /session command */
export interface SessionStats {
	sessionFile: string | undefined;
	sessionId: string;
	userMessages: number;
	assistantMessages: number;
	toolCalls: number;
	toolResults: number;
	totalMessages: number;
	tokens: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
	cost: number;
	contextUsage?: ContextUsage;
}

/** `/session` 视图使用的完整会话信息。 */
export interface SessionInfoView {
	name: string | null;
	sessionFile: string | null;
	sessionId: string;
	messages: {
		total: number;
		user: number;
		agent: number;
		toolCalls: number;
		toolResults: number;
	};
	tokens: SessionStats["tokens"];
	cost: number;
	usageBreakdown: UsageCostBreakdownEntry[];
	cacheWaste: CacheWasteTotals;
}

interface ToolDefinitionEntry {
	definition: ToolDefinition;
	sourceInfo: SourceInfo;
}

function estimateMessagesTokens(messages: AgentMessage[]): number {
	let tokens = 0;
	for (const message of messages) {
		tokens += estimateTokens(message);
	}
	return tokens;
}

// ============================================================================
// Constants
// ============================================================================
// AgentSession Class
// ============================================================================

export class AgentSession {
	readonly agent: Agent;
	readonly sessionManager: SessionManager;
	readonly settingsManager: SettingsManager;

	private _scopedModels: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>;
	private readonly _baseStreamFunction: Agent["streamFunction"];
	private readonly _wrappedStreamFunction: Agent["streamFunction"];
	private _fastMode = false;

	// Event subscription state
	private _unsubscribeAgent?: () => void;
	private _eventListeners: AgentSessionEventListener[] = [];
	private readonly _toolActivityTracker = new ToolActivityTracker();
	private _isAgentRunActive = false;
	private _agentRunAbortRequested = false;
	private _agentRunAbortController?: AbortController;
	private readonly _inputAbortControllers = new Set<AbortController>();
	private readonly _idleWaiters = new Set<{ inputSignal?: AbortSignal; resolve: () => void }>();
	private readonly _commandSignals = new AsyncLocalStorage<AbortSignal>();

	/** Tracks pending steering messages for UI display. Removed when delivered. */
	private _steeringMessages: string[] = [];
	private _steeringMessageIds: string[] = [];
	private _steeringQueueMessages: AgentMessage[] = [];
	/** Tracks pending follow-up messages for UI display. Removed when delivered. */
	private _followUpMessages: string[] = [];
	private _followUpMessageIds: string[] = [];
	private _followUpQueueMessages: AgentMessage[] = [];
	/** Messages queued to be included with the next user prompt as context ("asides"). */
	private _pendingNextTurnMessages: CustomMessage[] = [];
	/** Context-only custom messages queued during a run, flushed once the current turn's tool results are in. */
	private _pendingCustomMessages: CustomMessage[] = [];

	// Compaction state
	private _compactionAbortController: AbortController | undefined = undefined;
	private _autoCompactionAbortController: AbortController | undefined = undefined;
	private _lastAutoCompactionError: string | undefined;
	private _overflowRecoveryAttempted = false;

	// Branch summarization state
	private _branchSummaryAbortController: AbortController | undefined = undefined;

	// Retry state
	private _retryAbortController: AbortController | undefined = undefined;
	private _retryAttempt = 0;
	/**
	 * Failed response that the next request repeats, set by auto-retry and overflow recovery. The
	 * retry is routed with it as `failed`, since the context no longer contains it.
	 */
	private _failedResponse: AssistantMessage | undefined;

	// Bash execution state
	private readonly _bashAbortControllers = new Set<AbortController>();
	private _pendingBashMessages: BashExecutionMessage[] = [];

	// Extension system
	private _extensionRunner!: ExtensionRunner;
	private _turnIndex = 0;
	private _activeTurnContext?: AgentTurnContext;
	private _lastTurnResult?: AgentTurnResult;
	private _activeCapabilityLease?: AgentCapabilityLease;
	private readonly _entryIdsByMessage = new WeakMap<object, string>();
	private readonly _boundaryDispatchedMessages = new WeakSet<object>();
	private _lastAssistantMessage: AssistantMessage | undefined;
	private _lastAssistantToolResults: AgentMessage[] = [];
	private _lastActivityOutcome: AgentActivityOutcome = "completed";
	private _isBeforeSettle = false;
	private _abortDuringBeforeSettle = false;
	private _isEmittingAgentSettled = false;
	private readonly _deferredSettledActions: Array<() => Promise<void>> = [];

	private _resourceLoader: ResourceLoader;
	private _customTools: ToolDefinition[];
	private _baseToolDefinitions: Map<string, ToolDefinition> = new Map();
	private _cwd: string;
	private _extensionRunnerRef?: { current?: ExtensionRunner };
	private _initialActiveToolNames?: string[];
	/**
	 * Tools of the restored or reloaded loadout that are not registered yet, such as tools of MCP
	 * servers that are still connecting. They are activated when they are registered, and dropped when
	 * `setActiveToolsByName()` deactivates a tool or the next agent run starts.
	 */
	private _pendingToolNames = new Set<string>();
	private _usesDefaultTools: boolean;
	/** Matches the `--tools` entries: tool names or patterns. */
	private _allowedTools?: (name: string) => boolean;
	/**
	 * Whether the allowlist filters MCP tools: it is empty (`--no-tools`) or names an MCP tool
	 * (`mcp__*`). Otherwise it keeps MCP tools registered for codemode and tool_search.
	 */
	private _allowlistFiltersMcp = false;
	private _excludedTools?: (name: string) => boolean;
	private _baseToolsOverride?: Record<string, AgentTool>;
	private _sessionStartEvent: SessionStartEvent;
	private _extensionLifecycleDeferred: boolean;
	private _extensionLifecycleActive: boolean;
	private _extensionLifecycleActivation?: Promise<void>;
	private _extensionUIContext?: ExtensionUIContext;
	private _extensionMode: ExtensionMode = "print";
	private _extensionCommandContextActions?: ExtensionCommandContextActions;
	private _extensionAbortHandler?: () => void;
	private _extensionShutdownHandler?: ShutdownHandler;
	private _extensionErrorListener?: ExtensionErrorListener;
	private _extensionErrorUnsubscriber?: () => void;
	private _sessionLockCompromiseUnsubscriber?: () => void;

	private _modelRuntime: ModelRuntime;
	private readonly _toolRecoveryMode: ToolRecoveryMode;
	private readonly _toolRecoverySafeRefreshRegistry: ToolRecoverySafeRefreshRegistry;
	private readonly _toolRecoveryController?:
		| ObserveOnlyToolRecoveryController
		| AssistToolRecoveryController
		| AutoToolRecoveryController;
	private readonly _toolRecoveryAgentDir: string;
	private readonly _toolRecoveryScopeHash: string;
	private readonly _injectedToolRecoveryLessons = new Map<string, string[]>();
	private _cacheWarmer?: Pick<CacheWarmer, "cancel" | "status" | "onAgentSettled" | "onModeChanged" | "onWarmed">;

	// Tool registry for extension getTools/setTools
	private _toolRegistry: Map<string, AgentTool> = new Map();
	/** Created on the first `ctx.executeTool()` call. */
	private _nestedToolCalls: NestedToolCallRunner | undefined;
	/** Declared tools whose declarations requests leave out, from `prepareLoadout` hooks. */
	private _hiddenDeclarations: ReadonlySet<string> = new Set();
	private _toolDefinitions: Map<string, ToolDefinitionEntry> = new Map();
	private _toolPromptSnippets: Map<string, string> = new Map();
	private _toolPromptGuidelines: Map<string, string[]> = new Map();

	private _baseSystemPromptOptions!: NormalizedBuildSystemPromptOptions;
	/** Prompt options after before_agent_start mutations for the active run. */
	private _runSystemPromptOptions?: NormalizedBuildSystemPromptOptions;

	constructor(config: AgentSessionConfig) {
		this.agent = config.agent;
		this.sessionManager = config.sessionManager;
		this._restoreFastMode();
		this.settingsManager = config.settingsManager;
		this._scopedModels = config.scopedModels ?? [];
		this._resourceLoader = config.resourceLoader;
		this._customTools = config.customTools ?? [];
		this._cwd = config.cwd;
		this._modelRuntime = config.modelRuntime;
		this._baseStreamFunction = this.agent.streamFunction;
		this._wrappedStreamFunction = (model, context, options) =>
			this._baseStreamFunction(model, context, {
				...options,
				...(supportsFastMode(this._fastModeModel(model))
					? { serviceTier: this.fastMode ? "priority" : "default" }
					: {}),
			});
		this.agent.streamFunction = this._wrappedStreamFunction;
		this._toolRecoveryAgentDir = config.agentDir ?? getAgentDir();
		this._toolRecoveryScopeHash = hashToolRecoveryLessonScope(this._cwd);
		this._toolRecoveryMode = getToolRecoveryMode();
		this._toolRecoverySafeRefreshRegistry =
			config.toolRecoverySafeRefreshRegistry ?? createToolRecoverySafeRefreshRegistry();
		if (this._toolRecoveryMode !== "off") {
			const controllerOptions = {
				agentDir: this._toolRecoveryAgentDir,
				sessionManager: this.sessionManager,
				getTurnId: () => String(this._turnIndex),
				scopeHash: this._toolRecoveryScopeHash,
				refiner:
					config.toolRecoveryRefiner ??
					(this._toolRecoveryMode === "observe"
						? undefined
						: createModelBackedToolRecoveryRefiner({
								getRequestModel: () => {
									const settings = loadToolRecoveryConfig(this._toolRecoveryAgentDir);
									const reference = settings.model;
									const separator = reference?.indexOf("/") ?? -1;
									const model = reference
										? separator > 0
											? this._modelRuntime.getModel(
													reference.slice(0, separator),
													reference.slice(separator + 1),
												)
											: undefined
										: this.model;
									return model ? { model, thinkingLevel: settings.thinkingLevel } : undefined;
								},
								complete: (model, context, options) =>
									this._modelRuntime.completeSimple(model, context, options),
							})),
				getUserCorrections: config.getToolRecoveryUserCorrections,
			};
			this._toolRecoveryController =
				this._toolRecoveryMode === "observe"
					? new ObserveOnlyToolRecoveryController(controllerOptions)
					: this._toolRecoveryMode === "auto"
						? new AutoToolRecoveryController(controllerOptions)
						: new AssistToolRecoveryController(controllerOptions);
			this.agent.toolRecoveryController = this._toolRecoveryController;
		}
		this._cacheWarmer = config.cacheWarmer;
		if (this._cacheWarmer) {
			this._cacheWarmer.onWarmed = (entry) => this._emit({ type: "entry_appended", entry });
		}
		this._extensionRunnerRef = config.extensionRunnerRef;
		this._initialActiveToolNames = config.initialActiveToolNames;
		this._usesDefaultTools = config.usesDefaultTools ?? false;
		if (config.allowedToolNames) {
			this._allowedTools = createToolNameMatcher(config.allowedToolNames);
			this._allowlistFiltersMcp =
				config.allowedToolNames.length === 0 || config.allowedToolNames.some((entry) => entry.startsWith("mcp__"));
		}
		this._excludedTools = config.excludedToolNames ? createToolNameMatcher(config.excludedToolNames) : undefined;
		this._baseToolsOverride = config.baseToolsOverride;
		this._sessionStartEvent = config.sessionStartEvent ?? { type: "session_start", reason: "startup" };
		this._extensionLifecycleDeferred = config.deferExtensionLifecycle === true;
		this._extensionLifecycleActive = !this._extensionLifecycleDeferred;
		this._sessionLockCompromiseUnsubscriber = this.sessionManager.onLockCompromised(() => {
			this.abortRetry();
			this.abortCompaction();
			this.abortBranchSummary();
			this.abortBash();
			this.agent.abort();
		});

		// Always subscribe to agent events for internal handling
		// (session persistence, extensions, auto-compaction, retry logic)
		this._unsubscribeAgent = this.agent.subscribe(this._handleAgentEvent);
		this._installAgentToolHooks();
		this._installAgentNextTurnRefresh();
		this._installAgentRequestProjection();
		this._installAgentRequestPreparation();
		this._installAgentRequestValidation();
		this._installAgentBoundaryHooks();
		this._installHiddenDeclarationsProjection();
		this._installAgentForcedPromptProjection();

		this._buildRuntime({
			activeToolNames: this._initialActiveToolNames,
			includeAllExtensionTools: true,
		});
		if (this._initialActiveToolNames === undefined) this._restoreToolsFromTranscript();
	}

	get modelRuntime(): ModelRuntime {
		return this._modelRuntime;
	}

	private async _getRequiredRequestAuth(
		model: Model<any>,
		signal?: AbortSignal,
	): Promise<{
		model: Model<any>;
		apiKey?: string;
		headers?: Record<string, string>;
		env?: Record<string, string>;
	}> {
		let result: AuthResult | undefined;
		try {
			result = await this._modelRuntime.getAuth(model, { signal });
		} catch (error) {
			const cause = error instanceof Error ? error.cause : undefined;
			if (cause instanceof Error && cause.message === "authHeader requires a resolved API key") {
				throw new Error(formatNoApiKeyFoundMessage(model.provider));
			}
			throw error;
		}
		if (result && (result.auth.apiKey || result.auth.headers)) {
			const requestModel = result.auth.baseUrl ? { ...model, baseUrl: result.auth.baseUrl } : model;
			return {
				model: requestModel,
				apiKey: result.auth.apiKey,
				headers: withoutDeletedHeaders(result.auth.headers),
				env: result.env,
			};
		}

		const isOAuth = this._modelRuntime.isUsingOAuth(model.provider);
		if (isOAuth) {
			throw new Error(
				`Authentication failed for "${model.provider}". ` +
					`Credentials may have expired or network is unavailable. ` +
					`Run '/login ${model.provider}' to re-authenticate.`,
			);
		}
		throw new Error(formatNoApiKeyFoundMessage(model.provider));
	}

	private async _getSummarizationRequestAuth(
		selectedModel: Model<any>,
		signal?: AbortSignal,
	): Promise<{
		model: Model<any>;
		apiKey?: string;
		headers?: Record<string, string>;
		env?: Record<string, string>;
		thinkingLevel: ThinkingLevel;
	}> {
		// Route a virtual model first: summaries size their input and output from the model they get.
		const { model, thinkingLevel } = isVirtualModel(selectedModel)
			? await this._modelRuntime.resolveModel(selectedModel, convertToLlm(this.messages), {
					reason: "direct",
					thinkingLevel: this.thinkingLevel,
					signal,
				})
			: { model: selectedModel, thinkingLevel: this.thinkingLevel };
		if (this.agent.streamFunction === this._wrappedStreamFunction && this._baseStreamFunction === streamSimple) {
			return { ...(await this._getRequiredRequestAuth(model, signal)), thinkingLevel };
		}

		try {
			const result = await this._modelRuntime.getAuth(model, { signal });
			if (!result) return { model, thinkingLevel };
			const requestModel = result.auth.baseUrl ? { ...model, baseUrl: result.auth.baseUrl } : model;
			return {
				model: requestModel,
				apiKey: result.auth.apiKey,
				headers: withoutDeletedHeaders(result.auth.headers),
				env: result.env,
				thinkingLevel,
			};
		} catch (error) {
			if (signal?.aborted) throw error;
			return { model, thinkingLevel };
		}
	}

	private _capabilityViolation(toolName: string, args: Record<string, unknown>): string | undefined {
		const lease = this._activeCapabilityLease;
		if (!lease) return undefined;
		if (!lease.allowedTools.includes(toolName)) return `当前 Turn 不允许使用工具：${toolName}`;
		if (["bash", "powershell"].includes(toolName) && lease.shell) {
			return lease.shell === "disabled" ? "当前 Turn 已禁用 Shell" : "当前运行时没有可用的 Shell 沙箱";
		}
		const pathValue = typeof args.path === "string" ? args.path : undefined;
		if (!pathValue) return undefined;
		const resolvedPath = resolveCapabilityPath(this._cwd, pathValue);
		const roots = ["read", "grep", "find", "ls"].includes(toolName) ? lease.readRoots : lease.writeRoots;
		if (!roots || roots.length === 0) return `工具路径没有对应的能力租约：${pathValue}`;
		const insideRoot = roots.some((root) => {
			const resolvedRoot = resolveCapabilityPath(this._cwd, root);
			const suffix = relative(resolvedRoot, resolvedPath);
			return suffix === "" || (suffix !== ".." && !suffix.startsWith(`..${sep}`));
		});
		return insideRoot ? undefined : `工具路径超出当前 Turn 的能力租约：${pathValue}`;
	}

	/**
	 * The model whose limits apply to `message`, or undefined when the message came from another
	 * model. Under a virtual selection, that is the physical model that produced it.
	 */
	private _modelForMessage(message: AssistantMessage): Model<any> | undefined {
		const model = this.model;
		if (model && isVirtualModel(model)) return this._modelRuntime.getPhysicalModel(message.provider, message.model);
		return model?.provider === message.provider && model.id === message.model ? model : undefined;
	}

	/**
	 * Record the selection on the current branch when the branch implies another one, so a resume
	 * restores it. Tree navigation can leave the latest `model_change` on another branch; responses
	 * cannot record a virtual selection because they name physical models. Responses do record a
	 * physical selection unless the branch holds a virtual one; checking a physical selection against
	 * responses would record it on every prompt while `prepareRequest` redirects to another model.
	 */
	private _recordSelection(): void {
		const model = this.model;
		if (!model) return;
		const getModel = (provider: string, modelId: string) => this._modelRuntime.getModel(provider, modelId);
		const recorded = getBranchSelection(this.sessionManager.getBranch(), getModel);
		if (!recorded || (recorded.provider === model.provider && recorded.modelId === model.id)) return;
		const recordedModel = getModel(recorded.provider, recorded.modelId);
		if (!isVirtualModel(model) && !(recordedModel && isVirtualModel(recordedModel))) return;
		this.sessionManager.appendModelChange(model.provider, model.id);
	}

	/** The model whose limits apply to the conversation. */
	private _limitsModel(): Model<any> | undefined {
		return this.routedModel?.model ?? this.model;
	}

	/**
	 * Install tool hooks once on the Agent instance.
	 *
	 * The callbacks read `this._extensionRunner` at execution time, so extension reload swaps in the
	 * new runner without reinstalling hooks. Extension-specific tool wrappers are still used to adapt
	 * registered tool execution to the extension context. Tool call and tool result interception now
	 * happens here instead of in wrappers.
	 */
	private _installAgentToolHooks(): void {
		this.agent.beforeToolCall = (context) => this._beforeToolCall(context);
		this.agent.afterToolCall = (context) => this._afterToolCall(context);
	}

	/** `tool_call` handlers. `parentToolCallId` is set for calls another tool made. */
	private async _beforeToolCall(
		{ toolCall, args }: BeforeToolCallContext,
		parentToolCallId?: string,
	): Promise<BeforeToolCallResult | undefined> {
		const capabilityViolation = this._capabilityViolation(toolCall.name, args as Record<string, unknown>);
		if (capabilityViolation) return { block: true, reason: capabilityViolation, terminate: true };
		const runner = this._extensionRunner;
		if (!runner.hasHandlers("tool_call")) return undefined;

		try {
			return await runner.emitToolCall({
				type: "tool_call",
				toolName: toolCall.name,
				toolCallId: toolCall.id,
				...(parentToolCallId ? { parentToolCallId } : {}),
				input: args as Record<string, unknown>,
			});
		} catch (err) {
			if (err instanceof Error) throw err;
			throw new Error(`Extension failed, blocking execution: ${String(err)}`);
		}
	}

	/** `tool_result` handlers and image normalization. `parentToolCallId` is set for calls another tool made. */
	private async _afterToolCall(
		{ toolCall, args, result, isError }: AfterToolCallContext,
		parentToolCallId?: string,
	): Promise<AfterToolCallResult | undefined> {
		const runner = this._extensionRunner;
		const hookResult = runner.hasHandlers("tool_result")
			? await runner.emitToolResult({
					type: "tool_result",
					toolName: toolCall.name,
					toolCallId: toolCall.id,
					...(parentToolCallId ? { parentToolCallId } : {}),
					input: args as Record<string, unknown>,
					content: result.content,
					details: result.details,
					...(result.structuredContent === undefined ? {} : { structuredContent: result.structuredContent }),
					isError,
					usage: result.usage,
				})
			: undefined;

		const content = hookResult?.content ?? result.content ?? [];
		const resizeOptions = this._limitsModel()?.inputLimits?.images?.resize;
		const normalizedContent = await normalizeToolResultImages(content, {
			autoResizeImages: this.settingsManager.getImageAutoResize(),
			...(resizeOptions ? { resizeOptions } : {}),
		});
		const finalIsError = hookResult?.isError ?? isError;
		const injectedLessonIds = this._injectedToolRecoveryLessons.get(toolCall.name);
		this._injectedToolRecoveryLessons.delete(toolCall.name);
		if (injectedLessonIds && injectedLessonIds.length > 0 && !finalIsError) {
			this._toolRecoveryController?.recordLessonMatches(injectedLessonIds);
			void recordToolRecoveryLessonUsage(this._toolRecoveryAgentDir, injectedLessonIds, {
				source: "runtime",
				guidanceShown: true,
			}).catch(() => {});
		}

		let finalContent = normalizedContent;
		if (
			finalIsError &&
			this._toolRecoveryController &&
			(this._toolRecoveryMode === "assist" || this._toolRecoveryMode === "auto")
		) {
			const failure = this._toolRecoveryController.getFailureForToolCall(toolCall.id);
			if (failure) {
				try {
					const matches = await findMatchingToolRecoveryLessons(this._toolRecoveryAgentDir, {
						scopeHash: this._toolRecoveryScopeHash,
						toolName: toolCall.name,
						failureCode: failure.code,
						failureFingerprint: failure.fingerprint,
					});
					this._toolRecoveryController.recordSuspendedLessons(matches.suspendedLessonIds);
					const selected: string[] = [];
					let guidanceText = "相关恢复经验：";
					for (const lesson of matches.lessons) {
						if (selected.length >= 3) break;
						if (selected.includes(lesson.id)) continue;
						const nextText = `${guidanceText}\n${selected.length + 1}. ${lesson.guidance}`;
						if (estimateTextTokens(nextText) > 500) continue;
						guidanceText = nextText;
						selected.push(lesson.id);
					}
					if (selected.length > 0) {
						const selectedLessons = matches.lessons.filter((lesson) => selected.includes(lesson.id));
						const requiresRefresh = selectedLessons.some(
							(lesson) => lesson.status === "active" && lesson.allowedAction === "safe_refresh",
						);
						const refreshText = requiresRefresh
							? ((await this._toolRecoverySafeRefreshRegistry.run(toolCall.name, args, this._cwd)) ?? "")
							: "";
						const visibleText =
							refreshText && estimateTextTokens(`${refreshText}\n${guidanceText}`) <= 500
								? `${refreshText}\n${guidanceText}`
								: guidanceText;
						finalContent = [...normalizedContent, { type: "text", text: visibleText }];
						this._toolRecoveryController.recordLessonMatches(selected);
						await recordToolRecoveryLessonUsage(this._toolRecoveryAgentDir, selected, {
							source: "runtime",
							guidanceShown: true,
						}).catch(() => {});
					}
				} catch {
					// Lesson 查询失败不能改变最终 ToolResult。
				}
			}
		}

		const finalStructuredContent = hookResult ? hookResult.structuredContent : result.structuredContent;
		const finalToolResultEvent = {
			type: "tool_result" as const,
			toolName: toolCall.name,
			toolCallId: toolCall.id,
			...(parentToolCallId ? { parentToolCallId } : {}),
			input: args as Record<string, unknown>,
			content: finalContent,
			details: hookResult ? hookResult.details : result.details,
			...(finalStructuredContent === undefined ? {} : { structuredContent: finalStructuredContent }),
			isError: finalIsError,
			usage: hookResult ? hookResult.usage : result.usage,
		} as ToolResultEvent;
		await runner.observeContextProviderToolResult(finalToolResultEvent);

		if (!hookResult && finalContent === content) return undefined;
		return {
			content: finalContent,
			details: hookResult?.details,
			structuredContent: hookResult ? hookResult.structuredContent : result.structuredContent,
			isError: finalIsError,
			usage: hookResult?.usage,
		};
	}

	private async _estimateRequestTokens(context: AgentContext): Promise<ContextUsageEstimate> {
		const messages = await this.agent.convertToLlm(context.messages);
		return estimateContextTokensUpperBound({
			messages,
			tools: context.tools,
		});
	}

	private async _estimateRequestContentTokens(context: AgentContext): Promise<ContextUsageEstimate> {
		let lastCompactionIndex = -1;
		for (let index = context.messages.length - 1; index >= 0; index--) {
			if (context.messages[index]?.role === "compactionSummary") {
				lastCompactionIndex = index;
				break;
			}
		}
		const messages = await this.agent.convertToLlm(
			lastCompactionIndex === -1 ? context.messages : context.messages.slice(lastCompactionIndex + 1),
		);
		return estimateContextTokensUpperBound({ systemPrompt: "", messages, tools: [] });
	}

	private _assertRequestTokensWithinLimit(
		estimate: ContextUsageEstimate,
		compactionError?: string,
		contentEstimate: ContextUsageEstimate = estimate,
		allowCompactedPrefixOverflow = false,
	): void {
		const model = this.model;
		if (!model || model.contextWindow <= 0 || estimate.tokens < model.contextWindow) return;
		// Provider usage 之后的增量尚未经过 tokenizer；压缩摘要之前的历史不参与尾部硬拦截。
		const indivisibleEstimate = allowCompactedPrefixOverflow ? contentEstimate : estimate;
		if (indivisibleEstimate.trailingTokens < model.contextWindow) return;
		const resolution = compactionError
			? `自动压缩未完成：${compactionError}`
			: "压缩后估算仍超过上限，请减少单条 Prompt、Skill 或 Tool 输出，或切换到更大上下文的模型。";
		throw new Error(
			`请求中的不可拆内容预计为 ${indivisibleEstimate.trailingTokens} tokens，超过模型 ${model.provider}/${model.id} 配置的 ${model.contextWindow} tokens 上限。${resolution}`,
		);
	}

	private async _injectToolRecoveryGuidance(context: AgentContext): Promise<AgentContext> {
		this._injectedToolRecoveryLessons.clear();
		if (this._toolRecoveryMode === "off") return context;
		const messageText = (message: AgentMessage): string =>
			"content" in message ? contentText(message.content, "") : "";
		const messages = context.messages.filter(
			(message) => !messageText(message).startsWith(TOOL_RECOVERY_GUIDANCE_PREFIX),
		);
		const taskText = messages.slice(-8).map(messageText).join("\n").slice(-8_000);
		if (!taskText || !context.tools || context.tools.length === 0) return { ...context, messages };
		let lessons: Awaited<ReturnType<typeof findRelevantToolRecoveryLessons>>["lessons"];
		try {
			lessons = (
				await findRelevantToolRecoveryLessons(this._toolRecoveryAgentDir, {
					scopeHash: this._toolRecoveryScopeHash,
					toolNames: context.tools.map((tool) => tool.name),
					taskText,
				})
			).lessons;
		} catch {
			return { ...context, messages };
		}
		if (lessons.length === 0) return { ...context, messages };
		const lines = [TOOL_RECOVERY_GUIDANCE_PREFIX, "以下经验仅供参考，不是强制规则；先核对当前状态，再决定是否采用："];
		const selected: string[] = [];
		for (const lesson of lessons) {
			const candidate = `${lines.join("\n")}\n- ${lesson.matcher.toolName}：${lesson.guidance}`;
			if (estimateTextTokens(candidate) > 500) continue;
			lines.push(`- ${lesson.matcher.toolName}：${lesson.guidance}`);
			selected.push(lesson.id);
		}
		if (selected.length === 0) return { ...context, messages };
		for (const lesson of lessons) {
			if (!selected.includes(lesson.id)) continue;
			const ids = this._injectedToolRecoveryLessons.get(lesson.matcher.toolName) ?? [];
			ids.push(lesson.id);
			this._injectedToolRecoveryLessons.set(lesson.matcher.toolName, ids);
		}
		const guidanceMessage: AgentMessage = {
			role: "user",
			content: [{ type: "text", text: lines.join("\n") }],
			timestamp: Date.now(),
		};
		return { ...context, messages: [...messages, guidanceMessage] };
	}

	private async _prepareRequestContext(
		context: AgentContext,
		pendingMessagesAfterCompaction: AgentMessage[] = [],
		signal?: AbortSignal,
	): Promise<AgentContext> {
		context = await this._injectToolRecoveryGuidance(context);
		signal?.throwIfAborted();
		const model = this.model;
		if (!model || model.contextWindow <= 0 || isVirtualModel(model)) return context;

		const settings = this.settingsManager.getCompactionSettings();
		let estimate = await this._estimateRequestTokens(context);
		let contentEstimate = await this._estimateRequestContentTokens(context);
		signal?.throwIfAborted();
		let compactionAttempted = false;
		let allowCompactedPrefixOverflow = context.messages.some((message) => message.role === "compactionSummary");
		if (settings.enabled && shouldCompact(estimate.tokens, model.contextWindow, settings)) {
			compactionAttempted = true;
			const compacted = await this._runAutoCompaction("threshold", true);
			if (compacted) {
				context = {
					...context,
					messages: [...this.agent.state.messages, ...pendingMessagesAfterCompaction],
				};
				estimate = await this._estimateRequestTokens(context);
				contentEstimate = await this._estimateRequestContentTokens(context);
				allowCompactedPrefixOverflow = context.messages.some((message) => message.role === "compactionSummary");
			}
		}

		this._assertRequestTokensWithinLimit(
			estimate,
			compactionAttempted ? this._lastAutoCompactionError : undefined,
			contentEstimate,
			allowCompactedPrefixOverflow || compactionAttempted,
		);
		return context;
	}

	private _installAgentRequestPreparation(): void {
		const previousPrepareRequest = this.agent.prepareRequest;
		this.agent.prepareRequest = async (request, signal) => {
			const previous = await previousPrepareRequest?.(request, signal);
			const context = await this._prepareRequestContext(previous?.context ?? request.context, [], signal);
			return { ...previous, context };
		};
	}

	private _installAgentRequestValidation(): void {
		const previousValidateRequest = this.agent.validateRequest;
		this.agent.validateRequest = async (context, signal) => {
			await previousValidateRequest?.(context, signal);
			if (!this.model || isVirtualModel(this.model)) return;
			const estimate = await this._estimateRequestTokens(context);
			const contentEstimate = await this._estimateRequestContentTokens(context);
			const allowCompactedPrefixOverflow = context.messages.some((message) => message.role === "compactionSummary");
			this._assertRequestTokensWithinLimit(estimate, undefined, contentEstimate, allowCompactedPrefixOverflow);
		};
	}

	private async _executeNestedToolCall(
		parentToolCallId: string,
		name: string,
		args: unknown,
		options: ExecuteToolOptions,
	): Promise<AgentToolCallOutcome> {
		this._nestedToolCalls ??= new NestedToolCallRunner({
			getTools: () => this._getCallableTools(),
			isSequential: () => this.agent.toolExecution === "sequential",
			runToolCall: (toolCall, parentId, signal, onUpdate) => {
				const assistantMessage = this._findLastAssistantMessage();
				if (!assistantMessage) {
					return Promise.resolve({
						toolCall,
						result: { content: [{ type: "text", text: "No assistant message issued this call" }], details: {} },
						isError: true,
					});
				}
				return runToolCall(toolCall, {
					tools: this._getCallableTools(),
					assistantMessage,
					context: { messages: this.agent.state.messages, tools: this.agent.state.tools },
					beforeToolCall: (context) => this._beforeToolCall(context, parentId),
					afterToolCall: (context) => this._afterToolCall(context, parentId),
					signal,
					onUpdate,
				});
			},
			emit: async (event) => {
				await this._extensionRunner.emit(event);
				this._emit(event);
			},
		});
		return this._nestedToolCalls.execute(parentToolCallId, name, args, options);
	}

	/** Whether `projection`, the current session projection, exceeds the compaction threshold of `model`. */
	private _exceedsCompactionThreshold(model: Model<any>, projection: SessionProjection): boolean {
		if (model.contextWindow <= 0) return false;
		return shouldCompact(
			estimateProjectedContextTokens(projection, this.sessionManager.getBranch()).tokens,
			model.contextWindow,
			this.settingsManager.getCompactionSettings(this.model),
		);
	}

	private async _compactBeforeNextAssistantResponse(context: AgentContext): Promise<AgentContext> {
		const projection = this.sessionManager.buildSessionProjection();
		// A virtual selection is checked in prepareRequest, against the model the request is routed to.
		const model = this.model;
		if (!model || isVirtualModel(model) || !this._exceedsCompactionThreshold(model, projection)) {
			return { ...context, messages: projection.messages };
		}
		await this._runAutoCompaction("threshold", false);
		return { ...context, messages: this.sessionManager.buildSessionProjection().messages };
	}

	private _installAgentRequestProjection(): void {
		const previousPrepareRequest = this.agent.prepareRequest;
		this.agent.prepareRequest = async (request, signal) => {
			const failed = this._failedResponse;
			this._failedResponse = undefined;
			const prepare = async () => {
				const projection = this.sessionManager.buildSessionProjection();
				const canonicalContext = {
					...request.context,
					messages: projection.messages,
					// Messages declare the provider-visible loadout; context.tools keeps executable implementations.
					tools: this.agent.state.tools.slice(),
				};
				const previous = await previousPrepareRequest?.(
					{
						...request,
						context: canonicalContext,
						model: this.agent.state.model,
						thinkingLevel: this.agent.state.thinkingLevel,
					},
					signal,
				);
				return { previous, context: previous?.context ?? canonicalContext, projection };
			};
			let { previous, context, projection } = await prepare();
			const model = previous?.model ?? this.agent.state.model;
			const thinkingLevel = previous?.thinkingLevel ?? this.agent.state.thinkingLevel;
			if (!isVirtualModel(model)) return { ...previous, context, model, thinkingLevel };

			// The selection stays in agent state; only this request uses the routed model. A routing
			// failure rejects, which ends the run with an error response. Only messages the user wrote
			// start a turn; extension messages can follow them, e.g. from before_agent_start.
			const lastResponse = context.messages.findLastIndex((message) => message.role === "assistant");
			const userTurn = context.messages.slice(lastResponse + 1).some((message) => message.role === "user");
			const state = getVirtualModelState(this.sessionManager.getBranch(), model.provider, model.id);
			const route = await this._modelRuntime.resolveModel(model, convertToLlm(context.messages), {
				reason: failed ? "retry" : userTurn ? "user" : "continuation",
				thinkingLevel,
				signal,
				failed,
				state,
			});
			if (route.state !== undefined && route.state !== state) {
				const data: VirtualModelStateData = { provider: model.provider, modelId: model.id, state: route.state };
				const entry = this.sessionManager.getEntry(
					this.sessionManager.appendCustomEntry(VIRTUAL_MODEL_STATE_ENTRY, data),
				);
				if (entry) this._emit({ type: "entry_appended", entry });
			}
			// The route stands: the router already decided this request. The state entry does not change
			// the projection.
			if (this._exceedsCompactionThreshold(route.model, projection)) {
				await this._runAutoCompaction("threshold", false);
				({ previous, context } = await prepare());
			}
			return { ...previous, context, model: route.model, thinkingLevel: route.thinkingLevel };
		};
	}

	private async _dispatchTurnEndBoundary(
		message: AssistantMessage,
		toolResults: ToolResultMessage[],
	): Promise<boolean> {
		this._lastActivityOutcome =
			message.stopReason === "aborted" ? "aborted" : message.stopReason === "error" ? "error" : "completed";
		const messageEntryId = this._findPersistedMessageEntryId(message);
		if (!this._extensionRunner.hasHandlers("turn_end")) return false;
		if (!messageEntryId) {
			this._extensionRunner.emitError({
				extensionPath: "<boundary>",
				event: "turn_end",
				error: "turn_end could not resolve the persisted assistant entry ID",
			});
			return false;
		}
		const toolResultEntryIds = toolResults.flatMap((result) => {
			const entryId = this._findPersistedMessageEntryId(result);
			return entryId ? [entryId] : [];
		});
		const boundary = await this._extensionRunner.emitBoundary(
			{
				type: "turn_end",
				turnIndex: this._turnIndex,
				message,
				toolResults,
				messageEntryId,
				toolResultEntryIds,
				outcome: this._lastActivityOutcome,
			},
			(entries) => this._buildBoundaryContext(entries, "turn_end"),
		);
		this._commitBoundaryDrafts(boundary.entries);
		if (boundary.continue && !this._buildBoundaryContext([], "turn_end").canContinue) {
			this._reportInvalidBoundaryContinuation("turn_end");
			return false;
		}
		return boundary.continue;
	}

	private _installAgentBoundaryHooks(): void {
		const previousFinishTurn = this.agent.finishTurn;
		this.agent.finishTurn = async (turn, signal) => {
			this._boundaryDispatchedMessages.add(turn.message);
			const extensionContinue = await this._dispatchTurnEndBoundary(turn.message, turn.toolResults);
			const previousDecision = await previousFinishTurn?.(turn, signal);
			if (previousDecision?.action === "end") return previousDecision;
			if (extensionContinue || previousDecision?.action === "continue") return { action: "continue" };
			return undefined;
		};
	}

	private _installAgentNextTurnRefresh(): void {
		const previousPrepareNextTurnWithContext =
			this.agent.prepareNextTurnWithContext ??
			(this.agent.prepareNextTurn
				? async (_turn: PrepareNextTurnContext, signal?: AbortSignal) => await this.agent.prepareNextTurn?.(signal)
				: undefined);
		this.agent.prepareNextTurnWithContext = async (turn, signal) => {
			const context = await this._compactBeforeNextAssistantResponse(turn.context);
			const previousSnapshot = await previousPrepareNextTurnWithContext?.({ ...turn, context }, signal);
			const nextContext = previousSnapshot?.context ?? context;
			const runOptions = this._runSystemPromptOptions ?? this._baseSystemPromptOptions;
			const options = normalizeBuildSystemPromptOptions({
				...runOptions,
				selectedTools: this.getActiveToolNames(),
				toolSnippets: { ...this._baseSystemPromptOptions.toolSnippets, ...runOptions.toolSnippets },
				toolGuidelines: { ...this._baseSystemPromptOptions.toolGuidelines, ...runOptions.toolGuidelines },
			});
			const updateMessage = this._preparePromptAndToolLoadout(options, nextContext.messages);
			// Keep session.systemPrompt and ctx.getSystemPrompt() in step with what the provider sees.
			this._runSystemPromptOptions = options;

			return {
				...previousSnapshot,
				context: {
					...nextContext,
					tools: this.agent.state.tools.slice(),
				},
				messages: updateMessage
					? [...(previousSnapshot?.messages ?? []), updateMessage]
					: previousSnapshot?.messages,

				model: this.agent.state.model,
				thinkingLevel: this.agent.state.thinkingLevel,
			};
		};
	}

	// =========================================================================
	// Event Subscription
	// =========================================================================

	private _refreshFinalizedContext(): void {
		const projection = this.sessionManager.buildSessionProjection();
		for (const entry of projection.entries) {
			for (const message of entry.messages) this._entryIdsByMessage.set(message, entry.sourceEntry.id);
		}
		this.agent.state.messages = projection.messages;
	}

	private _applyBoundaryDrafts(manager: SessionManager, drafts: SessionBoundaryDraft[]): SessionEntry[] {
		const appended: SessionEntry[] = [];
		for (const draft of drafts) {
			let entryId: string;
			switch (draft.type) {
				case "custom":
					entryId = manager.appendCustomEntry(draft.customType, draft.data);
					break;
				case "custom_message":
					entryId = manager.appendCustomMessageEntry(
						draft.customType,
						draft.content,
						draft.display,
						draft.details,
					);
					break;
				case "context_edit":
					entryId = manager.appendContextEdit(draft.targetId, draft.replacement);
					break;
				case "compaction": {
					const tokensBefore = estimateProjectedContextTokens(
						manager.buildSessionProjection(),
						manager.getBranch(),
					).tokens;
					entryId = manager.appendCompaction(
						draft.summary,
						draft.firstKeptEntryId,
						tokensBefore,
						draft.details,
						true,
						draft.usage,
					);
					break;
				}
			}
			const entry = manager.getEntry(entryId);
			if (entry) appended.push(entry);
		}
		return appended;
	}

	private _createBoundaryPreviewManager(drafts: SessionBoundaryDraft[]): SessionManager {
		const header = this.sessionManager.getHeader();
		if (!header) throw new Error("Session header is missing");
		const manager = SessionManager.inMemory(this._cwd, undefined, [header, ...this.sessionManager.getBranch()]);
		this._applyBoundaryDrafts(manager, drafts);
		return manager;
	}

	private _getPendingBoundaryMessages(): AgentMessage[] {
		return [...this.agent.peekQueuedMessages(), ...this._pendingCustomMessages];
	}

	private _buildBoundaryContext(
		drafts: SessionBoundaryDraft[],
		boundary: "turn_end" | "agent_before_settle",
	): BoundaryContextPreview {
		const projection = this._createBoundaryPreviewManager(drafts).buildSessionProjection();
		const pendingMessages = this._getPendingBoundaryMessages();
		const llmMessages = convertToLlm(projection.messages);
		const finalRole = llmMessages[llmMessages.length - 1]?.role;
		const hasNonSystemContext = llmMessages.some((message) => message.role !== "system");
		const contextCanContinue = hasNonSystemContext && finalRole !== "assistant";
		const pendingCustomContext = this._pendingCustomMessages.length > 0;
		return {
			contextEntries: projection.entries,
			contextMessages: projection.messages,
			llmMessages,
			pendingMessages,
			canContinue:
				contextCanContinue ||
				pendingCustomContext ||
				(boundary === "turn_end"
					? this.agent.hasQueuedMessages()
					: finalRole === "assistant" && this.agent.hasQueuedMessages()),
		};
	}

	private _commitBoundaryDrafts(drafts: SessionBoundaryDraft[]): void {
		const appended = this._applyBoundaryDrafts(this.sessionManager, drafts);
		this._refreshFinalizedContext();
		for (const entry of appended) this._emit({ type: "entry_appended", entry });
	}

	private _reportInvalidBoundaryContinuation(event: "turn_end" | "agent_before_settle"): void {
		this._extensionRunner.emitError({
			extensionPath: "<boundary>",
			event,
			error: `${event} requested continuation without runnable model context`,
		});
	}

	/** Emit an event to all listeners */
	private _emit(event: AgentSessionEvent): void {
		const activities = event.type === "tool_activity" ? [] : this._toolActivityTracker.apply(event);
		for (const l of this._eventListeners) {
			l(event);
		}
		for (const activity of activities) {
			const activityEvent: AgentSessionEvent = { type: "tool_activity", activity };
			for (const l of this._eventListeners) {
				l(activityEvent);
			}
		}
	}

	private _nextQueueMessageId(requestedId?: string): string {
		const candidate = requestedId?.trim();
		if (candidate && !this._steeringMessageIds.includes(candidate) && !this._followUpMessageIds.includes(candidate)) {
			return candidate;
		}
		return randomUUID();
	}

	private _emitQueueUpdate(): void {
		this._emit({
			type: "queue_update",
			steering: [...this._steeringMessages],
			followUp: [...this._followUpMessages],
		});
	}

	private async _emitSessionCompactFailed(event: Omit<SessionCompactFailedEvent, "type">): Promise<void> {
		if (this._extensionRunner.hasHandlers("session_compact_failed")) {
			await this._extensionRunner.emit({ type: "session_compact_failed", ...event });
		}
	}

	private _isIdleForWait(inputSignal?: AbortSignal): boolean {
		const activeInputControllers = [...this._inputAbortControllers].filter(
			(controller) => controller.signal !== inputSignal,
		);
		return (
			!this._isAgentRunActive &&
			!this.isCompacting &&
			(!this._isEmittingAgentSettled || inputSignal !== undefined) &&
			activeInputControllers.length === 0
		);
	}

	private _getIdleWaitPromise(inputSignal?: AbortSignal): Promise<void> {
		return new Promise((resolve) => {
			this._idleWaiters.add({ inputSignal, resolve });
		});
	}

	private _resolveIdleWaitIfIdle(): void {
		for (const waiter of this._idleWaiters) {
			if (!this._isIdleForWait(waiter.inputSignal)) continue;
			this._idleWaiters.delete(waiter);
			waiter.resolve();
		}
	}

	private async _emitAgentSettled(): Promise<void> {
		this._cacheWarmer?.onAgentSettled();
		this._isAgentRunActive = false;
		const turn = this._activeTurnContext;
		if (!turn) {
			this._resolveIdleWaitIfIdle();
			return;
		}
		this._isEmittingAgentSettled = true;
		try {
			await this._extensionRunner.emit({ type: "agent_settled", turn });
			const lastAssistant = this._findLastAssistantMessage();
			const finalText = this.getLastAssistantText();
			const outcome =
				this._agentRunAbortRequested || lastAssistant?.stopReason === "aborted"
					? "aborted"
					: lastAssistant?.stopReason === "error"
						? "failed"
						: "completed";
			this._lastTurnResult = {
				...turn,
				outcome,
				...(finalText ? { finalText } : {}),
			};
			this._emit({ type: "agent_settled", turn });
		} finally {
			this._isEmittingAgentSettled = false;
		}

		const deferred = this._deferredSettledActions.splice(0);
		if (deferred.length > 0) {
			try {
				for (const action of deferred) await action();
			} finally {
				this._resolveIdleWaitIfIdle();
			}
			return;
		}
		this._resolveIdleWaitIfIdle();
	}

	/** Internal handler for agent events - shared by subscribe and reconnect */
	private _handleAgentEvent = async (event: AgentEvent): Promise<void> => {
		// M3 的恢复观察仅供本地诊断，不进入 Extension、订阅者、Session JSONL 或模型上下文。
		if (event.type === "tool_recovery_observe") return;
		if (event.type === "agent_start" && this._toolRecoveryMode !== "off") {
			const sessionFile = this.sessionManager.getSessionFile();
			if (sessionFile) {
				await reconcileToolRecoveryLessons(this._toolRecoveryAgentDir, sessionFile, this._toolRecoveryScopeHash, {
					source: "reconcile",
				}).catch(() => {});
			}
		}
		let queueId: string | undefined;
		// Record nested tool calls and their usage on the parent tool result.
		if (this._nestedToolCalls) {
			if (event.type === "message_start" && event.message.role === "toolResult") {
				const message = event.message;
				const summary = this._nestedToolCalls.takeRecord(message.toolCallId);
				if (summary?.calls) message.nestedCalls = summary.calls;
				if (summary?.usage)
					message.usage = message.usage ? combineUsage(message.usage, summary.usage) : summary.usage;
			} else if (event.type === "agent_end") {
				this._nestedToolCalls.clear();
			}
		}
		// When a user message starts, remove the exact queued object before notifying listeners.
		if (event.type === "message_start" && event.message.role === "user") {
			this._overflowRecoveryAttempted = false;
			const steeringIndex = this._steeringQueueMessages.indexOf(event.message);
			if (steeringIndex !== -1) {
				queueId = this._steeringMessageIds[steeringIndex];
				this._steeringMessages.splice(steeringIndex, 1);
				this._steeringMessageIds.splice(steeringIndex, 1);
				this._steeringQueueMessages.splice(steeringIndex, 1);
				this._emitQueueUpdate();
			} else {
				const followUpIndex = this._followUpQueueMessages.indexOf(event.message);
				if (followUpIndex !== -1) {
					queueId = this._followUpMessageIds[followUpIndex];
					this._followUpMessages.splice(followUpIndex, 1);
					this._followUpMessageIds.splice(followUpIndex, 1);
					this._followUpQueueMessages.splice(followUpIndex, 1);
					this._emitQueueUpdate();
				}
			}
		}

		// Emit to extensions first, then notify public listeners.
		await this._emitExtensionEvent(event);
		if (event.type === "turn_end") {
			void this._toolRecoveryController?.refineTurn().catch(() => {
				// 后台提炼失败不影响已完成的轮次。
			});
		}

		if (event.type === "agent_end") {
			this._emit({ ...event, willRetry: this._willRetryAfterAgentEnd(event) });
		} else if (event.type === "message_start" && event.message.role === "user" && queueId !== undefined) {
			this._emit({ ...event, queueId });
		} else {
			this._emit(event);
		}

		// Handle session persistence
		if (event.type === "message_end") {
			let entryId: string | undefined;
			// Check if this is a custom message from extensions
			if (event.message.role === "custom") {
				// Persist as CustomMessageEntry
				entryId = this.sessionManager.appendCustomMessageEntry(
					event.message.customType,
					event.message.content,
					event.message.display,
					event.message.details,
				);
			} else if (
				event.message.role === "system" ||
				event.message.role === "user" ||
				event.message.role === "assistant" ||
				event.message.role === "toolResult"
			) {
				// Regular LLM message - persist as SessionMessageEntry
				entryId = this.sessionManager.appendMessage(event.message);
			}
			if (entryId) this._entryIdsByMessage.set(event.message, entryId);
			// Other message types (bashExecution, compactionSummary, branchSummary) are persisted elsewhere

			if (event.message.role === "assistant") {
				const assistantMsg = event.message as AssistantMessage;
				this._lastAssistantMessage = assistantMsg;
				if (assistantMsg.stopReason !== "error" && assistantMsg.stopReason !== "length") {
					this._overflowRecoveryAttempted = false;
				}

				// Reset retry counter immediately on successful assistant response
				// This prevents accumulation across multiple LLM calls within a turn
				if (assistantMsg.stopReason !== "error" && this._retryAttempt > 0) {
					this._emit({
						type: "auto_retry_end",
						success: true,
						attempt: this._retryAttempt,
					});
					this._retryAttempt = 0;
				}
			}
		}

		// A turn ends after its assistant message and every tool result has been appended,
		// so this is the first point in the run where a context-only custom message can be
		// inserted without landing between a tool call and its result. Flushing after the
		// extension and listener dispatch above also picks up messages that turn_end
		// handlers queued.
		if (event.type === "turn_end") {
			this._lastAssistantToolResults = event.toolResults;
			this._flushPendingCustomMessages();
		}
	};

	private _willRetryAfterAgentEnd(event: Extract<AgentEvent, { type: "agent_end" }>): boolean {
		if (this._agentRunAbortRequested) return false;
		const settings = this.settingsManager.getRetrySettings();
		if (!settings.enabled || this._retryAttempt >= settings.maxRetries) {
			return false;
		}

		for (let i = event.messages.length - 1; i >= 0; i--) {
			const message = event.messages[i];
			if (message.role === "assistant") {
				return this._isRetryableError(message as AssistantMessage);
			}
		}
		return false;
	}

	private _findPersistedMessageEntryId(message: AgentMessage): string | undefined {
		const mapped = this._entryIdsByMessage.get(message);
		if (mapped) return mapped;
		for (const entry of [...this.sessionManager.getBranch()].reverse()) {
			if (entry.type === "message" && entry.message === message) return entry.id;
		}

		const messageIndex = this.agent.state.messages.indexOf(message);
		if (messageIndex < 0) return undefined;
		const projection = this.sessionManager.buildSessionProjection();
		let projectedIndex = 0;
		for (const entry of projection.entries) {
			for (let i = 0; i < entry.messages.length; i++) {
				if (projectedIndex === messageIndex) {
					this._entryIdsByMessage.set(message, entry.sourceEntry.id);
					return entry.sourceEntry.id;
				}
				projectedIndex++;
			}
		}
		return undefined;
	}

	private _omitRecoveryAttempt(message: AssistantMessage, toolResults: AgentMessage[] = []): void {
		const targets = [message, ...toolResults];
		const targetIds = targets.map((target) => this._findPersistedMessageEntryId(target));
		const unresolvedProjectedTarget = targets.some(
			(target, index) => targetIds[index] === undefined && this.agent.state.messages.includes(target),
		);
		if (unresolvedProjectedTarget) {
			throw new Error("Cannot persist recovery omission because a projected message has no source entry");
		}
		for (const targetId of targetIds) {
			if (!targetId) continue;
			const editId = this.sessionManager.appendContextEdit(targetId, null);
			const entry = this.sessionManager.getEntry(editId);
			if (entry) this._emit({ type: "entry_appended", entry });
		}
		this._refreshFinalizedContext();
	}

	/** Find the last assistant message in agent state (including aborted ones) */
	private _findLastAssistantMessage(): AssistantMessage | undefined {
		const messages = this.agent.state.messages;
		for (let i = messages.length - 1; i >= 0; i--) {
			const msg = messages[i];
			if (msg.role === "assistant") {
				return msg as AssistantMessage;
			}
		}
		return undefined;
	}

	private _replaceMessageInPlace(target: AgentMessage, replacement: AgentMessage): void {
		// Agent-core stores the finalized message object in its state before emitting message_end.
		// SessionManager persistence happens later in _handleAgentEvent() with event.message.
		// Mutating this object in place keeps agent state, later turn/agent events, listeners,
		// and the eventual SessionManager.appendMessage(event.message) persistence in sync.
		if (target === replacement) {
			return;
		}

		const targetRecord = target as unknown as Record<string, unknown>;
		for (const key of Object.keys(targetRecord)) {
			delete targetRecord[key];
		}
		Object.assign(targetRecord, replacement);
	}

	/** Emit extension events based on agent events */
	private async _emitExtensionEvent(event: AgentEvent): Promise<void> {
		if (event.type === "agent_start") {
			this._turnIndex = 0;
			await this._extensionRunner.emit({ type: "agent_start" });
		} else if (event.type === "agent_end") {
			await this._extensionRunner.emit({ type: "agent_end", messages: event.messages });
		} else if (event.type === "turn_start") {
			const extensionEvent: TurnStartEvent = {
				type: "turn_start",
				turnIndex: this._turnIndex,
				timestamp: Date.now(),
			};
			await this._extensionRunner.emit(extensionEvent);
		} else if (event.type === "turn_end") {
			if (event.message.role === "assistant" && !this._boundaryDispatchedMessages.delete(event.message)) {
				await this._dispatchTurnEndBoundary(event.message, event.toolResults);
			}
			this._turnIndex++;
		} else if (event.type === "message_start") {
			const extensionEvent: MessageStartEvent = {
				type: "message_start",
				message: event.message,
			};
			await this._extensionRunner.emit(extensionEvent);
		} else if (event.type === "message_update") {
			const extensionEvent: MessageUpdateEvent = {
				type: "message_update",
				message: event.message,
				assistantMessageEvent: event.assistantMessageEvent,
			};
			await this._extensionRunner.emit(extensionEvent);
		} else if (event.type === "message_end") {
			const extensionEvent: MessageEndEvent = {
				type: "message_end",
				message: event.message,
			};
			const replacement = await this._extensionRunner.emitMessageEnd(extensionEvent);
			if (replacement) {
				// Untyped extension handlers can return messages with null/missing content;
				// normalize so it never enters agent state or session history.
				const normalized =
					(replacement.role === "user" ||
						replacement.role === "assistant" ||
						replacement.role === "toolResult" ||
						replacement.role === "custom") &&
					replacement.content == null
						? ({ ...replacement, content: [] } as AgentMessage)
						: replacement;
				this._replaceMessageInPlace(event.message, normalized);
			}
		} else if (event.type === "tool_execution_start") {
			const extensionEvent: ToolExecutionStartEvent = {
				type: "tool_execution_start",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				args: event.args,
			};
			await this._extensionRunner.emit(extensionEvent);
		} else if (event.type === "tool_execution_update") {
			const extensionEvent: ToolExecutionUpdateEvent = {
				type: "tool_execution_update",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				args: event.args,
				partialResult: event.partialResult,
			};
			await this._extensionRunner.emit(extensionEvent);
		} else if (event.type === "tool_execution_end") {
			const extensionEvent: ToolExecutionEndEvent = {
				type: "tool_execution_end",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				result: event.result,
				isError: event.isError,
			};
			await this._extensionRunner.emit(extensionEvent);
		}
	}

	/** 当前工具活动轮次的标识，用于丢弃迟到事件。 */
	getToolActivityEpoch(): string {
		return this._toolActivityTracker.epoch;
	}

	/** 当前工具活动状态的单调版本号。 */
	getToolActivityRevision(): number {
		return this._toolActivityTracker.revision;
	}

	/** 当前工具进行时状态；默认返回当前轮全部工具，activeOnly 只返回未终态工具。 */
	getToolActivitySnapshot(options: { activeOnly?: boolean } = {}): ToolActivitySnapshot[] {
		return this._toolActivityTracker.getSnapshot(options);
	}

	/**
	 * Subscribe to agent events.
	 * Session persistence is handled internally (saves messages on message_end).
	 * Multiple listeners can be added. Returns unsubscribe function for this listener.
	 */
	subscribe(listener: AgentSessionEventListener): () => void {
		this._eventListeners.push(listener);

		// Return unsubscribe function for this specific listener
		return () => {
			const index = this._eventListeners.indexOf(listener);
			if (index !== -1) {
				this._eventListeners.splice(index, 1);
			}
		};
	}

	/** Disconnect from agent events during disposal. */
	private _disconnectFromAgent(): void {
		if (this._unsubscribeAgent) {
			this._unsubscribeAgent();
			this._unsubscribeAgent = undefined;
		}
	}

	/**
	 * Remove all listeners and disconnect from agent.
	 * Call this when completely done with the session.
	 */
	dispose(): void {
		try {
			const commandSignal = this._commandSignals.getStore();
			for (const controller of this._inputAbortControllers) {
				if (controller.signal !== commandSignal) controller.abort();
			}
			this._agentRunAbortController?.abort();
			this.abortRetry();
			this.abortCompaction();
			this.abortBranchSummary();
			this.abortBash();
			this.agent.abort();
		} catch {
			// Dispose must succeed even if an abort hook throws.
		}

		this._extensionRunner.invalidate(
			"This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload(). For newSession, fork, and switchSession, move post-replacement work into withSession and use the ctx passed to withSession. For reload, do not use the old ctx after await ctx.reload().",
		);
		this._disconnectFromAgent();
		this._eventListeners = [];
		this._sessionLockCompromiseUnsubscriber?.();
		this._sessionLockCompromiseUnsubscriber = undefined;
		this.sessionManager.dispose();
		if (this._cacheWarmer) {
			this._cacheWarmer.onWarmed = undefined;
			this._cacheWarmer.cancel();
		}
		cleanupSessionResources(this.sessionId);
	}

	// =========================================================================
	// Read-only State Access
	// =========================================================================

	/** Refresh the public finalized transcript from the canonical session projection. */
	refreshContext(): void {
		this._refreshFinalizedContext();
	}

	/** Full agent state */
	get state(): AgentState {
		return this.agent.state;
	}

	/** Current cache-warming state and the policy inputs that produced it. */
	get cacheWarmingStatus(): CacheWarmingStatus | undefined {
		return this._cacheWarmer?.status;
	}

	/** Persist the cache-warming mode and immediately reconcile active warming. */
	setCacheWarmingMode(mode: CacheWarmingMode): void {
		this.settingsManager.setCacheWarmingMode(mode);
		this._cacheWarmer?.onModeChanged();
	}

	/** Current model (may be undefined if not yet selected) */
	get model(): Model<any> | undefined {
		return this.agent.state.model;
	}

	/** Current thinking level */
	get thinkingLevel(): ThinkingLevel {
		return this.agent.state.thinkingLevel;
	}

	private _restoreFastMode(): void {
		const entry = this.sessionManager
			.getBranch()
			.reverse()
			.find((item) => item.type === "custom" && item.customType === "fast_mode");
		this._fastMode = entry?.type === "custom" && (entry.data as { enabled?: unknown } | undefined)?.enabled === true;
	}

	private _fastModeModel(model: Model<Api>): Model<Api> {
		return this._modelRuntime.getModel(model.provider, model.id) ?? model;
	}

	get fastMode(): boolean {
		const model = this.model;
		return this._fastMode && !!model && supportsFastMode(this._fastModeModel(model));
	}

	setFastMode(enabled: boolean): void {
		const model = this.model;
		if (!model || !supportsFastMode(this._fastModeModel(model))) throw new Error("当前模型不支持快速模式");
		if (this._fastMode === enabled) return;
		this.sessionManager.appendCustomEntry("fast_mode", { enabled });
		this._fastMode = enabled;
	}

	/** Under a virtual selection, the physical model and thinking level of the latest successful response. */
	get routedModel(): { model: Model<any>; thinkingLevel?: ThinkingLevel } | undefined {
		if (!this.model || !isVirtualModel(this.model)) return undefined;
		const latest = findLatestResponse(this.agent.state.messages);
		const model = latest && this._modelRuntime.getPhysicalModel(latest.provider, latest.model);
		return model && { model, thinkingLevel: latest?.thinkingLevel };
	}

	/** Whether the session is currently processing an agent run or post-run continuation. */
	get isStreaming(): boolean {
		return this._isAgentRunActive;
	}

	/** Whether the session has no active agent run, compaction, branch summary, retry, or queued continuation. */
	get isIdle(): boolean {
		const inputSignal = this._commandSignals.getStore();
		const activeInputControllers = [...this._inputAbortControllers].filter(
			(controller) => controller.signal !== inputSignal,
		);
		return (
			!this._isAgentRunActive &&
			(activeInputControllers.length === 0 || this._isEmittingAgentSettled) &&
			!this.isCompacting
		);
	}

	/** Return the completed result for a specific structured turn. */
	getTurnResult(turnId: string): AgentTurnResult | undefined {
		return this._lastTurnResult?.turnId === turnId ? this._lastTurnResult : undefined;
	}

	/** Current effective system prompt, including changes not yet sent to the model. */
	get systemPrompt(): string {
		return buildSystemPrompt(this._runSystemPromptOptions ?? this._baseSystemPromptOptions);
	}

	/** Current retry attempt (0 if not retrying) */
	get retryAttempt(): number {
		return this._retryAttempt;
	}

	/**
	 * Get the names of currently active tools, which are the tools declared to the model.
	 * Tools with `codemode` or `deferred` exposure are callable from other tools without being active.
	 */
	getActiveToolNames(): string[] {
		return this.agent.state.tools.map((t) => t.name);
	}

	/** Get the names of the tools that tools can call through `ctx.executeTool()`. */
	getCallableToolNames(): string[] {
		return this._getCallableTools().map((t) => t.name);
	}

	/**
	 * Get all configured tools with name, description, parameter schema, prompt guidelines, and source metadata.
	 */
	getAllTools(): ToolInfo[] {
		return Array.from(this._toolDefinitions.values()).map(({ definition, sourceInfo }) => ({
			name: definition.name,
			description: definition.description,
			parameters: definition.parameters,
			promptGuidelines: definition.promptGuidelines,
			exposure: this._getToolExposure(definition.name),
			...(definition.namespace ? { namespace: definition.namespace } : {}),
			...(definition.annotations ? { annotations: { ...definition.annotations } } : {}),
			sourceInfo,
		}));
	}

	getToolDefinition(name: string): ToolDefinition | undefined {
		return this._toolDefinitions.get(name)?.definition;
	}

	/**
	 * Set active tools by name.
	 * Only tools in the registry can be enabled. Unknown and hidden tool names are ignored.
	 * Also rebuilds the system prompt to reflect the new tool set.
	 * Changes take effect on the next agent turn.
	 */
	setActiveToolsByName(toolNames: string[]): void {
		const previous = this.getActiveToolNames();
		this._setActiveTools(toolNames);
		// A loadout that deactivates a tool replaces the restored one, whose pending tools are dropped.
		// One that only adds tools, like activating tool_search, keeps them.
		const active = new Set(this.getActiveToolNames());
		if (previous.some((name) => !active.has(name))) this._pendingToolNames.clear();
	}

	private _setActiveTools(toolNames: string[]): void {
		const tools = this._applyToolLoadout(toolNames);
		for (const tool of tools) this._pendingToolNames.delete(tool.name);
		this._rebuildSystemPrompt(tools.map((tool) => tool.name));
	}

	/**
	 * Whether `--tools` and `--exclude-tools` keep the tool registered. MCP tools stay registered
	 * unless the allowlist filters them (see `_allowlistFiltersMcp`).
	 */
	private _isAllowedTool(name: string): boolean {
		if (this._excludedTools?.(name)) return false;
		if (!this._allowedTools || this._allowedTools(name)) return true;
		return !this._allowlistFiltersMcp && isMcpToolName(name);
	}

	/**
	 * Whether the tool may be active, which declares it to the model. MCP tools the allowlist keeps
	 * without matching them are only for codemode and tool_search: they may be declared only when
	 * tool_search can load them (non-`direct` exposure and tool_search registered). This also applies
	 * to tools restored from the transcript or set by extensions.
	 */
	private _isActivatable(name: string): boolean {
		if (!this._allowedTools || this._allowedTools(name) || !isMcpToolName(name)) return true;
		return this._getToolExposure(name) !== "direct" && this._toolRegistry.has("tool_search");
	}

	private _getToolExposure(name: string): ToolExposure {
		return this._toolDefinitions.get(name)?.definition.exposure ?? "direct";
	}

	/**
	 * Tools callable through `ctx.executeTool()`: the active `direct` tools and every registered
	 * `codemode` or `deferred` tool.
	 */
	private _getCallableTools(active: ReadonlySet<string> = new Set(this.getActiveToolNames())): AgentTool[] {
		return [...this._toolRegistry.values()].filter((tool) => {
			const exposure = this._getToolExposure(tool.name);
			return exposure === "codemode" || exposure === "deferred" || (exposure === "direct" && active.has(tool.name));
		});
	}

	/**
	 * Set the agent's tools for the given active tool names and return them. The active tools are
	 * the registered, non-hidden ones; they are declared to the model. Active tools with a
	 * `prepareLoadout` hook can change the declared descriptions and hide declarations from
	 * requests (see {@link _installHiddenDeclarationsProjection}).
	 */
	private _applyToolLoadout(toolNames: string[]): AgentTool[] {
		const tools = [...new Set(toolNames)].flatMap((name) => {
			const tool = this._toolRegistry.get(name);
			return tool && this._getToolExposure(name) !== "hidden" && this._isActivatable(name) ? [tool] : [];
		});
		const hooks = tools.flatMap((tool) => {
			const entry = this._toolDefinitions.get(tool.name);
			return entry?.definition.prepareLoadout ? [entry] : [];
		});
		const hidden = new Set<string>();
		let declared = tools;
		if (hooks.length > 0) {
			const loadout: ToolLoadout = {
				declared: tools,
				callable: this._getCallableTools(new Set(tools.map((tool) => tool.name))),
				registered: [...this._toolRegistry.values()],
				getExposure: (name) => this._getToolExposure(name),
				getNamespace: (name) => this._toolDefinitions.get(name)?.definition.namespace,
				getPromptGuidelines: (name) => this._toolPromptGuidelines.get(name) ?? [],
			};
			const descriptions = new Map<string, string>();
			for (const { definition, sourceInfo } of hooks) {
				try {
					const changes = definition.prepareLoadout?.(loadout);
					for (const [name, description] of Object.entries(changes?.descriptions ?? {})) {
						descriptions.set(name, description);
					}
					for (const name of changes?.hiddenDeclarations ?? []) hidden.add(name);
				} catch (error) {
					this._extensionRunner.emitError({
						extensionPath: sourceInfo.path,
						event: "prepare_loadout",
						error: error instanceof Error ? error.message : String(error),
						stack: error instanceof Error ? error.stack : undefined,
					});
				}
			}
			declared = tools.map((tool) => {
				const description = descriptions.get(tool.name);
				return description === undefined ? tool : { ...tool, description };
			});
		}
		this._hiddenDeclarations = hidden;
		this.agent.state.tools = declared;
		return declared;
	}

	/** Whether compaction or branch summarization is currently running */
	get isCompacting(): boolean {
		return (
			this._autoCompactionAbortController !== undefined ||
			this._compactionAbortController !== undefined ||
			this._branchSummaryAbortController !== undefined
		);
	}

	/** All messages including custom types like BashExecutionMessage */
	get messages(): AgentMessage[] {
		return this.agent.state.messages;
	}

	/** Current steering mode */
	get steeringMode(): "all" | "one-at-a-time" {
		return this.agent.steeringMode;
	}

	/** Current follow-up mode */
	get followUpMode(): "all" | "one-at-a-time" {
		return this.agent.followUpMode;
	}

	/** Current session file path, or undefined if sessions are disabled */
	get sessionFile(): string | undefined {
		return this.sessionManager.getSessionFile();
	}

	/** Current session ID */
	get sessionId(): string {
		return this.sessionManager.getSessionId();
	}

	/** Current session display name, if set */
	get sessionName(): string | undefined {
		return this.sessionManager.getSessionName();
	}

	/** Local-only Tool recovery counters. This data is never sent to providers or extensions. */
	getToolRecoveryDiagnostics(): ToolRecoveryDiagnostics {
		return (
			this._toolRecoveryController?.getDiagnostics() ?? createEmptyToolRecoveryDiagnostics(this._toolRecoveryMode)
		);
	}

	/** Scoped models for cycling (from --models flag) */
	get scopedModels(): ReadonlyArray<{ model: Model<any>; thinkingLevel?: ThinkingLevel }> {
		return this._scopedModels;
	}

	/** Update scoped models for cycling */
	setScopedModels(scopedModels: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>): void {
		this._scopedModels = scopedModels;
	}

	/** File-based prompt templates */
	get promptTemplates(): ReadonlyArray<PromptTemplate> {
		return this._resourceLoader.getPrompts().prompts;
	}

	private _normalizePromptSnippet(text: string | undefined): string | undefined {
		if (!text) return undefined;
		const oneLine = text
			.replace(/[\r\n]+/g, " ")
			.replace(/\s+/g, " ")
			.trim();
		return oneLine.length > 0 ? oneLine : undefined;
	}

	private _normalizePromptGuidelines(guidelines: string[] | undefined): string[] {
		if (!guidelines || guidelines.length === 0) {
			return [];
		}

		const unique = new Set<string>();
		for (const guideline of guidelines) {
			const normalized = guideline.trim();
			if (normalized.length > 0) {
				unique.add(normalized);
			}
		}
		return Array.from(unique);
	}

	private _rebuildSystemPrompt(toolNames: string[]): void {
		const validToolNames = toolNames.filter((name) => this._toolRegistry.has(name));
		const toolSnippets: Record<string, string> = {};
		const promptGuidelines: string[] = [];
		for (const name of this._toolRegistry.keys()) {
			const snippet = this._toolPromptSnippets.get(name);
			// Tools without a snippet are not listed.
			if (snippet) toolSnippets[name] = snippet;
		}
		if (validToolNames.includes("edit") && !validToolNames.includes("apply_patch")) {
			promptGuidelines.push(
				"The apply_patch tool is unavailable. Use read snapshots and inclusive line ranges with edit; do not send oldText.",
			);
		}

		const loaderSystemPrompt = this._resourceLoader.getSystemPrompt();
		const loaderAppendSystemPrompt = this._resourceLoader.getAppendSystemPrompt();
		const appendSystemPrompt = loaderAppendSystemPrompt.length > 0 ? loaderAppendSystemPrompt.join("\n\n") : "";
		const loadedSkills = this._resourceLoader.getSkills().skills;
		const loadedContextFiles = this._resourceLoader.getAgentsFiles().agentsFiles;

		this._baseSystemPromptOptions = normalizeBuildSystemPromptOptions({
			cwd: this._cwd,
			skills: loadedSkills,
			contextFiles: loadedContextFiles,
			customPrompt: loaderSystemPrompt,
			appendSystemPrompt,
			selectedTools: validToolNames,
			hiddenTools: [...this._hiddenDeclarations],
			toolSnippets,
			toolGuidelines: Object.fromEntries(this._toolPromptGuidelines),
		});
	}

	/**
	 * Apply a prompt and tool loadout for the next request. Sets the executable tools and
	 * returns a system message patching the prompt sections the model currently has (replayed
	 * from `messages`), or undefined when the prompt is unchanged. Tool changes are declared by
	 * the agent loop before the request.
	 *
	 * A forced prompt does not affect the transcript: the structured sections are still diffed
	 * and persisted, and the forced text is projected onto the request by
	 * {@link _installAgentForcedPromptProjection}.
	 */
	private _preparePromptAndToolLoadout(
		options: NormalizedBuildSystemPromptOptions,
		messages: AgentMessage[] = this.agent.state.messages,
	): SystemMessage | undefined {
		options.selectedTools = this._applyToolLoadout(options.selectedTools).map((tool) => tool.name);
		// The tool list and rules must match the declarations the request carries.
		options.hiddenTools = [...this._hiddenDeclarations];
		const sections = diffSystemPromptSections(
			getCurrentSystemMessage(messages)?.sections ?? {},
			buildSystemPromptSections(options),
		);
		return sections ? { role: "system", content: "", sections, timestamp: Date.now() } : undefined;
	}

	/**
	 * Send a forced prompt as the provider's leading system prompt without recording it.
	 *
	 * A `before_agent_start` handler that returns `systemPrompt` needs that exact text at the
	 * head of the request; a mid-conversation system message would leave the original prompt
	 * in place. The forced text is a rendering of the current prompt, so the transcript keeps
	 * its structured sections and the request is projected instead: the system messages
	 * collapse into one head holding the forced text and the current tools. Runs after the
	 * `context` extension handlers.
	 */
	/**
	 * Remove the declarations that `prepareLoadout` hooks hide from every request. The whole
	 * transcript is filtered with the current set, so the projected declarations stay consistent
	 * across requests and only change when the loadout does.
	 */
	private _installHiddenDeclarationsProjection(): void {
		const previousTransformContext = this.agent.transformContext;
		this.agent.transformContext = async (messages, signal) => {
			const transformed = previousTransformContext ? await previousTransformContext(messages, signal) : messages;
			const hidden = this._hiddenDeclarations;
			if (hidden.size === 0) return transformed;
			return transformed.map((message) => {
				if (message.role !== "system" || (!message.toolsAdded && !message.toolsRemoved)) return message;
				const { toolsAdded, toolsRemoved, ...rest } = message;
				const added = toolsAdded?.filter((tool) => !hidden.has(tool.name)) ?? [];
				const removed = toolsRemoved?.filter((tool) => !hidden.has(tool.name)) ?? [];
				return {
					...rest,
					...(added.length > 0 ? { toolsAdded: added } : {}),
					...(removed.length > 0 ? { toolsRemoved: removed } : {}),
				};
			});
		};
	}

	private _installAgentForcedPromptProjection(): void {
		const previousTransformContext = this.agent.transformContext;
		this.agent.transformContext = async (messages, signal) => {
			const transformed = previousTransformContext ? await previousTransformContext(messages, signal) : messages;
			const forced = this._runSystemPromptOptions?.forceSystemPrompt;
			if (forced === undefined) return transformed;
			const current = getCurrentSystemMessage(transformed);
			const head: SystemMessage = {
				role: "system",
				content: forced,
				...(current?.toolsAdded ? { toolsAdded: current.toolsAdded } : {}),
				timestamp: current?.timestamp ?? Date.now(),
			};
			return [head, ...transformed.filter((message) => message.role !== "system")];
		};
	}

	/**
	 * Restore the active tool loadout declared by the session transcript, if it declares one.
	 * Tools reachable only from other tools are never declared, but they do not depend on the active
	 * set, so the transcript's declarations are the whole loadout.
	 */
	private _restoreToolsFromTranscript(): void {
		this._pendingToolNames.clear();
		const current = getCurrentSystemMessage(this.sessionManager.buildSessionContext().messages);
		if (!current) return;
		const names = (current.toolsAdded ?? []).map((tool) => tool.name);
		this._pendingToolNames = new Set(names.filter((name) => this._isAllowedTool(name)));
		this._setActiveTools(names);
	}

	// =========================================================================
	// Prompting
	// =========================================================================

	private async _withInputCancellation<T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> {
		const controller = new AbortController();
		if (!this._isAgentRunActive && this._inputAbortControllers.size === 0) this._agentRunAbortRequested = false;
		this._inputAbortControllers.add(controller);
		try {
			return await run(controller.signal);
		} finally {
			this._inputAbortControllers.delete(controller);
			this._resolveIdleWaitIfIdle();
		}
	}

	private async _runAgentPrompt(messages: AgentMessage | AgentMessage[], inputSignal?: AbortSignal): Promise<void> {
		inputSignal?.throwIfAborted();
		const controller = new AbortController();
		this._agentRunAbortController = controller;
		this._toolRecoveryController?.beginTask?.();
		this._agentRunAbortRequested = false;
		// Compaction before the prompt may have scheduled a retry; the new prompt replaces it.
		this._failedResponse = undefined;
		this._recordSelection();
		// The run records the loadout in the transcript; restored tools that did not register by now
		// are dropped, so a tool that never registers does not stay pending.
		this._pendingToolNames.clear();
		this._isAgentRunActive = true;
		try {
			await this.agent.prompt(messages);
			while (!this._agentRunAbortRequested) {
				if (await raceWithAbortSignal(this._handlePostAgentRun(), controller.signal)) {
					if (this._agentRunAbortRequested) break;
					await this.agent.continue();
					continue;
				}
				if (this._agentRunAbortRequested || !(await this._runBeforeSettleBoundary())) break;
				if (this._agentRunAbortRequested) break;
				await this.agent.continue();
			}
		} catch (error) {
			if (!controller.signal.aborted) throw error;
		} finally {
			if (this._agentRunAbortRequested) this._finishCancelledRetry();
			this._failedResponse = undefined;
			this._runSystemPromptOptions = undefined;
			this._flushPendingBashMessages();
			this._flushPendingCustomMessages();
			try {
				await this._emitAgentSettled();
			} finally {
				if (this._agentRunAbortController === controller) this._agentRunAbortController = undefined;
			}
		}
	}

	private async _handlePostAgentRun(): Promise<boolean> {
		const message = this._lastAssistantMessage;
		const toolResults = this._lastAssistantToolResults;
		this._lastAssistantMessage = undefined;
		this._lastAssistantToolResults = [];
		if (this._agentRunAbortRequested) {
			this._finishCancelledRetry();
			return false;
		}
		if (!message) return this.agent.hasQueuedMessages();

		if (this._isRetryableError(message) && (await this._prepareRetry(message))) {
			if (this._agentRunAbortRequested) this._finishCancelledRetry();
			this._failedResponse = message;
			return !this._agentRunAbortRequested;
		}
		if (this._agentRunAbortRequested) {
			this._finishCancelledRetry();
			return false;
		}

		if (message.stopReason === "error" && this._retryAttempt > 0) {
			this._emit({
				type: "auto_retry_end",
				success: false,
				attempt: this._retryAttempt,
				finalError: message.errorMessage,
			});
			this._retryAttempt = 0;
		}

		if (await this._checkCompaction(message, true, toolResults)) {
			return !this._agentRunAbortRequested;
		}

		// The low-level loop drains both queues before agent_end. Messages queued by
		// agent_end handlers require a fresh run before pre-settlement handlers fire.
		return !this._agentRunAbortRequested && this.agent.hasQueuedMessages();
	}

	private async _runBeforeSettleBoundary(): Promise<boolean> {
		if (!this._extensionRunner.hasHandlers("agent_before_settle")) return this.agent.hasQueuedMessages();
		this._isBeforeSettle = true;
		this._abortDuringBeforeSettle = false;
		try {
			const result = await this._extensionRunner.emitBoundary(
				{ type: "agent_before_settle", outcome: this._lastActivityOutcome },
				(entries) => this._buildBoundaryContext(entries, "agent_before_settle"),
			);
			this._commitBoundaryDrafts(result.entries);
			this._flushPendingCustomMessages();
			const finalContext = this._buildBoundaryContext([], "agent_before_settle");
			if (this._abortDuringBeforeSettle) return false;
			const shouldContinue = result.continue || this.agent.hasQueuedMessages();
			if (shouldContinue && !finalContext.canContinue) {
				if (result.continue) this._reportInvalidBoundaryContinuation("agent_before_settle");
				return false;
			}
			return shouldContinue;
		} finally {
			this._isBeforeSettle = false;
		}
	}

	private async _runInputHandlers(
		text: string,
		images: ImageContent[] | undefined,
		source: InputSource,
		streamingBehavior: "steer" | "followUp" | undefined,
		turn: AgentTurnContext,
	): Promise<{ text: string; images: ImageContent[] | undefined } | undefined> {
		if (!this._extensionRunner.hasHandlers("input")) {
			return { text, images };
		}

		const inputResult = await this._extensionRunner.emitInput(text, images, source, streamingBehavior, turn);
		if (inputResult.action === "handled") {
			return undefined;
		}
		if (inputResult.action === "transform") {
			return { text: inputResult.text, images: inputResult.images ?? images };
		}
		return { text, images };
	}

	private async _normalizePromptImages(
		images: ImageContent[] | undefined,
	): Promise<{ images: ImageContent[]; hints: string[] }> {
		if (!images) return { images: [], hints: [] };

		const normalizedImages: ImageContent[] = [];
		const hints: string[] = [];
		for (const image of images) {
			const processed = await processImage(Buffer.from(image.data, "base64"), image.mimeType, {
				autoResizeImages: this.settingsManager.getImageAutoResize(),
				resizeOptions: this._limitsModel()?.inputLimits?.images?.resize,
			});
			if (!processed.ok) {
				hints.push(processed.message);
				continue;
			}
			normalizedImages.push({ type: "image", data: processed.data, mimeType: processed.mimeType });
			hints.push(...processed.hints);
		}
		return { images: normalizedImages, hints };
	}

	/**
	 * Send a prompt to the agent.
	 * - Handles extension commands (registered via pi.registerCommand) immediately, even during streaming
	 * - Expands file-based prompt templates by default
	 * - During streaming, queues via steer() or followUp() based on streamingBehavior option
	 * - Validates model and API key before sending (when not streaming)
	 * @throws Error if streaming and no streamingBehavior specified
	 * @throws Error if no model selected or no API key available (when not streaming)
	 */
	async prompt(text: string, options?: PromptOptions): Promise<void> {
		await this.promptWithOrigin(text, options);
	}

	async promptWithOrigin(text: string, options?: PromptOptions): Promise<AgentTurnContext | undefined> {
		return this._withInputCancellation((signal) => this._promptWithOrigin(text, options, signal));
	}

	private async _promptWithOrigin(
		text: string,
		options: PromptOptions | undefined,
		signal: AbortSignal,
	): Promise<AgentTurnContext | undefined> {
		const roomInput = options?.origin !== undefined && rootOriginOf(options.origin) === "room";
		const expandPromptTemplates = !roomInput && (options?.expandPromptTemplates ?? true);
		if (this._isEmittingAgentSettled) {
			this._deferredSettledActions.push(async () => {
				await this.promptWithOrigin(text, options);
			});
			return;
		}
		const preflightResult = options?.preflightResult;
		let messages: AgentMessage[] | undefined;
		let turn: AgentTurnContext | undefined;
		let ownsTurn = false;
		const previousActiveToolNames = options?.activeToolNames ? this.getActiveToolNames() : undefined;
		const previousCapabilityLease = options?.capabilities ? this._activeCapabilityLease : undefined;

		try {
			if (roomInput && (this._activeTurnContext || this.isStreaming)) {
				throw new Error("当前会话仍在处理上一条消息，请稍后重试");
			}
			if (!roomInput && this._activeTurnContext?.rootOrigin === "room") {
				throw new Error("当前会话正在处理智能体协作消息，请稍后重试");
			}
			// Handle extension commands first (execute immediately, even during streaming)
			// Extension commands manage their own LLM interaction via pi.sendMessage()
			if (expandPromptTemplates && text.startsWith("/")) {
				const handled = await raceWithAbortSignal(this._tryExecuteExtensionCommand(text, signal), signal);
				signal.throwIfAborted();
				if (handled) {
					// Extension command executed, no prompt to send
					preflightResult?.("handled");
					return;
				}
			}

			if (this._compactionAbortController !== undefined) {
				throw new Error(
					"Cannot submit a prompt while compaction is in progress. Wait for compaction to finish and retry.",
				);
			}

			turn = this._activeTurnContext ?? {
				turnId: randomUUID(),
				inputId: options?.inputId ?? randomUUID(),
				origin:
					options?.origin ??
					({
						type: "user",
						channel: options?.source === "rpc" ? "rpc" : "interactive",
					} satisfies AgentInputOrigin),
				rootOrigin: rootOriginOf(
					options?.origin ?? { type: "user", channel: options?.source === "rpc" ? "rpc" : "interactive" },
				),
			};
			ownsTurn = this._activeTurnContext === undefined;
			if (ownsTurn) {
				this._activeTurnContext = turn;
				this._activeCapabilityLease = options?.capabilities;
			}

			// Emit input event for extension interception (before skill/template expansion)
			const processedInput = await raceWithAbortSignal(
				this._runInputHandlers(
					text,
					options?.images,
					options?.source ?? "interactive",
					this.isStreaming ? options?.streamingBehavior : undefined,
					turn,
				),
				signal,
			);
			signal.throwIfAborted();
			if (!processedInput) {
				preflightResult?.("handled");
				if (ownsTurn) {
					this._activeTurnContext = undefined;
					this._activeCapabilityLease = previousCapabilityLease;
				}
				return turn;
			}
			const { text: currentText, images: currentImages } = processedInput;

			// Expand skill commands (/skill:name args) and prompt templates (/template args)
			let expandedText = currentText;
			if (expandPromptTemplates) {
				expandedText = this._expandSkillCommand(expandedText);
				expandedText = expandPromptTemplate(expandedText, [...this.promptTemplates]);
			}

			// If streaming, queue via steer() or followUp() based on option
			if (this.isStreaming) {
				if (!options?.streamingBehavior) {
					throw new Error(
						"Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.",
					);
				}
				if (options.streamingBehavior === "followUp") {
					await this._queueFollowUp(expandedText, currentImages, options.queueId);
				} else {
					await this._queueSteer(expandedText, currentImages, options.queueId);
				}
				preflightResult?.("queued");
				if (ownsTurn) {
					this._activeTurnContext = undefined;
					this._activeCapabilityLease = previousCapabilityLease;
				}
				return turn;
			}

			// Flush any pending bash and custom messages before the new prompt
			this._flushPendingBashMessages();
			this._flushPendingCustomMessages();

			// Validate model
			if (!this.model) {
				throw new Error(formatNoModelSelectedMessage());
			}

			const hasConfiguredAuth =
				this._modelRuntime.hasConfiguredAuth(this.model.provider) ||
				(await raceWithAbortSignal(this._modelRuntime.checkAuth(this.model.provider), signal)) !== undefined;
			if (!hasConfiguredAuth) {
				const isOAuth = this._modelRuntime.isUsingOAuth(this.model.provider);
				if (isOAuth) {
					throw new Error(
						`Authentication failed for "${this.model.provider}". ` +
							`Credentials may have expired or network is unavailable. ` +
							`Run '/login ${this.model.provider}' to re-authenticate.`,
					);
				}
				throw new Error(formatNoApiKeyFoundMessage(this.model.provider));
			}

			// Check if we need to compact before sending (catches aborted responses).
			// The user's new prompt is sent below, so do not call agent.continue() here.
			const lastAssistant = this._findLastAssistantMessage();
			if (lastAssistant) {
				await raceWithAbortSignal(this._checkCompaction(lastAssistant, false), signal);
			}

			// Emit before_agent_start before normalizing images so extension-driven model
			// selection determines the resize profile used for the request and history.
			const selectedToolsBefore = this._baseSystemPromptOptions.selectedTools;
			const result = await raceWithAbortSignal(
				this._extensionRunner.emitBeforeAgentStart(
					expandedText,
					currentImages,
					this._baseSystemPromptOptions,
					turn,
				),
				signal,
			);
			signal.throwIfAborted();
			const providerMessages = await raceWithAbortSignal(
				this._extensionRunner.prepareContextProviders(expandedText, turn),
				signal,
			);
			signal.throwIfAborted();
			// Handlers may edit event.systemPromptOptions.selectedTools or call setActiveTools(),
			// which updates the live loadout instead. An explicit edit wins; otherwise the live
			// loadout is authoritative, so a setActiveTools() call is not undone here.
			const handlerEditedTools =
				result.systemPromptOptions.selectedTools.length !== selectedToolsBefore.length ||
				result.systemPromptOptions.selectedTools.some((name, index) => name !== selectedToolsBefore[index]);
			if (!handlerEditedTools) result.systemPromptOptions.selectedTools = this.getActiveToolNames();
			const toolLease = options?.capabilities?.allowedTools ?? options?.activeToolNames;
			if (toolLease) {
				const allowed = new Set(toolLease);
				result.systemPromptOptions.selectedTools = result.systemPromptOptions.selectedTools.filter((name) =>
					allowed.has(name),
				);
			}

			const normalized = await raceWithAbortSignal(this._normalizePromptImages(currentImages), signal);
			signal.throwIfAborted();
			const userText =
				normalized.hints.length > 0 ? `${expandedText}\n\n${normalized.hints.join("\n")}` : expandedText;

			// Build messages only after hooks and image normalization have completed.
			messages = [];
			const userContent: (TextContent | ImageContent)[] = [{ type: "text", text: userText }];
			userContent.push(...normalized.images);
			messages.push({
				role: "user",
				content: userContent,
				timestamp: Date.now(),
			});

			// Inject any pending "nextTurn" messages as context alongside the user message
			for (const msg of this._pendingNextTurnMessages) {
				messages.push(msg);
			}
			this._pendingNextTurnMessages = [];

			for (const msg of [...result.messages, ...providerMessages]) {
				messages.push({
					role: "custom",
					customType: msg.customType,
					// Untyped extensions can pass null/missing content; normalize at ingestion.
					content: msg.content ?? [],
					display: msg.display,
					details: msg.details,
					timestamp: Date.now(),
				});
			}
			const updateMessage = this._preparePromptAndToolLoadout(result.systemPromptOptions);
			this._runSystemPromptOptions = result.systemPromptOptions;
			if (updateMessage) messages.unshift(updateMessage);

			// 最终预算必须包含扩展展开的 Skill 和附加消息。
			await raceWithAbortSignal(
				this._prepareRequestContext(
					{
						messages: [...this.agent.state.messages, ...messages],
						tools: this.agent.state.tools,
					},
					messages,
					signal,
				),
				signal,
			);
			signal.throwIfAborted();
		} catch (error) {
			if (signal.aborted && ownsTurn) {
				await this._emitAgentSettled();
				this._activeTurnContext = undefined;
				this._activeCapabilityLease = previousCapabilityLease;
				return turn;
			}
			if (ownsTurn) {
				this._activeTurnContext = undefined;
				this._activeCapabilityLease = previousCapabilityLease;
			}
			throw error;
		}

		if (!messages) {
			if (ownsTurn) {
				this._activeTurnContext = undefined;
				this._activeCapabilityLease = previousCapabilityLease;
			}
			return turn;
		}

		preflightResult?.("started");
		try {
			await this._runAgentPrompt(messages, signal);
			return turn;
		} finally {
			if (previousActiveToolNames) this.setActiveToolsByName([...previousActiveToolNames]);
			if (ownsTurn) {
				this._activeTurnContext = undefined;
				this._activeCapabilityLease = previousCapabilityLease;
			}
		}
	}

	/**
	 * Try to execute an extension command. Returns true if command was found and executed.
	 */
	private async _tryExecuteExtensionCommand(text: string, signal: AbortSignal): Promise<boolean> {
		// Parse command name and args
		const spaceIndex = text.indexOf(" ");
		const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
		const args = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1);

		const command = this._extensionRunner.getCommand(commandName);
		if (!command) return false;

		// Get command context from extension runner (includes session control methods)
		const ctx = this._extensionRunner.createCommandContext();

		try {
			await raceWithAbortSignal(
				this._commandSignals.run(signal, () =>
					this._extensionRunner.runWithSignal(signal, () => command.handler(args, ctx)),
				),
				signal,
			);
			return true;
		} catch (err) {
			if (signal.aborted) throw err;
			// Emit error via extension runner
			this._extensionRunner.emitError({
				extensionPath: `command:${commandName}`,
				event: "command",
				error: err instanceof Error ? err.message : String(err),
			});
			return true;
		}
	}

	/**
	 * Expand skill commands (/skill:name args) to their full content.
	 * Returns the expanded text, or the original text if not a skill command or skill not found.
	 * Emits errors via extension runner if file read fails.
	 */
	private _expandSkillCommand(text: string): string {
		if (!text.startsWith("/skill:")) return text;

		const spaceIndex = text.indexOf(" ");
		const skillName = spaceIndex === -1 ? text.slice(7) : text.slice(7, spaceIndex);
		const args = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1).trim();

		const skill = this.resourceLoader.getSkills().skills.find((s) => s.name === skillName);
		if (!skill) return text; // Unknown skill, pass through

		try {
			const content = readFileSync(skill.filePath, "utf-8");
			const body = stripFrontmatter(content).trim();
			const skillBlock = `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`;
			return args ? `${skillBlock}\n\n${args}` : skillBlock;
		} catch (err) {
			// Emit error like extension commands do
			this._extensionRunner.emitError({
				extensionPath: skill.filePath,
				event: "skill_expansion",
				error: err instanceof Error ? err.message : String(err),
			});
			return text; // Return original on error
		}
	}

	private async _queueUserInput(
		text: string,
		images: ImageContent[] | undefined,
		behavior: "steer" | "followUp",
		source: InputSource,
		requestedQueueId?: string,
	): Promise<QueuedInputDisposition> {
		return this._withInputCancellation((signal) =>
			this._queueUserInputWithSignal(text, images, behavior, source, requestedQueueId, signal),
		);
	}

	private async _queueUserInputWithSignal(
		text: string,
		images: ImageContent[] | undefined,
		behavior: "steer" | "followUp",
		source: InputSource,
		requestedQueueId: string | undefined,
		signal: AbortSignal,
	): Promise<QueuedInputDisposition> {
		if (this._activeTurnContext?.rootOrigin === "room") {
			throw new Error("当前会话正在处理智能体协作消息，请稍后重试");
		}
		if (text.startsWith("/")) {
			this._throwIfExtensionCommand(text);
		}

		const processedInput = await raceWithAbortSignal(
			this._runInputHandlers(
				text,
				images,
				source,
				this.isStreaming ? behavior : undefined,
				this._activeTurnContext ?? {
					turnId: randomUUID(),
					inputId: requestedQueueId ?? randomUUID(),
					origin: { type: "user", channel: source === "rpc" ? "rpc" : "interactive" },
					rootOrigin: "user",
				},
			),
			signal,
		);
		signal.throwIfAborted();
		if (!processedInput) return "handled";

		let expandedText = this._expandSkillCommand(processedInput.text);
		expandedText = expandPromptTemplate(expandedText, [...this.promptTemplates]);

		if (behavior === "steer") {
			await this._queueSteer(expandedText, processedInput.images, requestedQueueId);
		} else {
			await this._queueFollowUp(expandedText, processedInput.images, requestedQueueId);
		}
		return "queued";
	}

	/**
	 * Queue a steering message while the agent is running.
	 * Delivered after the current assistant turn finishes executing its tool calls,
	 * before the next LLM call.
	 * Expands skill commands and prompt templates. Errors on extension commands.
	 * @param images Optional image attachments to include with the message
	 * @param options Input source; defaults to interactive
	 * @throws Error if text is an extension command
	 */
	async steer(
		text: string,
		images?: ImageContent[],
		optionsOrQueueId?: { source?: InputSource } | string,
	): Promise<QueuedInputDisposition> {
		const source = typeof optionsOrQueueId === "string" ? "interactive" : (optionsOrQueueId?.source ?? "interactive");
		const queueId = typeof optionsOrQueueId === "string" ? optionsOrQueueId : undefined;
		return this._queueUserInput(text, images, "steer", source, queueId);
	}

	/**
	 * Queue a follow-up message to be processed after the agent finishes.
	 * Delivered only when agent has no more tool calls or steering messages.
	 * Expands skill commands and prompt templates. Errors on extension commands.
	 * @param images Optional image attachments to include with the message
	 * @param options Input source; defaults to interactive
	 * @throws Error if text is an extension command
	 */
	async followUp(
		text: string,
		images?: ImageContent[],
		optionsOrQueueId?: { source?: InputSource } | string,
	): Promise<QueuedInputDisposition> {
		const source = typeof optionsOrQueueId === "string" ? "interactive" : (optionsOrQueueId?.source ?? "interactive");
		const queueId = typeof optionsOrQueueId === "string" ? optionsOrQueueId : undefined;
		return this._queueUserInput(text, images, "followUp", source, queueId);
	}

	/**
	 * Internal: Queue a steering message (already expanded, no extension command check).
	 */
	private async _queueSteer(text: string, images?: ImageContent[], requestedQueueId?: string): Promise<void> {
		const queueId = this._nextQueueMessageId(requestedQueueId);
		const content: (TextContent | ImageContent)[] = [{ type: "text", text }];
		if (images) content.push(...images);
		const message: AgentMessage = {
			role: "user",
			content,
			timestamp: Date.now(),
		};
		this._steeringMessages.push(text);
		this._steeringMessageIds.push(queueId);
		this._steeringQueueMessages.push(message);
		this._emitQueueUpdate();
		this.agent.steer(message);
	}

	/**
	 * Internal: Queue a follow-up message (already expanded, no extension command check).
	 */
	private async _queueFollowUp(text: string, images?: ImageContent[], requestedQueueId?: string): Promise<void> {
		const queueId = this._nextQueueMessageId(requestedQueueId);
		const content: (TextContent | ImageContent)[] = [{ type: "text", text }];
		if (images) content.push(...images);
		const message: AgentMessage = {
			role: "user",
			content,
			timestamp: Date.now(),
		};
		this._followUpMessages.push(text);
		this._followUpMessageIds.push(queueId);
		this._followUpQueueMessages.push(message);
		this._emitQueueUpdate();
		this.agent.followUp(message);
	}

	/**
	 * Throw an error if the text is an extension command.
	 */
	private _throwIfExtensionCommand(text: string): void {
		const spaceIndex = text.indexOf(" ");
		const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
		const command = this._extensionRunner.getCommand(commandName);

		if (command) {
			throw new Error(
				`Extension command "/${commandName}" cannot be queued. Use prompt() or execute the command when not streaming.`,
			);
		}
	}

	/**
	 * Send a custom message to the session. Creates a CustomMessageEntry.
	 *
	 * Handles four cases:
	 * - Streaming: queues message, processed when loop pulls from queue
	 * - Streaming + triggerTurn false: appended to state/session once the current turn ends
	 * - Not streaming + triggerTurn: appends to state/session, starts new turn
	 * - Not streaming + no trigger: appends to state/session, no turn
	 *
	 * @param message Custom message with customType, content, display, details
	 * @param options.triggerTurn If true and not streaming, triggers a new LLM turn
	 * @param options.deliverAs Delivery mode: "steer", "followUp", or "nextTurn"
	 */
	async sendCustomMessage<T = unknown>(
		message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details">,
		options?: {
			triggerTurn?: boolean;
			deliverAs?: "steer" | "followUp" | "nextTurn";
			origin?: AgentInputOrigin;
		},
	): Promise<void> {
		const appMessage = {
			role: "custom" as const,
			customType: message.customType,
			// Untyped extensions can pass null/missing content; normalize at ingestion.
			content: message.content ?? [],
			display: message.display,
			details: message.details,
			timestamp: Date.now(),
		} satisfies CustomMessage<T>;
		if (options?.deliverAs === "nextTurn") {
			this._pendingNextTurnMessages.push(appMessage);
		} else if (this.isStreaming && options?.triggerTurn !== false) {
			if (options?.deliverAs === "followUp") {
				this.agent.followUp(appMessage);
			} else {
				this.agent.steer(appMessage);
			}
		} else if (options?.triggerTurn) {
			const previousTurn = this._activeTurnContext;
			const turn = options.origin
				? {
						turnId: randomUUID(),
						inputId: randomUUID(),
						origin: options.origin,
						rootOrigin: rootOriginOf(options.origin),
					}
				: previousTurn;
			if (!turn) throw new Error("扩展触发的 Agent Turn 缺少来源上下文");
			this._activeTurnContext = turn;
			try {
				if (this._isEmittingAgentSettled) {
					this._deferredSettledActions.push(async () => await this._runAgentPrompt(appMessage));
					return;
				}
				await this._runAgentPrompt(appMessage);
			} finally {
				this._activeTurnContext = previousTurn;
			}
		} else if (this.isStreaming) {
			// Appending now would put the message between an assistant tool call and its
			// result, which providers that validate message order reject on replay. Defer
			// to the end of the turn. Nothing is emitted yet: message events must not
			// describe messages the session tree does not contain.
			this._pendingCustomMessages.push(appMessage);
		} else {
			this._appendCustomMessage(appMessage);
		}
	}

	private _appendCustomMessage(appMessage: CustomMessage): void {
		this.sessionManager.appendCustomMessageEntry(
			appMessage.customType,
			appMessage.content,
			appMessage.display,
			appMessage.details,
		);
		this._refreshFinalizedContext();
		this._emit({ type: "message_start", message: appMessage });
		this._emit({ type: "message_end", message: appMessage });
	}

	/**
	 * Append custom messages queued while the agent was running.
	 * Called once the current turn's tool results are in agent state and session history.
	 */
	private _flushPendingCustomMessages(): void {
		if (this._pendingCustomMessages.length === 0) return;

		const pending = this._pendingCustomMessages;
		this._pendingCustomMessages = [];
		for (const appMessage of pending) {
			this._appendCustomMessage(appMessage);
		}
	}

	/**
	 * Send a user message to the agent. Always triggers a turn.
	 * When the agent is streaming, use deliverAs to specify how to queue the message.
	 *
	 * @param content User message content (string or content array)
	 * @param options.deliverAs Delivery mode when streaming: "steer" or "followUp"
	 * @param options.expandPromptTemplates Whether to dispatch extension commands and expand skill commands and prompt templates. Default: false.
	 */
	async sendUserMessage(
		content: string | (TextContent | ImageContent)[],
		options?: { deliverAs?: "steer" | "followUp"; expandPromptTemplates?: boolean },
	): Promise<void> {
		// Normalize content to text string + optional images
		let text: string;
		let images: ImageContent[] | undefined;

		if (typeof content === "string") {
			text = content;
		} else {
			const textParts: string[] = [];
			images = [];
			for (const part of content) {
				if (part.type === "text") {
					textParts.push(part.text);
				} else {
					images.push(part);
				}
			}
			text = textParts.join("\n");
			if (images.length === 0) images = undefined;
		}

		await this.prompt(text, {
			expandPromptTemplates: options?.expandPromptTemplates ?? false,
			streamingBehavior: options?.deliverAs,
			images,
			source: "extension",
		});
	}

	/**
	 * Apply an action to one queued message without rebuilding the rest of the queue.
	 * "steer" moves a follow-up message into the steering queue and preserves attachments.
	 */
	queueAction(queueId: string, action: "remove" | "steer"): void {
		const id = queueId.trim();
		if (!id) throw Object.assign(new Error("排队消息标识不能为空"), { code: "queue_message_not_found" });

		const followUpIndex = this._followUpMessageIds.indexOf(id);
		if (followUpIndex !== -1) {
			const text = this._followUpMessages[followUpIndex];
			if (action === "steer" && text === undefined) throw new Error("排队消息内容不存在");
			const message = this.agent.removeFollowUpMessageAt(followUpIndex);
			if (!message) throw Object.assign(new Error("排队消息已被处理"), { code: "queue_message_not_found" });
			this._followUpMessages.splice(followUpIndex, 1);
			this._followUpMessageIds.splice(followUpIndex, 1);
			this._followUpQueueMessages.splice(followUpIndex, 1);
			if (action === "steer") {
				this._steeringMessages.push(text);
				this._steeringMessageIds.push(id);
				this._steeringQueueMessages.push(message);
				this.agent.steer(message);
			}
			this._emitQueueUpdate();
			return;
		}

		const steeringIndex = this._steeringMessageIds.indexOf(id);
		if (steeringIndex !== -1 && action === "remove") {
			const message = this.agent.removeSteeringMessageAt(steeringIndex);
			if (!message) throw Object.assign(new Error("排队消息已被处理"), { code: "queue_message_not_found" });
			this._steeringMessages.splice(steeringIndex, 1);
			this._steeringMessageIds.splice(steeringIndex, 1);
			this._steeringQueueMessages.splice(steeringIndex, 1);
			this._emitQueueUpdate();
			return;
		}

		if (steeringIndex !== -1) {
			throw Object.assign(new Error("引导消息不能再次调整方向"), { code: "queue_message_action_invalid" });
		}
		throw Object.assign(new Error("排队消息不存在"), { code: "queue_message_not_found" });
	}

	/**
	 * Clear all queued messages and return them.
	 * Useful for restoring to editor when user aborts.
	 * @returns Object with steering and followUp arrays
	 */
	clearQueue(): { steering: string[]; followUp: string[] } {
		const steering = [...this._steeringMessages];
		const followUp = [...this._followUpMessages];
		this._steeringMessages = [];
		this._steeringMessageIds = [];
		this._steeringQueueMessages = [];
		this._followUpMessages = [];
		this._followUpMessageIds = [];
		this._followUpQueueMessages = [];
		this.agent.clearAllQueues();
		this._emitQueueUpdate();
		return { steering, followUp };
	}

	/** Number of pending messages (includes both steering and follow-up) */
	get pendingMessageCount(): number {
		return this._steeringMessages.length + this._followUpMessages.length;
	}

	/** Get pending steering messages (read-only) */
	getSteeringMessages(): readonly string[] {
		return this._steeringMessages;
	}

	/** Get pending follow-up messages (read-only) */
	getFollowUpMessages(): readonly string[] {
		return this._followUpMessages;
	}

	/** Get pending steering messages with stable IDs (read-only) */
	getSteeringQueueItems(): Array<{ id: string; text: string }> {
		return this._steeringMessages.map((text, index) => ({ id: this._steeringMessageIds[index]!, text }));
	}

	/** Get pending follow-up messages with stable IDs (read-only) */
	getFollowUpQueueItems(): Array<{ id: string; text: string }> {
		return this._followUpMessages.map((text, index) => ({ id: this._followUpMessageIds[index]!, text }));
	}

	get resourceLoader(): ResourceLoader {
		return this._resourceLoader;
	}

	/**
	 * Abort current operation and wait for agent to become idle.
	 */
	async abort(): Promise<void> {
		if (this._isAgentRunActive || this._inputAbortControllers.size > 0) {
			this._agentRunAbortRequested = true;
		}
		const commandSignal = this._commandSignals.getStore();
		for (const controller of this._inputAbortControllers) {
			if (controller.signal !== commandSignal) controller.abort();
		}
		this._agentRunAbortController?.abort();
		this._deferredSettledActions.length = 0;
		this.abortRetry();
		this.abortCompaction();
		this.abortBranchSummary();
		if (this._isBeforeSettle) this._abortDuringBeforeSettle = true;
		this.agent.abort();
		await this.waitForIdle();
	}

	async waitForIdle(): Promise<void> {
		const inputSignal = this._commandSignals.getStore();
		if (this._isIdleForWait(inputSignal)) return;
		await this._getIdleWaitPromise(inputSignal);
	}

	// =========================================================================
	// Model Management
	// =========================================================================

	private async _emitModelSelect(
		nextModel: Model<any>,
		previousModel: Model<any> | undefined,
		source: "set" | "cycle" | "restore",
	): Promise<void> {
		if (modelsAreEqual(previousModel, nextModel)) return;
		await this._extensionRunner.emit({
			type: "model_select",
			model: nextModel,
			previousModel,
			source,
		});
	}

	/**
	 * Set model directly.
	 * Validates that auth is configured and saves to the session transcript.
	 * Persists to global defaults only when options.persist is true.
	 * @throws Error if no auth is configured for the model
	 */
	async setModel(model: Model<any>, options: ModelMutationOptions = {}): Promise<void> {
		if (!(await this._modelRuntime.checkAuth(model.provider))) {
			throw new Error(`No API key for ${model.provider}/${model.id}`);
		}

		const previousModel = this.model;
		const thinkingLevel = this._getThinkingLevelForModelSwitch(model);
		this.agent.state.model = model;
		this.sessionManager.appendModelChange(model.provider, model.id);
		if (this._fastMode && !supportsFastMode(model)) {
			this.sessionManager.appendCustomEntry("fast_mode", { enabled: false });
			this._fastMode = false;
		}
		if (options.persist) {
			this.settingsManager.setDefaultModelAndProvider(model.provider, model.id);
			this._addPersistedDefaultToNonEmptyScope(model);
		}

		// Apply thinking level for the new model.
		// Per-model thinking level overrides take priority over the global default.
		// Model persistence does not implicitly rewrite the global thinking default.
		this.setThinkingLevel(thinkingLevel);

		await this._emitModelSelect(model, previousModel, "set");
	}

	private _addPersistedDefaultToNonEmptyScope(model: Model<any>): void {
		if (this._scopedModels.length === 0) return;
		if (this._scopedModels.some((scoped) => modelsAreEqual(scoped.model, model))) return;

		this._scopedModels = [...this._scopedModels, { model }];

		const enabledModels = this.settingsManager.getEnabledModels();
		if (!enabledModels?.length) return;

		const modelReference = `${model.provider}/${model.id}`;
		if (enabledModels.some((pattern) => pattern.toLowerCase() === modelReference.toLowerCase())) return;
		this.settingsManager.setEnabledModels([...enabledModels, modelReference]);
	}

	/**
	 * Cycle to next/previous model.
	 * Uses scoped models (from --models flag) if available, otherwise all available models.
	 * @param direction - "forward" (default) or "backward"
	 * @returns The new model info, or undefined if only one model available
	 */
	async cycleModel(
		direction: "forward" | "backward" = "forward",
		options: ModelMutationOptions = {},
	): Promise<ModelCycleResult | undefined> {
		if (this._scopedModels.length > 0) {
			return this._cycleScopedModel(direction, options);
		}
		return this._cycleAvailableModel(direction, options);
	}

	private async _cycleScopedModel(
		direction: "forward" | "backward",
		options: ModelMutationOptions,
	): Promise<ModelCycleResult | undefined> {
		const availableIds = new Set(
			this._modelRuntime.getAvailableSnapshot().map((model) => `${model.provider}\0${model.id}`),
		);
		const scopedModels = this._scopedModels.filter((scoped) =>
			availableIds.has(`${scoped.model.provider}\0${scoped.model.id}`),
		);
		if (scopedModels.length <= 1) return undefined;

		const currentModel = this.model;
		let currentIndex = scopedModels.findIndex((sm) => modelsAreEqual(sm.model, currentModel));

		if (currentIndex === -1) currentIndex = 0;
		const len = scopedModels.length;
		const nextIndex = direction === "forward" ? (currentIndex + 1) % len : (currentIndex - 1 + len) % len;
		const next = scopedModels[nextIndex];
		const thinkingLevel = this._getThinkingLevelForModelSwitch(next.model, next.thinkingLevel);

		// Apply model
		this.agent.state.model = next.model;
		this.sessionManager.appendModelChange(next.model.provider, next.model.id);
		if (this._fastMode && !supportsFastMode(next.model)) {
			this.sessionManager.appendCustomEntry("fast_mode", { enabled: false });
			this._fastMode = false;
		}
		if (options.persist) {
			this.settingsManager.setDefaultModelAndProvider(next.model.provider, next.model.id);
			this._addPersistedDefaultToNonEmptyScope(next.model);
		}

		// Apply thinking level for the new model.
		// - Explicit scoped model thinking level overrides defaults
		// - Per-model thinking level overrides take priority over the global default
		// setThinkingLevel clamps to model capabilities.
		// Model persistence does not implicitly rewrite the global thinking default.
		this.setThinkingLevel(thinkingLevel);

		await this._emitModelSelect(next.model, currentModel, "cycle");

		return { model: next.model, thinkingLevel: this.thinkingLevel, isScoped: true };
	}

	private async _cycleAvailableModel(
		direction: "forward" | "backward",
		options: ModelMutationOptions,
	): Promise<ModelCycleResult | undefined> {
		const availableModels = this._modelRuntime.getAvailableSnapshot();
		if (availableModels.length <= 1) return undefined;

		const currentModel = this.model;
		let currentIndex = availableModels.findIndex((m) => modelsAreEqual(m, currentModel));

		if (currentIndex === -1) currentIndex = 0;
		const len = availableModels.length;
		const nextIndex = direction === "forward" ? (currentIndex + 1) % len : (currentIndex - 1 + len) % len;
		const nextModel = availableModels[nextIndex];

		const thinkingLevel = this._getThinkingLevelForModelSwitch(nextModel);
		this.agent.state.model = nextModel;
		this.sessionManager.appendModelChange(nextModel.provider, nextModel.id);
		if (this._fastMode && !supportsFastMode(nextModel)) {
			this.sessionManager.appendCustomEntry("fast_mode", { enabled: false });
			this._fastMode = false;
		}
		if (options.persist) {
			this.settingsManager.setDefaultModelAndProvider(nextModel.provider, nextModel.id);
			this._addPersistedDefaultToNonEmptyScope(nextModel);
		}

		// Apply thinking level for the new model.
		// Model persistence does not implicitly rewrite the global thinking default.
		this.setThinkingLevel(thinkingLevel);

		await this._emitModelSelect(nextModel, currentModel, "cycle");

		return { model: nextModel, thinkingLevel: this.thinkingLevel, isScoped: false };
	}

	// =========================================================================
	// Thinking Level Management
	// =========================================================================

	/**
	 * Set thinking level.
	 * Clamps to model capabilities based on available thinking levels.
	 * Saves the clamped level to the session transcript only if the level actually changes.
	 * Persists the requested level to global defaults only when options.persist is true.
	 */
	setThinkingLevel(level: ThinkingLevel, options: ModelMutationOptions = {}): void {
		const availableLevels = this.getAvailableThinkingLevels();
		const effectiveLevel = availableLevels.includes(level) ? level : this._clampThinkingLevel(level, availableLevels);

		// Only persist if actually changing
		const previousLevel = this.agent.state.thinkingLevel;
		const isChanging = effectiveLevel !== previousLevel;

		this.agent.state.thinkingLevel = effectiveLevel;

		if (options.persist) {
			this.settingsManager.setDefaultThinkingLevel(level);
		}

		if (isChanging) {
			this.sessionManager.appendThinkingLevelChange(effectiveLevel);
			this._emit({ type: "thinking_level_changed", level: effectiveLevel });
			void this._extensionRunner.emit({
				type: "thinking_level_select",
				level: effectiveLevel,
				previousLevel,
			});
		}
	}

	/**
	 * Cycle to next thinking level.
	 * @returns New level, or undefined if model doesn't support thinking
	 */
	cycleThinkingLevel(options: ModelMutationOptions = {}): ThinkingLevel | undefined {
		if (!this.supportsThinking()) return undefined;

		const levels = this.getAvailableThinkingLevels();
		const currentIndex = levels.indexOf(this.thinkingLevel);
		const nextIndex = (currentIndex + 1) % levels.length;
		const nextLevel = levels[nextIndex];

		this.setThinkingLevel(nextLevel, options);
		return nextLevel;
	}

	/**
	 * Get available thinking levels for current model.
	 * The provider will clamp to what the specific model supports internally.
	 */
	getAvailableThinkingLevels(): ThinkingLevel[] {
		if (!this.model) return [...THINKING_LEVEL_OPTIONS];
		return getSupportedThinkingLevels(this.model) as ThinkingLevel[];
	}

	/**
	 * Check if current model supports thinking/reasoning.
	 */
	supportsThinking(): boolean {
		return !!this.model?.reasoning;
	}

	private _getThinkingLevelForModelSwitch(targetModel?: Model<any>, explicitLevel?: ThinkingLevel): ThinkingLevel {
		if (explicitLevel !== undefined) {
			return explicitLevel;
		}
		// Per-model default takes priority when switching to a model that has one
		if (targetModel) {
			const perModel = this.settingsManager.getModelThinkingLevel(targetModel.provider, targetModel.id);
			if (perModel !== undefined) {
				return perModel;
			}
		}
		return this.settingsManager.getDefaultThinkingLevel() ?? this.thinkingLevel ?? DEFAULT_THINKING_LEVEL;
	}

	private _clampThinkingLevel(level: ThinkingLevel, _availableLevels: ThinkingLevel[]): ThinkingLevel {
		return this.model ? (clampThinkingLevel(this.model, level) as ThinkingLevel) : "off";
	}

	// =========================================================================
	// Queue Mode Management
	// =========================================================================

	private syncQueueModesFromSettings(): void {
		this.agent.steeringMode = this.settingsManager.getSteeringMode();
		this.agent.followUpMode = this.settingsManager.getFollowUpMode();
	}

	/**
	 * Set steering message mode.
	 * Saves to settings.
	 */
	setSteeringMode(mode: "all" | "one-at-a-time"): void {
		this.agent.steeringMode = mode;
		this.settingsManager.setSteeringMode(mode);
	}

	/**
	 * Set follow-up message mode.
	 * Saves to settings.
	 */
	setFollowUpMode(mode: "all" | "one-at-a-time"): void {
		this.agent.followUpMode = mode;
		this.settingsManager.setFollowUpMode(mode);
	}

	// =========================================================================
	// Compaction
	// =========================================================================

	/** Generate Pi's built-in compaction summary for manual and automatic compaction. */
	private async _runDefaultCompaction(
		preparation: CompactionPreparation,
		model: Model<any>,
		customInstructions: string | undefined,
		signal: AbortSignal,
		reason: "manual" | "threshold" | "overflow",
	): Promise<CompactionResult> {
		// Resolve the request only when Pi summarizes itself: routing may call models or fail.
		const request = await raceWithAbortSignal(this._getSummarizationRequestAuth(model, signal), signal);
		return raceWithAbortSignal(
			compact(
				preparation,
				request.model,
				request.apiKey,
				request.headers,
				customInstructions,
				signal,
				request.thinkingLevel,
				this.agent.streamFunction,
				request.env,
				this.settingsManager.getRetrySettings(),
				this._summarizationRetryCallbacks({ source: "compaction", reason }),
				undefined, // sessionId
			),
			signal,
		);
	}

	private _clearManualCompactionState(): void {
		this._compactionAbortController = undefined;
		this._resolveIdleWaitIfIdle();
	}

	/**
	 * Manually compact the session context.
	 *
	 * This is the manual entry point used by `/compact`, RPC, and extensions. It is
	 * separate from automatic threshold/overflow compaction, which enters through
	 * `_checkCompaction()` and `_runAutoCompaction()`. After preparation and the
	 * `session_before_compact` hook, both paths call the lower-level `compact()`
	 * function imported from `./compaction/index.ts`, unless the hook cancels or
	 * supplies a custom result.
	 *
	 * Aborts the current agent operation first. Manual compaction never retries or
	 * continues the interrupted agent turn.
	 *
	 * @param customInstructions Optional instructions for the compaction summary
	 */
	async compact(customInstructions?: string): Promise<CompactionResult> {
		await this.abort();
		this._compactionAbortController = new AbortController();
		this._emit({ type: "compaction_start", reason: "manual" });
		let fromExtension = false;
		let cancelledByExtension = false;

		try {
			const model = this.model;
			if (!model) {
				throw new Error(formatNoModelSelectedMessage());
			}

			const settings = this.settingsManager.getCompactionSettings(model);
			const pathEntries = this.sessionManager.getBranch();

			const preparation = prepareCompaction(pathEntries, settings);
			if (!preparation) {
				// Check why we can't compact
				const lastEntry = pathEntries[pathEntries.length - 1];
				if (lastEntry?.type === "compaction") {
					throw new Error("Already compacted");
				}
				throw new Error("Nothing to compact (session too small)");
			}

			let extensionCompaction: CompactionResult | undefined;

			if (this._extensionRunner.hasHandlers("session_before_compact")) {
				const result = (await this._extensionRunner.emit({
					type: "session_before_compact",
					preparation,
					branchEntries: pathEntries,
					customInstructions,
					reason: "manual",
					willRetry: false,
					signal: this._compactionAbortController.signal,
				})) as SessionBeforeCompactResult | undefined;

				if (this._compactionAbortController.signal.aborted) throw new Error("Compaction cancelled");
				if (result?.cancel) {
					cancelledByExtension = true;
					throw new Error("Compaction cancelled");
				}

				if (result?.compaction) {
					extensionCompaction = result.compaction;
					fromExtension = true;
				}
			}

			let summary: string;
			let firstKeptEntryId: string;
			let tokensBefore: number;
			let usage: Usage | undefined;
			let details: unknown;

			if (extensionCompaction) {
				// Extension provided compaction content
				summary = extensionCompaction.summary;
				firstKeptEntryId = extensionCompaction.firstKeptEntryId;
				tokensBefore = extensionCompaction.tokensBefore;
				usage = extensionCompaction.usage;
				details = extensionCompaction.details;
			} else {
				// Shared default summary generator, also used by automatic compaction.
				const result = await this._runDefaultCompaction(
					preparation,
					model,
					customInstructions,
					this._compactionAbortController.signal,
					"manual",
				);
				summary = result.summary;
				firstKeptEntryId = result.firstKeptEntryId;
				tokensBefore = result.tokensBefore;
				usage = result.usage;
				details = result.details;
			}

			if (this._compactionAbortController.signal.aborted) {
				throw new Error("Compaction cancelled");
			}

			const compactionEntryId = this.sessionManager.appendCompaction(
				summary,
				firstKeptEntryId,
				tokensBefore,
				details,
				fromExtension,
				usage,
			);
			const savedCompactionEntry = this.sessionManager.getEntry(compactionEntryId) as CompactionEntry | undefined;
			if (savedCompactionEntry) {
				this._emit({ type: "entry_appended", entry: savedCompactionEntry });
			}
			this._refreshFinalizedContext();
			const estimatedTokensAfter = estimateMessagesTokens(this.agent.state.messages);

			if (this._extensionRunner && savedCompactionEntry) {
				await this._extensionRunner.emit({
					type: "session_compact",
					compactionEntry: savedCompactionEntry,
					fromExtension,
					reason: "manual",
					willRetry: false,
				});
			}

			const compactionResult: CompactionResult = {
				summary,
				firstKeptEntryId,
				tokensBefore,
				estimatedTokensAfter,
				usage,
				details,
			};
			// compaction_end listeners may submit queued prompts, so expose idle state before notifying them.
			this._clearManualCompactionState();
			this._emit({
				type: "compaction_end",
				reason: "manual",
				result: compactionResult,
				aborted: false,
				willRetry: false,
			});
			return compactionResult;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const aborted = this._compactionAbortController.signal.aborted || cancelledByExtension;
			const errorMessage = aborted ? undefined : `Compaction failed: ${message}`;
			this._clearManualCompactionState();
			this._emit({
				type: "compaction_end",
				reason: "manual",
				result: undefined,
				aborted,
				willRetry: false,
				errorMessage,
			});
			await this._emitSessionCompactFailed({
				reason: "manual",
				errorMessage,
				aborted,
				willRetry: false,
				fromExtension,
			});
			throw aborted ? new Error("Compaction cancelled") : error;
		} finally {
			this._clearManualCompactionState();
		}
	}

	/**
	 * Cancel in-progress compaction (manual or auto).
	 */
	abortCompaction(): void {
		this._compactionAbortController?.abort();
		this._autoCompactionAbortController?.abort();
	}

	/**
	 * Cancel in-progress branch summarization.
	 */
	abortBranchSummary(): void {
		this._branchSummaryAbortController?.abort();
	}

	/**
	 * Dispatch automatic compaction after `agent_end` or before prompt submission.
	 * Manual compaction does not call this method; it enters through `compact()`.
	 *
	 * Automatic cases:
	 * 1. Overflow with retry: a context-overflow error or recoverable length stop;
	 *    remove the failed assistant message, compact, and retry the turn once.
	 * 2. Overflow without retry: a successful response exceeded the configured
	 *    context window; compact but preserve the completed response.
	 * 3. Threshold without retry: valid or estimated context usage crossed the
	 *    configured threshold; compact without retrying the completed response.
	 *
	 * Each case calls `_runAutoCompaction()`. After preparation and the
	 * `session_before_compact` hook, that method calls the lower-level `compact()`
	 * function imported from `./compaction/index.ts`, unless the hook cancels or
	 * supplies a custom result.
	 *
	 * @param assistantMessage The assistant message to check
	 * @param skipAbortedCheck If false, include aborted messages (for pre-prompt check). Default: true
	 * @returns Whether the post-run loop should call `agent.continue()` for overflow recovery or queued messages
	 */
	private async _checkCompaction(
		assistantMessage: AssistantMessage,
		skipAbortedCheck = true,
		toolResults: AgentMessage[] = [],
	): Promise<boolean> {
		const settings = this.settingsManager.getCompactionSettings(this.model);
		if (!settings.enabled) return false;

		// Skip if message was aborted (user cancelled) - unless skipAbortedCheck is false
		if (skipAbortedCheck && assistantMessage.stopReason === "aborted") return false;

		// Skip overflow check if the message came from a different model.
		// This handles the case where user switched from a smaller-context model (e.g. opus)
		// to a larger-context model (e.g. codex) - the overflow error from the old model
		// shouldn't trigger compaction for the new model. Under a virtual selection, the
		// physical model that produced the message supplies the limits.
		const messageModel = this._modelForMessage(assistantMessage);
		const sameModel = messageModel !== undefined;
		const contextWindow = (messageModel ?? this.model)?.contextWindow ?? 0;

		// Skip compaction checks if this assistant message is older than the latest
		// compaction boundary. This prevents a stale pre-compaction usage/error
		// from retriggering compaction on the first prompt after compaction.
		const compactionEntry = getLatestCompactionEntry(this.sessionManager.getBranch());
		const assistantIsFromBeforeCompaction =
			compactionEntry !== null && assistantMessage.timestamp <= new Date(compactionEntry.timestamp).getTime();
		if (assistantIsFromBeforeCompaction) {
			return false;
		}

		// Automatic cases 1 and 2: context overflow.
		// A length stop is recoverable when output ended below the model's original desired limit,
		// independent of the configured context size or any context-clamped provider request limit.
		const currentProjection = this.sessionManager.buildSessionProjection();
		const assistantEntryId = this._findPersistedMessageEntryId(assistantMessage);
		const assistantIsProjected =
			assistantEntryId === undefined ||
			currentProjection.entries.some(
				(entry) =>
					entry.sourceEntry.id === assistantEntryId &&
					entry.messages.some((message) => message.role === "assistant"),
			);
		const branch = this.sessionManager.getBranch();
		const assistantIndex = assistantEntryId ? branch.findIndex((entry) => entry.id === assistantEntryId) : -1;
		const entriesAfterAssistant = assistantIndex >= 0 ? branch.slice(assistantIndex + 1) : [];
		const hasPostAssistantContextEdit = entriesAfterAssistant.some((entry) => entry.type === "context_edit");
		const latestAssistantEdit = entriesAfterAssistant
			.filter(
				(entry): entry is ContextEditEntry => entry.type === "context_edit" && entry.targetId === assistantEntryId,
			)
			.at(-1);
		const assistantRetainedForExplicitRecovery =
			assistantEntryId === undefined ||
			(!entriesAfterAssistant.some((entry) => entry.type === "compaction") &&
				latestAssistantEdit?.replacement !== null);
		const assistantUsageMatchesProjection = assistantIsProjected && !hasPostAssistantContextEdit;
		const explicitOverflow = assistantMessage.stopReason === "error" && isContextOverflow(assistantMessage);
		const contextOverflow =
			sameModel &&
			((explicitOverflow && assistantRetainedForExplicitRecovery) ||
				(assistantUsageMatchesProjection && isContextOverflow(assistantMessage, contextWindow)));
		const recoverableLength =
			sameModel && assistantIsProjected && isRecoverableLength(assistantMessage, messageModel.maxTokens);
		if (contextOverflow || recoverableLength) {
			const willRetry = assistantMessage.stopReason !== "stop";

			// Case 2: the response completed successfully. Compact, but do not retry because
			// agent.continue() cannot continue from a completed assistant response.
			if (!willRetry) {
				return await this._runAutoCompaction("overflow", false);
			}

			if (this._overflowRecoveryAttempted) {
				const errorMessage = contextOverflow
					? "Context overflow recovery failed after one compact-and-retry attempt. Try reducing context or switching to a larger-context model."
					: "Truncated response recovery failed after one compact-and-retry attempt.";
				this._emit({
					type: "compaction_end",
					reason: "overflow",
					result: undefined,
					aborted: false,
					willRetry: false,
					errorMessage,
				});
				await this._emitSessionCompactFailed({
					reason: "overflow",
					errorMessage,
					aborted: false,
					willRetry: false,
					fromExtension: false,
				});
				return false;
			}

			// Persistently omit the selected final attempt before post-run recovery compaction.
			this._overflowRecoveryAttempted = true;
			this._omitRecoveryAttempt(assistantMessage, toolResults);
			const retry = await this._runAutoCompaction("overflow", willRetry);
			if (retry) this._failedResponse = assistantMessage;
			return retry;
		}

		// Case 3: threshold compaction without retry.
		// For error messages or all-zero usage messages, estimate from the last valid response.
		// This ensures sessions that hit persistent API errors (e.g. 529) or malformed zero-usage
		// responses can still compact and do not reset context accounting.
		let contextTokens: number;
		const projection = currentProjection;
		const hasContextEdits = projection.entries.some((entry) => entry.sourceEntry.type === "context_edit");
		const directContextTokens = assistantMessage.usage ? calculateContextTokens(assistantMessage.usage) : 0;
		if (hasContextEdits) {
			contextTokens = estimateProjectedContextTokens(projection, branch).tokens;
		} else if (assistantMessage.stopReason === "error" || directContextTokens === 0) {
			const messages = this.agent.state.messages;
			const estimate = estimateContextTokens(messages);
			if (estimate.lastUsageIndex !== null) {
				const usageMsg = messages[estimate.lastUsageIndex];
				if (
					compactionEntry &&
					usageMsg?.role === "assistant" &&
					(usageMsg as AssistantMessage).timestamp <= new Date(compactionEntry.timestamp).getTime()
				) {
					return false;
				}
			}
			contextTokens = estimate.tokens;
		} else {
			contextTokens = directContextTokens;
		}
		if (shouldCompact(contextTokens, contextWindow, settings)) {
			return await this._runAutoCompaction("threshold", false);
		}
		return false;
	}

	/**
	 * Execute threshold or overflow compaction. Manual compaction uses
	 * `AgentSession.compact()` instead. Both paths call the lower-level `compact()`
	 * function imported from `./compaction/index.ts` after preparation and extension
	 * interception.
	 *
	 * @param reason Automatic trigger selected by `_checkCompaction()`
	 * @param willRetry Whether to continue the interrupted turn after overflow compaction
	 * @returns Whether the post-run loop should call `agent.continue()`
	 */
	private async _runAutoCompaction(reason: "overflow" | "threshold", willRetry: boolean): Promise<boolean> {
		const model = this.model;
		const settings = this.settingsManager.getCompactionSettings(model);
		let abortController: AbortController | undefined;
		this._lastAutoCompactionError = undefined;
		let started = false;
		let fromExtension = false;
		let cancelledByExtension = false;

		try {
			if (!model) {
				return false;
			}

			const pathEntries = this.sessionManager.getBranch();
			const preparation = prepareCompaction(pathEntries, settings);
			if (!preparation) {
				this._lastAutoCompactionError = "没有找到可安全拆分的历史消息，请缩短当前单条输入或 Tool 输出。";
				return false;
			}

			abortController = new AbortController();
			this._autoCompactionAbortController = abortController;
			started = true;
			this._emit({ type: "compaction_start", reason });
			abortController.signal.throwIfAborted();

			let extensionCompaction: CompactionResult | undefined;

			if (this._extensionRunner.hasHandlers("session_before_compact")) {
				const extensionResult = (await this._extensionRunner.emit({
					type: "session_before_compact",
					preparation,
					branchEntries: pathEntries,
					customInstructions: undefined,
					reason,
					willRetry,
					signal: abortController.signal,
				})) as SessionBeforeCompactResult | undefined;

				if (extensionResult?.cancel) {
					cancelledByExtension = true;
					this._lastAutoCompactionError = "Extension 取消了本次压缩。";
					this._emit({
						type: "compaction_end",
						reason,
						result: undefined,
						aborted: true,
						willRetry: false,
					});
					await this._emitSessionCompactFailed({
						reason,
						aborted: true,
						willRetry: false,
						fromExtension: false,
					});
					return false;
				}

				if (extensionResult?.compaction) {
					extensionCompaction = extensionResult.compaction;
					fromExtension = true;
				}
			}
			abortController.signal.throwIfAborted();

			let summary: string;
			let firstKeptEntryId: string;
			let tokensBefore: number;
			let usage: Usage | undefined;
			let details: unknown;

			if (extensionCompaction) {
				// Extension provided compaction content
				summary = extensionCompaction.summary;
				firstKeptEntryId = extensionCompaction.firstKeptEntryId;
				tokensBefore = extensionCompaction.tokensBefore;
				usage = extensionCompaction.usage;
				details = extensionCompaction.details;
			} else {
				// Shared default summary generator, also used by manual compaction.
				const compactResult = await this._runDefaultCompaction(
					preparation,
					model,
					undefined,
					abortController.signal,
					reason,
				);
				summary = compactResult.summary;
				firstKeptEntryId = compactResult.firstKeptEntryId;
				tokensBefore = compactResult.tokensBefore;
				usage = compactResult.usage;
				details = compactResult.details;
			}
			abortController.signal.throwIfAborted();

			const compactionEntryId = this.sessionManager.appendCompaction(
				summary,
				firstKeptEntryId,
				tokensBefore,
				details,
				fromExtension,
				usage,
			);
			const savedCompactionEntry = this.sessionManager.getEntry(compactionEntryId) as CompactionEntry | undefined;
			if (savedCompactionEntry) {
				this._emit({ type: "entry_appended", entry: savedCompactionEntry });
			}
			this._refreshFinalizedContext();
			const estimatedTokensAfter = estimateMessagesTokens(this.agent.state.messages);

			if (this._extensionRunner && savedCompactionEntry) {
				await this._extensionRunner.emit({
					type: "session_compact",
					compactionEntry: savedCompactionEntry,
					fromExtension,
					reason,
					willRetry,
				});
			}

			const result: CompactionResult = {
				summary,
				firstKeptEntryId,
				tokensBefore,
				estimatedTokensAfter,
				usage,
				details,
			};
			this._emit({ type: "compaction_end", reason, result, aborted: false, willRetry });

			if (willRetry) return true;

			// Auto-compaction can complete while follow-up/steering/custom messages are waiting.
			// Continue once so queued messages are delivered.
			return this.agent.hasQueuedMessages();
		} catch (error) {
			const message = error instanceof Error ? error.message : "compaction failed";
			const aborted = abortController?.signal.aborted === true || cancelledByExtension;
			if (!aborted) this._lastAutoCompactionError = message;
			if (started) {
				const errorMessage = aborted
					? undefined
					: reason === "overflow"
						? `Context overflow recovery failed: ${message}`
						: `Auto-compaction failed: ${message}`;
				this._emit({
					type: "compaction_end",
					reason,
					result: undefined,
					aborted,
					willRetry: false,
					errorMessage,
				});
				await this._emitSessionCompactFailed({
					reason,
					errorMessage,
					aborted,
					willRetry: false,
					fromExtension,
				});
			}
			return false;
		} finally {
			if (this._autoCompactionAbortController === abortController) {
				this._autoCompactionAbortController = undefined;
			}
			this._resolveIdleWaitIfIdle();
		}
	}

	/**
	 * Toggle auto-compaction setting.
	 */
	setAutoCompactionEnabled(enabled: boolean): void {
		this.settingsManager.setCompactionEnabled(enabled);
	}

	/** Whether auto-compaction is enabled */
	get autoCompactionEnabled(): boolean {
		return this.settingsManager.getCompactionEnabled();
	}

	async bindExtensions(bindings: ExtensionBindings): Promise<void> {
		if (bindings.uiContext !== undefined) {
			this._extensionUIContext = bindings.uiContext;
		}
		if (bindings.mode !== undefined) {
			this._extensionMode = bindings.mode;
		}
		if (bindings.commandContextActions !== undefined) {
			this._extensionCommandContextActions = bindings.commandContextActions;
		}
		if (bindings.abortHandler !== undefined) {
			this._extensionAbortHandler = bindings.abortHandler;
		}
		if (bindings.shutdownHandler !== undefined) {
			this._extensionShutdownHandler = bindings.shutdownHandler;
		}
		if (bindings.onError !== undefined) {
			this._extensionErrorListener = bindings.onError;
		}

		this._applyExtensionBindings(this._extensionRunner);
		if (!this._extensionLifecycleDeferred) {
			await this.emitSessionStart(this._sessionStartEvent);
		}
	}

	async activateExtensionLifecycle(): Promise<void> {
		if (!this._extensionLifecycleDeferred) return;
		if (this._extensionLifecycleActivation) return this._extensionLifecycleActivation;
		const activation = (async () => {
			await this.waitForIdle();
			this._extensionLifecycleDeferred = false;
			this._extensionLifecycleActive = true;
			try {
				await this.emitSessionStart(this._sessionStartEvent);
			} catch (error) {
				this._extensionLifecycleDeferred = true;
				this._extensionLifecycleActive = false;
				throw error;
			}
		})();
		this._extensionLifecycleActivation = activation;
		try {
			await activation;
		} finally {
			if (this._extensionLifecycleActivation === activation) this._extensionLifecycleActivation = undefined;
		}
	}

	async emitSessionShutdownEvent(event: SessionShutdownEvent): Promise<void> {
		if (!this._extensionLifecycleActive) return;
		if (this._extensionRunner.hasHandlers("session_shutdown")) await this._extensionRunner.emit(event);
	}

	private async emitSessionStart(event: SessionStartEvent): Promise<void> {
		await this._extensionRunner.emit(event);
		this._extensionRunner.reportUnhandledMcpServers();
		await this.extendResourcesFromExtensions(event.reason === "reload" ? "reload" : "startup");
		this._extensionLifecycleActive = true;
	}

	private async extendResourcesFromExtensions(reason: "startup" | "reload"): Promise<void> {
		if (!this._extensionRunner.hasHandlers("resources_discover")) {
			return;
		}

		const { skillPaths, promptPaths, themePaths } = await this._extensionRunner.emitResourcesDiscover(
			this._cwd,
			reason,
		);

		if (skillPaths.length === 0 && promptPaths.length === 0 && themePaths.length === 0) {
			return;
		}

		const extensionPaths: ResourceExtensionPaths = {
			skillPaths: this.buildExtensionResourcePaths(skillPaths),
			promptPaths: this.buildExtensionResourcePaths(promptPaths),
			themePaths: this.buildExtensionResourcePaths(themePaths),
		};

		this._resourceLoader.extendResources(extensionPaths);
		this._rebuildSystemPrompt(this.getActiveToolNames());
	}

	private buildExtensionResourcePaths(entries: Array<{ path: string; extensionPath: string }>): Array<{
		path: string;
		metadata: { source: string; scope: "temporary"; origin: "top-level"; baseDir?: string };
	}> {
		return entries.map((entry) => {
			const source = this.getExtensionSourceLabel(entry.extensionPath);
			const baseDir = isSyntheticPath(entry.extensionPath) ? undefined : dirname(entry.extensionPath);
			return {
				path: entry.path,
				metadata: {
					source,
					scope: "temporary",
					origin: "top-level",
					baseDir,
				},
			};
		});
	}

	private getExtensionSourceLabel(extensionPath: string): string {
		if (isSyntheticPath(extensionPath)) {
			return `extension:${extensionPath.replace(/[<>]/g, "")}`;
		}
		const base = basename(extensionPath);
		const name = base.replace(/\.(ts|js)$/, "");
		return `extension:${name}`;
	}

	private _applyExtensionBindings(runner: ExtensionRunner): void {
		runner.setUIContext(this._extensionUIContext, this._extensionMode);
		runner.bindCommandContext(this._extensionCommandContextActions);

		this._extensionErrorUnsubscriber?.();
		this._extensionErrorUnsubscriber = this._extensionErrorListener
			? runner.onError(this._extensionErrorListener)
			: undefined;
	}

	private _refreshCurrentModelFromRegistry(): void {
		const currentModel = this.model;
		if (!currentModel) {
			return;
		}

		const refreshedModel = this._modelRuntime.getModel(currentModel.provider, currentModel.id);
		if (!refreshedModel || refreshedModel === currentModel) {
			return;
		}

		this.agent.state.model = refreshedModel;
	}

	private _bindExtensionCore(runner: ExtensionRunner): void {
		const getCommands = (): SlashCommandInfo[] => {
			const extensionCommands: SlashCommandInfo[] = runner.getRegisteredCommands().map((command) => ({
				name: command.invocationName,
				description: command.description,
				source: "extension",
				sourceInfo: command.sourceInfo,
			}));

			const templates: SlashCommandInfo[] = this.promptTemplates.map((template) => ({
				name: template.name,
				description: template.description,
				source: "prompt",
				sourceInfo: template.sourceInfo,
			}));

			const skills: SlashCommandInfo[] = this._resourceLoader.getSkills().skills.map((skill) => ({
				name: `skill:${skill.name}`,
				description: skill.description,
				source: "skill",
				sourceInfo: skill.sourceInfo,
			}));

			return [...extensionCommands, ...templates, ...skills];
		};

		runner.bindCore(
			{
				sendMessage: (message, options, origin) => {
					this.sendCustomMessage(message, { ...options, ...(origin ? { origin } : {}) }).catch((err) => {
						runner.emitError({
							extensionPath: "<runtime>",
							event: "send_message",
							error: err instanceof Error ? err.message : String(err),
						});
					});
				},
				sendUserMessage: (content, options) => {
					this.sendUserMessage(content, options).catch((err) => {
						runner.emitError({
							extensionPath: "<runtime>",
							event: "send_user_message",
							error: err instanceof Error ? err.message : String(err),
						});
					});
				},
				appendEntry: (customType, data) => {
					const entryId = this.sessionManager.appendCustomEntry(customType, data);
					const entry = this.sessionManager.getEntry(entryId);
					if (entry) {
						this._emit({ type: "entry_appended", entry });
					}
				},
				setSessionName: (name) => {
					this.setSessionName(name);
				},
				getSessionName: () => {
					return this.sessionManager.getSessionName();
				},
				setLabel: (entryId, label) => {
					this.sessionManager.appendLabelChange(entryId, label);
				},
				getActiveTools: () => this.getActiveToolNames(),
				getAllTools: () => this.getAllTools(),
				getSettings: () => this.settingsManager.getSettings(),
				setActiveTools: (toolNames) => this.setActiveToolsByName(toolNames),
				refreshTools: () => this._refreshToolRegistry(),
				getCommands,
				setModel: async (model) => {
					if (!this._modelRuntime.hasConfiguredAuth(model.provider)) return false;
					await this.setModel(model);
					return true;
				},
				getThinkingLevel: () => this.thinkingLevel,
				setThinkingLevel: (level) => this.setThinkingLevel(level),
			},
			{
				getModel: () => this.model,
				getScopedModels: () => this._scopedModels,
				isIdle: () => this.isIdle,
				isProjectTrusted: () => this.settingsManager.isProjectTrusted(),
				getSignal: () =>
					this._agentRunAbortController?.signal ??
					this._inputAbortControllers.values().next().value?.signal ??
					this._compactionAbortController?.signal ??
					this._autoCompactionAbortController?.signal ??
					this._branchSummaryAbortController?.signal ??
					this.agent.signal,
				abort: () => {
					if (this._extensionAbortHandler) {
						this._extensionAbortHandler();
						return;
					}
					void this.abort();
				},
				hasPendingMessages: () => this.pendingMessageCount > 0,
				shutdown: () => {
					this._extensionShutdownHandler?.();
				},
				getContextUsage: () => this.getContextUsage(),
				compact: (options) => {
					void (async () => {
						try {
							const result = await this.compact(options?.customInstructions);
							options?.onComplete?.(result);
						} catch (error) {
							const err = error instanceof Error ? error : new Error(String(error));
							options?.onError?.(err);
						}
					})();
				},
				getSystemPrompt: () => this.systemPrompt,
				getSystemPromptOptions: () => this._baseSystemPromptOptions,
				getCurrentTurn: () => this._activeTurnContext,
				executeTool: (callerId, name, args, options) => this._executeNestedToolCall(callerId, name, args, options),
				getCallableTools: () => this._getCallableTools(),
			},
			{
				registerProvider: (name, config) => {
					this._modelRuntime.registerProvider(name, config);
					this._refreshCurrentModelFromRegistry();
				},
				registerNativeProvider: (provider) => {
					this._modelRuntime.registerNativeProvider(provider);
					this._refreshCurrentModelFromRegistry();
				},
				unregisterProvider: (name) => {
					this._modelRuntime.unregisterProvider(name);
					this._refreshCurrentModelFromRegistry();
				},
				registerVirtualModel: (definition) => {
					this._modelRuntime.registerVirtualModel(definition);
					this._refreshCurrentModelFromRegistry();
				},
				unregisterVirtualModel: (provider, id) => {
					this._modelRuntime.unregisterVirtualModel(provider, id);
					this._refreshCurrentModelFromRegistry();
				},
			},
		);
	}

	private _refreshToolRegistry(options?: { activeToolNames?: string[]; includeAllExtensionTools?: boolean }): void {
		// Tools that were already activated on registration. A tool whose exposure changes to
		// `direct` or `model-only` (for example from `hidden`) is activated like a new tool.
		const previousActivatedOnRegistration = new Set(
			[...this._toolRegistry.keys()].filter((name) => this._isActivatedOnRegistration(name)),
		);
		const previousActiveToolNames = this.getActiveToolNames();
		const allowedTools = this._allowedTools;

		const registeredTools = this._extensionRunner.getAllRegisteredTools();
		const allCustomTools = [
			...registeredTools,
			...this._customTools.map((definition) => ({
				definition,
				sourceInfo: createSyntheticSourceInfo(`<sdk:${definition.name}>`, { source: "sdk" }),
			})),
		].filter((tool) => this._isAllowedTool(tool.definition.name));
		const definitionRegistry = new Map<string, ToolDefinitionEntry>(
			Array.from(this._baseToolDefinitions.entries())
				.filter(([name]) => this._isAllowedTool(name))
				.map(([name, definition]) => [
					name,
					{
						definition,
						sourceInfo: createSyntheticSourceInfo(`${BUILTIN_PATH_PREFIX}${name}`, { source: "builtin" }),
					},
				]),
		);
		for (const tool of allCustomTools) {
			definitionRegistry.set(tool.definition.name, {
				definition: tool.definition,
				sourceInfo: tool.sourceInfo,
			});
		}
		this._toolDefinitions = definitionRegistry;
		this._toolPromptSnippets = new Map(
			Array.from(definitionRegistry.values())
				.map(({ definition }) => {
					const snippet = this._normalizePromptSnippet(definition.promptSnippet);
					return snippet ? ([definition.name, snippet] as const) : undefined;
				})
				.filter((entry): entry is readonly [string, string] => entry !== undefined),
		);
		this._toolPromptGuidelines = new Map(
			Array.from(definitionRegistry.values())
				.map(({ definition }) => {
					const guidelines = this._normalizePromptGuidelines(definition.promptGuidelines);
					return guidelines.length > 0 ? ([definition.name, guidelines] as const) : undefined;
				})
				.filter((entry): entry is readonly [string, string[]] => entry !== undefined),
		);
		const runner = this._extensionRunner;
		const wrappedExtensionTools = wrapRegisteredTools(allCustomTools, runner);
		const wrappedBuiltInTools = wrapRegisteredTools(
			Array.from(this._baseToolDefinitions.values())
				.filter((definition) => this._isAllowedTool(definition.name))
				.map((definition) => ({
					definition,
					sourceInfo: createSyntheticSourceInfo(`${BUILTIN_PATH_PREFIX}${definition.name}`, {
						source: "builtin",
					}),
				})),
			runner,
		);

		if (!this._baseToolsOverride) {
			for (const tool of wrappedBuiltInTools) registerBuiltInToolIdentity(tool);
			for (const [index, tool] of wrappedExtensionTools.entries()) {
				if (allCustomTools[index]?.sourceInfo.source === "builtin") registerBuiltInToolIdentity(tool);
			}
		}

		const toolRegistry = new Map(wrappedBuiltInTools.map((tool) => [tool.name, tool]));
		for (const tool of wrappedExtensionTools as AgentTool[]) {
			toolRegistry.set(tool.name, tool);
		}
		this._toolRegistry = toolRegistry;

		const nextActiveToolNames = (
			options?.activeToolNames ? [...options.activeToolNames] : [...previousActiveToolNames]
		).filter((name) => this._isAllowedTool(name));

		if (allowedTools) {
			for (const toolName of this._toolRegistry.keys()) {
				// Naming or matching a tool activates it even when it is not active by default. MCP tools
				// kept registered without being named stay inactive.
				if (allowedTools(toolName) && this._isDeclarable(toolName)) {
					nextActiveToolNames.push(toolName);
				}
			}
		} else if (options?.includeAllExtensionTools) {
			for (const tool of wrappedExtensionTools) {
				if (this._isActivatedOnRegistration(tool.name)) nextActiveToolNames.push(tool.name);
			}
		} else if (!options?.activeToolNames) {
			for (const toolName of this._toolRegistry.keys()) {
				if (!previousActivatedOnRegistration.has(toolName) && this._isActivatedOnRegistration(toolName)) {
					nextActiveToolNames.push(toolName);
				}
			}
		}
		// Pending tools that are registered now become active.
		nextActiveToolNames.push(...this._pendingToolNames);

		this._setActiveTools([...new Set(nextActiveToolNames)]);
	}

	/** Whether activating the tool declares it to the model. */
	private _isDeclarable(name: string): boolean {
		const exposure = this._getToolExposure(name);
		return exposure === "direct" || exposure === "model-only";
	}

	/** Whether registering the tool activates it, which declares it to the model. */
	private _isActivatedOnRegistration(name: string): boolean {
		return this._isDeclarable(name) && this._toolDefinitions.get(name)?.definition.defaultActive !== false;
	}

	private _buildRuntime(options: {
		activeToolNames?: string[];
		flagValues?: Map<string, boolean | string>;
		includeAllExtensionTools?: boolean;
	}): void {
		const autoResizeImages = this.settingsManager.getImageAutoResize();
		const shellCommandPrefix = this.settingsManager.getShellCommandPrefix();
		const shellPath = this.settingsManager.getShellPath();
		const baseToolDefinitions = this._baseToolsOverride
			? Object.fromEntries(
					Object.entries(this._baseToolsOverride).map(([name, tool]) => [
						name,
						createToolDefinitionFromAgentTool(tool),
					]),
				)
			: createAllToolDefinitions(this._cwd, {
					read: { autoResizeImages },
					bash: { commandPrefix: shellCommandPrefix, shellPath },
				});

		this._baseToolDefinitions = new Map(
			Object.entries(baseToolDefinitions).map(([name, tool]) => [name, tool as ToolDefinition]),
		);

		const extensionsResult = this._resourceLoader.getExtensions();
		if (options.flagValues) {
			for (const [name, value] of options.flagValues) {
				extensionsResult.runtime.flagValues.set(name, value);
			}
		}

		this._extensionRunner = new ExtensionRunner(
			extensionsResult.extensions,
			extensionsResult.runtime,
			this._cwd,
			this.sessionManager,
			new ModelRegistry(this._modelRuntime),
		);
		if (this._extensionRunnerRef) {
			this._extensionRunnerRef.current = this._extensionRunner;
		}
		this._bindExtensionCore(this._extensionRunner);
		this._applyExtensionBindings(this._extensionRunner);

		const defaultActiveToolNames = this._baseToolsOverride
			? Object.keys(this._baseToolsOverride)
			: ["read", "bash", "edit", "write"];
		const baseActiveToolNames = options.activeToolNames ?? defaultActiveToolNames;
		this._refreshToolRegistry({
			activeToolNames: baseActiveToolNames,
			includeAllExtensionTools: options.includeAllExtensionTools,
		});
	}

	async reload(options?: { beforeSessionStart?: () => void | Promise<void> }): Promise<void> {
		const oldRunner = this._extensionRunner;
		const previousFlagValues = oldRunner.getFlagValues();
		await this.emitSessionShutdownEvent({ type: "session_shutdown", reason: "reload" });
		oldRunner.invalidate();
		const previousDefaultTools = new Set(
			this._usesDefaultTools ? (this.settingsManager.getDefaultTools() ?? DEFAULT_TOOL_NAMES) : [],
		);
		await this.settingsManager.reload();
		this.syncQueueModesFromSettings();
		resetApiProviders();
		await this._resourceLoader.reload();
		// Activate tools newly added to defaultTools. Removed ones stay active, and tools disabled
		// during the session stay disabled unless the setting newly adds them.
		const addedDefaultTools = this._usesDefaultTools
			? (this.settingsManager.getDefaultTools() ?? DEFAULT_TOOL_NAMES).filter(
					(name) => !previousDefaultTools.has(name),
				)
			: [];
		// Tools the new extensions register later, such as MCP tools, are pending until then.
		for (const name of this.getActiveToolNames()) this._pendingToolNames.add(name);
		this._buildRuntime({
			activeToolNames: [...this.getActiveToolNames(), ...addedDefaultTools],
			flagValues: previousFlagValues,
			includeAllExtensionTools: true,
		});

		const hasBindings =
			this._extensionUIContext ||
			this._extensionCommandContextActions ||
			this._extensionShutdownHandler ||
			this._extensionErrorListener;
		if (hasBindings && !this._extensionLifecycleDeferred) {
			await options?.beforeSessionStart?.();
			await this.emitSessionStart({ type: "session_start", reason: "reload" });
		}
	}

	// =========================================================================
	// Auto-Retry
	// =========================================================================

	/**
	 * Check if an error is retryable (overloaded, rate limit, server errors).
	 * Context overflow errors are NOT retryable (handled by compaction instead).
	 */
	private _isRetryableError(message: AssistantMessage): boolean {
		if (message.errorMessage?.startsWith("请求中的不可拆内容预计为 ")) return false;
		// Context overflow is handled by compaction, not retry.
		if (isContextOverflow(message, (this._modelForMessage(message) ?? this.model)?.contextWindow ?? 0)) return false;
		return isRetryableAssistantError(message);
	}

	/**
	 * Retry policy + callbacks shared by compaction and branch-summary summarization calls.
	 * Uses the same `settings.retry` budget/backoff as agent-turn retries so a single transient
	 * stream drop no longer fails the whole operation. `source` carries the context
	 * the TUI needs to render the retry and recreate the underlying indicator.
	 */
	private _summarizationRetryCallbacks(
		source: { source: "branchSummary" } | { source: "compaction"; reason: "manual" | "threshold" | "overflow" },
	): RetryCallbacks {
		return {
			onRetryScheduled: (attempt, maxAttempts, delayMs, errorMessage) => {
				this._emit({
					type: "summarization_retry_scheduled",
					attempt,
					maxAttempts,
					delayMs,
					errorMessage,
				});
			},
			onRetryAttemptStart: () => {
				this._emit({
					type: "summarization_retry_attempt_start",
					...source,
				});
			},
			onRetryFinished: () => {
				this._emit({ type: "summarization_retry_finished" });
			},
		};
	}

	private _finishCancelledRetry(): void {
		if (this._retryAttempt === 0) return;
		const attempt = this._retryAttempt;
		this._retryAttempt = 0;
		this._emit({
			type: "auto_retry_end",
			success: false,
			attempt,
			finalError: "Retry cancelled",
		});
	}

	/**
	 * Prepare a retryable error for continuation with exponential backoff.
	 * @returns true if the caller should continue the agent, false otherwise
	 */
	private async _prepareRetry(message: AssistantMessage): Promise<boolean> {
		const settings = this.settingsManager.getRetrySettings();
		if (!settings.enabled) {
			return false;
		}

		this._retryAttempt++;

		if (this._retryAttempt > settings.maxRetries) {
			// Preserve the completed attempt count so post-run handling can emit the final failure.
			this._retryAttempt--;
			return false;
		}

		const delayMs = retryDelayMs(settings, this._retryAttempt);

		this._emit({
			type: "auto_retry_start",
			attempt: this._retryAttempt,
			maxAttempts: settings.maxRetries,
			delayMs,
			errorMessage: message.errorMessage || "Unknown error",
		});

		// Keep the failed attempt in raw history while durably omitting it from model projection.
		this._omitRecoveryAttempt(message);

		// Wait with exponential backoff (abortable)
		this._retryAbortController = new AbortController();
		try {
			await sleep(delayMs, this._retryAbortController.signal);
		} catch {
			// Aborted during sleep - emit end event so UI can clean up
			this._finishCancelledRetry();
			return false;
		} finally {
			this._retryAbortController = undefined;
		}

		return true;
	}

	/**
	 * Cancel in-progress retry.
	 */
	abortRetry(): void {
		this._retryAbortController?.abort();
	}

	/** Whether auto-retry is currently in progress */
	get isRetrying(): boolean {
		return this._retryAbortController !== undefined;
	}

	/** Whether auto-retry is enabled */
	get autoRetryEnabled(): boolean {
		return this.settingsManager.getRetryEnabled();
	}

	/**
	 * Toggle auto-retry setting.
	 */
	setAutoRetryEnabled(enabled: boolean): void {
		this.settingsManager.setRetryEnabled(enabled);
	}

	// =========================================================================
	// Bash Execution
	// =========================================================================

	/**
	 * Execute a bash command.
	 * Adds result to agent context and session.
	 * @param command The bash command to execute
	 * @param onChunk Optional streaming callback for output
	 * @param options.excludeFromContext If true, command output won't be sent to LLM (!! prefix)
	 * @param options.id Optional identifier included in bash execution update events
	 * @param options.operations Custom BashOperations for remote execution
	 */
	async executeBash(
		command: string,
		onChunk?: (chunk: string) => void,
		options?: { excludeFromContext?: boolean; id?: string; operations?: BashOperations },
	): Promise<BashResult> {
		const abortController = new AbortController();
		this._bashAbortControllers.add(abortController);

		// Apply command prefix if configured (e.g., "shopt -s expand_aliases" for alias support)
		const prefix = this.settingsManager.getShellCommandPrefix();
		const shellPath = this.settingsManager.getShellPath();
		const resolvedCommand = prefix ? `${prefix}\n${command}` : command;

		try {
			const result = await executeBashWithOperations(
				resolvedCommand,
				this.sessionManager.getCwd(),
				options?.operations ?? createLocalBashOperations({ shellPath }),
				{
					onChunk: (delta) => {
						onChunk?.(delta);
						this._emit({ type: "bash_execution_update", id: options?.id, delta });
					},
					signal: abortController.signal,
				},
			);

			this.recordBashResult(command, result, options);
			return result;
		} finally {
			this._bashAbortControllers.delete(abortController);
		}
	}

	/**
	 * Record a bash execution result in session history.
	 * Used by executeBash and by extensions that handle bash execution themselves.
	 */
	recordBashResult(command: string, result: BashResult, options?: { excludeFromContext?: boolean }): void {
		const bashMessage: BashExecutionMessage = {
			role: "bashExecution",
			command,
			output: result.output,
			exitCode: result.exitCode,
			cancelled: result.cancelled,
			truncated: result.truncated,
			fullOutputPath: result.fullOutputPath,
			timestamp: Date.now(),
			excludeFromContext: options?.excludeFromContext,
		};

		// If agent is streaming, defer adding to avoid breaking tool_use/tool_result ordering
		if (this.isStreaming) {
			// Queue for later - will be flushed on agent_end
			this._pendingBashMessages.push(bashMessage);
		} else {
			this.sessionManager.appendMessage(bashMessage);
			this._refreshFinalizedContext();
		}
	}

	/**
	 * Cancel running bash command.
	 */
	abortBash(): void {
		for (const abortController of [...this._bashAbortControllers]) {
			abortController.abort();
		}
	}

	/** Whether a bash command is currently running */
	get isBashRunning(): boolean {
		return this._bashAbortControllers.size > 0;
	}

	/** Whether there are pending bash messages waiting to be flushed */
	get hasPendingBashMessages(): boolean {
		return this._pendingBashMessages.length > 0;
	}

	/**
	 * Flush pending bash messages to agent state and session.
	 * Called after agent turn completes to maintain proper message ordering.
	 */
	private _flushPendingBashMessages(): void {
		if (this._pendingBashMessages.length === 0) return;

		for (const bashMessage of this._pendingBashMessages) {
			this.sessionManager.appendMessage(bashMessage);
		}
		this._pendingBashMessages = [];
		this._refreshFinalizedContext();
	}

	// =========================================================================
	// Session Management
	// =========================================================================

	/**
	 * Set a display name for the current session.
	 */
	setSessionName(name: string): void {
		this.sessionManager.appendSessionInfo(name);
		const event = { type: "session_info_changed", name: this.sessionManager.getSessionName() } as const;
		this._emit(event);
		void this._extensionRunner.emit(event);
	}

	// =========================================================================
	// Tree Navigation
	// =========================================================================

	/**
	 * Navigate to a different node in the session tree.
	 * Unlike fork() which creates a new session file, this stays in the same file.
	 *
	 * @param targetId The entry ID to navigate to
	 * @param options.summarize Whether user wants to summarize abandoned branch
	 * @param options.customInstructions Custom instructions for summarizer
	 * @param options.replaceInstructions If true, customInstructions replaces the default prompt
	 * @param options.label Label to attach to the branch summary entry
	 * @returns Result with editorText (if user message) and cancelled status
	 */
	async navigateTree(
		targetId: string,
		options: { summarize?: boolean; customInstructions?: string; replaceInstructions?: boolean; label?: string } = {},
	): Promise<{ editorText?: string; cancelled: boolean; aborted?: boolean; summaryEntry?: BranchSummaryEntry }> {
		if (this.isStreaming) {
			throw new Error("Wait for the current response to finish before navigating the session tree.");
		}
		if (this.isCompacting) {
			throw new Error(
				"Wait for the current compaction or tree navigation to finish before navigating the session tree.",
			);
		}

		const oldLeafId = this.sessionManager.getLeafId();
		const targetEntry = this.sessionManager.getEntry(targetId);
		if (!targetEntry) {
			throw new Error(`Entry ${targetId} not found`);
		}
		const opensInEditor =
			targetEntry.type === "custom_message" ||
			(targetEntry.type === "message" && targetEntry.message.role === "user");

		// Re-editing a user message must move the leaf to its parent, even when that message is the current leaf.
		if (targetId === oldLeafId && !opensInEditor) {
			return { cancelled: false };
		}

		// Model required for summarization
		if (options.summarize && !this.model) {
			throw new Error("No model available for summarization");
		}

		// Collect entries to summarize (from old leaf to common ancestor)
		const { entries: entriesToSummarize, commonAncestorId } = collectEntriesForBranchSummary(
			this.sessionManager,
			oldLeafId,
			targetId,
		);

		// Prepare event data - mutable so extensions can override
		let customInstructions = options.customInstructions;
		let replaceInstructions = options.replaceInstructions;
		let label = options.label;

		const preparation: TreePreparation = {
			targetId,
			oldLeafId,
			commonAncestorId,
			entriesToSummarize,
			userWantsSummary: options.summarize ?? false,
			customInstructions,
			replaceInstructions,
			label,
		};

		// Set up abort controller for summarization
		this._branchSummaryAbortController = new AbortController();

		try {
			let extensionSummary: { summary: string; details?: unknown; usage?: Usage } | undefined;
			let fromExtension = false;

			// Emit session_before_tree event
			if (this._extensionRunner.hasHandlers("session_before_tree")) {
				const result = (await this._extensionRunner.emit({
					type: "session_before_tree",
					preparation,
					signal: this._branchSummaryAbortController.signal,
				})) as SessionBeforeTreeResult | undefined;

				if (result?.cancel) {
					return { cancelled: true };
				}

				if (result?.summary && options.summarize) {
					extensionSummary = result.summary;
					fromExtension = true;
				}

				// Allow extensions to override instructions and label
				if (result?.customInstructions !== undefined) {
					customInstructions = result.customInstructions;
				}
				if (result?.replaceInstructions !== undefined) {
					replaceInstructions = result.replaceInstructions;
				}
				if (result?.label !== undefined) {
					label = result.label;
				}
			}

			// Run default summarizer if needed
			let summaryText: string | undefined;
			let summaryDetails: unknown;
			let summaryUsage: Usage | undefined;
			if (options.summarize && entriesToSummarize.length > 0 && !extensionSummary) {
				const signal = this._branchSummaryAbortController.signal;
				const branchSummarySettings = this.settingsManager.getBranchSummarySettings();
				const result = await generateBranchSummary(entriesToSummarize, {
					...(await this._getSummarizationRequestAuth(this.model!, signal)),
					signal,
					customInstructions,
					replaceInstructions,
					reserveTokens: branchSummarySettings.reserveTokens,
					streamFn: this.agent.streamFunction,
					retry: this.settingsManager.getRetrySettings(),
					callbacks: this._summarizationRetryCallbacks({ source: "branchSummary" }),
				});
				if (result.aborted) {
					return { cancelled: true, aborted: true };
				}
				if (result.error) {
					throw new Error(result.error);
				}
				summaryText = result.summary;
				summaryUsage = result.usage;
				summaryDetails = {
					readFiles: result.readFiles || [],
					modifiedFiles: result.modifiedFiles || [],
				};
			} else if (extensionSummary) {
				summaryText = extensionSummary.summary;
				summaryDetails = extensionSummary.details;
				summaryUsage = extensionSummary.usage;
			}

			// Determine the new leaf position based on target type
			let newLeafId: string | null;
			let editorText: string | undefined;

			if (targetEntry.type === "message" && targetEntry.message.role === "user") {
				// User message: leaf = parent (null if root), text goes to editor
				newLeafId = targetEntry.parentId;
				editorText = contentText(targetEntry.message.content, "");
			} else if (targetEntry.type === "custom_message") {
				// Custom message: leaf = parent (null if root), text goes to editor
				newLeafId = targetEntry.parentId;
				editorText = contentText(targetEntry.content, "");
			} else {
				// Non-user message: leaf = selected node
				newLeafId = targetId;
			}

			// Switch leaf (with or without summary)
			// Summary is attached at the navigation target position (newLeafId), not the old branch
			let summaryEntry: BranchSummaryEntry | undefined;
			if (summaryText) {
				// Create summary at target position (can be null for root)
				const summaryId = this.sessionManager.branchWithSummary(
					newLeafId,
					summaryText,
					summaryDetails,
					fromExtension,
					summaryUsage,
				);
				summaryEntry = this.sessionManager.getEntry(summaryId) as BranchSummaryEntry;

				// Attach label to the summary entry
				if (label) {
					this.sessionManager.appendLabelChange(summaryId, label);
				}
			} else if (newLeafId === null) {
				// No summary, navigating to root - reset leaf
				this.sessionManager.resetLeaf();
			} else {
				// No summary, navigating to non-root
				this.sessionManager.branch(newLeafId);
			}

			// Attach label to target entry when not summarizing (no summary entry to label)
			if (label && !summaryText) {
				this.sessionManager.appendLabelChange(targetId, label);
			}

			// Update finalized context from the canonical session projection.
			this._restoreFastMode();
			this._refreshFinalizedContext();
			this._restoreToolsFromTranscript();

			// Emit session_tree event
			await this._extensionRunner.emit({
				type: "session_tree",
				newLeafId: this.sessionManager.getLeafId(),
				oldLeafId,
				summaryEntry,
				fromExtension: summaryText ? fromExtension : undefined,
			});

			// Emit to custom tools

			return { editorText, cancelled: false, summaryEntry };
		} finally {
			this._branchSummaryAbortController = undefined;
			this._resolveIdleWaitIfIdle();
		}
	}

	/**
	 * Get all user messages from session for fork selector.
	 */
	getUserMessagesForForking(): Array<{ entryId: string; text: string }> {
		const entries = this.sessionManager.getEntries();
		const result: Array<{ entryId: string; text: string }> = [];

		for (const entry of entries) {
			if (entry.type !== "message") continue;
			if (entry.message.role !== "user") continue;

			const text = contentText(entry.message.content, "");
			if (text) {
				result.push({ entryId: entry.id, text });
			}
		}

		return result;
	}

	/**
	 * Get session statistics. Aggregates over ALL session entries (including
	 * history that was compacted away), so token/cost totals reflect what was
	 * actually billed across the session.
	 */
	getSessionStats(): SessionStats {
		let userMessages = 0;
		let assistantMessages = 0;
		let toolResults = 0;
		let totalMessages = 0;
		let toolCalls = 0;
		const usageTotals = createUsageTotals();

		for (const entry of this.sessionManager.getEntries()) {
			if (entry.type === "usage") {
				addUsageToTotals(usageTotals, entry.usage);
			} else if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) {
				addUsageToTotals(usageTotals, entry.usage);
			}
			if (entry.type !== "message") continue;
			totalMessages++;
			const message = entry.message;
			if (message.role === "user") {
				userMessages++;
			} else if (message.role === "toolResult") {
				toolResults++;
				if (message.usage) {
					addUsageToTotals(usageTotals, message.usage);
				}
			} else if (message.role === "assistant") {
				assistantMessages++;
				const assistantMsg = message as AssistantMessage;
				if (Array.isArray(assistantMsg.content)) {
					toolCalls += assistantMsg.content.filter((c) => c.type === "toolCall").length;
				}
				addUsageToTotals(usageTotals, assistantMsg.usage);
			}
		}

		return {
			sessionFile: this.sessionFile,
			sessionId: this.sessionId,
			userMessages,
			assistantMessages,
			toolCalls,
			toolResults,
			totalMessages,
			tokens: {
				input: usageTotals.input,
				output: usageTotals.output,
				cacheRead: usageTotals.cacheRead,
				cacheWrite: usageTotals.cacheWrite,
				total: usageTotals.input + usageTotals.output + usageTotals.cacheRead + usageTotals.cacheWrite,
			},
			cost: usageTotals.cost,
			contextUsage: this.getContextUsage(),
		};
	}

	getSessionInfo(): SessionInfoView {
		const stats = this.getSessionStats();
		const entries = this.sessionManager.getEntries();
		return {
			name: this.sessionName ?? null,
			sessionFile: stats.sessionFile ?? null,
			sessionId: stats.sessionId,
			messages: {
				total: stats.totalMessages,
				user: stats.userMessages,
				agent: stats.assistantMessages,
				toolCalls: stats.toolCalls,
				toolResults: stats.toolResults,
			},
			tokens: stats.tokens,
			cost: stats.cost,
			usageBreakdown: getUsageCostBreakdown(entries),
			cacheWaste: computeCacheWaste(entries, this.modelRuntime),
		};
	}

	getContextUsage(): ContextUsage | undefined {
		const model = this._limitsModel();
		if (!model) return undefined;

		const contextWindow = model.contextWindow ?? 0;
		if (contextWindow <= 0) return undefined;

		// After compaction, the last assistant usage reflects pre-compaction context size.
		// We can only trust usage from an assistant that responded after the latest compaction.
		// If no such assistant exists, context token count is unknown until the next LLM response.
		const projection = this.sessionManager.buildSessionProjection();
		const branch = this.sessionManager.getBranch();
		const latestCompaction = getLatestCompactionEntry(branch);

		if (latestCompaction) {
			const projectedAssistants = new Set(
				projection.entries.flatMap((entry) =>
					entry.messages.some(
						(message) =>
							message.role === "assistant" &&
							message.stopReason !== "aborted" &&
							message.stopReason !== "error" &&
							calculateContextTokens(message.usage) > 0,
					)
						? [entry.sourceEntry.id]
						: [],
				),
			);
			const compactionIndex = branch.findIndex((entry) => entry.id === latestCompaction.id);
			const hasPostCompactionUsage = branch
				.slice(compactionIndex + 1)
				.some((entry) => projectedAssistants.has(entry.id));
			if (!hasPostCompactionUsage) return { tokens: null, contextWindow, percent: null };
		}

		const estimate = estimateProjectedContextTokens(projection, branch);
		const percent = (estimate.tokens / contextWindow) * 100;

		return {
			tokens: estimate.tokens,
			contextWindow,
			percent,
		};
	}

	/**
	 * Export session to HTML.
	 * @param outputPath Optional output path (defaults to session directory)
	 * @param options Optional export presentation settings
	 * @returns Path to exported file
	 */
	async exportToHtml(outputPath?: string, options: { themeName?: string } = {}): Promise<string> {
		const themeName = [options.themeName, this.settingsManager.getTheme()].find(
			(candidate) => candidate !== undefined && getThemeByName(candidate) !== undefined,
		);

		// Create tool renderer if we have an extension runner (for custom tool HTML rendering)
		const toolRenderer: ToolHtmlRenderer = createToolHtmlRenderer({
			getToolRenderers: (name) =>
				this._extensionRunner.resolveToolRenderers(name, () => this.getToolDefinition(name)),
			theme,
			cwd: this.sessionManager.getCwd(),
		});

		return await exportSessionToHtml(this.sessionManager, this.state, {
			outputPath,
			themeName,
			toolRenderer,
		});
	}

	/**
	 * Export the current session branch to a JSONL file.
	 * Writes the session header followed by all entries on the current branch path.
	 * @param outputPath Target file path. If omitted, generates a timestamped file in cwd.
	 * @returns The resolved output file path.
	 */
	exportToJsonl(outputPath?: string): string {
		return exportSessionToJsonl(this.sessionManager, outputPath);
	}

	/**
	 * Ask the current model to describe what went wrong in this session for a bug report.
	 * Used when the user declines to share the transcript itself.
	 */
	async summarizeForBugReport(options: { hint?: string; signal: AbortSignal }): Promise<string> {
		const model = this.model;
		if (!model) {
			throw new Error("No model selected");
		}
		return generateBugReportSummary({
			...(await this._getSummarizationRequestAuth(model, options.signal)),
			messages: this.messages,
			hint: options.hint,
			signal: options.signal,
			streamFn: this.agent.streamFunction,
			retry: this.settingsManager.getRetrySettings(),
			sessionId: this.sessionId,
		});
	}

	// =========================================================================
	// Utilities
	// =========================================================================

	/**
	 * Return slash-command, prompt, skill and model argument completions using the active session resources.
	 */
	async getCompletions(text: string, cursor: number): Promise<AgentSessionCompletionResult | undefined> {
		const before = text.slice(0, cursor);
		const slash = /^\/([^\s]*)$/.exec(before);
		if (slash) {
			const query = slash[1].toLowerCase();
			const builtinCommandNames = new Set(BUILTIN_SLASH_COMMANDS.map((command) => command.name));
			const commands: AgentSessionCompletionItem[] = [
				...BUILTIN_SLASH_COMMANDS.map((command) => ({
					value: `/${command.name} `,
					label: command.name,
					description: command.description,
					kind: "command" as const,
				})),
				...this._extensionRunner
					.getRegisteredCommands()
					.filter((command) => !builtinCommandNames.has(command.name))
					.map((command) => ({
						value: `/${command.invocationName} `,
						label: command.invocationName,
						description: command.description,
						kind: "extension" as const,
					})),
				...this.promptTemplates.map((prompt) => ({
					value: `/${prompt.name} `,
					label: prompt.name,
					description: prompt.description,
					kind: "prompt" as const,
				})),
				...this._resourceLoader.getSkills().skills.map((skill) => ({
					value: `/skill:${skill.name} `,
					label: `skill:${skill.name}`,
					description: skill.description,
					kind: "skill" as const,
				})),
			];
			return {
				prefixStart: 0,
				prefixEnd: cursor,
				items: commands
					.filter((item) => `${item.label} ${item.description ?? ""}`.toLowerCase().includes(query))
					.slice(0, 50),
			};
		}

		const argument = /^\/([^\s]+)\s(.*)$/.exec(before);
		if (argument) {
			if (argument[1] === "model") {
				const prefix = argument[2];
				const models =
					this._scopedModels.length > 0
						? this._scopedModels.map((scoped) => scoped.model)
						: this._modelRuntime.getAvailableSnapshot();
				const query = prefix.toLowerCase();
				const items = models
					.map((model) => ({
						value: `${model.provider}/${model.id}`,
						label: model.id,
						description: model.provider,
						kind: "command" as const,
					}))
					.filter((item) => `${item.label} ${item.description}`.toLowerCase().includes(query))
					.slice(0, 50);
				return {
					prefixStart: cursor - prefix.length,
					prefixEnd: cursor,
					items,
				};
			}
			const command = this._extensionRunner
				.getRegisteredCommands()
				.find((candidate) => candidate.invocationName === argument[1]);
			if (command?.getArgumentCompletions) {
				const argumentPrefix = argument[2];
				const suggestions = await command.getArgumentCompletions(argumentPrefix);
				if (Array.isArray(suggestions) && suggestions.length > 0) {
					return {
						prefixStart: cursor - argumentPrefix.length,
						prefixEnd: cursor,
						items: suggestions.slice(0, 50).map((item) => ({
							value: item.value,
							label: item.label,
							...(item.description ? { description: item.description } : {}),
							kind: "extension" as const,
						})),
					};
				}
			}
		}

		const skill = /(?:^|\s)([$@])(\[?)([a-z0-9-]*)$/i.exec(before);
		if (!skill) return undefined;
		const symbol = skill[1];
		const query = skill[3].toLowerCase();
		const prefix = `${symbol}${skill[2]}${skill[3]}`;
		const items = this._resourceLoader
			.getSkills()
			.skills.filter((candidate) => `${candidate.name} ${candidate.description}`.toLowerCase().includes(query))
			.slice(0, 30)
			.map((candidate) => ({
				value: `${symbol}[${candidate.name}] `,
				label: candidate.name,
				description: candidate.description,
				kind: "skill" as const,
			}));
		return { prefixStart: cursor - prefix.length, prefixEnd: cursor, items };
	}

	/**
	 * Get text content of last assistant message.
	 * Useful for /copy command.
	 * @returns Text content, or undefined if no assistant message exists
	 */
	getLastAssistantText(): string | undefined {
		const lastAssistant = this.messages
			.slice()
			.reverse()
			.find((m) => {
				if (m.role !== "assistant") return false;
				const msg = m as AssistantMessage;
				// Skip aborted messages with no content
				if (msg.stopReason === "aborted" && msg.content.length === 0) return false;
				return true;
			});

		if (!lastAssistant) return undefined;

		let text = "";
		for (const content of (lastAssistant as AssistantMessage).content) {
			if (content.type === "text") {
				text += content.text;
			}
		}

		return text.trim() || undefined;
	}

	// =========================================================================
	// Extension System
	// =========================================================================

	createReplacedSessionContext(): ReplacedSessionContext {
		const context = Object.defineProperties(
			{},
			Object.getOwnPropertyDescriptors(this._extensionRunner.createCommandContext()),
		) as ReplacedSessionContext;
		context.sendMessage = (message, options) => this.sendCustomMessage(message, options);
		context.sendUserMessage = (content, options) => this.sendUserMessage(content, options);
		return context;
	}

	/**
	 * Check if extensions have handlers for a specific event type.
	 */
	hasExtensionHandlers(eventType: string): boolean {
		return this._extensionRunner.hasHandlers(eventType);
	}

	/**
	 * Get the extension runner (for setting UI context and error handlers).
	 */
	get extensionRunner(): ExtensionRunner {
		return this._extensionRunner;
	}
}
