/**
 * Core modules shared between all run modes.
 */

export { type AuthEvent, type AuthPrompt, type AuthType, getSupportedThinkingLevels } from "@earendil-works/pi-ai";
export {
	APP_NAME,
	APP_TITLE,
	CONFIG_DIR_NAME,
	ENV_TOOL_RECOVERY_MODE,
	getAgentDir,
	getSessionsDir,
	getToolRecoveryMode,
	PACKAGE_NAME,
	PACKAGE_VERSION,
	RELEASE_REPOSITORY,
	type ToolRecoveryMode,
	ToolRecoveryModeError,
	VERSION,
} from "../config.ts";
export { builtInExtensions } from "../extensions/index.ts";
export {
	type AgentDefinition,
	type AgentDefinitionScope,
	discoverAgentDefinitions,
} from "../extensions/subagent/agents.ts";
export {
	abortSubagent,
	continueSubagentSession,
	getCurrentSubagentRuns,
	type SingleResult as SubagentSingleResult,
	type SubagentDetails,
	type SubagentRunSnapshot,
	type SubagentSessionDescriptor,
	type SubagentSessionRef,
	subscribeSubagentRuns,
} from "../extensions/subagent/index.ts";
export { getBuiltinThemeNames } from "../modes/interactive/theme/theme.ts";
export { getFullChangelogMarkdown } from "../utils/changelog.ts";
export { copyToClipboard, readClipboardText } from "../utils/clipboard.ts";
export { readClipboardImage } from "../utils/clipboard-image.ts";
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
	type SessionInfoView,
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
export { type BashExecutorOptions, type BashResult, executeBashWithOperations } from "./bash-executor.ts";
export type { CacheWarmingDecision, CacheWarmingStatus } from "./cache-warmer.ts";
export type { CompactionResult } from "./compaction/index.ts";
export { createEventBus, type EventBus, type EventBusController } from "./event-bus.ts";
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
	type CacheWarmingDecisionEvent,
	type CacheWarmingDecisionEventResult,
	type ContextEvent,
	defineTool,
	discoverAndLoadExtensions,
	type ExecOptions,
	type ExecResult,
	type Extension,
	type ExtensionActivityEvent,
	type ExtensionActivityListener,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionCommandContextActions,
	type ExtensionContext,
	type ExtensionError,
	type ExtensionEvent,
	type ExtensionFactory,
	type ExtensionFlag,
	type ExtensionHandler,
	type ExtensionHandlerOptions,
	type ExtensionHandlerScope,
	ExtensionRunner,
	type ExtensionShortcut,
	type ExtensionUIContext,
	type InlineExtension,
	type LoadExtensionsResult,
	type MessageRenderer,
	type NormalizedBuildSystemPromptOptions,
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
	discoverHarnessImports,
	type HarnessId,
	type HarnessImportItem,
	type HarnessImportPreview,
	type HarnessImportResult,
	type HarnessImportResultItem,
	type HarnessImportScope,
	type HarnessImportSource,
	type HarnessResourceType,
	importHarnessResources,
} from "./harness-resource-import.ts";
export {
	type AgentCapabilityLease,
	type AgentInputChannel,
	type AgentInputOrigin,
	type AgentRoomMessageKind,
	type AgentRootOrigin,
	type AgentTurnContext,
	type AgentTurnResult,
	rootOriginOf,
} from "./input-origin.ts";
export {
	getLystarSetting,
	getLystarSettingsForUi,
	LYSTAR_SETTINGS_CATALOG,
	type LystarSettingDefinition,
	type LystarSettingKind,
	type LystarSettingValue,
	SETTINGS_SELECTOR_PERSISTENT_IDS,
} from "./lystar-settings-catalog.ts";
export {
	clearModelsJsonModelOverride,
	clearModelsJsonProviderCatalogProvider,
	ModelConfig,
	type ModelsJsonModel,
	type ModelsJsonModelOverride,
	type ModelsJsonProvider,
	removeModelsJsonModels,
	removeModelsJsonProvider,
	saveModelsJsonModel,
	saveModelsJsonModelOverride,
	saveModelsJsonModels,
	saveModelsJsonProvider,
	saveModelsJsonSyncedModels,
	setModelsJsonModelDisabled,
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
export { promptDisplayText, stripInternalPromptContent } from "./prompt-display.ts";
export {
	DefaultResourceLoader,
	type DefaultResourceLoaderOptions,
	loadProjectContextFiles,
	type ResourceLoader,
	type ResourceLoaderReloadOptions,
} from "./resource-loader.ts";
export {
	type RichTextMessageType,
	type RichTextRenderOptions,
	type RichTextRenderResult,
	renderTerminalRichText,
} from "./rich-text-renderer.ts";
export type {
	SessionCoordinator,
	SessionCoordinatorCreateInput,
	SessionCoordinatorCreateResult,
	SessionCoordinatorOutcome,
	SessionCoordinatorProfile,
	SessionCoordinatorResult,
	SessionCoordinatorSummary,
	SessionCoordinatorTask,
	SessionSendMode,
} from "./session-coordinator.ts";
export {
	type FileEntry,
	getDefaultSessionDir,
	type NewSessionOptions,
	type ReadOnlySessionSnapshot,
	type ReadonlySessionManager,
	readSessionSnapshot,
	type SessionCollaborationResult,
	type SessionCollaborationTask,
	type SessionContext,
	type SessionEntry,
	type SessionHeader,
	type SessionInfo,
	type SessionInfoCache,
	type SessionInfoCacheEntry,
	type SessionListOptions,
	SessionLockCompromisedError,
	SessionLockedError,
	SessionManager,
	type SessionOutcome,
	type SessionProfileSnapshot,
	type SessionRelation,
	type SessionWorkspaceMode,
	type SessionWorkspaceSnapshot,
	type SessionWorkspaceStatus,
} from "./session-manager.ts";
export {
	discoverSessionProfiles,
	findSessionProfile,
	type SessionProfile,
} from "./session-profile.ts";
export type {
	SessionRoom,
	SessionRoomApi,
	SessionRoomAttachment,
	SessionRoomCursor,
	SessionRoomDeliveryError,
	SessionRoomMember,
	SessionRoomMemberRole,
	SessionRoomMessage,
	SessionRoomMessageKind,
	SessionRoomMode,
	SessionRoomReadResult,
	SessionRoomRoute,
	SessionRoomSenderType,
	SessionRoomSendResult,
	SessionRoomSummary,
} from "./session-room.ts";
export {
	SessionShareError,
	type SessionShareResult,
	shareSessionAsPrivateGist,
} from "./session-share.ts";
export { createSessionsTool } from "./session-tool.ts";
export {
	type DefaultProjectTrust,
	type Settings,
	SettingsManager,
} from "./settings-manager.ts";
export { type LoadSkillsOptions, type LoadSkillsResult, loadSkills } from "./skills.ts";
export { BUILTIN_SLASH_COMMANDS, type BuiltinSlashCommand } from "./slash-commands.ts";
export { createSyntheticSourceInfo } from "./source-info.ts";
export {
	formatSubagentModelReference,
	parseSubagentMarkdown,
	renderSubagentMarkdown,
	SUBAGENT_THINKING_LEVELS,
	type SubagentConfigInput,
	type SubagentThinkingLevel,
} from "./subagent-config.ts";
export {
	boundedText,
	isDiffTool,
	type ToolActivityDiff,
	type ToolActivityDiffFile,
	type ToolActivityEvent,
	type ToolActivitySnapshot,
	type ToolActivityState,
	ToolActivityTracker,
	toolInputSummary,
	toolOutputSummary,
	toolPath,
	toolProgressDiff,
	toolRecord,
} from "./tool-activity.ts";
export {
	getToolRecoveryDoctorReport,
	summarizeToolRecoveryDiagnostics,
	type ToolRecoveryDiagnosticSummary,
	type ToolRecoveryDoctorReport,
	type ToolRecoveryRuntimeDiagnostics,
	type ToolRecoveryRuntimeMetrics,
} from "./tool-recovery/diagnostics.ts";
export {
	getToolRecoveryLessonDiagnostics,
	type ToolRecoveryLessonCounts,
	type ToolRecoveryLessonStoreDiagnostic,
} from "./tool-recovery/lessons-store.ts";
export {
	createToolRecoverySafeRefreshRegistry,
	type ToolRecoverySafeRefreshContext,
	type ToolRecoverySafeRefreshHandler,
	ToolRecoverySafeRefreshRegistry,
} from "./tool-recovery/safe-refresh.ts";
export {
	getProjectTrustOptions,
	hasTrustRequiringProjectResources,
	type ProjectTrustDecision,
	type ProjectTrustOption,
	ProjectTrustStore,
} from "./trust-manager.ts";
export {
	getWebCompanionEndpoint,
	getWebSessionHandoffEndpoint,
	requestWebSessionHandoff,
	WEB_COMPANION_CAPABILITIES,
	WEB_COMPANION_LEGACY_CAPABILITIES,
	WEB_COMPANION_LEGACY_PROTOCOL_VERSION,
	WEB_COMPANION_PROTOCOL_VERSION,
	WEB_SESSION_HANDOFF_PROTOCOL_VERSION,
	type WebCompanionCapability,
	type WebCompanionCommand,
	type WebCompanionImage,
	type WebCompanionProtocolVersion,
	WebCompanionServer,
	type WebCompanionServerMessage,
	type WebCompanionSnapshot,
	type WebCompanionSnapshotWire,
	type WebSessionHandoffCommand,
	type WebSessionHandoffServerMessage,
} from "./web-companion.ts";
