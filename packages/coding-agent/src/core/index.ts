/**
 * Core modules shared between all run modes.
 */

export { type AuthEvent, type AuthPrompt, type AuthType, getSupportedThinkingLevels } from "@earendil-works/pi-ai";
export {
	APP_NAME,
	APP_TITLE,
	CONFIG_DIR_NAME,
	getAgentDir,
	getSessionsDir,
	PACKAGE_NAME,
	PACKAGE_VERSION,
	RELEASE_REPOSITORY,
	VERSION,
} from "../config.ts";
export {
	formatVersionCheckError,
	getLatestPiRelease,
	isNewerPackageVersion,
	type LatestPiRelease,
} from "../utils/version-check.ts";
export {
	AgentSession,
	type AgentSessionConfig,
	type AgentSessionEvent,
	type AgentSessionEventListener,
	type ModelCycleResult,
	type PromptOptions,
	type SessionStats,
} from "./agent-session.ts";
export {
	AgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
	type CreateAgentSessionRuntimeResult,
	createAgentSessionRuntime,
} from "./agent-session-runtime.ts";
export {
	type AgentSessionRuntimeDiagnostic,
	type AgentSessionServices,
	type CreateAgentSessionFromServicesOptions,
	type CreateAgentSessionServicesOptions,
	createAgentSessionFromServices,
	createAgentSessionServices,
} from "./agent-session-services.ts";
export { AuthStorage, type AuthStorageBackend } from "./auth-storage.ts";
export { type BashExecutorOptions, type BashResult, executeBashWithOperations } from "./bash-executor.ts";
export type { CompactionResult } from "./compaction/index.ts";
export { createEventBus, type EventBus, type EventBusController } from "./event-bus.ts";
export { areExperimentalFeaturesEnabled } from "./experimental.ts";
// Extensions system
export {
	type AgentEndEvent,
	type AgentSettledEvent,
	type AgentStartEvent,
	type AgentToolResult,
	type AgentToolUpdateCallback,
	type BeforeAgentStartEvent,
	type BeforeAgentStartEventResult,
	type BuildSystemPromptOptions,
	type ContextEvent,
	defineTool,
	discoverAndLoadExtensions,
	type ExecOptions,
	type ExecResult,
	type Extension,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionCommandContextActions,
	type ExtensionContext,
	type ExtensionError,
	type ExtensionEvent,
	type ExtensionFactory,
	type ExtensionFlag,
	type ExtensionHandler,
	ExtensionRunner,
	type ExtensionShortcut,
	type ExtensionUIContext,
	type InlineExtension,
	type LoadExtensionsResult,
	type MessageRenderer,
	type ProjectTrustContext,
	type RegisteredCommand,
	type SessionBeforeCompactEvent,
	type SessionBeforeForkEvent,
	type SessionBeforeSwitchEvent,
	type SessionBeforeTreeEvent,
	type SessionCompactEvent,
	type SessionShutdownEvent,
	type SessionStartEvent,
	type SessionTreeEvent,
	type ToolCallEvent,
	type ToolCallEventResult,
	type ToolDefinition,
	type ToolRenderResultOptions,
	type ToolResultEvent,
	type TurnEndEvent,
	type TurnStartEvent,
	type WorkingIndicatorOptions,
} from "./extensions/index.ts";
export {
	ModelConfig,
	type ModelsJsonModel,
	type ModelsJsonProvider,
	saveModelsJsonModel,
	saveModelsJsonProvider,
} from "./model-config.ts";
export {
	type CreateModelRuntimeOptions,
	CredentialSynchronizationError,
	ModelRuntime,
	type ModelRuntimeAuthOverrides,
} from "./model-runtime.ts";
export {
	DefaultPackageManager,
	type PackageManager,
	type PathMetadata,
	type ResolvedPaths,
	type ResolvedResource,
} from "./package-manager.ts";
export {
	type AppMode,
	type ResolveProjectTrustedOptions,
	resolveProjectTrusted,
} from "./project-trust.ts";
export {
	DefaultResourceLoader,
	type DefaultResourceLoaderOptions,
	loadProjectContextFiles,
	type ResourceLoader,
	type ResourceLoaderReloadOptions,
} from "./resource-loader.ts";
export {
	type FileEntry,
	getDefaultSessionDir,
	type NewSessionOptions,
	type ReadOnlySessionSnapshot,
	type ReadonlySessionManager,
	readSessionSnapshot,
	type SessionContext,
	type SessionEntry,
	type SessionHeader,
	type SessionInfo,
	SessionLockCompromisedError,
	SessionLockedError,
	SessionManager,
	type SessionOutcome,
} from "./session-manager.ts";
export {
	type DefaultProjectTrust,
	type Settings,
	SettingsManager,
} from "./settings-manager.ts";
export { loadSkills, type Skill } from "./skills.ts";
export { createSyntheticSourceInfo } from "./source-info.ts";
export {
	getProjectTrustOptions,
	hasTrustRequiringProjectResources,
	type ProjectTrustDecision,
	type ProjectTrustOption,
	ProjectTrustStore,
} from "./trust-manager.ts";
