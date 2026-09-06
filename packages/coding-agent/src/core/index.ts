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
	abortSubagent,
	continueSubagentSession,
	getCurrentSubagentRuns,
	type SingleResult as SubagentSingleResult,
	type SubagentDetails,
	type SubagentRunSnapshot,
	type SubagentSessionDescriptor,
	type SubagentSessionRef,
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
	saveModelsJsonModel,
	saveModelsJsonModelOverride,
	saveModelsJsonModels,
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
export { stripInternalPromptContent } from "./prompt-display.ts";
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
	type SessionInfoCache,
	type SessionInfoCacheEntry,
	type SessionListOptions,
	SessionLockCompromisedError,
	SessionLockedError,
	SessionManager,
	type SessionOutcome,
} from "./session-manager.ts";
export {
	SessionShareError,
	type SessionShareResult,
	shareSessionAsPrivateGist,
} from "./session-share.ts";
export {
	type DefaultProjectTrust,
	type Settings,
	SettingsManager,
} from "./settings-manager.ts";
export { type LoadSkillsOptions, type LoadSkillsResult, loadSkills } from "./skills.ts";
export { BUILTIN_SLASH_COMMANDS, type BuiltinSlashCommand } from "./slash-commands.ts";
export { createSyntheticSourceInfo } from "./source-info.ts";
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
	WEB_COMPANION_CAPABILITIES,
	WEB_COMPANION_LEGACY_CAPABILITIES,
	WEB_COMPANION_LEGACY_PROTOCOL_VERSION,
	WEB_COMPANION_PROTOCOL_VERSION,
	type WebCompanionCapability,
	type WebCompanionCommand,
	type WebCompanionImage,
	type WebCompanionProtocolVersion,
	WebCompanionServer,
	type WebCompanionServerMessage,
	type WebCompanionSnapshot,
	type WebCompanionSnapshotWire,
} from "./web-companion.ts";
