/**
 * Interactive mode for the coding agent.
 * Handles TUI rendering and user interaction, delegating business logic to AgentSession.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AuthEvent, AuthPrompt, Transport } from "@earendil-works/pi-ai";
import type { AssistantMessage, ImageContent, Message, Model } from "@earendil-works/pi-ai/compat";
import type {
	AltScreenSearchTarget,
	AutocompleteItem,
	AutocompleteProvider,
	EditorComponent,
	Keybinding,
	KeyId,
	MarkdownTheme,
	OverlayHandle,
	OverlayOptions,
	SlashCommand,
	Terminal,
	TuiInputListener,
	TuiMainScreenRenderState,
} from "@earendil-works/pi-tui";
import {
	CombinedAutocompleteProvider,
	type Component,
	Container,
	fuzzyFilter,
	getCapabilities,
	hyperlink,
	Markdown,
	matchesKey,
	ProcessTerminal,
	Spacer,
	setKeybindings,
	Text,
	TruncatedText,
	type TUI,
	TuiMainScreen,
	visibleWidth,
} from "@earendil-works/pi-tui";
import chalk from "chalk";
import { execFile, spawn, spawnSync } from "child_process";
import {
	APP_NAME,
	APP_TITLE,
	CONFIG_DIR_NAME,
	getAgentDir,
	getAuthPath,
	getDebugLogPath,
	getDocsPath,
	RELEASE_REPOSITORY,
	VERSION,
} from "../../config.ts";
import { type AgentSession, type AgentSessionEvent, parseSkillBlock } from "../../core/agent-session.ts";
import { type AgentSessionRuntime, SessionImportFileNotFoundError } from "../../core/agent-session-runtime.ts";
import type { AgentSessionRuntimeDiagnostic } from "../../core/agent-session-services.ts";
import { CACHE_TTL_MS, type CacheMiss, collectCacheMisses, detectCacheMiss } from "../../core/cache-stats.ts";
import type {
	AutocompleteProviderFactory,
	EditorFactory,
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionRunner,
	ExtensionUIContext,
	ExtensionUIDialogOptions,
	ExtensionWidgetOptions,
	MarkdownTransformer,
	ProjectTrustContext,
	WorkingIndicatorOptions,
} from "../../core/extensions/index.ts";
import { FooterDataProvider, type ReadonlyFooterDataProvider } from "../../core/footer-data-provider.ts";
import { GuiCompanionServer } from "../../core/gui-companion.ts";
import { configureHttpDispatcher, formatHttpIdleTimeoutMs } from "../../core/http-dispatcher.ts";
import { type AppKeybinding, KeybindingsManager } from "../../core/keybindings.ts";
import {
	defaultModelPerProvider,
	findExactModelReferenceMatch,
	resolveModelScopeFromModels,
} from "../../core/model-resolver.ts";
import { CredentialSynchronizationError } from "../../core/model-runtime.ts";
import { DefaultPackageManager } from "../../core/package-manager.ts";
import type { ResourceDiagnostic } from "../../core/resource-loader.ts";
import { formatMissingSessionCwdPrompt, MissingSessionCwdError } from "../../core/session-cwd.ts";
import { type SessionEntry, SessionManager, sessionEntryToContextMessages } from "../../core/session-manager.ts";
import type { FullscreenExitOutput, ThinkingDisplayMode, TuiMode } from "../../core/settings-manager.ts";
import { BUILTIN_SLASH_COMMANDS } from "../../core/slash-commands.ts";
import type { SourceInfo } from "../../core/source-info.ts";
import { isInstallTelemetryEnabled } from "../../core/telemetry.ts";
import type { TruncationResult } from "../../core/tools/truncate.ts";
import { hasTrustRequiringProjectResources, ProjectTrustStore } from "../../core/trust-manager.ts";
import {
	type AgentRunState,
	abortSubagent,
	continueSubagentSession,
	getCurrentSubagentRuns,
	getLiveSubagentMessages,
	getFinalOutput as getSubagentFinalOutput,
	type SingleResult,
	type SubagentDetails,
	type SubagentSessionDescriptor,
	subscribeSubagent,
} from "../../extensions/subagent/index.ts";
import { localizeSettingValue } from "../../locales/settings-zh-CN.ts";
import { formatThinkingLevel, t } from "../../locales/zh-CN.ts";
import {
	getChangelogPath,
	getFullChangelogMarkdown,
	getNewEntries,
	normalizeChangelogLinks,
	parseChangelog,
} from "../../utils/changelog.ts";
import { copyToClipboard, readClipboardText } from "../../utils/clipboard.ts";
import { extensionForImageMimeType, readClipboardImage } from "../../utils/clipboard-image.ts";
import { parseGitUrl } from "../../utils/git.ts";
import { openBrowser } from "../../utils/open-browser.ts";
import { getCwdRelativePath } from "../../utils/paths.ts";
import { getPiUserAgent } from "../../utils/pi-user-agent.ts";
import { getGitRuntime, killTrackedDetachedChildren } from "../../utils/shell.ts";
import { ensureManagedWindowsBash, ensureTool, type ToolStatus } from "../../utils/tools-manager.ts";
import { checkForNewPiVersion, type LatestPiRelease } from "../../utils/version-check.ts";
import { type AgentWorkbenchAgent, AgentWorkbenchComponent } from "./components/agent-workbench.ts";
import { ArminComponent } from "./components/armin.ts";
import { AssistantMessageComponent } from "./components/assistant-message.ts";
import { BashExecutionComponent } from "./components/bash-execution.ts";
import { BorderedLoader } from "./components/bordered-loader.ts";
import { BranchSummaryMessageComponent } from "./components/branch-summary-message.ts";
import { ChangelogViewerComponent } from "./components/changelog-viewer.ts";
import { ChangesSelectorComponent, type WorkspaceChangeFile } from "./components/changes-selector.ts";
import { CompactionSummaryMessageComponent } from "./components/compaction-summary-message.ts";
import { CustomEditor } from "./components/custom-editor.ts";
import { CustomEntryComponent } from "./components/custom-entry.ts";
import { CustomMessageComponent } from "./components/custom-message.ts";
import { DaxnutsComponent } from "./components/daxnuts.ts";
import { DynamicBorder } from "./components/dynamic-border.ts";
import { EarendilAnnouncementComponent } from "./components/earendil-announcement.ts";
import { ExtensionEditorComponent } from "./components/extension-editor.ts";
import { ExtensionInputComponent } from "./components/extension-input.ts";
import { ExtensionSelectorComponent } from "./components/extension-selector.ts";
import { FooterComponent, formatTokens } from "./components/footer.ts";
import {
	activateInteractiveCard,
	type InteractiveCard,
	isInteractiveCard,
	resolveInteractiveCardAction,
	visitInteractiveCards,
} from "./components/interactive-card.ts";
import { formatKeyText, keyDisplayText } from "./components/keybinding-hints.ts";
import { LoginDialogComponent } from "./components/login-dialog.ts";
import {
	LystarWorkspace,
	WORKSPACE_HEADER_SEPARATOR,
	WorkspaceComposer,
	type WorkspaceComposerInfo,
	WorkspaceHeader,
	type WorkspaceScrollAnchor,
} from "./components/lystar-workspace.ts";
import { createMermaidMarkdownTransformer } from "./components/mermaid.ts";
import { ModelSelectorComponent } from "./components/model-selector.ts";
import {
	type AuthSelectorProvider,
	formatAuthSelectorProviderType,
	OAuthSelectorComponent,
} from "./components/oauth-selector.ts";
import { ScopedModelsSelectorComponent } from "./components/scoped-models-selector.ts";
import { SessionSelectorComponent } from "./components/session-selector.ts";
import { SettingsSelectorComponent } from "./components/settings-selector.ts";
import { SkillInvocationMessageComponent } from "./components/skill-invocation-message.ts";
import {
	BranchSummaryStatusIndicator,
	CompactionStatusIndicator,
	IdleStatus,
	RetryStatusIndicator,
	type StatusIndicator,
} from "./components/status-indicator.ts";
import type { SubagentRunTarget } from "./components/subagent-run.ts";
import { SubagentSessionViewComponent } from "./components/subagent-session-view.ts";
import { ToolExecutionComponent } from "./components/tool-execution.ts";
import { ToolExecutionStackComponent } from "./components/tool-execution-stack.ts";
import { TreeSelectorComponent } from "./components/tree-selector.ts";
import { TrustSelectorComponent } from "./components/trust-selector.ts";
import {
	resolveTurnOutcome,
	type TurnFileSummary,
	TurnSummaryComponent,
	type TurnSummaryData,
} from "./components/turn-summary.ts";
import { UserMessageComponent } from "./components/user-message.ts";
import { UserMessageSelectorComponent } from "./components/user-message-selector.ts";
import { WorkspaceActivityBar, type WorkspaceActivityPhase } from "./components/workspace-activity-bar.ts";
import { WorkspaceShortcutBar } from "./components/workspace-shortcut-bar.ts";
import { editInExternalEditor } from "./external-editor.ts";
import { loadLystarSettings } from "./lystar-settings.ts";
import { LystarTUI } from "./lystar-tui.ts";
import { refreshModelCatalogs } from "./model-catalog-refresh.ts";
import { getModelSearchText } from "./model-search.ts";
import { parseMouseEvent, WheelScrollNormalizer } from "./mouse.ts";
import {
	isTuiVisibleSessionEntry,
	SessionTranscriptSource,
	TranscriptCursorInvalidError,
} from "./session-transcript-source.ts";
import { type AltScreenMode, createTerminalModeContext, shouldUseAlternateScreen } from "./terminal-mode.ts";
import {
	getAvailableThemes,
	getAvailableThemesWithPaths,
	getEditorTheme,
	getMarkdownTheme,
	getThemeByName,
	onThemeChange,
	setRegisteredThemes,
	stopThemeWatcher,
	Theme,
	type ThemeColor,
	theme,
} from "./theme/theme.ts";
import { InteractiveThemeController } from "./theme/theme-controller.ts";
import { uiGlyphs } from "./ui-glyphs.ts";

/** Interface for components that can be expanded/collapsed */
interface Expandable {
	setExpanded(expanded: boolean): void;
}

function isExpandable(obj: unknown): obj is Expandable {
	return typeof obj === "object" && obj !== null && "setExpanded" in obj && typeof obj.setExpanded === "function";
}

class ExpandableText extends Text implements Expandable {
	private readonly getCollapsedText: () => string;
	private readonly getExpandedText: () => string;

	constructor(
		getCollapsedText: () => string,
		getExpandedText: () => string,
		expanded = false,
		paddingX = 0,
		paddingY = 0,
	) {
		super(expanded ? getExpandedText() : getCollapsedText(), paddingX, paddingY);
		this.getCollapsedText = getCollapsedText;
		this.getExpandedText = getExpandedText;
	}

	setExpanded(expanded: boolean): void {
		this.setText(expanded ? this.getExpandedText() : this.getCollapsedText());
	}
}

type CompactionQueuedMessage = {
	text: string;
	mode: "steer" | "followUp";
};

type TrackedTurnTool = {
	id: string;
	name: string;
	args: unknown;
	status: "pending" | "running" | "success" | "error" | "cancelled";
	action?: string;
	subject?: string;
	filePath?: string;
	files?: TurnFileSummary[];
	additions?: number;
	deletions?: number;
	diff?: string;
	error?: string;
};

type TurnActivityCollector = {
	startedAt: number;
	phase: WorkspaceActivityPhase;
	action?: string;
	thinking?: string;
	tools: Map<string, TrackedTurnTool>;
	toolOrder: string[];
	queueCount: number;
	retried: boolean;
	compacted: boolean;
	cancelled: boolean;
	finalStopReason?: AssistantMessage["stopReason"];
};

type RenderSessionItem = AgentMessage | Extract<SessionEntry, { type: "custom" }>;

type TranscriptPaginationState = "idle" | "loading" | "exhausted" | "retryable-error" | "cursor-invalidated";

interface TranscriptScrollAnchor extends WorkspaceScrollAnchor {
	entryId: string;
	cursor: string;
	generation: number;
}

interface MaterializedTranscriptPage {
	children: Component[];
	entryComponents: Map<string, Component>;
}

function isCustomSessionEntry(item: RenderSessionItem): item is Extract<SessionEntry, { type: "custom" }> {
	return "type" in item && item.type === "custom";
}

export function getLatestThinkingActivityText(message: AssistantMessage): string | undefined {
	for (let index = message.content.length - 1; index >= 0; index--) {
		const content = message.content[index];
		if (content?.type !== "thinking") continue;
		const lines = content.thinking
			.split(/\r?\n/)
			.map((line) => line.trim())
			.filter(Boolean);
		return lines.at(-1);
	}
	return undefined;
}

const DEAD_TERMINAL_ERROR_CODES = new Set(["EIO", "EPIPE", "ENOTCONN"]);

function isDeadTerminalError(error: unknown): boolean {
	if (!error || typeof error !== "object" || !("code" in error)) {
		return false;
	}
	const code = (error as NodeJS.ErrnoException).code;
	return code !== undefined && DEAD_TERMINAL_ERROR_CODES.has(code);
}

const ANTHROPIC_SUBSCRIPTION_AUTH_WARNING =
	"Anthropic 订阅认证已启用。通过第三方工具使用时会按 token 计入额外用量，不受 Claude 套餐额度限制。可在 https://claude.ai/settings/usage 管理额外用量，也可在 /settings 中关闭此提醒。";

function isAnthropicSubscriptionAuthKey(apiKey: string | undefined): boolean {
	return typeof apiKey === "string" && apiKey.startsWith("sk-ant-oat");
}

function formatAbortedMessage(retryAttempt: number): string {
	return retryAttempt > 0 ? `重试 ${retryAttempt} 次后已取消` : t("status.operationAborted");
}

function isUnknownModel(model: Model<any> | undefined): boolean {
	return !!model && model.provider === "unknown" && model.id === "unknown" && model.api === "unknown";
}

function quoteIfNeeded(value: string): string {
	if (value.length > 0 && !/[^a-zA-Z0-9_\-./~:@]/.test(value)) {
		return value;
	}
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function formatResumeCommand(sessionManager: SessionManager): string | undefined {
	if (!process.stdout.isTTY) return undefined;
	if (!sessionManager.isPersisted()) return undefined;

	const sessionFile = sessionManager.getSessionFile();
	if (!sessionFile || !fs.existsSync(sessionFile)) return undefined;

	const args = [APP_NAME];
	if (!sessionManager.usesDefaultSessionDir()) {
		args.push("--session-dir", quoteIfNeeded(sessionManager.getSessionDir()));
	}
	args.push("--session", sessionManager.getSessionId());
	return args.join(" ");
}

function hasDefaultModelProvider(providerId: string): providerId is keyof typeof defaultModelPerProvider {
	return providerId in defaultModelPerProvider;
}

type LoginProviderCompletionOption = {
	id: string;
	name: string;
	authTypes: AuthSelectorProvider["authType"][];
};

const AUTH_TYPE_ORDER = { oauth: 0, api_key: 1 } satisfies Record<AuthSelectorProvider["authType"], number>;

function createFuzzyAutocompleteItems<T>(
	items: T[],
	prefix: string,
	getSearchText: (item: T) => string,
	toAutocompleteItem: (item: T) => AutocompleteItem,
): AutocompleteItem[] | null {
	const filtered = fuzzyFilter(items, prefix, getSearchText);
	if (filtered.length === 0) return null;
	return filtered.map(toAutocompleteItem);
}

function getLoginProviderCompletionOptions(
	providerOptions: readonly AuthSelectorProvider[],
): LoginProviderCompletionOption[] {
	const byId = new Map<string, LoginProviderCompletionOption>();
	for (const provider of providerOptions) {
		const existing = byId.get(provider.id);
		if (existing) {
			if (!existing.authTypes.includes(provider.authType)) {
				existing.authTypes.push(provider.authType);
				existing.authTypes.sort((a, b) => AUTH_TYPE_ORDER[a] - AUTH_TYPE_ORDER[b]);
			}
			continue;
		}
		byId.set(provider.id, {
			id: provider.id,
			name: provider.name,
			authTypes: [provider.authType],
		});
	}
	return Array.from(byId.values()).sort((a, b) => a.name.localeCompare(b.name));
}

function getLoginProviderSearchText(provider: LoginProviderCompletionOption): string {
	const authTypes = provider.authTypes
		.map((authType) =>
			authType === "oauth"
				? `${authType} subscription ${formatAuthSelectorProviderType(authType)}`
				: `${authType} API key`,
		)
		.join(" ");
	return `${provider.id} ${provider.name} ${authTypes}`;
}

function formatLoginProviderCompletionDescription(provider: LoginProviderCompletionOption): string {
	const authTypes = provider.authTypes.map(formatAuthSelectorProviderType).join("/");
	return provider.name === provider.id ? authTypes : `${provider.name} · ${authTypes}`;
}

/**
 * Options for InteractiveMode initialization.
 */
export interface InteractiveModeOptions {
	/** Providers that were migrated to auth.json (shows warning) */
	migratedProviders?: string[];
	/** Diagnostics collected before the interactive TUI was initialized. */
	startupDiagnostics?: AgentSessionRuntimeDiagnostic[];
	/** Warning message if session model couldn't be restored */
	modelFallbackMessage?: string;
	/** Cwd to trust after reload if it gained a .pi directory during this implicitly trusted session. */
	autoTrustOnReloadCwd?: string;
	/** Initial message to send on startup (can include @file content) */
	initialMessage?: string;
	/** Images to attach to the initial message */
	initialImages?: ImageContent[];
	/** Additional messages to send after the initial message */
	initialMessages?: string[];
	/** Force verbose startup (overrides quietStartup setting) */
	verbose?: boolean;
	/** Override alternate-screen selection for this run. */
	altScreen?: AltScreenMode;
	/** Override fullscreen mouse input for this run. */
	mouse?: boolean;
	/** TUI layout mode. */
	tuiMode?: TuiMode;
	/** Initial interactive theme setting for this invocation. */
	initialThemeSetting?: string;
}

interface InteractiveTuiOptions {
	tuiMode: TuiMode;
	showHardwareCursor: boolean;
	logDirectory: string;
	mouse?: boolean;
	workspaceInputHandler?: TuiInputListener;
	workspaceSearchTarget?: () => AltScreenSearchTarget | undefined;
	terminal?: Terminal;
	copyOnSelect?: boolean;
	onRightClickPaste?: () => void;
}

/** Composition root for selecting the interactive terminal renderer. */
export function createInteractiveTui(options: InteractiveTuiOptions): TuiMainScreen | LystarTUI {
	const terminal = options.terminal ?? new ProcessTerminal();
	if (options.tuiMode === "fullscreen") {
		const styleSearchMatch = (text: string) => theme.bg("searchMatchBg", theme.fg("searchMatchText", text));
		return new LystarTUI(terminal, options.showHardwareCursor, options.logDirectory, {
			mouse: options.mouse,
			copyOnSelect: options.copyOnSelect,
			searchMatchStyle: (text) => theme.underline(styleSearchMatch(text)),
			searchCurrentMatchStyle: (text) => theme.bold(theme.inverse(styleSearchMatch(text))),
			openUrl: openBrowser,
			searchTarget: options.workspaceSearchTarget,
			workspaceInputHandler: options.workspaceInputHandler,
			onRightClickPaste: options.onRightClickPaste,
			copySelection: async (text) => {
				try {
					await copyToClipboard(text);
					return true;
				} catch {
					return false;
				}
			},
		});
	}
	return new TuiMainScreen(terminal, options.showHardwareCursor, options.logDirectory);
}

/** Stable reference for components while InteractiveMode replaces the active renderer. */
export function createInteractiveTuiReference(getTui: () => TUI): TUI {
	return new Proxy({} as TUI, {
		get: (_target, property) => {
			const tui = getTui();
			const value = Reflect.get(tui, property, tui);
			if (typeof value !== "function") return value;
			let methodTui = tui;
			let method = value;
			return (...args: unknown[]) => {
				const currentTui = getTui();
				if (currentTui !== methodTui) {
					const currentMethod = Reflect.get(currentTui, property, currentTui);
					if (typeof currentMethod !== "function") {
						throw new TypeError(`TUI property ${String(property)} is not callable`);
					}
					methodTui = currentTui;
					method = currentMethod;
				}
				return Reflect.apply(method, methodTui, args);
			};
		},
		set: (_target, property, value) => {
			const tui = getTui();
			return Reflect.set(tui, property, value, tui);
		},
		has: (_target, property) => Reflect.has(getTui(), property),
		getPrototypeOf: () => Reflect.getPrototypeOf(getTui()),
	});
}

const TRANSCRIPT_PAGE_SIZE = 80;

interface GuiCompanionCoordinationState {
	ensureQueue: Promise<void>;
	warningKey?: string;
	failedSessionPath?: string;
}

const guiCompanionCoordinationStates = new WeakMap<object, GuiCompanionCoordinationState>();

function getGuiCompanionCoordinationState(owner: object): GuiCompanionCoordinationState {
	const existing = guiCompanionCoordinationStates.get(owner);
	if (existing) return existing;
	const state: GuiCompanionCoordinationState = { ensureQueue: Promise.resolve() };
	guiCompanionCoordinationStates.set(owner, state);
	return state;
}

export class InteractiveMode {
	private runtimeHost: AgentSessionRuntime;
	private guiCompanion?: GuiCompanionServer;
	private guiCompanionSessionPath?: string;
	private renderer: TuiMainScreen | LystarTUI;
	private ui: TUI;
	private mainScreenRenderState: TuiMainScreenRenderState | undefined;
	private loadedResourcesContainer: Container;
	private chatContainer: Container;
	private pendingMessagesContainer: Container;
	private statusContainer: Container;
	private defaultEditor: CustomEditor;
	private editor: EditorComponent;
	private editorComponentFactory: EditorFactory | undefined;
	private autocompleteProvider: AutocompleteProvider | undefined;
	private autocompleteProviderWrappers: AutocompleteProviderFactory[] = [];
	private fdPath: string | undefined;
	private editorContainer: Container;
	private activeSelectorToken?: object;
	private activeSelectorDispose?: () => void;
	private footer: FooterComponent;
	private footerContainer: Container;
	private shortcutContainer: Container;
	private composer: WorkspaceComposer;
	private activityBar: WorkspaceActivityBar;
	private workspace: LystarWorkspace;
	private fullscreenMouse = true;
	private footerDataProvider: FooterDataProvider;
	// Stored so the same manager can be injected into custom editors, selectors, and extension UI.
	private keybindings: KeybindingsManager;
	private version: string;
	private isInitialized = false;
	private onInputCallback?: (text: string) => void;
	private pendingUserInputs: string[] = [];
	private activeStatusIndicator: StatusIndicator | undefined = undefined;
	private readonly idleStatus = new IdleStatus();
	private workingMessage: string | undefined = undefined;
	private workingVisible = true;
	private workingIndicatorOptions: WorkingIndicatorOptions | undefined = undefined;
	private readonly defaultHiddenThinkingLabel = t("status.thinking");
	private hiddenThinkingLabel = this.defaultHiddenThinkingLabel;

	private lastSigintTime = 0;
	private lastEscapeTime = 0;
	private changelogMarkdown: string | undefined = undefined;
	private startupNoticesShown = false;
	private anthropicSubscriptionWarningShown = false;

	// Status line tracking (for mutating immediately-sequential status updates)
	private lastStatusSpacer: Spacer | undefined = undefined;
	private lastStatusText: Text | undefined = undefined;
	private managedToolStatusStarted = false;

	// Streaming message tracking
	private streamingComponent: AssistantMessageComponent | undefined = undefined;
	private streamingMessage: AssistantMessage | undefined = undefined;

	// Tool execution tracking: toolCallId -> component
	private pendingTools = new Map<string, ToolExecutionComponent>();
	private streamingToolStack: ToolExecutionStackComponent | undefined;
	private turnActivity: TurnActivityCollector | undefined;
	private lastTurnFiles: TurnFileSummary[] = [];
	private transcriptSource: SessionTranscriptSource | undefined;
	private transcriptCursor: string | undefined;
	private transcriptEntries: SessionEntry[] = [];
	private transcriptGeneration = 0;
	private transcriptPaginationState: TranscriptPaginationState = "exhausted";
	private transcriptComponentEntryIds = new WeakMap<Component, string>();

	// Tool output expansion state
	private toolOutputExpanded = false;
	private cardExpansionSessionId: string | undefined;
	private cardExpansion = new Map<string, boolean>();
	private pendingCardClick: { row: number; column: number; component: Component; componentRow: number } | undefined;
	private hoveredCard: InteractiveCard | undefined;
	private readonly wheelScroll = new WheelScrollNormalizer();

	// Thinking block visibility state
	private hideThinkingBlock = false;
	private thinkingDisplayMode: ThinkingDisplayMode = "activity";
	private outputPad = 1;
	private readonly mermaidMarkdownTransformer: MarkdownTransformer = createMermaidMarkdownTransformer({
		getMode: () => this.settingsManager.getMermaidRenderingMode(),
		theme,
	});

	// Skill commands: command name -> skill file path
	private skillCommands = new Map<string, string>();

	// Agent subscription unsubscribe function
	private unsubscribe?: () => void;
	private signalCleanupHandlers: Array<() => void> = [];

	private lystarSettingsWarning?: string;

	// Track if editor is in bash mode (text starts with !)
	private isBashMode = false;

	// Track current bash execution component
	private bashComponent: BashExecutionComponent | undefined = undefined;

	// Track pending bash components (shown in pending area, moved to chat on submit)
	private pendingBashComponents: BashExecutionComponent[] = [];

	// Auto-compaction state
	private autoCompactionEscapeHandler?: () => void;

	// Auto-retry state
	private retryEscapeHandler?: () => void;

	// Messages queued while compaction is running
	private compactionQueuedMessages: CompactionQueuedMessage[] = [];

	// Shutdown state
	private shutdownRequested = false;

	// Extension UI state
	private extensionSelector: ExtensionSelectorComponent | undefined = undefined;
	private extensionInput: ExtensionInputComponent | undefined = undefined;
	private extensionEditor: ExtensionEditorComponent | undefined = undefined;
	private extensionTerminalInputSubscriptions = new Set<{
		handler: (data: string) => { consume?: boolean; data?: string } | undefined;
		unsubscribe: () => void;
	}>();

	// Extension widgets (components rendered above/below the editor)
	private extensionWidgetsAbove = new Map<string, Component & { dispose?(): void }>();
	private extensionWidgetsBelow = new Map<string, Component & { dispose?(): void }>();
	private widgetContainerAbove!: Container;
	private widgetContainerBelow!: Container;

	// Custom footer from extension (undefined = use built-in footer)
	private customFooter: (Component & { dispose?(): void }) | undefined = undefined;

	// Header container that holds the built-in or custom header
	private headerContainer: Container;

	// Built-in header (logo + keybinding hints + changelog)
	private builtInHeader: Component | undefined = undefined;
	private headerContextUsage: ReturnType<AgentSession["getContextUsage"]> = undefined;
	private headerContextMessages: AgentMessage[] | undefined;
	private headerContextMessageCount = -1;
	private headerContextModel: unknown;
	private headerContextUsageDirty = true;

	// Custom header from extension (undefined = use built-in header)
	private customHeader: (Component & { dispose?(): void }) | undefined = undefined;

	private options: InteractiveModeOptions;
	private readonly onRightClickPaste = (): void => {
		void this.handleRightClickPaste();
	};
	private autoTrustOnReloadCwd: string | undefined;
	private themeController: InteractiveThemeController;

	// Convenience accessors
	private get session(): AgentSession {
		return this.runtimeHost.session;
	}
	private get agent() {
		return this.session.agent;
	}
	private get sessionManager() {
		return this.session.sessionManager;
	}
	private get settingsManager() {
		return this.session.settingsManager;
	}

	private getHeaderContextUsage(): ReturnType<AgentSession["getContextUsage"]> {
		const messages = this.session.messages;
		const model = this.session.model;
		if (
			this.headerContextUsageDirty ||
			this.headerContextMessages !== messages ||
			this.headerContextMessageCount !== messages.length ||
			this.headerContextModel !== model
		) {
			this.headerContextUsage = this.session.getContextUsage();
			this.headerContextMessages = messages;
			this.headerContextMessageCount = messages.length;
			this.headerContextModel = model;
			this.headerContextUsageDirty = false;
		}
		return this.headerContextUsage;
	}

	private getWorkspaceComposerInfo(): WorkspaceComposerInfo {
		const state = this.session.state;
		const model = !state.model || state.model.id === "unknown" ? t("status.noModel") : state.model.id;
		const provider =
			state.model && this.footerDataProvider.getAvailableProviderCount() > 1 ? state.model.provider : undefined;
		const thinking = state.model?.reasoning ? `思考 ${formatThinkingLevel(state.thinkingLevel || "off")}` : undefined;
		const projectTrusted = this.settingsManager.isProjectTrusted();
		const trustState = projectTrusted
			? undefined
			: hasTrustRequiringProjectResources(this.sessionManager.getCwd())
				? "项目资源受限"
				: "项目未信任";
		return {
			primary: [`${provider ? `${provider}/` : ""}${model}`, thinking].filter(Boolean).join(" · "),
			secondary: !state.model || state.model.id === "unknown" ? "无可用模型" : trustState,
			provider,
			model,
			thinking,
		};
	}

	constructor(runtimeHost: AgentSessionRuntime, options: InteractiveModeOptions = {}) {
		this.runtimeHost = runtimeHost;
		const lystarSettings = loadLystarSettings(getAgentDir());
		this.lystarSettingsWarning = lystarSettings.warning;
		this.fullscreenMouse = options.mouse ?? lystarSettings.settings.mouse;
		const legacyTuiMode =
			options.altScreen === undefined
				? undefined
				: shouldUseAlternateScreen(options.altScreen, createTerminalModeContext())
					? "fullscreen"
					: "regular";
		const defaultTuiMode = shouldUseAlternateScreen(lystarSettings.settings.altScreen, createTerminalModeContext())
			? "fullscreen"
			: "regular";
		const tuiMode = options.tuiMode ?? legacyTuiMode ?? this.settingsManager.getConfiguredTuiMode() ?? defaultTuiMode;
		this.options = { ...options, tuiMode };
		this.autoTrustOnReloadCwd = options.autoTrustOnReloadCwd;
		this.runtimeHost.setBeforeSessionInvalidate(() => {
			this.resetExtensionUI();
		});
		this.runtimeHost.setRebindSession(async () => {
			await this.rebindCurrentSession({ renderBeforeBind: true });
			await this.themeController.applyFromSettings();
		});
		this.version = VERSION;
		this.renderer = createInteractiveTui({
			tuiMode,
			showHardwareCursor: this.settingsManager.getShowHardwareCursor(),
			logDirectory: getAgentDir(),
			mouse: this.fullscreenMouse,
			copyOnSelect: this.settingsManager.getFullscreenCopyOnSelect(),
			workspaceInputHandler: (data) => this.handleWorkspaceInput(data),
			workspaceSearchTarget: () => this.workspace?.getAltScreenSearchTarget?.(),
			onRightClickPaste: this.onRightClickPaste,
		});
		this.ui = createInteractiveTuiReference(() => this.renderer);
		this.ui.setReduceMotion(lystarSettings.settings.reduceMotion);
		this.ui.setClearOnShrink(this.settingsManager.getClearOnShrink());
		this.headerContainer = new Container();
		this.loadedResourcesContainer = new Container();
		this.chatContainer = new Container();
		this.pendingMessagesContainer = new Container();
		this.statusContainer = new Container();
		this.widgetContainerAbove = new Container();
		this.widgetContainerBelow = new Container();
		this.keybindings = KeybindingsManager.create();
		setKeybindings(this.keybindings);
		const editorPaddingX = this.settingsManager.getEditorPaddingX();
		const autocompleteMaxVisible = this.settingsManager.getAutocompleteMaxVisible();
		this.defaultEditor = new CustomEditor(this.ui, getEditorTheme(), this.keybindings, {
			paddingX: tuiMode === "fullscreen" ? Math.max(2, editorPaddingX) : editorPaddingX,
			autocompleteMaxVisible,
		});
		this.editor = this.defaultEditor;
		this.editorContainer = new Container();
		this.editorContainer.addChild(this.editor as Component);
		this.footerDataProvider = new FooterDataProvider(this.sessionManager.getCwd());
		this.footer = new FooterComponent(this.session, this.footerDataProvider, { showUsage: false });
		this.footerContainer = new Container();
		this.footerContainer.addChild(this.footer);
		this.shortcutContainer = new Container();
		this.shortcutContainer.addChild(
			new WorkspaceShortcutBar({
				getState: () => ({
					streaming: this.session.isStreaming,
					bashRunning: this.session.isBashRunning,
					following: this.workspace?.isFollowing() ?? true,
				}),
				getKeyText: (keybinding) => keyDisplayText(keybinding),
				getStatus: (width) => (this.customFooter ? undefined : this.footer.renderUsage(width)),
			}),
		);

		this.composer = new WorkspaceComposer({
			editor: this.editorContainer,
			brand: APP_TITLE,
			structuredEditor: this.defaultEditor,
			fullscreen: tuiMode === "fullscreen",
			getInfo: () => this.getWorkspaceComposerInfo(),
		});
		this.activityBar = new WorkspaceActivityBar(
			() => this.ui.requestRender(),
			() => this.ui.reduceMotion,
		);
		this.workspace = new LystarWorkspace({
			getHeight: () => this.ui.terminal.rows,
			header: this.headerContainer,
			scrollContainers: [this.loadedResourcesContainer, this.chatContainer],
			bottomContainers: [
				this.pendingMessagesContainer,
				this.statusContainer,
				this.widgetContainerAbove,
				this.activityBar,
				this.composer,
				this.widgetContainerBelow,
				this.footerContainer,
				this.shortcutContainer,
			],
			fixedBottomContainers: [this.composer, this.shortcutContainer],
			optionalBottomPriority: [
				this.activityBar,
				this.pendingMessagesContainer,
				this.statusContainer,
				this.footerContainer,
				this.widgetContainerAbove,
				this.widgetContainerBelow,
			],
			fullscreen: tuiMode === "fullscreen",
			scrollbar: this.settingsManager.getFullscreenScrollbar(),
			scrollbarStyle: (text) => theme.bg("scrollbarThumb", text),
		});

		// Load hide thinking block setting
		this.hideThinkingBlock = this.settingsManager.getHideThinkingBlock();
		this.thinkingDisplayMode = this.settingsManager.getThinkingDisplayMode();
		this.outputPad = this.settingsManager.getOutputPad();

		// Register themes from resource loader and initialize
		setRegisteredThemes(this.session.resourceLoader.getThemes().themes);
		this.themeController = new InteractiveThemeController(this.ui, {
			getSettingsManager: () => this.settingsManager,
			showError: (message) => this.showError(message),
			onChanged: () => this.updateEditorBorderColor(),
			initialThemeSetting: options.initialThemeSetting,
		});
	}

	private getAutocompleteSourceTag(sourceInfo?: SourceInfo): string | undefined {
		if (!sourceInfo) {
			return undefined;
		}

		const scopePrefix = sourceInfo.scope === "user" ? "u" : sourceInfo.scope === "project" ? "p" : "t";
		const source = sourceInfo.source.trim();

		if (source === "auto" || source === "local" || source === "cli") {
			return scopePrefix;
		}

		if (source.startsWith("npm:")) {
			return `${scopePrefix}:${source}`;
		}

		const gitSource = parseGitUrl(source);
		if (gitSource) {
			const ref = gitSource.ref ? `@${gitSource.ref}` : "";
			return `${scopePrefix}:git:${gitSource.host}/${gitSource.path}${ref}`;
		}

		return scopePrefix;
	}

	private prefixAutocompleteDescription(description: string | undefined, sourceInfo?: SourceInfo): string | undefined {
		const sourceTag = this.getAutocompleteSourceTag(sourceInfo);
		if (!sourceTag) {
			return description;
		}
		return description ? `[${sourceTag}] ${description}` : `[${sourceTag}]`;
	}

	private getBuiltInCommandConflictDiagnostics(extensionRunner: ExtensionRunner): ResourceDiagnostic[] {
		const builtinNames = new Set(BUILTIN_SLASH_COMMANDS.map((command) => command.name));
		return extensionRunner
			.getRegisteredCommands()
			.filter((command) => builtinNames.has(command.name))
			.map((command) => ({
				type: "warning" as const,
				message:
					command.invocationName === command.name
						? `Extension command '/${command.name}' conflicts with built-in interactive command. Skipping in autocomplete.`
						: `Extension command '/${command.name}' conflicts with built-in interactive command. Available as '/${command.invocationName}'.`,
				path: command.sourceInfo.path,
			}));
	}

	private createBaseAutocompleteProvider(): AutocompleteProvider {
		// Define commands for autocomplete
		const slashCommands: SlashCommand[] = BUILTIN_SLASH_COMMANDS.map((command) => ({
			name: command.name,
			description: command.description,
			...(command.argumentHint && { argumentHint: command.argumentHint }),
		}));

		const modelCommand = slashCommands.find((command) => command.name === "model");
		if (modelCommand) {
			modelCommand.getArgumentCompletions = (prefix: string): AutocompleteItem[] | null => {
				const models =
					this.session.scopedModels.length > 0
						? this.session.scopedModels.map((s) => s.model)
						: this.session.modelRuntime.getAvailableSnapshot();

				if (models.length === 0) return null;

				// Create items with provider/id format
				const items = models.map((m) => ({
					id: m.id,
					provider: m.provider,
					name: m.name,
					label: `${m.provider}/${m.id}`,
				}));

				return createFuzzyAutocompleteItems(items, prefix, getModelSearchText, (item) => ({
					value: item.label,
					label: item.id,
					description: item.provider,
				}));
			};
		}

		const loginCommand = slashCommands.find((command) => command.name === "login");
		if (loginCommand) {
			loginCommand.getArgumentCompletions = (prefix: string): AutocompleteItem[] | null => {
				const providers = getLoginProviderCompletionOptions(this.getLoginProviderOptions());
				return createFuzzyAutocompleteItems(providers, prefix, getLoginProviderSearchText, (provider) => ({
					value: provider.id,
					label: provider.id,
					description: formatLoginProviderCompletionDescription(provider),
				}));
			};
		}

		// Convert prompt templates to SlashCommand format for autocomplete
		const templateCommands: SlashCommand[] = this.session.promptTemplates.map((cmd) => ({
			name: cmd.name,
			description: this.prefixAutocompleteDescription(cmd.description, cmd.sourceInfo),
			...(cmd.argumentHint && { argumentHint: cmd.argumentHint }),
		}));

		// Convert extension commands to SlashCommand format
		const builtinCommandNames = new Set(slashCommands.map((c) => c.name));
		const extensionCommands: SlashCommand[] = this.session.extensionRunner
			.getRegisteredCommands()
			.filter((cmd) => !builtinCommandNames.has(cmd.name))
			.map((cmd) => ({
				name: cmd.invocationName,
				description: this.prefixAutocompleteDescription(cmd.description, cmd.sourceInfo),
				getArgumentCompletions: cmd.getArgumentCompletions,
			}));

		// Build skill commands from session.skills (if enabled)
		this.skillCommands.clear();
		const skillCommandList: SlashCommand[] = [];
		if (this.settingsManager.getEnableSkillCommands()) {
			for (const skill of this.session.resourceLoader.getSkills().skills) {
				const commandName = `skill:${skill.name}`;
				this.skillCommands.set(commandName, skill.filePath);
				skillCommandList.push({
					name: commandName,
					description: this.prefixAutocompleteDescription(skill.description, skill.sourceInfo),
				});
			}
		}

		return new CombinedAutocompleteProvider(
			[...slashCommands, ...templateCommands, ...extensionCommands, ...skillCommandList],
			this.sessionManager.getCwd(),
			this.fdPath,
		);
	}

	private setupAutocompleteProvider(): void {
		let provider = this.createBaseAutocompleteProvider();
		const triggerCharacters: string[] = [];
		for (const wrapProvider of this.autocompleteProviderWrappers) {
			provider = wrapProvider(provider);
			triggerCharacters.push(...(provider.triggerCharacters ?? []));
		}
		if (triggerCharacters.length > 0) {
			provider.triggerCharacters = [...new Set(triggerCharacters)];
		}

		this.autocompleteProvider = provider;
		this.defaultEditor.setAutocompleteProvider(provider);
		if (this.editor !== this.defaultEditor) {
			this.editor.setAutocompleteProvider?.(provider);
		}
	}

	private showStartupNoticesIfNeeded(): void {
		if (this.startupNoticesShown) {
			return;
		}
		this.startupNoticesShown = true;

		if (!this.changelogMarkdown) {
			return;
		}

		if (this.chatContainer.children.length > 0) {
			this.chatContainer.addChild(new Spacer(1));
		}
		const condensedText = `${t("update.productUpdated", { app: APP_TITLE, version: this.version })} ${t(
			"update.productChangelog",
			{ app: APP_TITLE },
		)}`;
		if (this.workspace.isFullscreen()) {
			this.chatContainer.addChild(new Text(condensedText, 1, 0));
			return;
		}

		this.chatContainer.addChild(new DynamicBorder());
		if (this.settingsManager.getCollapseChangelog()) {
			this.chatContainer.addChild(new Text(condensedText, 1, 0));
		} else {
			this.chatContainer.addChild(new Text(theme.bold(theme.fg("accent", "更新内容")), 1, 0));
			this.chatContainer.addChild(new Spacer(1));
			this.chatContainer.addChild(
				new Markdown(this.changelogMarkdown.trim(), 1, 0, this.getMarkdownThemeWithSettings()),
			);
			this.chatContainer.addChild(new Spacer(1));
		}
		this.chatContainer.addChild(new DynamicBorder());
	}

	private mountInteractiveTui(tui: TuiMainScreen | LystarTUI, components: readonly Component[]): void {
		for (const component of components) tui.addChild(component);
	}

	private stopInteractiveTui(fullscreenExitOutput: FullscreenExitOutput): void {
		if (this.renderer.mode === "fullscreen" && fullscreenExitOutput === "transcript") {
			while (this.renderer.hasOverlayEntries) this.renderer.hideOverlay();
			this.switchTuiMode("regular", false, false);
			this.workspace.setBottomContainersVisible(false);
			this.renderer.renderNow();
		} else {
			while (this.renderer.hasOverlayEntries) this.renderer.hideOverlay();
		}
		this.ui.stop({ preserveScreen: this.renderer.mode === "fullscreen" });
	}

	private switchTuiMode(mode: TuiMode, restoreProgress = true, startRenderer = true): boolean {
		const previousUi = this.renderer;
		if (mode === previousUi.mode) return true;
		if (previousUi.hasOverlayEntries) return false;

		const components = [...previousUi.children];
		const focus = previousUi.getFocusedComponent();
		const terminal = previousUi.terminal;
		const showHardwareCursor = previousUi.getShowHardwareCursor();
		const clearOnShrink = previousUi.getClearOnShrink();
		const reduceMotion = previousUi.reduceMotion;
		const onDebug = previousUi.onDebug;
		if (previousUi instanceof TuiMainScreen) {
			this.mainScreenRenderState = previousUi.captureRenderState();
		}

		previousUi.stop({ preserveScreen: true });
		previousUi.setFocus(null);
		previousUi.clear();

		const nextUi = createInteractiveTui({
			tuiMode: mode,
			showHardwareCursor,
			logDirectory: getAgentDir(),
			mouse: this.fullscreenMouse,
			copyOnSelect: this.settingsManager.getFullscreenCopyOnSelect(),
			workspaceInputHandler: (data) => this.handleWorkspaceInput(data),
			workspaceSearchTarget: () => this.workspace?.getAltScreenSearchTarget?.(),
			terminal,
			onRightClickPaste: this.onRightClickPaste,
		});
		nextUi.setClearOnShrink(clearOnShrink);
		nextUi.setReduceMotion(reduceMotion);
		nextUi.onDebug = onDebug;
		if (nextUi instanceof TuiMainScreen && this.mainScreenRenderState) {
			nextUi.restoreRenderState(this.mainScreenRenderState);
		}
		this.renderer = nextUi;
		this.options.tuiMode = mode;
		const fullscreen = mode === "fullscreen";
		this.composer.setFullscreen(fullscreen);
		this.workspace.setFullscreen(fullscreen);
		const editorPaddingX = fullscreen
			? Math.max(2, this.settingsManager.getEditorPaddingX())
			: this.settingsManager.getEditorPaddingX();
		this.defaultEditor.setPaddingX(editorPaddingX);
		if (this.editor !== this.defaultEditor) this.editor.setPaddingX?.(editorPaddingX);
		this.mountInteractiveTui(nextUi, components);
		nextUi.invalidate();
		nextUi.setFocus(focus);
		if (!startRenderer) return true;
		nextUi.start();
		this.themeController.rebindTui();
		this.rebindExtensionTerminalInputListeners();
		if (
			restoreProgress &&
			this.settingsManager.getShowTerminalProgress() &&
			(this.session.isStreaming || this.session.isCompacting)
		) {
			terminal.setProgress(true);
		}
		return true;
	}

	async init(): Promise<void> {
		if (this.isInitialized) return;

		this.registerSignalHandlers();

		// Load changelog (only show new entries, skip for resumed sessions)
		this.changelogMarkdown = this.getChangelogForDisplay();

		// Windows 始终准备 LYStar 自己管理的 Bash；fd/rg 继续按现有规则补齐。
		if (this.session.scopedModels.length > 0 && (this.options.verbose || !this.settingsManager.getQuietStartup())) {
			const modelList = this.session.scopedModels
				.map((sm) => {
					const thinkingStr = sm.thinkingLevel ? `:${sm.thinkingLevel}` : "";
					return `${sm.model.id}${thinkingStr}`;
				})
				.join(", ");
			const cycleKeys = this.keybindings.getKeys("app.model.cycleForward");
			const cycleHint =
				cycleKeys.length > 0
					? theme.fg("muted", `（${formatKeyText(cycleKeys.join("/"), { capitalize: true })} 切换）`)
					: "";
			console.log(theme.fg("dim", `模型范围：${modelList}${cycleHint}`));
		}

		// The workspace owns the fixed header, scrollback viewport, editor, and footer.
		this.renderWidgets();
		this.mountInteractiveTui(this.renderer, [this.workspace]);
		this.defaultEditor.onAction("app.clear", () => this.handleCtrlC());
		this.defaultEditor.onCtrlD = () => this.handleCtrlD();
		this.defaultEditor.onSubmit = (text) => this.handleStartupSubmit(text);
		this.ui.setFocus(this.editor);

		// Start the UI before initializing extensions so session_start handlers can use interactive dialogs
		this.ui.start();
		this.isInitialized = true;

		await this.themeController.applyFromSettings();

		this.builtInHeader = new WorkspaceHeader(() => {
			const usage = this.getHeaderContextUsage();
			const used = usage?.tokens === null || usage?.tokens === undefined ? "?" : formatTokens(usage.tokens);
			const available = usage ? formatTokens(usage.contextWindow) : "?";
			const percentValue = usage?.percent ?? undefined;
			const percent = percentValue === null || percentValue === undefined ? "?" : `${percentValue.toFixed(1)}%`;
			const branch = this.footerDataProvider.getGitBranch();
			const path = this.formatDisplayPath(this.sessionManager.getCwd());
			const compaction = this.settingsManager.getCompactionSettings();
			const threshold =
				usage && usage.contextWindow > 0
					? ((usage.contextWindow - compaction.reserveTokens) / usage.contextWindow) * 100
					: 100;
			return {
				product: APP_TITLE,
				path,
				branch: branch ?? undefined,
				session: this.getWorkspaceStatusLabel(),
				context: `上下文 ${percent}${WORKSPACE_HEADER_SEPARATOR}${used}/${available}`,
				compactContext: `上下文 ${percent}`,
				contextWarning: percentValue !== null && percentValue !== undefined && percentValue >= threshold - 5,
			};
		});
		this.headerContainer.addChild(this.builtInHeader);
		this.ui.requestRender();

		const [fdPath] = await Promise.all([
			ensureTool("fd", (status: ToolStatus) => this.showManagedToolStatus(status)),
			ensureTool("rg", (status: ToolStatus) => this.showManagedToolStatus(status)),
			ensureManagedWindowsBash(),
		]);
		this.fdPath = fdPath;
		if (this.lystarSettingsWarning) {
			this.showWarning(this.lystarSettingsWarning);
		}
		this.setupKeyHandlers();
		this.setupEditorSubmitHandler();
		this.ui.requestRender();

		// Initialize extensions first so resources are shown before messages
		await this.rebindCurrentSession();

		// Render initial messages AFTER showing loaded resources
		await this.renderInitialMessagesFromTranscript();

		// Set up theme file watcher
		onThemeChange(() => {
			this.ui.invalidate();
			this.updateEditorBorderColor();
			this.ui.requestRender();
		});

		// Set up git branch watcher (uses provider instead of footer)
		this.footerDataProvider.onBranchChange(() => {
			this.ui.requestRender();
		});

		// Initialize available provider count for footer display
		await this.updateAvailableProviderCount();
	}

	/**
	 * Update terminal title with session name and cwd.
	 */
	private updateTerminalTitle(): void {
		const cwdBasename = path.basename(this.sessionManager.getCwd());
		const sessionName = this.sessionManager.getSessionName();
		if (sessionName) {
			this.ui.terminal.setTitle(`${APP_TITLE} - ${sessionName} - ${cwdBasename}`);
		} else {
			this.ui.terminal.setTitle(`${APP_TITLE} - ${cwdBasename}`);
		}
	}

	/**
	 * Run the interactive mode. This is the main entry point.
	 * Initializes the UI, shows warnings, processes initial messages, and starts the interactive loop.
	 */
	async run(): Promise<void> {
		await this.init();

		if (!process.env.PI_OFFLINE) {
			const controller = new AbortController();
			const timeout = setTimeout(() => controller.abort(), 15_000);
			void refreshModelCatalogs(this.session.modelRuntime, controller.signal)
				.then(() => this.updateAvailableProviderCount())
				.catch(() => {})
				.finally(() => clearTimeout(timeout));
		}

		// Start version check asynchronously
		checkForNewPiVersion(this.version).then((newRelease) => {
			if (newRelease) {
				this.showNewVersionNotification(newRelease);
			}
		});

		// Start package update check asynchronously
		this.checkForPackageUpdates()
			.then((updates) => {
				if (updates.length > 0) {
					this.showPackageUpdateNotification(updates);
				}
			})
			.finally(() => {
				// On Windows, npm can overwrite the shared console title while checking
				// extension package versions. Restore Pi's title after the startup check.
				if (process.platform === "win32" && this.isInitialized) {
					this.updateTerminalTitle();
				}
			});

		// Check tmux keyboard setup asynchronously
		this.checkTmuxKeyboardSetup().then((warning) => {
			if (warning) {
				this.showWarning(warning);
			}
		});

		// Show startup warnings
		const {
			migratedProviders,
			startupDiagnostics,
			modelFallbackMessage,
			initialMessage,
			initialImages,
			initialMessages,
		} = this.options;

		for (const diagnostic of startupDiagnostics ?? []) {
			if (diagnostic.type === "error") {
				this.showError(diagnostic.message);
			} else if (diagnostic.type === "warning") {
				this.showWarning(diagnostic.message);
			} else {
				this.showStatus(diagnostic.message);
			}
		}

		if (migratedProviders && migratedProviders.length > 0) {
			this.showWarning(`凭据已迁移到 auth.json：${migratedProviders.join(", ")}`);
		}

		const modelsJsonError = this.session.modelRuntime.getError();
		if (modelsJsonError) {
			this.showError(`models.json 错误：${modelsJsonError}`);
		}

		if (modelFallbackMessage) {
			this.showWarning(modelFallbackMessage);
		}

		void this.maybeWarnAboutAnthropicSubscriptionAuth();

		// Process initial messages
		if (initialMessage) {
			try {
				await this.session.prompt(initialMessage, { images: initialImages });
			} catch (error: unknown) {
				const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
				this.showError(errorMessage);
			}
		}

		if (initialMessages) {
			for (const message of initialMessages) {
				try {
					await this.session.prompt(message);
				} catch (error: unknown) {
					const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
					this.showError(errorMessage);
				}
			}
		}

		// Main interactive loop
		while (true) {
			const userInput = await this.getUserInput();
			try {
				await this.session.prompt(userInput);
			} catch (error: unknown) {
				const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
				this.showError(errorMessage);
			}
		}
	}

	private async checkForPackageUpdates(): Promise<string[]> {
		if (process.env.PI_OFFLINE) {
			return [];
		}

		try {
			const packageManager = new DefaultPackageManager({
				cwd: this.sessionManager.getCwd(),
				agentDir: getAgentDir(),
				settingsManager: this.settingsManager,
			});
			const updates = await packageManager.checkForAvailableUpdates();
			return updates.map((update) => update.displayName);
		} catch {
			return [];
		}
	}

	private async checkTmuxKeyboardSetup(): Promise<string | undefined> {
		if (!process.env.TMUX) return undefined;

		const runTmuxShow = (option: string): Promise<string | undefined> => {
			return new Promise((resolve) => {
				const proc = spawn("tmux", ["show", "-gv", option], {
					stdio: ["ignore", "pipe", "ignore"],
				});
				let stdout = "";
				const timer = setTimeout(() => {
					proc.kill();
					resolve(undefined);
				}, 2000);

				proc.stdout?.on("data", (data) => {
					stdout += data.toString();
				});
				proc.on("error", () => {
					clearTimeout(timer);
					resolve(undefined);
				});
				proc.on("close", (code) => {
					clearTimeout(timer);
					resolve(code === 0 ? stdout.trim() : undefined);
				});
			});
		};

		const [extendedKeys, extendedKeysFormat] = await Promise.all([
			runTmuxShow("extended-keys"),
			runTmuxShow("extended-keys-format"),
		]);

		// If we couldn't query tmux (timeout, sandbox, etc.), don't warn
		if (extendedKeys === undefined) return undefined;

		if (extendedKeys !== "on" && extendedKeys !== "always") {
			return "tmux 的 extended-keys 未启用，带修饰键的 Enter 可能失效。请在 ~/.tmux.conf 中加入 `set -g extended-keys on` 后重启 tmux。";
		}

		if (extendedKeysFormat === "xterm") {
			return "tmux 的 extended-keys-format 当前为 xterm。建议在 ~/.tmux.conf 中加入 `set -g extended-keys-format csi-u` 后重启 tmux。";
		}

		return undefined;
	}

	/**
	 * Get changelog entries to display on startup.
	 * Only shows new entries since last seen version, skips for resumed sessions.
	 */
	private getChangelogForDisplay(): string | undefined {
		// Skip changelog for resumed/continued sessions (already have messages)
		if (this.session.state.messages.length > 0) {
			return undefined;
		}

		const lastVersion = this.settingsManager.getLastChangelogVersion();
		const changelogPath = getChangelogPath();
		const entries = parseChangelog(changelogPath);

		if (!lastVersion) {
			// Fresh install - record the version, send telemetry, don't show changelog
			this.settingsManager.setLastChangelogVersion(VERSION);
			this.reportInstallTelemetry(VERSION);
			return undefined;
		}

		const newEntries = getNewEntries(entries, lastVersion);
		if (newEntries.length > 0) {
			this.settingsManager.setLastChangelogVersion(VERSION);
			this.reportInstallTelemetry(VERSION);
			return newEntries.map((e) => normalizeChangelogLinks(e.content, e)).join("\n\n");
		}

		return undefined;
	}

	private reportInstallTelemetry(version: string): void {
		if (process.env.PI_OFFLINE) {
			return;
		}

		if (!isInstallTelemetryEnabled(this.settingsManager)) {
			return;
		}

		void fetch(`https://pi.dev/api/report-install?version=${encodeURIComponent(version)}`, {
			headers: {
				"User-Agent": getPiUserAgent(version),
			},
			signal: AbortSignal.timeout(5000),
		})
			.then(() => undefined)
			.catch(() => undefined);
	}

	private getMarkdownThemeWithSettings(): MarkdownTheme {
		return {
			...getMarkdownTheme(),
			codeBlockIndent: this.settingsManager.getCodeBlockIndent(),
			showCodeBlockFences: this.settingsManager.getShowMarkdownCodeBlockFences(),
		};
	}

	// =========================================================================
	// Extension System
	// =========================================================================

	private formatDisplayPath(p: string): string {
		const home = os.homedir();
		let result = p;

		// Replace home directory with ~
		if (result.startsWith(home)) {
			result = `~${result.slice(home.length)}`;
		}

		return result;
	}

	private formatExtensionDisplayPath(path: string): string {
		let result = this.formatDisplayPath(path);
		result = result.replace(/\/index\.ts$/, "").replace(/\/index\.js$/, "");
		return result;
	}

	private formatContextPath(p: string): string {
		const cwd = path.resolve(this.sessionManager.getCwd());
		const absolutePath = path.isAbsolute(p) ? path.resolve(p) : path.resolve(cwd, p);
		const relativePath = getCwdRelativePath(absolutePath, cwd);
		if (relativePath !== undefined) {
			return relativePath;
		}

		return this.formatDisplayPath(absolutePath);
	}

	private getStartupExpansionState(): boolean {
		return this.options.verbose || this.toolOutputExpanded;
	}

	/**
	 * Get a short path relative to the package root for display.
	 */
	private getShortPath(fullPath: string, sourceInfo?: SourceInfo): string {
		const normalizedFullPath = fullPath.replace(/\\/g, "/");
		const baseDir = sourceInfo?.baseDir;
		if (baseDir && this.isPackageSource(sourceInfo)) {
			const normalizedBaseDir = baseDir.replace(/\\/g, "/");
			const npmRootMatch = normalizedBaseDir.match(/^(.*\/node_modules)\/(@?[^/]+(?:\/[^/]+)?)$/);
			// If fullPath is under the same node_modules root as baseDir, preserve that relative topology.
			if (npmRootMatch?.[1] && normalizedFullPath.startsWith(`${npmRootMatch[1]}/`)) {
				return path.posix.relative(normalizedBaseDir, normalizedFullPath);
			}

			const relativePath = path.relative(path.resolve(baseDir), path.resolve(fullPath));
			if (
				relativePath &&
				relativePath !== "." &&
				!relativePath.startsWith("..") &&
				!relativePath.startsWith(`..${path.sep}`) &&
				!path.isAbsolute(relativePath)
			) {
				return relativePath.replace(/\\/g, "/");
			}
		}

		const source = sourceInfo?.source ?? "";
		const npmMatch = normalizedFullPath.match(/node_modules\/(@?[^/]+(?:\/[^/]+)?)\/(.*)/);
		if (npmMatch && source.startsWith("npm:")) {
			return npmMatch[2];
		}

		const gitMatch = normalizedFullPath.match(/git\/[^/]+\/[^/]+\/(.*)/);
		if (gitMatch && source.startsWith("git:")) {
			return gitMatch[1];
		}

		return this.formatDisplayPath(fullPath);
	}

	private getCompactPathLabel(resourcePath: string, sourceInfo?: SourceInfo): string {
		const shortPath = this.getShortPath(resourcePath, sourceInfo);
		const normalizedPath = shortPath.replace(/\\/g, "/");
		const segments = normalizedPath.split("/").filter((segment) => segment.length > 0 && segment !== "~");
		if (segments.length > 0) {
			return segments[segments.length - 1]!;
		}
		return shortPath;
	}

	private getCompactPackageSourceLabel(sourceInfo?: SourceInfo): string {
		const source = sourceInfo?.source ?? "";
		if (source.startsWith("npm:")) {
			return source.slice("npm:".length) || source;
		}

		const gitSource = parseGitUrl(source);
		if (gitSource) {
			return gitSource.path || source;
		}

		return source;
	}

	private getCompactExtensionLabel(resourcePath: string, sourceInfo?: SourceInfo): string {
		if (!this.isPackageSource(sourceInfo)) {
			return this.getCompactPathLabel(resourcePath, sourceInfo);
		}

		const sourceLabel = this.getCompactPackageSourceLabel(sourceInfo);
		if (!sourceLabel) {
			return this.getCompactPathLabel(resourcePath, sourceInfo);
		}

		const shortPath = this.getShortPath(resourcePath, sourceInfo).replace(/\\/g, "/");
		const packagePath = shortPath.startsWith("extensions/") ? shortPath.slice("extensions/".length) : shortPath;
		const parsedPath = path.posix.parse(packagePath);

		if (parsedPath.name === "index") {
			return !parsedPath.dir || parsedPath.dir === "." ? sourceLabel : `${sourceLabel}:${parsedPath.dir}`;
		}

		return `${sourceLabel}:${packagePath}`;
	}

	private getCompactDisplayPathSegments(resourcePath: string): string[] {
		return this.formatDisplayPath(resourcePath)
			.replace(/\\/g, "/")
			.split("/")
			.filter((segment) => segment.length > 0 && segment !== "~");
	}

	private getCompactNonPackageExtensionLabel(
		resourcePath: string,
		index: number,
		allPaths: Array<{ path: string; segments: string[] }>,
	): string {
		const segments = allPaths[index]?.segments;
		if (!segments || segments.length === 0) {
			return this.getCompactPathLabel(resourcePath);
		}

		for (let segmentCount = 1; segmentCount <= segments.length; segmentCount += 1) {
			const candidate = segments.slice(-segmentCount).join("/");
			const isUnique = allPaths.every((item, itemIndex) => {
				if (itemIndex === index) {
					return true;
				}
				return item.segments.slice(-segmentCount).join("/") !== candidate;
			});

			if (isUnique) {
				return candidate;
			}
		}

		return segments.join("/");
	}

	private getCompactExtensionLabels(extensions: Array<{ path: string; sourceInfo?: SourceInfo }>): string[] {
		const nonPackageExtensions = extensions
			.map((extension) => {
				const segments = this.getCompactDisplayPathSegments(extension.path);
				const lastSegment = segments[segments.length - 1];
				if (segments.length > 1 && (lastSegment === "index.ts" || lastSegment === "index.js")) {
					segments.pop();
				}
				return {
					path: extension.path,
					sourceInfo: extension.sourceInfo,
					segments,
				};
			})
			.filter((extension) => !this.isPackageSource(extension.sourceInfo));

		return extensions.map((extension) => {
			if (this.isPackageSource(extension.sourceInfo)) {
				return this.getCompactExtensionLabel(extension.path, extension.sourceInfo);
			}

			const nonPackageIndex = nonPackageExtensions.findIndex((item) => item.path === extension.path);
			if (nonPackageIndex === -1) {
				return this.getCompactPathLabel(extension.path, extension.sourceInfo);
			}

			return this.getCompactNonPackageExtensionLabel(extension.path, nonPackageIndex, nonPackageExtensions);
		});
	}

	private getDisplaySourceInfo(sourceInfo?: SourceInfo): {
		label: string;
		scopeLabel?: string;
		color: "accent" | "muted";
	} {
		const source = sourceInfo?.source ?? "local";
		const scope = sourceInfo?.scope ?? "project";
		if (source === "local") {
			if (scope === "user") {
				return { label: "用户", color: "muted" };
			}
			if (scope === "project") {
				return { label: "项目", color: "muted" };
			}
			if (scope === "temporary") {
				return { label: "路径", scopeLabel: "临时", color: "muted" };
			}
			return { label: "路径", color: "muted" };
		}

		if (source === "cli") {
			return { label: "路径", scopeLabel: scope === "temporary" ? "临时" : undefined, color: "muted" };
		}

		const scopeLabel =
			scope === "user" ? "用户" : scope === "project" ? "项目" : scope === "temporary" ? "临时" : undefined;
		return { label: source, scopeLabel, color: "accent" };
	}

	private getScopeGroup(sourceInfo?: SourceInfo): "user" | "project" | "path" {
		const source = sourceInfo?.source ?? "local";
		const scope = sourceInfo?.scope ?? "project";
		if (source === "cli" || scope === "temporary") return "path";
		if (scope === "user") return "user";
		if (scope === "project") return "project";
		return "path";
	}

	private isPackageSource(sourceInfo?: SourceInfo): boolean {
		const source = sourceInfo?.source ?? "";
		return source.startsWith("npm:") || source.startsWith("git:");
	}

	private buildScopeGroups(items: Array<{ path: string; sourceInfo?: SourceInfo }>): Array<{
		scope: "user" | "project" | "path";
		paths: Array<{ path: string; sourceInfo?: SourceInfo }>;
		packages: Map<string, Array<{ path: string; sourceInfo?: SourceInfo }>>;
	}> {
		const groups: Record<
			"user" | "project" | "path",
			{
				scope: "user" | "project" | "path";
				paths: Array<{ path: string; sourceInfo?: SourceInfo }>;
				packages: Map<string, Array<{ path: string; sourceInfo?: SourceInfo }>>;
			}
		> = {
			user: { scope: "user", paths: [], packages: new Map() },
			project: { scope: "project", paths: [], packages: new Map() },
			path: { scope: "path", paths: [], packages: new Map() },
		};

		for (const item of items) {
			const groupKey = this.getScopeGroup(item.sourceInfo);
			const group = groups[groupKey];
			const source = item.sourceInfo?.source ?? "local";

			if (this.isPackageSource(item.sourceInfo)) {
				const list = group.packages.get(source) ?? [];
				list.push(item);
				group.packages.set(source, list);
			} else {
				group.paths.push(item);
			}
		}

		return [groups.project, groups.user, groups.path].filter(
			(group) => group.paths.length > 0 || group.packages.size > 0,
		);
	}

	private formatScopeGroups(
		groups: Array<{
			scope: "user" | "project" | "path";
			paths: Array<{ path: string; sourceInfo?: SourceInfo }>;
			packages: Map<string, Array<{ path: string; sourceInfo?: SourceInfo }>>;
		}>,
		options: {
			formatPath: (item: { path: string; sourceInfo?: SourceInfo }) => string;
			formatPackagePath: (item: { path: string; sourceInfo?: SourceInfo }, source: string) => string;
		},
	): string {
		const lines: string[] = [];

		for (const group of groups) {
			const scopeLabel = group.scope === "user" ? "用户" : group.scope === "project" ? "项目" : "路径";
			lines.push(`  ${theme.fg("accent", scopeLabel)}`);

			const sortedPaths = [...group.paths].sort((a, b) => a.path.localeCompare(b.path));
			for (const item of sortedPaths) {
				lines.push(theme.fg("dim", `    ${options.formatPath(item)}`));
			}

			const sortedPackages = Array.from(group.packages.entries()).sort(([a], [b]) => a.localeCompare(b));
			for (const [source, items] of sortedPackages) {
				lines.push(`    ${theme.fg("mdLink", source)}`);
				const sortedPackagePaths = [...items].sort((a, b) => a.path.localeCompare(b.path));
				for (const item of sortedPackagePaths) {
					lines.push(theme.fg("dim", `      ${options.formatPackagePath(item, source)}`));
				}
			}
		}

		return lines.join("\n");
	}

	private findSourceInfoForPath(p: string, sourceInfos: Map<string, SourceInfo>): SourceInfo | undefined {
		const exact = sourceInfos.get(p);
		if (exact) return exact;

		let current = p;
		while (current.includes("/")) {
			current = current.substring(0, current.lastIndexOf("/"));
			const parent = sourceInfos.get(current);
			if (parent) return parent;
		}

		return undefined;
	}

	private formatPathWithSource(p: string, sourceInfo?: SourceInfo): string {
		if (sourceInfo) {
			const shortPath = this.getShortPath(p, sourceInfo);
			const { label, scopeLabel } = this.getDisplaySourceInfo(sourceInfo);
			const labelText = scopeLabel ? `${label} (${scopeLabel})` : label;
			return `${labelText} ${shortPath}`;
		}
		return this.formatDisplayPath(p);
	}

	private formatDiagnostics(diagnostics: readonly ResourceDiagnostic[], sourceInfos: Map<string, SourceInfo>): string {
		const lines: string[] = [];

		// Group collision diagnostics by name
		const collisions = new Map<string, ResourceDiagnostic[]>();
		const otherDiagnostics: ResourceDiagnostic[] = [];

		for (const d of diagnostics) {
			if (d.type === "collision" && d.collision) {
				const list = collisions.get(d.collision.name) ?? [];
				list.push(d);
				collisions.set(d.collision.name, list);
			} else {
				otherDiagnostics.push(d);
			}
		}

		// Format collision diagnostics grouped by name
		for (const [name, collisionList] of collisions) {
			const first = collisionList[0]?.collision;
			if (!first) continue;
			lines.push(theme.fg("warning", `  “${name}”存在冲突：`));
			lines.push(
				theme.fg(
					"dim",
					`    ${theme.fg("success", uiGlyphs.success)} ${this.formatPathWithSource(first.winnerPath, this.findSourceInfoForPath(first.winnerPath, sourceInfos))}`,
				),
			);
			for (const d of collisionList) {
				if (d.collision) {
					lines.push(
						theme.fg(
							"dim",
							`    ${theme.fg("warning", uiGlyphs.failure)} ${this.formatPathWithSource(d.collision.loserPath, this.findSourceInfoForPath(d.collision.loserPath, sourceInfos))}（已跳过）`,
						),
					);
				}
			}
		}

		for (const d of otherDiagnostics) {
			if (d.path) {
				const formattedPath = this.formatPathWithSource(d.path, this.findSourceInfoForPath(d.path, sourceInfos));
				lines.push(theme.fg(d.type === "error" ? "error" : "warning", `  ${formattedPath}`));
				lines.push(theme.fg(d.type === "error" ? "error" : "warning", `    ${d.message}`));
			} else {
				lines.push(theme.fg(d.type === "error" ? "error" : "warning", `  ${d.message}`));
			}
		}

		return lines.join("\n");
	}

	private showLoadedResources(options?: {
		extensions?: Array<{ path: string; sourceInfo?: SourceInfo }>;
		force?: boolean;
		showDiagnosticsWhenQuiet?: boolean;
		summary?: boolean;
	}): void {
		// Resource rendering is idempotent; chat clears no longer clear this separate container.
		this.loadedResourcesContainer.clear();

		const showListing = options?.force || this.options.verbose || !this.settingsManager.getQuietStartup();
		const showDiagnostics = showListing || options?.showDiagnosticsWhenQuiet === true;
		if (!showListing && !showDiagnostics) {
			return;
		}

		const sectionHeader = (name: string, color: ThemeColor = "mdHeading") => theme.fg(color, `[${name}]`);
		const formatCompactList = (items: string[], options?: { sort?: boolean }): string => {
			const labels = items.map((item) => item.trim()).filter((item) => item.length > 0);
			if (options?.sort !== false) {
				labels.sort((a, b) => a.localeCompare(b));
			}
			return theme.fg("dim", `  ${labels.join(", ")}`);
		};
		const addLoadedSection = (
			name: string,
			collapsedBody: string,
			expandedBody = collapsedBody,
			color: ThemeColor = "mdHeading",
		): void => {
			const section = new ExpandableText(
				() => `${sectionHeader(name, color)}\n${collapsedBody}`,
				() => `${sectionHeader(name, color)}\n${expandedBody}`,
				this.getStartupExpansionState(),
				0,
				0,
			);
			this.loadedResourcesContainer.addChild(section);
			this.loadedResourcesContainer.addChild(new Spacer(1));
		};

		const skillsResult = this.session.resourceLoader.getSkills();
		const promptsResult = this.session.resourceLoader.getPrompts();
		const themesResult = this.session.resourceLoader.getThemes();
		const extensions =
			options?.extensions ??
			this.session.resourceLoader
				.getExtensions()
				.extensions.filter((extension) => !extension.hidden)
				.map((extension) => ({
					path: extension.path,
					sourceInfo: extension.sourceInfo,
				}));
		const sourceInfos = new Map<string, SourceInfo>();
		for (const extension of extensions) {
			if (extension.sourceInfo) {
				sourceInfos.set(extension.path, extension.sourceInfo);
			}
		}
		for (const skill of skillsResult.skills) {
			if (skill.sourceInfo) {
				sourceInfos.set(skill.filePath, skill.sourceInfo);
			}
		}
		for (const prompt of promptsResult.prompts) {
			if (prompt.sourceInfo) {
				sourceInfos.set(prompt.filePath, prompt.sourceInfo);
			}
		}
		for (const loadedTheme of themesResult.themes) {
			if (loadedTheme.sourcePath && loadedTheme.sourceInfo) {
				sourceInfos.set(loadedTheme.sourcePath, loadedTheme.sourceInfo);
			}
		}

		if (showListing && options?.summary && !this.options.verbose) {
			const systemPromptSource = this.session.resourceLoader.getSystemPromptSource();
			const contextCount =
				(systemPromptSource ? 1 : 0) +
				this.session.resourceLoader.getAppendSystemPromptSources().length +
				this.session.resourceLoader.getAgentsFiles().agentsFiles.length;
			const customThemeCount = themesResult.themes.filter((loadedTheme) => loadedTheme.sourcePath).length;
			const parts = [
				contextCount > 0 ? `${contextCount} 个上下文` : undefined,
				skillsResult.skills.length > 0 ? `${skillsResult.skills.length} 个 Skill` : undefined,
				this.session.promptTemplates.length > 0 ? `${this.session.promptTemplates.length} 个 Prompt` : undefined,
				extensions.length > 0 ? `${extensions.length} 个 Extension` : undefined,
				customThemeCount > 0 ? `${customThemeCount} 个主题` : undefined,
			].filter((part): part is string => Boolean(part));
			if (parts.length > 0) {
				this.loadedResourcesContainer.addChild(
					new TruncatedText(theme.fg("dim", `已加载 ${parts.join(" · ")}`), 0, 0),
				);
				this.loadedResourcesContainer.addChild(new Spacer(1));
			}
		} else if (showListing) {
			const systemPromptSource = this.session.resourceLoader.getSystemPromptSource();
			const contextFiles = [
				...(systemPromptSource ? [systemPromptSource] : []),
				...this.session.resourceLoader.getAppendSystemPromptSources(),
				...this.session.resourceLoader.getAgentsFiles().agentsFiles,
			];
			if (contextFiles.length > 0) {
				this.loadedResourcesContainer.addChild(new Spacer(1));
				const contextList = contextFiles
					.map((f) => theme.fg("dim", `  ${this.formatDisplayPath(f.path)}`))
					.join("\n");
				const contextCompactList = formatCompactList(
					contextFiles.map((contextFile) => this.formatContextPath(contextFile.path)),
					{ sort: false },
				);
				addLoadedSection("上下文", contextCompactList, contextList);
			}

			const skills = skillsResult.skills;
			if (skills.length > 0) {
				const groups = this.buildScopeGroups(
					skills.map((skill) => ({ path: skill.filePath, sourceInfo: skill.sourceInfo })),
				);
				const skillList = this.formatScopeGroups(groups, {
					formatPath: (item) => this.formatDisplayPath(item.path),
					formatPackagePath: (item) => this.getShortPath(item.path, item.sourceInfo),
				});
				const skillCompactList = formatCompactList(skills.map((skill) => skill.name));
				addLoadedSection("Skill", skillCompactList, skillList);
			}

			const templates = this.session.promptTemplates;
			if (templates.length > 0) {
				const groups = this.buildScopeGroups(
					templates.map((template) => ({ path: template.filePath, sourceInfo: template.sourceInfo })),
				);
				const templateByPath = new Map(templates.map((t) => [t.filePath, t]));
				const templateList = this.formatScopeGroups(groups, {
					formatPath: (item) => {
						const template = templateByPath.get(item.path);
						return template ? `/${template.name}` : this.formatDisplayPath(item.path);
					},
					formatPackagePath: (item) => {
						const template = templateByPath.get(item.path);
						return template ? `/${template.name}` : this.formatDisplayPath(item.path);
					},
				});
				const promptCompactList = formatCompactList(templates.map((template) => `/${template.name}`));
				addLoadedSection("Prompt", promptCompactList, templateList);
			}

			if (extensions.length > 0) {
				const groups = this.buildScopeGroups(extensions);
				const extList = this.formatScopeGroups(groups, {
					formatPath: (item) => this.formatExtensionDisplayPath(item.path),
					formatPackagePath: (item) =>
						this.formatExtensionDisplayPath(this.getShortPath(item.path, item.sourceInfo)),
				});
				const extensionCompactList = formatCompactList(this.getCompactExtensionLabels(extensions));
				addLoadedSection("Extension", extensionCompactList, extList, "mdHeading");
			}

			// Show loaded themes (excluding built-in)
			const loadedThemes = themesResult.themes;
			const customThemes = loadedThemes.filter((t) => t.sourcePath);
			if (customThemes.length > 0) {
				const groups = this.buildScopeGroups(
					customThemes.map((loadedTheme) => ({
						path: loadedTheme.sourcePath!,
						sourceInfo: loadedTheme.sourceInfo,
					})),
				);
				const themeList = this.formatScopeGroups(groups, {
					formatPath: (item) => this.formatDisplayPath(item.path),
					formatPackagePath: (item) => this.getShortPath(item.path, item.sourceInfo),
				});
				const themeCompactList = formatCompactList(
					customThemes.map(
						(loadedTheme) =>
							loadedTheme.name ?? this.getCompactPathLabel(loadedTheme.sourcePath!, loadedTheme.sourceInfo),
					),
				);
				addLoadedSection("主题", themeCompactList, themeList);
			}
		}

		if (showDiagnostics) {
			const skillDiagnostics = skillsResult.diagnostics;
			if (skillDiagnostics.length > 0) {
				const warningLines = this.formatDiagnostics(skillDiagnostics, sourceInfos);
				this.loadedResourcesContainer.addChild(
					new Text(`${theme.fg("warning", "[Skill 冲突]")}\n${warningLines}`, 0, 0),
				);
				this.loadedResourcesContainer.addChild(new Spacer(1));
			}

			const promptDiagnostics = promptsResult.diagnostics;
			if (promptDiagnostics.length > 0) {
				const warningLines = this.formatDiagnostics(promptDiagnostics, sourceInfos);
				this.loadedResourcesContainer.addChild(
					new Text(`${theme.fg("warning", "[Prompt 冲突]")}\n${warningLines}`, 0, 0),
				);
				this.loadedResourcesContainer.addChild(new Spacer(1));
			}

			const extensionDiagnostics: ResourceDiagnostic[] = [];
			const extensionErrors = this.session.resourceLoader.getExtensions().errors;
			if (extensionErrors.length > 0) {
				for (const error of extensionErrors) {
					extensionDiagnostics.push({ type: "error", message: error.error, path: error.path });
				}
			}

			const commandDiagnostics = this.session.extensionRunner.getCommandDiagnostics();
			extensionDiagnostics.push(...commandDiagnostics);
			extensionDiagnostics.push(...this.getBuiltInCommandConflictDiagnostics(this.session.extensionRunner));

			const shortcutDiagnostics = this.session.extensionRunner.getShortcutDiagnostics();
			extensionDiagnostics.push(...shortcutDiagnostics);

			if (extensionDiagnostics.length > 0) {
				const warningLines = this.formatDiagnostics(extensionDiagnostics, sourceInfos);
				this.loadedResourcesContainer.addChild(
					new Text(`${theme.fg("warning", "[Extension 问题]")}\n${warningLines}`, 0, 0),
				);
				this.loadedResourcesContainer.addChild(new Spacer(1));
			}

			const themeDiagnostics = themesResult.diagnostics;
			if (themeDiagnostics.length > 0) {
				const warningLines = this.formatDiagnostics(themeDiagnostics, sourceInfos);
				this.loadedResourcesContainer.addChild(
					new Text(`${theme.fg("warning", "[主题冲突]")}\n${warningLines}`, 0, 0),
				);
				this.loadedResourcesContainer.addChild(new Spacer(1));
			}
		}
	}

	/**
	 * Initialize the extension system with TUI-based UI context.
	 */
	private async bindCurrentSessionExtensions(): Promise<void> {
		const uiContext = this.createExtensionUIContext();
		await this.session.bindExtensions({
			uiContext,
			mode: "tui",
			abortHandler: () => {
				this.restoreQueuedMessagesToEditor({ abort: true });
			},
			commandContextActions: {
				waitForIdle: () => this.session.waitForIdle(),
				newSession: async (options) => {
					this.clearStatusIndicator();
					try {
						return await this.runtimeHost.newSession(options);
					} catch (error: unknown) {
						return this.handleFatalRuntimeError("新建会话失败", error);
					}
				},
				fork: async (entryId, options) => {
					try {
						const result = await this.runtimeHost.fork(entryId, options);
						if (!result.cancelled) {
							this.editor.setText(result.selectedText ?? "");
							this.showStatus("已创建分支会话");
						}
						return { cancelled: result.cancelled };
					} catch (error: unknown) {
						return this.handleFatalRuntimeError("创建分支会话失败", error);
					}
				},
				navigateTree: async (targetId, options) => {
					const result = await this.session.navigateTree(targetId, {
						summarize: options?.summarize,
						customInstructions: options?.customInstructions,
						replaceInstructions: options?.replaceInstructions,
						label: options?.label,
					});
					if (result.cancelled) {
						return { cancelled: true };
					}

					this.workspace.resetScrollback();
					this.chatContainer.clear();
					this.renderInitialMessages();
					if (result.editorText && !this.editor.getText().trim()) {
						this.editor.setText(result.editorText);
					}
					this.showStatus("已切换到所选位置");
					void this.flushCompactionQueue({ willRetry: false });
					return { cancelled: false };
				},
				switchSession: async (sessionPath, options) => {
					return this.handleResumeSession(sessionPath, options);
				},
				reload: async () => {
					await this.handleReloadCommand();
				},
			},
			shutdownHandler: () => {
				this.shutdownRequested = true;
				if (this.session.isIdle) {
					void this.shutdown();
				}
			},
			onError: (error) => {
				this.showExtensionError(error.extensionPath, error.error, error.stack);
			},
		});

		setRegisteredThemes(this.session.resourceLoader.getThemes().themes);
		this.setupAutocompleteProvider();

		const extensionRunner = this.session.extensionRunner;
		this.setupExtensionShortcuts(extensionRunner);
		this.showLoadedResources({ force: false, showDiagnosticsWhenQuiet: true, summary: true });
		this.showStartupNoticesIfNeeded();
	}

	private getEffectiveEditorPaddingX(): number {
		const configured = this.settingsManager.getEditorPaddingX();
		return this.workspace?.isFullscreen() ? Math.max(2, configured) : configured;
	}

	private applyFullscreenScrollbarSetting(): void {
		this.workspace.setScrollbar(this.settingsManager.getFullscreenScrollbar());
		this.ui.requestRender();
	}

	private applyRuntimeSettings(): void {
		configureHttpDispatcher(this.settingsManager.getHttpIdleTimeoutMs());
		this.applyFullscreenScrollbarSetting();
		this.footer.setSession(this.session);
		this.footerDataProvider.setCwd(this.sessionManager.getCwd());
		this.hideThinkingBlock = this.settingsManager.getHideThinkingBlock();
		this.thinkingDisplayMode = this.settingsManager.getThinkingDisplayMode();
		this.outputPad = this.settingsManager.getOutputPad();
		this.ui.setShowHardwareCursor(this.settingsManager.getShowHardwareCursor());
		const clearOnShrink = this.settingsManager.getClearOnShrink();
		this.ui.setClearOnShrink(clearOnShrink);
		if (!clearOnShrink && !this.activeStatusIndicator) {
			this.statusContainer.clear();
		}
		const editorPaddingX = this.getEffectiveEditorPaddingX();
		const autocompleteMaxVisible = this.settingsManager.getAutocompleteMaxVisible();
		this.defaultEditor.setPaddingX(editorPaddingX);
		this.defaultEditor.setAutocompleteMaxVisible(autocompleteMaxVisible);
		if (this.editor !== this.defaultEditor) {
			this.editor.setPaddingX?.(editorPaddingX);
			this.editor.setAutocompleteMaxVisible?.(autocompleteMaxVisible);
		}
	}

	private async rebindCurrentSession(options: { renderBeforeBind?: boolean } = {}): Promise<void> {
		const session = this.session;

		this.unsubscribe?.();
		this.unsubscribe = undefined;
		this.applyRuntimeSettings();

		if (options.renderBeforeBind) {
			this.renderCurrentSessionState();
			this.subscribeToAgent();
		}

		await this.bindCurrentSessionExtensions();

		if (this.session !== session) {
			return;
		}

		if (!options.renderBeforeBind) {
			this.subscribeToAgent();
		}

		await this.updateAvailableProviderCount();
		this.updateEditorBorderColor();
		this.updateTerminalTitle();
		if (typeof this.ensureGuiCompanion === "function") await this.ensureGuiCompanion({ force: true });
	}

	private ensureGuiCompanion(options: { force?: boolean } = {}): Promise<boolean> {
		const coordination = getGuiCompanionCoordinationState(this);
		const targetSession = this.session;
		const targetSessionPath = this.sessionManager.getSessionFile();
		const task = coordination.ensureQueue.then(() =>
			this.ensureGuiCompanionNow(targetSession, targetSessionPath, coordination, options.force === true),
		);
		coordination.ensureQueue = task.then(
			() => undefined,
			() => undefined,
		);
		return task;
	}

	private async ensureGuiCompanionNow(
		targetSession: AgentSession,
		targetSessionPath: string | undefined,
		coordination: GuiCompanionCoordinationState,
		force: boolean,
	): Promise<boolean> {
		const isCurrentTarget = () =>
			!this.isShuttingDown &&
			this.session === targetSession &&
			this.sessionManager.getSessionFile() === targetSessionPath;

		if (!isCurrentTarget()) return false;
		if (!targetSessionPath || !fs.existsSync(targetSessionPath)) {
			await this.guiCompanion?.dispose();
			this.guiCompanion = undefined;
			this.guiCompanionSessionPath = undefined;
			coordination.warningKey = undefined;
			coordination.failedSessionPath = undefined;
			return false;
		}
		if (!force && coordination.failedSessionPath === targetSessionPath) return false;
		if (this.guiCompanion && this.guiCompanionSessionPath === targetSessionPath) return true;

		await this.guiCompanion?.dispose();
		this.guiCompanion = undefined;
		this.guiCompanionSessionPath = undefined;
		if (!isCurrentTarget()) return false;

		const companion = new GuiCompanionServer(targetSession, getAgentDir());
		try {
			await companion.start();
			if (!isCurrentTarget()) {
				await companion.dispose();
				return false;
			}
			this.guiCompanion = companion;
			this.guiCompanionSessionPath = targetSessionPath;
			coordination.warningKey = undefined;
			coordination.failedSessionPath = undefined;
			return true;
		} catch (error) {
			await companion.dispose().catch(() => {});
			if (!isCurrentTarget()) return false;
			const message = error instanceof Error ? error.message : String(error);
			coordination.failedSessionPath = targetSessionPath;
			const warningKey = `${targetSessionPath}\0${message}`;
			if (coordination.warningKey !== warningKey) {
				this.showWarning(`GUI 共享通道启动失败：${message}`);
				coordination.warningKey = warningKey;
			}
			return false;
		}
	}

	private async handleFatalRuntimeError(prefix: string, error: unknown): Promise<never> {
		const message = error instanceof Error ? error.message : String(error);
		this.showError(`${prefix}: ${message}`);
		stopThemeWatcher();
		this.stop("transcript");
		process.exit(1);
	}

	private renderCurrentSessionState(): void {
		this.headerContextUsageDirty = true;
		this.workspace.resetScrollback();
		this.loadedResourcesContainer.clear();
		this.chatContainer.clear();
		this.pendingMessagesContainer.clear();
		this.compactionQueuedMessages = [];
		this.streamingComponent = undefined;
		this.streamingMessage = undefined;
		this.pendingTools.clear();
		this.renderInitialMessages();
	}

	/**
	 * Get a registered tool definition by name (for custom rendering).
	 */
	private getRegisteredToolDefinition(toolName: string) {
		return this.session.getToolDefinition(toolName);
	}

	private getMarkdownTransformers(): MarkdownTransformer[] {
		return [this.mermaidMarkdownTransformer, ...this.session.extensionRunner.getMarkdownTransformers()];
	}

	/**
	 * Set up keyboard shortcuts registered by extensions.
	 */
	private setupExtensionShortcuts(extensionRunner: ExtensionRunner): void {
		const shortcuts = extensionRunner.getShortcuts(this.keybindings.getEffectiveConfig());
		if (shortcuts.size === 0) return;

		// Create a context for shortcut handlers
		const createContext = (): ExtensionContext => ({
			ui: this.createExtensionUIContext(),
			mode: "tui",
			hasUI: true,
			cwd: this.sessionManager.getCwd(),
			sessionManager: this.sessionManager,
			modelRegistry: extensionRunner.getModelRegistry(),
			model: this.session.model,
			scopedModels: this.session.scopedModels,
			thinkingLevel: this.session.thinkingLevel,
			isIdle: () => this.session.isIdle,
			isProjectTrusted: () => this.settingsManager.isProjectTrusted(),
			signal: this.session.agent.signal,
			abort: () => {
				this.restoreQueuedMessagesToEditor({ abort: true });
			},
			hasPendingMessages: () => this.session.pendingMessageCount > 0,
			shutdown: () => {
				this.shutdownRequested = true;
			},
			getContextUsage: () => this.session.getContextUsage(),
			compact: (options) => {
				void (async () => {
					try {
						const result = await this.session.compact(options?.customInstructions);
						options?.onComplete?.(result);
					} catch (error) {
						const err = error instanceof Error ? error : new Error(String(error));
						options?.onError?.(err);
					}
				})();
			},
			getSystemPrompt: () => this.session.systemPrompt,
		});

		// Set up the extension shortcut handler on the default editor
		this.defaultEditor.onExtensionShortcut = (data: string) => {
			for (const [shortcutStr, shortcut] of shortcuts) {
				// Cast to KeyId - extension shortcuts use the same format
				if (matchesKey(data, shortcutStr as KeyId)) {
					// Run handler async, don't block input
					Promise.resolve(shortcut.handler(createContext())).catch((err) => {
						this.showError(`快捷键处理失败：${err instanceof Error ? err.message : String(err)}`);
					});
					return true;
				}
			}
			return false;
		};
	}

	/**
	 * Set extension status text in the footer.
	 */
	private setExtensionStatus(key: string, text: string | undefined): void {
		this.footerDataProvider.setExtensionStatus(key, text);
		this.ui.requestRender();
	}

	private showStatusIndicator(indicator: StatusIndicator): void {
		this.activeStatusIndicator?.dispose();
		this.activeStatusIndicator = indicator;
		this.statusContainer.clear();
		this.statusContainer.addChild(indicator);
	}

	private clearStatusIndicator(kind?: StatusIndicator["kind"]): void {
		if (kind && this.activeStatusIndicator?.kind !== kind) {
			return;
		}
		const hadActiveStatusIndicator = this.activeStatusIndicator !== undefined;
		this.activeStatusIndicator?.dispose();
		this.activeStatusIndicator = undefined;
		this.statusContainer.clear();
		if (hadActiveStatusIndicator && this.options.tuiMode === "regular" && this.ui.getClearOnShrink()) {
			this.statusContainer.addChild(this.idleStatus);
		}
	}

	private setWorkingVisible(visible: boolean): void {
		this.workingVisible = visible;
		this.updateActivityBar();
		this.ui.requestRender();
	}

	private setWorkingIndicator(options?: WorkingIndicatorOptions): void {
		this.workingIndicatorOptions = options;
		this.updateActivityBar();
		this.ui.requestRender();
	}

	private setHiddenThinkingLabel(label?: string): void {
		this.hiddenThinkingLabel = label ?? this.defaultHiddenThinkingLabel;
		for (const child of this.chatContainer.children) {
			if (child instanceof AssistantMessageComponent) {
				child.setHiddenThinkingLabel(this.hiddenThinkingLabel);
			}
		}
		if (this.streamingComponent) {
			this.streamingComponent.setHiddenThinkingLabel(this.hiddenThinkingLabel);
		}
		this.ui.requestRender();
	}

	/**
	 * Set an extension widget (string array or custom component).
	 */
	private setExtensionWidget(
		key: string,
		content: string[] | ((tui: TUI, thm: Theme) => Component & { dispose?(): void }) | undefined,
		options?: ExtensionWidgetOptions,
	): void {
		const placement = options?.placement ?? "aboveEditor";
		const removeExisting = (map: Map<string, Component & { dispose?(): void }>) => {
			const existing = map.get(key);
			if (existing?.dispose) existing.dispose();
			map.delete(key);
		};

		removeExisting(this.extensionWidgetsAbove);
		removeExisting(this.extensionWidgetsBelow);

		if (content === undefined) {
			this.renderWidgets();
			return;
		}

		let component: Component & { dispose?(): void };

		if (Array.isArray(content)) {
			// Wrap string array in a Container with Text components
			const container = new Container();
			for (const line of content.slice(0, InteractiveMode.MAX_WIDGET_LINES)) {
				container.addChild(new Text(line, 1, 0));
			}
			if (content.length > InteractiveMode.MAX_WIDGET_LINES) {
				container.addChild(new Text(theme.fg("muted", "...（Widget 内容过长，已截断）"), 1, 0));
			}
			component = container;
		} else {
			// Factory function - create component
			component = content(this.ui, theme);
		}

		const targetMap = placement === "belowEditor" ? this.extensionWidgetsBelow : this.extensionWidgetsAbove;
		targetMap.set(key, component);
		this.renderWidgets();
	}

	private clearExtensionWidgets(): void {
		for (const widget of this.extensionWidgetsAbove.values()) {
			widget.dispose?.();
		}
		for (const widget of this.extensionWidgetsBelow.values()) {
			widget.dispose?.();
		}
		this.extensionWidgetsAbove.clear();
		this.extensionWidgetsBelow.clear();
		this.renderWidgets();
	}

	private resetExtensionUI(): void {
		if (this.extensionSelector) {
			this.hideExtensionSelector();
		}
		if (this.extensionInput) {
			this.hideExtensionInput();
		}
		if (this.extensionEditor) {
			this.hideExtensionEditor();
		}
		this.ui.hideOverlay();
		this.clearExtensionTerminalInputListeners();
		this.setExtensionFooter(undefined);
		this.setExtensionHeader(undefined);
		this.clearExtensionWidgets();
		this.footerDataProvider.clearExtensionStatuses();
		this.footer.invalidate();
		this.autocompleteProviderWrappers = [];
		this.setCustomEditorComponent(undefined);
		this.setupAutocompleteProvider();
		this.defaultEditor.onExtensionShortcut = undefined;
		this.updateTerminalTitle();
		this.workingMessage = undefined;
		this.workingVisible = true;
		this.setWorkingIndicator();
		this.updateActivityBar();
		this.setHiddenThinkingLabel();
	}

	// Maximum total widget lines to prevent viewport overflow
	private static readonly MAX_WIDGET_LINES = 10;

	/**
	 * Render all extension widgets to the widget container.
	 */
	private renderWidgets(): void {
		if (!this.widgetContainerAbove || !this.widgetContainerBelow) return;
		this.renderWidgetContainer(this.widgetContainerAbove, this.extensionWidgetsAbove, true, true);
		this.renderWidgetContainer(this.widgetContainerBelow, this.extensionWidgetsBelow, false, false);
		this.ui.requestRender();
	}

	private renderWidgetContainer(
		container: Container,
		widgets: Map<string, Component & { dispose?(): void }>,
		spacerWhenEmpty: boolean,
		leadingSpacer: boolean,
	): void {
		container.clear();

		if (widgets.size === 0) {
			if (spacerWhenEmpty) {
				container.addChild(new Spacer(1));
			}
			return;
		}

		if (leadingSpacer) {
			container.addChild(new Spacer(1));
		}
		for (const component of widgets.values()) {
			container.addChild(component);
		}
	}

	/**
	 * Set a custom footer component, or restore the built-in footer.
	 */
	private setExtensionFooter(
		factory:
			| ((tui: TUI, thm: Theme, footerData: ReadonlyFooterDataProvider) => Component & { dispose?(): void })
			| undefined,
	): void {
		// Dispose existing custom footer
		if (this.customFooter?.dispose) {
			this.customFooter.dispose();
		}

		this.footerContainer.clear();
		if (factory) {
			this.customFooter = factory(this.ui, theme, this.footerDataProvider);
			this.footerContainer.addChild(this.customFooter);
		} else {
			this.customFooter = undefined;
			this.footerContainer.addChild(this.footer);
		}

		this.ui.requestRender();
	}

	/**
	 * Set a custom header component, or restore the built-in header.
	 */
	private setExtensionHeader(factory: ((tui: TUI, thm: Theme) => Component & { dispose?(): void }) | undefined): void {
		// Header may not be initialized yet if called during early initialization
		if (!this.builtInHeader) {
			return;
		}

		// Dispose existing custom header
		if (this.customHeader?.dispose) {
			this.customHeader.dispose();
		}

		// Find the index of the current header in the header container
		const currentHeader = this.customHeader || this.builtInHeader;
		const index = this.headerContainer.children.indexOf(currentHeader);

		if (factory) {
			// Create and add custom header
			this.customHeader = factory(this.ui, theme);
			if (isExpandable(this.customHeader)) {
				this.customHeader.setExpanded(this.toolOutputExpanded);
			}
			if (index !== -1) {
				this.headerContainer.children[index] = this.customHeader;
			} else {
				// If not found (e.g. builtInHeader was never added), add at the top
				this.headerContainer.children.unshift(this.customHeader);
			}
		} else {
			// Restore built-in header
			this.customHeader = undefined;
			if (isExpandable(this.builtInHeader)) {
				this.builtInHeader.setExpanded(this.toolOutputExpanded);
			}
			if (index !== -1) {
				this.headerContainer.children[index] = this.builtInHeader;
			}
		}

		this.ui.requestRender();
	}

	private addExtensionTerminalInputListener(
		handler: (data: string) => { consume?: boolean; data?: string } | undefined,
	): () => void {
		const subscription = { handler, unsubscribe: this.ui.addInputListener(handler) };
		this.extensionTerminalInputSubscriptions.add(subscription);
		return () => {
			subscription.unsubscribe();
			this.extensionTerminalInputSubscriptions.delete(subscription);
		};
	}

	private rebindExtensionTerminalInputListeners(): void {
		for (const subscription of this.extensionTerminalInputSubscriptions) {
			subscription.unsubscribe();
			subscription.unsubscribe = this.ui.addInputListener(subscription.handler);
		}
	}

	private clearExtensionTerminalInputListeners(): void {
		for (const subscription of this.extensionTerminalInputSubscriptions) subscription.unsubscribe();
		this.extensionTerminalInputSubscriptions.clear();
	}

	/**
	 * Create the ExtensionUIContext for extensions.
	 */
	private createProjectTrustContext(cwd: string): ProjectTrustContext {
		const ui = this.createExtensionUIContext();
		return {
			cwd,
			mode: "tui",
			hasUI: true,
			ui: {
				select: ui.select,
				confirm: ui.confirm,
				input: ui.input,
				notify: ui.notify,
			},
		};
	}

	private createExtensionUIContext(): ExtensionUIContext {
		return {
			select: (title, options, opts) => this.showExtensionSelector(title, options, opts),
			confirm: (title, message, opts) => this.showExtensionConfirm(title, message, opts),
			input: (title, placeholder, opts) => this.showExtensionInput(title, placeholder, opts),
			notify: (message, type) => this.showExtensionNotify(message, type),
			onTerminalInput: (handler) => this.addExtensionTerminalInputListener(handler),
			setStatus: (key, text) => this.setExtensionStatus(key, text),
			setWorkingMessage: (message) => {
				this.workingMessage = message;
				this.updateActivityBar();
				this.ui.requestRender();
			},
			setWorkingVisible: (visible) => this.setWorkingVisible(visible),
			setWorkingIndicator: (options) => this.setWorkingIndicator(options),
			setHiddenThinkingLabel: (label) => this.setHiddenThinkingLabel(label),
			setWidget: (key, content, options) => this.setExtensionWidget(key, content, options),
			setFooter: (factory) => this.setExtensionFooter(factory),
			setHeader: (factory) => this.setExtensionHeader(factory),
			setTitle: (title) => this.ui.terminal.setTitle(title),
			custom: (factory, options) => this.showExtensionCustom(factory, options),
			pasteToEditor: (text) => this.editor.handleInput(`\x1b[200~${text}\x1b[201~`),
			setEditorText: (text) => this.editor.setText(text),
			getEditorText: () => this.editor.getExpandedText?.() ?? this.editor.getText(),
			editor: (title, prefill) => this.showExtensionEditor(title, prefill),
			addAutocompleteProvider: (factory) => {
				this.autocompleteProviderWrappers.push(factory);
				this.setupAutocompleteProvider();
			},
			setEditorComponent: (factory) => this.setCustomEditorComponent(factory),
			getEditorComponent: () => this.editorComponentFactory,
			get theme() {
				return theme;
			},
			getAllThemes: () => getAvailableThemesWithPaths(),
			getTheme: (name) => getThemeByName(name),
			setTheme: (themeOrName) => {
				if (themeOrName instanceof Theme) {
					return this.themeController.setThemeInstance(themeOrName);
				}
				const result = this.themeController.setThemeName(themeOrName);
				if (result.success) {
					if (this.settingsManager.getTheme() !== themeOrName) {
						this.settingsManager.setTheme(themeOrName);
					}
				}
				return result;
			},
			getToolsExpanded: () => this.toolOutputExpanded,
			setToolsExpanded: (expanded) => this.setToolsExpanded(expanded),
		};
	}

	/**
	 * Show a selector for extensions.
	 */
	private showExtensionSelector(
		title: string,
		options: string[],
		opts?: ExtensionUIDialogOptions,
	): Promise<string | undefined> {
		return new Promise((resolve) => {
			if (opts?.signal?.aborted) {
				resolve(undefined);
				return;
			}

			const onAbort = () => {
				this.hideExtensionSelector();
				resolve(undefined);
			};
			opts?.signal?.addEventListener("abort", onAbort, { once: true });

			this.extensionSelector = new ExtensionSelectorComponent(
				title,
				options,
				(option) => {
					opts?.signal?.removeEventListener("abort", onAbort);
					this.hideExtensionSelector();
					resolve(option);
				},
				() => {
					opts?.signal?.removeEventListener("abort", onAbort);
					this.hideExtensionSelector();
					resolve(undefined);
				},
				{ tui: this.ui, timeout: opts?.timeout, onToggleToolsExpanded: () => this.toggleToolOutputExpansion() },
			);

			this.disposeActiveSelector();
			this.editorContainer.clear();
			this.editorContainer.addChild(this.extensionSelector);
			this.ui.setFocus(this.extensionSelector);
			this.ui.requestRender();
		});
	}

	/**
	 * Hide the extension selector.
	 */
	private hideExtensionSelector(): void {
		this.extensionSelector?.dispose();
		this.editorContainer.clear();
		this.editorContainer.addChild(this.editor);
		this.extensionSelector = undefined;
		this.ui.setFocus(this.editor);
		this.ui.requestRender();
	}

	/**
	 * Show a confirmation dialog for extensions.
	 */
	private async showExtensionConfirm(
		title: string,
		message: string,
		opts?: ExtensionUIDialogOptions,
	): Promise<boolean> {
		const result = await this.showExtensionSelector(`${title}\n${message}`, ["是", "否"], opts);
		return result === "是";
	}

	private async promptForMissingSessionCwd(error: MissingSessionCwdError): Promise<string | undefined> {
		const confirmed = await this.showExtensionConfirm(
			"找不到会话工作目录",
			formatMissingSessionCwdPrompt(error.issue),
		);
		return confirmed ? error.issue.fallbackCwd : undefined;
	}

	/**
	 * Show a text input for extensions.
	 */
	private showExtensionInput(
		title: string,
		placeholder?: string,
		opts?: ExtensionUIDialogOptions,
	): Promise<string | undefined> {
		return new Promise((resolve) => {
			if (opts?.signal?.aborted) {
				resolve(undefined);
				return;
			}

			const onAbort = () => {
				this.hideExtensionInput();
				resolve(undefined);
			};
			opts?.signal?.addEventListener("abort", onAbort, { once: true });

			this.extensionInput = new ExtensionInputComponent(
				title,
				placeholder,
				(value) => {
					opts?.signal?.removeEventListener("abort", onAbort);
					this.hideExtensionInput();
					resolve(value);
				},
				() => {
					opts?.signal?.removeEventListener("abort", onAbort);
					this.hideExtensionInput();
					resolve(undefined);
				},
				{ tui: this.ui, timeout: opts?.timeout },
			);

			this.disposeActiveSelector();
			this.editorContainer.clear();
			this.editorContainer.addChild(this.extensionInput);
			this.ui.setFocus(this.extensionInput);
			this.ui.requestRender();
		});
	}

	/**
	 * Hide the extension input.
	 */
	private hideExtensionInput(): void {
		this.extensionInput?.dispose();
		this.editorContainer.clear();
		this.editorContainer.addChild(this.editor);
		this.extensionInput = undefined;
		this.ui.setFocus(this.editor);
		this.ui.requestRender();
	}

	/**
	 * Show a multi-line editor for extensions (with Ctrl+G support).
	 */
	private showExtensionEditor(title: string, prefill?: string): Promise<string | undefined> {
		return new Promise((resolve) => {
			this.extensionEditor = new ExtensionEditorComponent(
				this.ui,
				this.keybindings,
				title,
				prefill,
				(value) => {
					this.hideExtensionEditor();
					resolve(value);
				},
				() => {
					this.hideExtensionEditor();
					resolve(undefined);
				},
				undefined,
				this.settingsManager.getExternalEditorCommand(),
			);

			this.disposeActiveSelector();
			this.editorContainer.clear();
			this.editorContainer.addChild(this.extensionEditor);
			this.ui.setFocus(this.extensionEditor);
			this.ui.requestRender();
		});
	}

	/**
	 * Hide the extension editor.
	 */
	private hideExtensionEditor(): void {
		this.editorContainer.clear();
		this.editorContainer.addChild(this.editor);
		this.extensionEditor = undefined;
		this.ui.setFocus(this.editor);
		this.ui.requestRender();
	}

	/**
	 * Set a custom editor component from an extension.
	 * Pass undefined to restore the default editor.
	 */
	private setCustomEditorComponent(factory: EditorFactory | undefined): void {
		this.editorComponentFactory = factory;

		// Save text from current editor before switching
		const currentText = this.editor.getText();

		this.disposeActiveSelector();
		this.editorContainer.clear();

		if (factory) {
			// Create the custom editor with tui, theme, and keybindings
			const newEditor = factory(this.ui, getEditorTheme(), this.keybindings);

			// Wire up callbacks from the default editor
			newEditor.onSubmit = this.defaultEditor.onSubmit;
			newEditor.onChange = this.defaultEditor.onChange;

			// Copy text from previous editor
			newEditor.setText(currentText);

			// Copy appearance settings if supported
			if (newEditor.borderColor !== undefined) {
				newEditor.borderColor = this.defaultEditor.borderColor;
			}
			if (newEditor.setPaddingX !== undefined) {
				newEditor.setPaddingX(this.defaultEditor.getPaddingX());
			}
			if (newEditor.setAutocompleteMaxVisible !== undefined) {
				newEditor.setAutocompleteMaxVisible(this.defaultEditor.getAutocompleteMaxVisible());
			}

			// Set autocomplete if supported
			if (newEditor.setAutocompleteProvider && this.autocompleteProvider) {
				newEditor.setAutocompleteProvider(this.autocompleteProvider);
			}

			// If extending CustomEditor, copy app-level handlers
			// Use duck typing since instanceof fails across jiti module boundaries
			const customEditor = newEditor as unknown as Record<string, unknown>;
			if ("actionHandlers" in customEditor && customEditor.actionHandlers instanceof Map) {
				if (!customEditor.onEscape) {
					customEditor.onEscape = () => this.defaultEditor.onEscape?.();
				}
				if (!customEditor.onCtrlD) {
					customEditor.onCtrlD = () => this.defaultEditor.onCtrlD?.();
				}
				if (!customEditor.onPasteImage) {
					customEditor.onPasteImage = () => this.defaultEditor.onPasteImage?.();
				}
				if (!customEditor.onExtensionShortcut) {
					customEditor.onExtensionShortcut = (data: string) => this.defaultEditor.onExtensionShortcut?.(data);
				}
				// Copy action handlers (clear, suspend, model switching, etc.)
				for (const [action, handler] of this.defaultEditor.actionHandlers) {
					(customEditor.actionHandlers as Map<string, () => void>).set(action, handler);
				}
			}

			this.editor = newEditor;
		} else {
			// Restore default editor with text from custom editor
			this.defaultEditor.setText(currentText);
			this.editor = this.defaultEditor;
		}

		this.editorContainer.addChild(this.editor as Component);
		this.ui.setFocus(this.editor as Component);
		this.ui.requestRender();
	}

	/**
	 * Show a notification for extensions.
	 */
	private showExtensionNotify(message: string, type?: "info" | "warning" | "error"): void {
		if (type === "error") {
			this.showError(message);
		} else if (type === "warning") {
			this.showWarning(message);
		} else {
			this.showStatus(message);
		}
	}

	/** Show a custom component with keyboard focus. Overlay mode renders on top of existing content. */
	private async showExtensionCustom<T>(
		factory: (
			tui: TUI,
			theme: Theme,
			keybindings: KeybindingsManager,
			done: (result: T) => void,
		) => (Component & { dispose?(): void }) | Promise<Component & { dispose?(): void }>,
		options?: {
			overlay?: boolean;
			overlayOptions?: OverlayOptions | (() => OverlayOptions);
			onHandle?: (handle: OverlayHandle) => void;
		},
	): Promise<T> {
		const savedText = this.editor.getText();
		const isOverlay = options?.overlay ?? false;

		const restoreEditor = () => {
			this.editorContainer.clear();
			this.editorContainer.addChild(this.editor);
			this.editor.setText(savedText);
			this.ui.setFocus(this.editor);
			this.ui.requestRender();
		};

		return new Promise((resolve, reject) => {
			let component: Component & { dispose?(): void };
			let closed = false;

			const close = (result: T) => {
				if (closed) return;
				closed = true;
				if (isOverlay) this.ui.hideOverlay();
				else restoreEditor();
				// Note: both branches above already call requestRender
				resolve(result);
				try {
					component?.dispose?.();
				} catch {
					/* ignore dispose errors */
				}
			};

			Promise.resolve(factory(this.ui, theme, this.keybindings, close))
				.then((c) => {
					if (closed) return;
					component = c;
					if (isOverlay) {
						// Resolve overlay options - can be static or dynamic function
						const resolveOptions = (): OverlayOptions | undefined => {
							if (options?.overlayOptions) {
								const opts =
									typeof options.overlayOptions === "function"
										? options.overlayOptions()
										: options.overlayOptions;
								return opts;
							}
							// Fallback: use component's width property if available
							const w = (component as { width?: number }).width;
							return w ? { width: w } : undefined;
						};
						const handle = this.ui.showOverlay(component, resolveOptions());
						// Expose handle to caller for visibility control
						options?.onHandle?.(handle);
					} else {
						this.disposeActiveSelector();
						this.editorContainer.clear();
						this.editorContainer.addChild(component);
						this.ui.setFocus(component);
						this.ui.requestRender();
					}
				})
				.catch((err) => {
					if (closed) return;
					if (!isOverlay) restoreEditor();
					reject(err);
				});
		});
	}

	/**
	 * Show an extension error in the UI.
	 */
	private showExtensionError(extensionPath: string, error: string, stack?: string): void {
		const errorMsg = `Extension“${extensionPath}”执行失败：${error}`;
		const errorText = new Text(theme.fg("error", errorMsg), 1, 0);
		this.chatContainer.addChild(errorText);
		if (stack) {
			// Show stack trace in dim color, indented
			const stackLines = stack
				.split("\n")
				.slice(1) // Skip first line (duplicates error message)
				.map((line) => theme.fg("dim", `  ${line.trim()}`))
				.join("\n");
			if (stackLines) {
				this.chatContainer.addChild(new Text(stackLines, 1, 0));
			}
		}
		this.ui.requestRender();
	}

	// =========================================================================
	// Key Handlers
	// =========================================================================

	private setHoveredCard(card: InteractiveCard | undefined): boolean {
		const next = card?.setHovered ? card : undefined;
		if (this.hoveredCard === next) return false;
		this.hoveredCard?.setHovered?.(false);
		this.hoveredCard = next;
		this.hoveredCard?.setHovered?.(true);
		return true;
	}

	private updateHoveredCard(row: number): boolean {
		const hit = this.workspace.getComponentHitAtScreenRow(row);
		const action = hit ? resolveInteractiveCardAction(hit.component, hit.row) : undefined;
		return this.setHoveredCard(action?.type === "toggle" ? action.component : undefined);
	}

	private handleWorkspaceInput(data: string): { consume: true } | undefined {
		if (!this.workspace.isFullscreen() || this.renderer.hasOverlay()) return undefined;

		const mouse = parseMouseEvent(data);
		if (mouse) {
			if (mouse.shift) {
				this.pendingCardClick = undefined;
				if (this.setHoveredCard(undefined)) this.ui.requestRender();
				return undefined;
			}
			if (mouse.button === "wheel-up" || mouse.button === "wheel-down") {
				this.pendingCardClick = undefined;
				this.setHoveredCard(undefined);
				const lines = this.wheelScroll.getDelta(mouse.button === "wheel-up" ? -1 : 1);
				this.workspace.scrollBy(lines);
				if (lines < 0 && this.workspace.isAtTop()) void this.loadPreviousTranscriptPage();
			} else if (mouse.motion && mouse.button !== "left") {
				if (this.updateHoveredCard(mouse.row)) this.ui.requestRender();
				return undefined;
			} else if (mouse.button === "left" && mouse.motion) {
				this.pendingCardClick = undefined;
				this.setHoveredCard(undefined);
				return undefined;
			} else if (mouse.released && (mouse.button === "left" || mouse.button === "other")) {
				const pending = this.pendingCardClick;
				this.pendingCardClick = undefined;
				if (pending && pending.row === mouse.row && pending.column === mouse.column) {
					const action = activateInteractiveCard(pending.component, pending.componentRow, (target) =>
						this.openSubagentSession(target),
					);
					if (action?.type === "toggle") {
						this.rememberCardExpansion(action.component);
					}
					this.ui.requestRender();
				}
				return pending ? { consume: true } : undefined;
			} else if (mouse.button === "left") {
				if (this.workspace.isNewContentIndicatorRow(mouse.row)) {
					this.workspace.scrollToBottom();
					this.ui.requestRender();
					return { consume: true };
				} else if (this.ui instanceof LystarTUI && this.ui.getLinkAtScreenPosition(mouse.row, mouse.column)) {
					return undefined;
				}
				const hit = this.workspace.getComponentHitAtScreenRow(mouse.row);
				if (!hit || !resolveInteractiveCardAction(hit.component, hit.row)) return undefined;
				this.pendingCardClick = {
					row: mouse.row,
					column: mouse.column,
					component: hit.component,
					componentRow: hit.row,
				};
				return { consume: true };
			} else {
				this.pendingCardClick = undefined;
				return undefined;
			}
			this.ui.requestRender();
			return { consume: true };
		}

		if (
			this.keybindings.matches(data, "app.viewport.pageUp") ||
			this.keybindings.matches(data, "tui.altScreen.pageUp")
		) {
			this.workspace.pageUp();
			if (this.workspace.isAtTop()) void this.loadPreviousTranscriptPage();
		} else if (
			this.keybindings.matches(data, "app.viewport.pageDown") ||
			this.keybindings.matches(data, "tui.altScreen.pageDown")
		) {
			this.workspace.pageDown();
		} else if (this.keybindings.matches(data, "tui.altScreen.halfPageUp")) {
			this.workspace.halfPageUp();
			if (this.workspace.isAtTop()) void this.loadPreviousTranscriptPage();
		} else if (this.keybindings.matches(data, "tui.altScreen.halfPageDown")) {
			this.workspace.halfPageDown();
		} else if (
			this.keybindings.matches(data, "app.viewport.top") ||
			this.keybindings.matches(data, "tui.altScreen.top")
		) {
			this.workspace.scrollToTop();
			void this.loadPreviousTranscriptPage();
		} else if (
			this.keybindings.matches(data, "app.viewport.bottom") ||
			this.keybindings.matches(data, "tui.altScreen.bottom")
		) {
			this.workspace.scrollToBottom();
		} else {
			return undefined;
		}
		this.ui.requestRender();
		return { consume: true };
	}

	private setupKeyHandlers(): void {
		// Set up handlers on defaultEditor - they use this.editor for text access
		// so they work correctly regardless of which editor is active
		this.defaultEditor.onEscape = () => {
			if (this.session.isStreaming) {
				this.restoreQueuedMessagesToEditor({ abort: true });
			} else if (this.session.isBashRunning) {
				this.session.abortBash();
			} else if (this.isBashMode) {
				this.editor.setText("");
				this.isBashMode = false;
				this.updateEditorBorderColor();
			} else if (!this.editor.getText().trim()) {
				// Double-escape with empty editor triggers /tree, /fork, or nothing based on setting
				const action = this.settingsManager.getDoubleEscapeAction();
				if (action !== "none") {
					const now = Date.now();
					if (now - this.lastEscapeTime < 500) {
						if (action === "tree") {
							this.showTreeSelector();
						} else {
							this.showUserMessageSelector();
						}
						this.lastEscapeTime = 0;
					} else {
						this.lastEscapeTime = now;
					}
				}
			}
		};

		// Register app action handlers
		this.defaultEditor.onAction("app.clear", () => this.handleCtrlC());
		this.defaultEditor.onCtrlD = () => this.handleCtrlD();
		this.defaultEditor.onAction("app.suspend", () => this.handleCtrlZ());
		this.defaultEditor.onAction("app.thinking.cycle", () => this.cycleThinkingLevel());
		this.defaultEditor.onAction("app.model.cycleForward", () => this.cycleModel("forward"));
		this.defaultEditor.onAction("app.model.cycleBackward", () => this.cycleModel("backward"));

		// Global debug handler on TUI (works regardless of focus)
		this.ui.onDebug = () => this.handleDebugCommand();
		this.defaultEditor.onAction("app.model.select", () => this.showModelSelector());
		this.defaultEditor.onAction("app.tools.expand", () => this.toggleToolOutputExpansion());
		this.defaultEditor.onAction("app.thinking.toggle", () => this.toggleThinkingBlockVisibility());
		this.defaultEditor.onAction("app.editor.external", () => void this.handleOpenExternalEditor());
		this.defaultEditor.onAction(
			"app.message.copy",
			() => void this.handleCopyCommand({ flashConfirmation: true, preferSelection: true }),
		);
		this.defaultEditor.onAction("app.message.followUp", () => this.handleFollowUp());
		this.defaultEditor.onAction("app.message.dequeue", () => this.handleDequeue());
		this.defaultEditor.onAction("app.session.new", () => this.handleClearCommand());
		this.defaultEditor.onAction("app.session.tree", () => this.showTreeSelector());
		this.defaultEditor.onAction("app.session.fork", () => this.showUserMessageSelector());
		this.defaultEditor.onAction("app.session.resume", () => this.showSessionSelector());

		this.defaultEditor.onChange = (text: string) => {
			const wasBashMode = this.isBashMode;
			this.isBashMode = text.trimStart().startsWith("!");
			if (wasBashMode !== this.isBashMode) {
				this.updateEditorBorderColor();
			}
		};

		// Handle clipboard paste (triggered on Ctrl+V). Images are attached by path;
		// otherwise, paste plain text from the system clipboard.
		this.defaultEditor.onPasteImage = () => {
			void this.handleClipboardPaste();
		};
	}

	private async handleRightClickPaste(): Promise<void> {
		const target = this.renderer.getFocusedComponent();
		const handleInput = target?.handleInput;
		if (!target || !handleInput) return;
		try {
			const text = await readClipboardText();
			if (!text || this.renderer.getFocusedComponent() !== target) return;
			handleInput.call(target, `\x1b[200~${text}\x1b[201~`);
			this.ui.requestRender();
		} catch {
			// Silently ignore clipboard errors (may not have permission, etc.)
		}
	}

	private async handleClipboardPaste(): Promise<void> {
		try {
			let image = await readClipboardImage();
			let terminalText: string | undefined;
			if (!image) {
				const content = await this.ui.queryTerminalClipboard({
					mimeTypes: ["image/png", "image/jpeg", "image/webp", "image/gif", "text/plain"],
					tmux: Boolean(process.env.TMUX),
				});
				if (content?.mimeType.startsWith("image/")) {
					image = content;
				} else if (content) {
					terminalText = new TextDecoder().decode(content.bytes);
				}
			}

			if (image) {
				const tmpDir = os.tmpdir();
				const ext = extensionForImageMimeType(image.mimeType) ?? "png";
				const fileName = `pi-clipboard-${crypto.randomUUID()}.${ext}`;
				const filePath = path.join(tmpDir, fileName);
				fs.writeFileSync(filePath, Buffer.from(image.bytes));

				this.editor.insertTextAtCursor?.(filePath);
				this.ui.requestRender();
				return;
			}

			const text = terminalText || (await readClipboardText());
			if (text) {
				this.editor.insertTextAtCursor?.(text);
				this.ui.requestRender();
				return;
			}

			const remote = Boolean(process.env.SSH_CONNECTION || process.env.SSH_CLIENT || process.env.MOSH_CONNECTION);
			this.showWarning(
				remote
					? `未读取到剪贴板内容。SSH${process.env.TMUX ? "/tmux" : ""} 下需要支持 OSC 5522 的终端${process.env.TMUX ? "，并启用 tmux allow-passthrough" : ""}；也可以粘贴远端图片路径。`
					: "剪贴板中没有可用的图片或文本。",
			);
		} catch (error) {
			this.showWarning(`粘贴剪贴板失败：${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private handleStartupSubmit(text: string): void {
		this.editor.setText(text);
		this.showStatus("Startup is still in progress");
	}

	private setupEditorSubmitHandler(): void {
		this.defaultEditor.onSubmit = async (text: string) => {
			text = text.trim();
			if (!text) return;
			this.workspace?.scrollToBottom();

			// Handle commands
			if (text === "/settings") {
				this.showSettingsSelector();
				this.editor.setText("");
				return;
			}
			if (text === "/scoped-models") {
				this.editor.setText("");
				await this.showModelsSelector();
				return;
			}
			if (text === "/model" || text.startsWith("/model ")) {
				const searchTerm = text.startsWith("/model ") ? text.slice(7).trim() : undefined;
				this.editor.setText("");
				await this.handleModelCommand(searchTerm);
				return;
			}
			if (text === "/export" || text.startsWith("/export ")) {
				await this.handleExportCommand(text);
				this.editor.setText("");
				return;
			}
			if (text === "/import" || text.startsWith("/import ")) {
				await this.handleImportCommand(text);
				this.editor.setText("");
				return;
			}
			if (text === "/share") {
				await this.handleShareCommand();
				this.editor.setText("");
				return;
			}
			if (text === "/copy") {
				await this.handleCopyCommand();
				this.editor.setText("");
				return;
			}
			if (text === "/name" || text.startsWith("/name ")) {
				this.handleNameCommand(text);
				this.editor.setText("");
				return;
			}
			if (text === "/session") {
				this.handleSessionCommand();
				this.editor.setText("");
				return;
			}
			if (text === "/changes") {
				this.handleChangesCommand();
				this.editor.setText("");
				return;
			}
			if (text === "/agents") {
				this.handleAgentsCommand();
				this.editor.setText("");
				return;
			}
			if (text === "/changelog") {
				this.handleChangelogCommand();
				this.editor.setText("");
				return;
			}
			if (text === "/hotkeys") {
				this.handleHotkeysCommand();
				this.editor.setText("");
				return;
			}
			if (text === "/fork") {
				this.showUserMessageSelector();
				this.editor.setText("");
				return;
			}
			if (text === "/clone") {
				this.editor.setText("");
				await this.handleCloneCommand();
				return;
			}
			if (text === "/tree") {
				this.showTreeSelector();
				this.editor.setText("");
				return;
			}
			if (text === "/trust") {
				this.showTrustSelector();
				this.editor.setText("");
				return;
			}
			if (text === "/login" || text.startsWith("/login ")) {
				const providerRef = text.startsWith("/login ") ? text.slice(7).trim() : undefined;
				this.editor.setText("");
				await this.handleLoginCommand(providerRef);
				return;
			}
			if (text === "/logout") {
				this.showOAuthSelector("logout");
				this.editor.setText("");
				return;
			}
			if (text === "/new") {
				this.editor.setText("");
				await this.handleClearCommand();
				return;
			}
			if (text === "/compact" || text.startsWith("/compact ")) {
				const customInstructions = text.startsWith("/compact ") ? text.slice(9).trim() : undefined;
				this.editor.setText("");
				await this.handleCompactCommand(customInstructions);
				return;
			}
			if (text === "/reload") {
				this.editor.setText("");
				await this.handleReloadCommand();
				return;
			}
			if (text === "/gui") {
				this.editor.setText("");
				await this.handleGuiCommand();
				return;
			}
			if (text === "/debug") {
				this.handleDebugCommand();
				this.editor.setText("");
				return;
			}
			if (text === "/arminsayshi") {
				this.handleArminSaysHi();
				this.editor.setText("");
				return;
			}
			if (text === "/dementedelves") {
				this.handleDementedDelves();
				this.editor.setText("");
				return;
			}
			if (text === "/resume") {
				this.showSessionSelector();
				this.editor.setText("");
				return;
			}
			if (text === "/quit") {
				this.editor.setText("");
				await this.shutdown();
				return;
			}

			// Handle bash command (! for normal, !! for excluded from context)
			if (text.startsWith("!")) {
				const isExcluded = text.startsWith("!!");
				const command = isExcluded ? text.slice(2).trim() : text.slice(1).trim();
				if (command) {
					if (this.session.isBashRunning) {
						this.showWarning("已有 Shell 命令正在运行，请先按 Esc 取消。");
						this.editor.setText(text);
						return;
					}
					this.editor.addToHistory?.(text);
					await this.handleBashCommand(command, isExcluded);
					this.isBashMode = false;
					this.updateEditorBorderColor();
					return;
				}
			}

			// Queue input during compaction (extension commands execute immediately)
			if (this.session.isCompacting) {
				if (this.isExtensionCommand(text)) {
					this.editor.addToHistory?.(text);
					this.editor.setText("");
					await this.session.prompt(text);
				} else {
					this.queueCompactionMessage(text, "steer");
				}
				return;
			}

			// If streaming, use prompt() with steer behavior
			// This handles extension commands (execute immediately), prompt template expansion, and queueing
			if (this.session.isStreaming) {
				this.editor.addToHistory?.(text);
				this.editor.setText("");
				await this.session.prompt(text, { streamingBehavior: "steer" });
				this.updatePendingMessagesDisplay();
				this.ui.requestRender();
				return;
			}

			// Normal message submission
			// First, move any pending bash components to chat
			this.flushPendingBashComponents();

			if (this.onInputCallback) {
				this.onInputCallback(text);
			} else {
				this.pendingUserInputs.push(text);
			}
			this.editor.addToHistory?.(text);
		};
	}

	private async handleGuiCommand(): Promise<void> {
		const sessionPath = this.sessionManager.getSessionFile();
		if (!sessionPath || !this.sessionManager.isPersisted() || !fs.existsSync(sessionPath)) {
			this.showWarning("当前会话没有可共享的持久化文件。");
			return;
		}
		if (!(await this.ensureGuiCompanion({ force: true }))) return;
		try {
			await this.launchGui(sessionPath);
			this.showStatus("GUI 已打开，当前会话由 TUI 与 GUI 共同使用。");
		} catch (error) {
			this.showError(`启动 GUI 失败：${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private getGuiLauncher(): { command: string; shell: boolean } {
		const configured = process.env.LYSTAR_GUI_LAUNCHER?.trim();
		if (configured)
			return { command: configured, shell: process.platform === "win32" && configured.endsWith(".cmd") };
		if (process.platform === "win32") {
			return {
				command: path.join(os.homedir(), "AppData", "Local", "lystar-agent", "bin", "lystar-code-gui.cmd"),
				shell: true,
			};
		}
		return { command: path.join(os.homedir(), ".local", "bin", "lystar-code-gui"), shell: false };
	}

	private async launchGui(sessionPath: string): Promise<void> {
		const launcher = this.getGuiLauncher();
		await new Promise<void>((resolve, reject) => {
			const child = spawn(launcher.command, [], {
				detached: true,
				env: { ...process.env, PI_GUI_STARTUP_SESSION_PATH: sessionPath },
				stdio: "ignore",
				shell: launcher.shell,
			});
			child.once("error", reject);
			child.once("spawn", () => {
				child.unref();
				resolve();
			});
		});
	}

	private getWorkspaceStatusLabel(): string | undefined {
		if (this.session.isCompacting) return "压缩中";
		switch (this.turnActivity?.phase) {
			case "thinking":
				return "思考中";
			case "runningTool":
				return "执行中";
			case "waiting":
				return "等待模型";
			case "retrying":
				return "重试中";
			case "compacting":
			case "summarizing":
				return "压缩中";
			case "cancelled":
				return "正在取消";
		}
		if (this.session.isBashRunning) return "执行中";
		if (this.session.isStreaming) return "思考中";
		return undefined;
	}

	private normalizeTurnFilePath(filePath: string): string {
		const cwd = path.resolve(this.sessionManager.getCwd());
		const absolutePath = path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve(cwd, filePath);
		return (getCwdRelativePath(absolutePath, cwd) ?? absolutePath).split(path.sep).join("/");
	}

	private getTrackedToolDisplay(
		name: string,
		args: unknown,
	): { action?: string; subject?: string; filePath?: string } {
		if (name === "apply_patch") return { action: t("tool.applyPatch.running") };
		if (!args || typeof args !== "object") return {};
		const values = args as Record<string, unknown>;
		if (name === "read" || name === "edit" || name === "write") {
			const rawPath =
				typeof values.path === "string"
					? values.path
					: typeof values.file_path === "string"
						? values.file_path
						: undefined;
			if (!rawPath) return {};
			const filePath = this.normalizeTurnFilePath(rawPath);
			return { subject: filePath, filePath: name === "edit" || name === "write" ? filePath : undefined };
		}
		if (name === "bash" && typeof values.command === "string") {
			return { subject: values.command.split(/\r?\n/, 1)[0]?.trim() };
		}
		return {};
	}

	private ensureTrackedTool(id: string, name: string, args: unknown): TrackedTurnTool | undefined {
		const activity = this.turnActivity;
		if (!activity) return undefined;
		const existing = activity.tools.get(id);
		if (existing) {
			if (args !== undefined) {
				existing.args = args;
				const display = this.getTrackedToolDisplay(name, args);
				existing.action = display.action;
				existing.subject = display.subject;
				existing.filePath = display.filePath;
			}
			return existing;
		}
		const display = this.getTrackedToolDisplay(name, args);
		const tool: TrackedTurnTool = { id, name, args, status: "pending", ...display };
		activity.tools.set(id, tool);
		activity.toolOrder.push(id);
		return tool;
	}

	private updateActivityBar(phase?: WorkspaceActivityPhase, action?: string): void {
		const activity = this.turnActivity;
		if (!activity) {
			this.activityBar.setState(undefined);
			return;
		}
		if (phase) activity.phase = phase;
		if (action !== undefined) activity.action = action;
		const tools = activity.toolOrder
			.map((id) => activity.tools.get(id))
			.filter((tool): tool is TrackedTurnTool => Boolean(tool));
		const running = tools.filter((tool) => tool.status === "running");
		const current = running.at(-1);
		this.activityBar.setState({
			phase: activity.phase,
			action: activity.phase === "runningTool" ? (current?.action ?? current?.name) : activity.action,
			subject: activity.phase === "runningTool" && running.length <= 1 ? current?.subject : undefined,
			thinking: this.thinkingDisplayMode === "activity" ? activity.thinking : undefined,
			workingVisible: this.workingVisible,
			workingMessage: this.workingMessage,
			workingIndicator: this.workingIndicatorOptions,
			startedAt: activity.startedAt,
			completedTools: tools.filter(
				(tool) => tool.status === "success" || tool.status === "error" || tool.status === "cancelled",
			).length,
			knownTools: tools.length,
			queueCount: activity.queueCount,
			runningTools: running.length,
		});
	}

	private getCurrentTurnFiles(): TurnFileSummary[] {
		const activity = this.turnActivity;
		if (!activity) return this.lastTurnFiles;
		const files = new Map<string, TurnFileSummary>();
		const addFile = (file: TurnFileSummary): void => {
			const current = files.get(file.path) ?? { path: file.path };
			if (file.additions !== undefined) current.additions = (current.additions ?? 0) + file.additions;
			if (file.deletions !== undefined) current.deletions = (current.deletions ?? 0) + file.deletions;
			if (file.diff) current.diff = current.diff ? `${current.diff}\n\n${file.diff}` : file.diff;
			files.set(file.path, current);
		};
		for (const id of activity.toolOrder) {
			const tool = activity.tools.get(id);
			if (!tool || tool.status !== "success") continue;
			if (tool.files) {
				for (const file of tool.files) addFile(file);
			} else if (tool.filePath) {
				addFile({
					path: tool.filePath,
					additions: tool.additions,
					deletions: tool.deletions,
					diff: tool.diff,
				});
			}
		}
		return [...files.values()];
	}

	private finishTurnActivity(): void {
		const activity = this.turnActivity;
		if (!activity) return;
		const tools = activity.toolOrder
			.map((id) => activity.tools.get(id))
			.filter((tool): tool is TrackedTurnTool => Boolean(tool));
		const hasUnfinishedTools = tools.some((tool) => tool.status === "pending" || tool.status === "running");
		const outcome = resolveTurnOutcome({
			cancelled: activity.cancelled,
			stopReason: activity.finalStopReason,
			hasUnfinishedTools,
		});
		const toolErrors = tools.filter((tool) => tool.status === "error").length;
		for (const tool of tools) {
			if (tool.status === "pending" || tool.status === "running") {
				tool.status = outcome === "cancelled" ? "cancelled" : "error";
			}
		}
		const files = this.getCurrentTurnFiles();
		this.lastTurnFiles = files;
		if (tools.length > 0) {
			const data: TurnSummaryData = {
				startedAt: activity.startedAt,
				endedAt: Date.now(),
				outcome,
				toolErrors,
				totalTools: tools.length,
				successfulTools: tools.filter((tool) => tool.status === "success").length,
				failedTools: tools.filter((tool) => tool.status === "error").length,
				cancelledTools: tools.filter((tool) => tool.status === "cancelled").length,
				commandCount: tools.filter((tool) => tool.name === "bash").length,
				successfulCommands: tools.filter((tool) => tool.name === "bash" && tool.status === "success").length,
				files,
				tools: tools.map((tool) => ({
					name: tool.name,
					subject: tool.subject,
					status: tool.status === "pending" || tool.status === "running" ? "error" : tool.status,
					error: tool.error,
				})),
				retried: activity.retried,
				compacted: activity.compacted,
				cancelled: activity.cancelled,
			};
			this.chatContainer.addChild(new Spacer(1));
			this.chatContainer.addChild(new TurnSummaryComponent(data));
		}
		this.turnActivity = undefined;
		this.activityBar.setState(undefined);
		this.ui.requestRender(tools.length > 0);
	}

	private subscribeToAgent(): void {
		this.unsubscribe = this.session.subscribe(async (event) => {
			await this.handleEvent(event);
		});
	}

	private async handleEvent(event: AgentSessionEvent): Promise<void> {
		if (!this.isInitialized) {
			await this.init();
		}
		if (event.type === "entry_appended" || event.type === "message_end") {
			void this.ensureGuiCompanion();
		}

		this.footer.invalidate();

		switch (event.type) {
			case "agent_start":
				this.pendingTools.clear();
				this.streamingToolStack = undefined;
				this.turnActivity ??= {
					startedAt: Date.now(),
					phase: "thinking",
					tools: new Map(),
					toolOrder: [],
					queueCount: 0,
					retried: false,
					compacted: false,
					cancelled: false,
				};
				this.updateActivityBar("thinking");
				if (this.settingsManager.getShowTerminalProgress()) {
					this.ui.terminal.setProgress(true);
				}
				// Restore main escape handler if retry handler is still active
				// (retry success event fires later, but we need main handler now)
				if (this.retryEscapeHandler) {
					this.defaultEditor.onEscape = this.retryEscapeHandler;
					this.retryEscapeHandler = undefined;
				}
				this.activeStatusIndicator?.dispose();
				this.activeStatusIndicator = undefined;
				this.statusContainer.clear();
				this.ui.requestRender();
				break;

			case "queue_update":
				if (this.turnActivity) {
					this.turnActivity.queueCount = event.steering.length + event.followUp.length;
					this.updateActivityBar();
				}
				this.updatePendingMessagesDisplay();
				this.ui.requestRender();
				break;

			case "entry_appended":
				if (event.entry.type === "custom") {
					this.addCustomEntryToChat(event.entry);
					this.ui.requestRender();
				}
				break;

			case "session_info_changed":
				this.updateTerminalTitle();
				this.footer.invalidate();
				this.ui.requestRender();
				break;

			case "thinking_level_changed":
				this.footer.invalidate();
				this.updateEditorBorderColor();
				break;

			case "message_start":
				if (event.message.role === "custom") {
					this.addMessageToChat(event.message);
					this.ui.requestRender();
				} else if (event.message.role === "user") {
					this.addMessageToChat(event.message);
					this.updatePendingMessagesDisplay();
					this.ui.requestRender();
				} else if (event.message.role === "assistant") {
					if (this.turnActivity) {
						this.turnActivity.thinking = undefined;
						this.updateActivityBar("thinking");
					}
					this.streamingToolStack = undefined;
					this.streamingComponent = new AssistantMessageComponent(
						undefined,
						this.hideThinkingBlock,
						this.getMarkdownThemeWithSettings(),
						this.hiddenThinkingLabel,
						this.outputPad,
						this.getMarkdownTransformers(),
						this.thinkingDisplayMode === "transcript",
					);
					this.streamingMessage = event.message;
					this.chatContainer.addChild(this.streamingComponent);
					this.streamingComponent.updateContent(this.streamingMessage, true);
					this.ui.requestRender();
				}
				break;

			case "message_update":
				if (this.streamingComponent && event.message.role === "assistant") {
					this.streamingMessage = event.message;
					this.streamingComponent.updateContent(this.streamingMessage, true);
					if (this.turnActivity) {
						const streamEvent = event.assistantMessageEvent;
						if (
							streamEvent.type === "thinking_start" ||
							streamEvent.type === "thinking_delta" ||
							streamEvent.type === "thinking_end"
						) {
							this.turnActivity.thinking = getLatestThinkingActivityText(this.streamingMessage);
							this.updateActivityBar("thinking");
						} else if (
							streamEvent.type === "text_start" ||
							streamEvent.type === "toolcall_start" ||
							streamEvent.type === "websearch_start"
						) {
							this.turnActivity.thinking = undefined;
							this.updateActivityBar("waiting");
						}
					}

					for (const content of this.streamingMessage.content) {
						if (content.type === "toolCall") {
							this.ensureTrackedTool(content.id, content.name, content.arguments);
							this.updateActivityBar();
							if (!this.pendingTools.has(content.id)) {
								const component = new ToolExecutionComponent(
									content.name,
									content.id,
									content.arguments,
									{
										showImages: this.settingsManager.getShowImages(),
										imageWidthCells: this.settingsManager.getImageWidthCells(),
									},
									this.getRegisteredToolDefinition(content.name),
									this.ui,
									this.sessionManager.getCwd(),
								);
								component.setExpanded(this.toolOutputExpanded);
								if (!this.streamingToolStack) {
									this.streamingToolStack = new ToolExecutionStackComponent();
									this.streamingToolStack.setExpanded(this.toolOutputExpanded);
									this.chatContainer.addChild(new Spacer(1));
									this.chatContainer.addChild(this.streamingToolStack);
								}
								this.streamingToolStack.addTool(component);
								this.pendingTools.set(content.id, component);
							} else {
								const component = this.pendingTools.get(content.id);
								if (component) {
									component.updateArgs(content.arguments);
								}
							}
						}
					}
					this.ui.requestRender();
				}
				break;

			case "message_end":
				this.headerContextUsageDirty = true;
				if (event.message.role === "user") break;
				if (event.message.role === "assistant" && this.turnActivity) {
					this.turnActivity.finalStopReason = event.message.stopReason;
				}
				if (this.streamingComponent && event.message.role === "assistant") {
					this.streamingMessage = event.message;
					let errorMessage: string | undefined;
					if (this.streamingMessage.stopReason === "aborted") {
						errorMessage = formatAbortedMessage(this.session.retryAttempt);
						this.streamingMessage.errorMessage = errorMessage;
					}
					this.streamingComponent.updateContent(this.streamingMessage, false);

					if (this.streamingMessage.stopReason === "aborted" || this.streamingMessage.stopReason === "error") {
						if (this.turnActivity && this.streamingMessage.stopReason === "aborted") {
							this.turnActivity.cancelled = true;
							for (const tool of this.turnActivity.tools.values()) {
								if (tool.status === "pending" || tool.status === "running") tool.status = "cancelled";
							}
							this.updateActivityBar("cancelled");
						}
						if (!errorMessage) {
							errorMessage = this.streamingMessage.errorMessage || t("status.unknownError");
						}
						for (const [, component] of this.pendingTools.entries()) {
							if (this.streamingMessage.stopReason === "aborted") {
								component.markCancelled(errorMessage);
							} else {
								component.updateResult({
									content: [{ type: "text", text: errorMessage }],
									isError: true,
								});
							}
						}
						this.pendingTools.clear();
					} else {
						// Args are now complete - trigger diff computation for edit tools
						for (const [, component] of this.pendingTools.entries()) {
							component.setArgsComplete();
						}
						this.maybeShowCacheMissNotice(this.streamingMessage);
					}
					this.streamingComponent = undefined;
					this.streamingMessage = undefined;
					this.streamingToolStack = undefined;
					this.footer.invalidate();
				}
				this.ui.requestRender();
				break;

			case "bash_execution_update":
				// The bash execution callback handles TUI output rendering.
				break;

			case "tool_execution_start": {
				if (this.turnActivity) {
					const trackedTool = this.ensureTrackedTool(event.toolCallId, event.toolName, event.args);
					if (trackedTool) trackedTool.status = "running";
					this.updateActivityBar("runningTool");
				}
				let component = this.pendingTools.get(event.toolCallId);
				if (!component) {
					component = new ToolExecutionComponent(
						event.toolName,
						event.toolCallId,
						event.args,
						{
							showImages: this.settingsManager.getShowImages(),
							imageWidthCells: this.settingsManager.getImageWidthCells(),
						},
						this.getRegisteredToolDefinition(event.toolName),
						this.ui,
						this.sessionManager.getCwd(),
					);
					component.setExpanded(this.toolOutputExpanded);
					if (!this.streamingToolStack) {
						this.streamingToolStack = new ToolExecutionStackComponent();
						this.streamingToolStack.setExpanded(this.toolOutputExpanded);
						this.chatContainer.addChild(new Spacer(1));
						this.chatContainer.addChild(this.streamingToolStack);
					}
					this.streamingToolStack.addTool(component);
					this.pendingTools.set(event.toolCallId, component);
				}
				component.markExecutionStarted();
				this.ui.requestRender();
				break;
			}

			case "tool_execution_update": {
				const component = this.pendingTools.get(event.toolCallId);
				if (component?.updateResult({ ...event.partialResult, isError: false }, true)) {
					this.ui.requestRender();
				}
				break;
			}

			case "tool_execution_end": {
				if (this.turnActivity) {
					const trackedTool = this.ensureTrackedTool(event.toolCallId, event.toolName, undefined);
					if (trackedTool) {
						const result = event.result as {
							content?: Array<{ type?: string; text?: string }>;
							details?: unknown;
						};
						const firstError = result.content
							?.find((content) => content.type === "text" && content.text?.trim())
							?.text?.trim()
							.split(/\r?\n/, 1)[0];
						const cancelled = event.isError && Boolean(firstError?.match(/abort|cancel|取消/i));
						trackedTool.status = cancelled ? "cancelled" : event.isError ? "error" : "success";
						trackedTool.error = event.isError ? firstError : undefined;
						if (event.result.details && typeof event.result.details === "object") {
							const details = event.result.details as Record<string, unknown>;
							trackedTool.additions = typeof details.additions === "number" ? details.additions : undefined;
							trackedTool.deletions = typeof details.deletions === "number" ? details.deletions : undefined;
							trackedTool.diff = typeof details.diff === "string" ? details.diff : undefined;
							if (Array.isArray(details.files)) {
								trackedTool.files = details.files.flatMap((file): TurnFileSummary[] => {
									if (!file || typeof file !== "object") return [];
									const value = file as Record<string, unknown>;
									if (typeof value.path !== "string") return [];
									return [
										{
											path: this.normalizeTurnFilePath(value.path),
											additions: typeof value.additions === "number" ? value.additions : undefined,
											deletions: typeof value.deletions === "number" ? value.deletions : undefined,
											diff: typeof value.diff === "string" ? value.diff : undefined,
										},
									];
								});
								trackedTool.subject = `${trackedTool.files.length} 个文件`;
							}
						}
						if (cancelled) this.turnActivity.cancelled = true;
					}
					const hasRunningTools = [...this.turnActivity.tools.values()].some((tool) => tool.status === "running");
					this.updateActivityBar(hasRunningTools ? "runningTool" : "waiting");
				}
				const component = this.pendingTools.get(event.toolCallId);
				if (component) {
					component.updateResult({ ...event.result, isError: event.isError });
					this.pendingTools.delete(event.toolCallId);

					this.ui.requestRender();
				}
				break;
			}

			case "agent_end":
				if (event.willRetry && this.turnActivity) {
					this.turnActivity.finalStopReason = undefined;
				}
				if (this.settingsManager.getShowTerminalProgress()) {
					this.ui.terminal.setProgress(false);
				}
				if (this.streamingComponent) {
					this.chatContainer.removeChild(this.streamingComponent);
					this.streamingComponent = undefined;
					this.streamingMessage = undefined;
				}
				this.pendingTools.clear();
				this.streamingToolStack = undefined;
				if (this.turnActivity) {
					this.updateActivityBar(
						event.willRetry ? "retrying" : this.turnActivity.cancelled ? "cancelled" : "waiting",
					);
				}

				this.ui.requestRender();
				break;

			case "agent_settled":
				this.finishTurnActivity();
				await this.checkShutdownRequested();
				break;

			case "compaction_start": {
				if (this.turnActivity) {
					this.turnActivity.compacted = true;
					this.updateActivityBar("compacting");
				}
				if (this.settingsManager.getShowTerminalProgress()) {
					this.ui.terminal.setProgress(true);
				}
				// Keep editor active; submissions are queued during compaction.
				this.autoCompactionEscapeHandler = this.defaultEditor.onEscape;
				this.defaultEditor.onEscape = () => {
					this.session.abortCompaction();
				};
				this.showStatusIndicator(new CompactionStatusIndicator(this.ui, event.reason));
				this.ui.requestRender();
				break;
			}

			case "compaction_end": {
				this.headerContextUsageDirty = true;
				if (this.settingsManager.getShowTerminalProgress() && !event.willRetry) {
					this.ui.terminal.setProgress(false);
				}
				if (this.autoCompactionEscapeHandler) {
					this.defaultEditor.onEscape = this.autoCompactionEscapeHandler;
					this.autoCompactionEscapeHandler = undefined;
				}
				this.clearStatusIndicator("compaction");
				if (event.willRetry) {
					this.setWorkingVisible(this.workingVisible);
				}
				if (event.aborted) {
					if (event.reason === "manual") {
						this.showError("上下文压缩已取消");
					} else {
						this.showStatus("自动压缩已取消");
					}
				} else if (event.result) {
					this.rebuildChatFromMessages();
					this.footer.invalidate();
				} else if (event.errorMessage) {
					if (event.reason === "manual") {
						this.showError(event.errorMessage);
					} else {
						this.chatContainer.addChild(new Spacer(1));
						this.chatContainer.addChild(new Text(theme.fg("error", event.errorMessage), 1, 0));
					}
				}
				void this.flushCompactionQueue({ willRetry: event.willRetry });
				if (this.turnActivity) this.updateActivityBar(event.willRetry ? "thinking" : "waiting");
				this.ui.requestRender(true);
				break;
			}

			case "auto_retry_start": {
				if (this.turnActivity) {
					this.turnActivity.retried = true;
					this.updateActivityBar("retrying", `第 ${event.attempt}/${event.maxAttempts} 次重试`);
				}
				// Set up escape to abort retry
				this.retryEscapeHandler = this.defaultEditor.onEscape;
				this.defaultEditor.onEscape = () => {
					this.session.abortRetry();
				};
				this.showStatusIndicator(
					new RetryStatusIndicator(this.ui, event.attempt, event.maxAttempts, event.delayMs),
				);
				this.ui.requestRender();
				break;
			}

			case "auto_retry_end": {
				// Restore escape handler
				if (this.retryEscapeHandler) {
					this.defaultEditor.onEscape = this.retryEscapeHandler;
					this.retryEscapeHandler = undefined;
				}
				this.clearStatusIndicator("retry");
				if (this.turnActivity && event.success) this.updateActivityBar("thinking");
				// Show error only on final failure (success shows normal response)
				if (!event.success) {
					this.showError(`重试 ${event.attempt} 次后仍然失败：${event.finalError || t("status.unknownError")}`);
				}
				this.ui.requestRender();
				break;
			}

			case "summarization_retry_scheduled": {
				if (this.turnActivity) this.updateActivityBar("summarizing");
				this.showError(event.errorMessage);
				this.showStatusIndicator(
					new RetryStatusIndicator(this.ui, event.attempt, event.maxAttempts, event.delayMs),
				);
				this.ui.requestRender();
				break;
			}

			case "summarization_retry_attempt_start": {
				if (this.turnActivity) this.updateActivityBar("summarizing");
				this.clearStatusIndicator("retry");
				if (event.source === "branchSummary") {
					this.showStatusIndicator(new BranchSummaryStatusIndicator(this.ui));
				} else {
					this.showStatusIndicator(new CompactionStatusIndicator(this.ui, event.reason));
				}
				this.ui.requestRender();
				break;
			}

			case "summarization_retry_finished": {
				this.clearStatusIndicator("retry");
				this.ui.requestRender();
				break;
			}
		}
	}

	/** Extract text content from a user message */
	private getUserMessageText(message: Message): string {
		if (message.role !== "user") return "";
		const textBlocks =
			typeof message.content === "string"
				? [{ type: "text", text: message.content }]
				: message.content.filter((c: { type: string }) => c.type === "text");
		return textBlocks.map((c) => (c as { text: string }).text).join("");
	}

	/** Show a managed-tool status update in the chat. */
	private showManagedToolStatus(status: ToolStatus): void {
		if (!this.managedToolStatusStarted) {
			this.chatContainer.addChild(new Spacer(1));
			this.managedToolStatusStarted = true;
		}
		const message = status.type === "warning" ? `Warning: ${status.message}` : status.message;
		const color = status.type === "warning" ? "warning" : "dim";
		this.chatContainer.addChild(new Text(theme.fg(color, message), 1, 0));
		this.lastStatusSpacer = undefined;
		this.lastStatusText = undefined;
		this.ui.requestRender();
	}

	/**
	 * Show a status message in the chat.
	 *
	 * If multiple status messages are emitted back-to-back (without anything else being added to the chat),
	 * we update the previous status line instead of appending new ones to avoid log spam.
	 */
	private showStatus(message: string): void {
		const children = this.chatContainer.children;
		const last = children.length > 0 ? children[children.length - 1] : undefined;
		const secondLast = children.length > 1 ? children[children.length - 2] : undefined;

		if (last && secondLast && last === this.lastStatusText && secondLast === this.lastStatusSpacer) {
			this.lastStatusText.setText(theme.fg("dim", message));
			this.ui.requestRender();
			return;
		}

		const spacer = new Spacer(1);
		const text = new Text(theme.fg("dim", message), 1, 0);
		this.chatContainer.addChild(spacer);
		this.chatContainer.addChild(text);
		this.lastStatusSpacer = spacer;
		this.lastStatusText = text;
		this.ui.requestRender();
	}

	private addCustomEntryToChat(entry: Extract<SessionEntry, { type: "custom" }>): void {
		const renderer = this.session.extensionRunner.getEntryRenderer(entry.customType);
		if (!renderer) {
			return;
		}
		const component = new CustomEntryComponent(entry, renderer);
		component.setExpanded(this.toolOutputExpanded);
		if (!component.hasContent()) {
			return;
		}

		if (this.streamingComponent) {
			const streamingIndex = this.chatContainer.children.indexOf(this.streamingComponent);
			if (streamingIndex >= 0) {
				this.chatContainer.children.splice(streamingIndex, 0, component);
				return;
			}
		}

		this.chatContainer.addChild(component);
	}

	private addMessageToChat(message: AgentMessage, options?: { populateHistory?: boolean }): void {
		switch (message.role) {
			case "bashExecution": {
				const component = new BashExecutionComponent(message.command, this.ui, message.excludeFromContext);
				component.setExpanded(this.toolOutputExpanded);
				if (message.output) {
					component.appendOutput(message.output);
				}
				component.setComplete(
					message.exitCode,
					message.cancelled,
					message.truncated ? ({ truncated: true } as TruncationResult) : undefined,
					message.fullOutputPath,
				);
				this.chatContainer.addChild(component);
				break;
			}
			case "custom": {
				if (message.display) {
					const renderer = this.session.extensionRunner.getMessageRenderer(message.customType);
					const component = new CustomMessageComponent(
						message,
						renderer,
						this.getMarkdownThemeWithSettings(),
						this.outputPad,
					);
					component.setExpanded(this.toolOutputExpanded);
					this.chatContainer.addChild(component);
				}
				break;
			}
			case "compactionSummary": {
				this.chatContainer.addChild(new Spacer(1));
				const component = new CompactionSummaryMessageComponent(message, this.getMarkdownThemeWithSettings());
				component.setExpanded(this.toolOutputExpanded);
				this.chatContainer.addChild(component);
				break;
			}
			case "branchSummary": {
				this.chatContainer.addChild(new Spacer(1));
				const component = new BranchSummaryMessageComponent(message, this.getMarkdownThemeWithSettings());
				component.setExpanded(this.toolOutputExpanded);
				this.chatContainer.addChild(component);
				break;
			}
			case "user": {
				const textContent = this.getUserMessageText(message);
				if (textContent) {
					if (this.chatContainer.children.length > 0) {
						this.chatContainer.addChild(new Spacer(1));
					}
					const skillBlock = parseSkillBlock(textContent);
					if (skillBlock) {
						// Render skill block (collapsible)
						const component = new SkillInvocationMessageComponent(
							skillBlock,
							this.getMarkdownThemeWithSettings(),
						);
						component.setExpanded(this.toolOutputExpanded);
						this.chatContainer.addChild(component);
						// Render user message separately if present
						if (skillBlock.userMessage) {
							this.chatContainer.addChild(new Spacer(1));
							const userComponent = new UserMessageComponent(
								skillBlock.userMessage,
								this.getMarkdownThemeWithSettings(),
								this.outputPad,
								this.getMarkdownTransformers(),
							);
							this.chatContainer.addChild(userComponent);
						}
					} else {
						const userComponent = new UserMessageComponent(
							textContent,
							this.getMarkdownThemeWithSettings(),
							this.outputPad,
							this.getMarkdownTransformers(),
						);
						this.chatContainer.addChild(userComponent);
					}
					if (options?.populateHistory) {
						this.editor.addToHistory?.(textContent);
					}
				}
				break;
			}
			case "assistant": {
				const assistantComponent = new AssistantMessageComponent(
					message,
					this.hideThinkingBlock,
					this.getMarkdownThemeWithSettings(),
					this.hiddenThinkingLabel,
					this.outputPad,
					this.getMarkdownTransformers(),
					this.thinkingDisplayMode === "transcript",
				);
				this.chatContainer.addChild(assistantComponent);
				break;
			}
			case "toolResult": {
				// Tool results are rendered inline with tool calls, handled separately
				break;
			}
			default: {
				const _exhaustive: never = message;
			}
		}
	}

	private renderSessionItems(
		items: readonly RenderSessionItem[],
		options: { updateFooter?: boolean; populateHistory?: boolean; cwd?: string; includeCacheMisses?: boolean } = {},
		onItemRendered?: (item: RenderSessionItem, components: Component[], index: number) => void,
	): void {
		this.pendingTools.clear();
		this.streamingToolStack = undefined;
		const renderedPendingTools = new Map<string, ToolExecutionComponent>();
		// Cache-miss notices are not persisted; re-derive them from the full entry
		// list and re-inject them after the assistant messages that paid for them.
		const cacheMisses =
			(options.includeCacheMisses ?? true) && this.settingsManager.getShowCacheMissNotices()
				? collectCacheMisses(this.sessionManager.getEntries(), this.session.modelRuntime)
				: new Map<AssistantMessage, CacheMiss>();
		const cwd = options.cwd ?? this.sessionManager.getCwd();

		if (options.updateFooter) {
			this.footer.invalidate();
			this.updateEditorBorderColor();
		}

		for (const [index, item] of items.entries()) {
			const childStart = this.chatContainer.children.length;
			let fallbackComponent: Component | undefined;
			if (isCustomSessionEntry(item)) {
				this.addCustomEntryToChat(item);
				onItemRendered?.(item, this.chatContainer.children.slice(childStart), index);
				continue;
			}

			const message = item;
			// Assistant messages need special handling for tool calls
			if (message.role === "assistant") {
				this.addMessageToChat(message);
				fallbackComponent = this.chatContainer.children.at(-1);
				let toolStack: ToolExecutionStackComponent | undefined;
				// Render tool call components
				for (const content of message.content) {
					if (content.type === "toolCall") {
						const component = new ToolExecutionComponent(
							content.name,
							content.id,
							content.arguments,
							{
								showImages: this.settingsManager.getShowImages(),
								imageWidthCells: this.settingsManager.getImageWidthCells(),
							},
							this.getRegisteredToolDefinition(content.name),
							this.ui,
							cwd,
						);
						component.setExpanded(this.toolOutputExpanded);
						if (!toolStack) {
							toolStack = new ToolExecutionStackComponent();
							toolStack.setExpanded(this.toolOutputExpanded);
							this.chatContainer.addChild(new Spacer(1));
							this.chatContainer.addChild(toolStack);
						}
						toolStack.addTool(component);

						if (message.stopReason === "aborted" || message.stopReason === "error") {
							const errorMessage =
								message.stopReason === "aborted"
									? formatAbortedMessage(this.session.retryAttempt)
									: message.errorMessage || t("status.unknownError");
							if (message.stopReason === "aborted") {
								component.markCancelled(errorMessage);
							} else {
								component.updateResult({ content: [{ type: "text", text: errorMessage }], isError: true });
							}
						} else {
							renderedPendingTools.set(content.id, component);
						}
					}
				}
				if (message.stopReason !== "aborted" && message.stopReason !== "error") {
					const miss = cacheMisses.get(message);
					if (miss) this.addCacheMissNotice(miss);
				}
			} else if (message.role === "toolResult") {
				// Match tool results to pending tool components
				const component = renderedPendingTools.get(message.toolCallId);
				if (component) {
					component.updateResult(message);
					fallbackComponent = component;
					renderedPendingTools.delete(message.toolCallId);
				}
			} else {
				// All other messages use standard rendering
				this.addMessageToChat(message, options);
			}

			onItemRendered?.(
				item,
				this.chatContainer.children.slice(childStart).length > 0
					? this.chatContainer.children.slice(childStart)
					: fallbackComponent
						? [fallbackComponent]
						: [],
				index,
			);
		}

		for (const [toolCallId, component] of renderedPendingTools) {
			this.pendingTools.set(toolCallId, component);
		}
		this.restoreCardExpansion(this.chatContainer.children);
		this.ui.requestRender();
	}

	/**
	 * Render session entries to chat. Used for initial load and rebuild after compaction.
	 * @param entries Compaction-aware session entries to render
	 * @param options.updateFooter Update footer state
	 * @param options.populateHistory Add user messages to editor history
	 */
	private renderSessionEntries(
		entries: SessionEntry[],
		options: { updateFooter?: boolean; populateHistory?: boolean } = {},
		onEntryRendered?: (entryId: string, components: Component[]) => void,
	): void {
		const itemEntries = entries.flatMap((entry) => {
			if (entry.type === "custom") {
				return [{ entryId: entry.id, item: entry as RenderSessionItem }];
			}
			return sessionEntryToContextMessages(entry).map((item) => ({ entryId: entry.id, item }));
		});
		this.renderSessionItems(
			itemEntries.map(({ item }) => item),
			options,
			(_item, components, index) => {
				const entryId = itemEntries[index]?.entryId;
				if (entryId) onEntryRendered?.(entryId, components);
			},
		);
	}

	/**
	 * Show a transcript notice when a completed assistant message paid for a
	 * significant cache miss. Only states observable facts: the miss itself,
	 * a model switch, or an idle gap past the cache TTL.
	 */
	private maybeShowCacheMissNotice(message: AssistantMessage): void {
		if (!this.settingsManager.getShowCacheMissNotices()) return;

		// Entries don't contain `message` yet: message_end fires before persistence.
		const miss = detectCacheMiss(this.sessionManager.getEntries(), message, this.session.modelRuntime);
		if (miss) this.addCacheMissNotice(miss);
	}

	private addCacheMissNotice(miss: CacheMiss): void {
		if (miss.missedTokens < 20_000 && miss.missedCost < 0.1) return;

		const cost = miss.missedCost >= 0.01 ? `（约 $${miss.missedCost.toFixed(2)}）` : "";
		const reBilled = `${formatTokens(miss.missedTokens)} Token 重新计费${cost}`;
		let label = "Prompt Cache 未命中";
		if (miss.modelChanged) {
			label = "切换模型后 Prompt Cache 未命中";
		} else if (miss.idleMs >= CACHE_TTL_MS) {
			label = `空闲 ${Math.round(miss.idleMs / 60_000)} 分钟后 Prompt Cache 未命中`;
		}
		const text = theme.fg("warning", `${label}：${reBilled}`);
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Text(text, 1, 0));
	}

	renderInitialMessages(): void {
		this.headerContextUsageDirty = true;
		const entries = this.resetTranscriptPagination();
		this.renderInitialEntries(entries);
	}

	private async renderInitialMessagesFromTranscript(): Promise<void> {
		this.headerContextUsageDirty = true;
		if (!this.workspace.isFullscreen()) {
			this.renderInitialEntries(this.resetTranscriptPagination());
			return;
		}

		const sessionFile = this.sessionManager.getSessionFile();
		if (!sessionFile || !fs.existsSync(sessionFile)) {
			this.renderInitialEntries(this.resetTranscriptPagination());
			return;
		}

		const generation = ++this.transcriptGeneration;
		const source = new SessionTranscriptSource(sessionFile);
		this.transcriptSource = source;
		this.transcriptPaginationState = "loading";
		try {
			const page = await source.readTail({
				leafId: this.sessionManager.getLeafId(),
				limit: TRANSCRIPT_PAGE_SIZE,
			});
			if (this.transcriptGeneration !== generation || this.transcriptSource !== source) return;
			this.transcriptEntries = page.entries;
			this.transcriptCursor = page.previousCursor;
			this.transcriptPaginationState = page.hasMore && page.previousCursor ? "idle" : "exhausted";
			this.renderInitialEntries(page.entries);
		} catch {
			if (this.transcriptGeneration !== generation || this.transcriptSource !== source) return;
			this.renderInitialEntries(this.resetTranscriptPagination());
			this.showWarning("历史记录分页读取失败，向上滚动可重试。");
		}
	}

	private renderInitialEntries(entries: SessionEntry[]): void {
		this.transcriptComponentEntryIds = new WeakMap();
		this.renderSessionEntries(
			entries,
			{
				updateFooter: true,
				populateHistory: true,
			},
			(entryId, components) => {
				for (const component of components) this.transcriptComponentEntryIds.set(component, entryId);
			},
		);
		this.renderProjectTrustWarningIfNeeded();

		const compactionCount = this.sessionManager.getEntries().filter((entry) => entry.type === "compaction").length;
		if (compactionCount > 0) {
			this.showStatus(`当前会话已压缩 ${compactionCount} 次`);
		}
	}

	private resetTranscriptPagination(): SessionEntry[] {
		const generation = ++this.transcriptGeneration;
		this.transcriptCursor = undefined;
		this.transcriptPaginationState = "exhausted";
		const branch = this.sessionManager.getBranch();
		if (!this.workspace.isFullscreen()) {
			this.transcriptSource = undefined;
			this.transcriptEntries = branch;
			return branch;
		}

		const sessionFile = this.sessionManager.getSessionFile();
		if (!sessionFile || !fs.existsSync(sessionFile)) {
			this.transcriptSource = undefined;
			this.transcriptEntries = branch;
			return branch;
		}

		const visibleBranch = branch.filter(isTuiVisibleSessionEntry);
		let tailStart = Math.max(0, visibleBranch.length - TRANSCRIPT_PAGE_SIZE);
		while (tailStart > 0) {
			const entry = visibleBranch[tailStart];
			if (entry?.type !== "message" || entry.message.role !== "toolResult") break;
			tailStart--;
		}
		this.transcriptEntries = visibleBranch.slice(tailStart);
		const source = new SessionTranscriptSource(sessionFile);
		this.transcriptSource = source;
		this.transcriptPaginationState = "loading";
		void source
			.readTail({ leafId: this.sessionManager.getLeafId(), limit: TRANSCRIPT_PAGE_SIZE })
			.then((page) => {
				if (this.transcriptGeneration !== generation || this.transcriptSource !== source) return;
				this.transcriptCursor = page.previousCursor;
				this.transcriptPaginationState = page.hasMore && page.previousCursor ? "idle" : "exhausted";
			})
			.catch(() => {
				if (this.transcriptGeneration === generation && this.transcriptSource === source) {
					this.transcriptCursor = undefined;
					this.transcriptPaginationState = "retryable-error";
				}
			});
		return this.transcriptEntries;
	}

	private materializeSessionEntries(entries: SessionEntry[]): MaterializedTranscriptPage {
		const chatContainer = this.chatContainer;
		const pendingTools = this.pendingTools;
		const streamingToolStack = this.streamingToolStack;
		const temporary = new Container();
		const entryComponents = new Map<string, Component>();
		this.chatContainer = temporary;
		try {
			this.renderSessionEntries(entries, {}, (entryId, components) => {
				const component = components[0];
				if (!component) return;
				entryComponents.set(entryId, component);
				for (const child of components) this.transcriptComponentEntryIds.set(child, entryId);
			});
			return { children: [...temporary.children], entryComponents };
		} finally {
			this.chatContainer = chatContainer;
			this.pendingTools = pendingTools;
			this.streamingToolStack = streamingToolStack;
		}
	}

	private materializeSubagentMessages(messages: AgentMessage[], cwd: string): Component[] {
		const chatContainer = this.chatContainer;
		const pendingTools = this.pendingTools;
		const streamingToolStack = this.streamingToolStack;
		const temporary = new Container();
		this.chatContainer = temporary;
		this.pendingTools = new Map();
		this.streamingToolStack = undefined;
		try {
			this.renderSessionItems(messages as RenderSessionItem[], { cwd, includeCacheMisses: false });
			return [...temporary.children];
		} finally {
			this.chatContainer = chatContainer;
			this.pendingTools = pendingTools;
			this.streamingToolStack = streamingToolStack;
		}
	}

	private captureTranscriptScrollAnchor(): TranscriptScrollAnchor | undefined {
		const cursor = this.transcriptCursor;
		if (!cursor) return undefined;
		const workspaceAnchor = this.workspace.captureScrollAnchor((component) =>
			this.transcriptComponentEntryIds.has(component),
		);
		if (!workspaceAnchor) return undefined;
		const entryId = this.transcriptComponentEntryIds.get(workspaceAnchor.component);
		if (!entryId) return undefined;
		return {
			...workspaceAnchor,
			entryId,
			cursor,
			generation: this.transcriptGeneration,
		};
	}

	private async loadPreviousTranscriptPage(): Promise<void> {
		const source = this.transcriptSource;
		const cursor = this.transcriptCursor;
		if (!cursor && source && this.transcriptPaginationState === "retryable-error") {
			this.resetTranscriptPagination();
			return;
		}
		if (
			!source ||
			!cursor ||
			this.transcriptPaginationState === "loading" ||
			this.transcriptPaginationState === "exhausted" ||
			this.session.isStreaming
		) {
			return;
		}
		const anchor = this.captureTranscriptScrollAnchor();
		this.transcriptPaginationState = "loading";
		const generation = this.transcriptGeneration;
		try {
			const page = await source.readPrevious(cursor, TRANSCRIPT_PAGE_SIZE);
			if (this.transcriptGeneration !== generation || this.transcriptSource !== source) return;
			const existingIds = new Set(this.transcriptEntries.map((entry) => entry.id));
			const previousEntries = page.entries.filter((entry) => !existingIds.has(entry.id));
			this.transcriptCursor = page.previousCursor;
			this.transcriptPaginationState = page.hasMore && page.previousCursor ? "idle" : "exhausted";
			if (previousEntries.length === 0) return;
			const existingChildren = [...this.chatContainer.children];
			const previousPage = this.materializeSessionEntries(previousEntries);
			this.chatContainer.children = [...previousPage.children, ...existingChildren];
			this.transcriptEntries = [...previousEntries, ...this.transcriptEntries];
			if (anchor && anchor.generation === generation && anchor.cursor === cursor) {
				this.workspace.restoreScrollAnchor(anchor);
			}
			this.ui.requestRender();
		} catch (error) {
			if (this.transcriptGeneration !== generation) return;
			if (error instanceof TranscriptCursorInvalidError) {
				this.transcriptPaginationState = "cursor-invalidated";
				this.showWarning("历史记录已变化，正在重新定位。再次向上滚动可继续加载。");
				this.resetTranscriptPagination();
			} else {
				this.transcriptPaginationState = "retryable-error";
				this.showWarning("历史记录加载失败，再次向上滚动可重试。");
			}
		}
	}

	private renderProjectTrustWarningIfNeeded(): void {
		if (this.settingsManager.isProjectTrusted() || !hasTrustRequiringProjectResources(this.sessionManager.getCwd())) {
			return;
		}

		if (this.chatContainer.children.length > 0) {
			this.chatContainer.addChild(new Spacer(1));
		}
		this.chatContainer.addChild(
			new Text(
				theme.fg(
					"warning",
					`当前项目尚未信任，项目级 ${CONFIG_DIR_NAME} 资源和 Package 暂不加载。运行 /trust 保存选择后，重启 ${APP_NAME} 生效。`,
				),
				1,
				0,
			),
		);
	}

	async getUserInput(): Promise<string> {
		const queuedInput = this.pendingUserInputs.shift();
		if (queuedInput !== undefined) {
			return queuedInput;
		}

		return new Promise((resolve) => {
			this.onInputCallback = (text: string) => {
				this.onInputCallback = undefined;
				resolve(text);
			};
		});
	}

	private rebuildChatFromMessages(): void {
		this.headerContextUsageDirty = true;
		this.workspace.resetScrollback();
		this.chatContainer.clear();
		this.renderSessionEntries(this.resetTranscriptPagination());
	}

	// =========================================================================
	// Key handlers
	// =========================================================================

	private handleCtrlC(): void {
		const now = Date.now();
		if (now - this.lastSigintTime < 500) {
			void this.shutdown();
		} else {
			this.clearEditor();
			this.lastSigintTime = now;
		}
	}

	private handleCtrlD(): void {
		// Only called when editor is empty (enforced by CustomEditor)
		void this.shutdown();
	}

	/**
	 * Gracefully shutdown the agent.
	 * Stops the TUI before emitting shutdown events so extension UI cleanup cannot
	 * repaint the final frame while the process is exiting.
	 */
	private isShuttingDown = false;

	private async shutdown(options?: { fromSignal?: boolean; handoffToGui?: string }): Promise<void> {
		if (this.isShuttingDown) return;
		this.isShuttingDown = true;
		// Keep signal handlers registered until terminal cleanup has completed.
		// `signal-exit` checks the listener list during the same SIGTERM/SIGHUP
		// dispatch and re-sends the signal if only its own listeners remain.

		if (options?.fromSignal) {
			// Signal-triggered shutdown (SIGTERM/SIGHUP). Emit extension cleanup
			// (session_shutdown) BEFORE touching the terminal. Extension teardown
			// such as removing sockets does not write to the tty, so it must not be
			// skipped if a later terminal-restore write fails on a dead or stalled
			// terminal. If the terminal is gone, the restore writes below emit EIO,
			// which the stdout/stderr error handler turns into emergencyTerminalExit;
			// the render loop is already idle, so this cannot hot-spin (see #4144).
			const coordination = getGuiCompanionCoordinationState(this);
			const companionDispose = this.guiCompanion?.dispose();
			this.guiCompanion = undefined;
			const runtimeDispose = this.runtimeHost.dispose();
			await companionDispose;
			await coordination.ensureQueue;
			await runtimeDispose;
			this.themeController.disableAutoSync();
			await this.ui.terminal.drainInput(1000);
			this.stop();
			process.exit(0);
		}

		// Interactive quit (Ctrl+D, Ctrl+C, /quit, extension shutdown()). Stop the
		// TUI before emitting shutdown events so extension UI cleanup cannot repaint
		// the final frame while the process is exiting.
		// Drain any in-flight Kitty key release events before stopping.
		// This prevents escape sequences from leaking to the parent shell over slow SSH.
		this.themeController.disableAutoSync();
		await this.ui.terminal.drainInput(1000);

		this.stop();
		await getGuiCompanionCoordinationState(this).ensureQueue;
		await this.guiCompanion?.dispose();
		this.guiCompanion = undefined;
		await this.runtimeHost.dispose();

		if (options?.handoffToGui) {
			try {
				await this.launchGui(options.handoffToGui);
			} catch (error) {
				process.stderr.write(`启动 GUI 失败：${error instanceof Error ? error.message : String(error)}\n`);
				process.exit(1);
			}
			process.exit(0);
		}

		const resumeCommand = formatResumeCommand(this.sessionManager);
		if (resumeCommand) {
			process.stdout.write(`${chalk.dim("继续当前会话：")} ${resumeCommand}\n`);
		}

		process.exit(0);
	}

	private emergencyTerminalExit(): never {
		this.isShuttingDown = true;
		this.unregisterSignalHandlers();
		killTrackedDetachedChildren();
		// The terminal is gone. Do not run normal shutdown because TUI and
		// extension cleanup can write restore sequences and re-trigger EIO.
		process.exit(129);
	}

	/**
	 * Last-resort handler for uncaught exceptions. The TUI puts stdin into raw
	 * mode and hides the cursor; without this handler, an uncaught throw from
	 * anywhere (e.g. an extension's async `ChildProcess.on("exit")` callback)
	 * tears down the process while leaving the terminal in raw mode with no
	 * cursor, requiring `stty sane && reset` to recover.
	 *
	 * Unlike emergencyTerminalExit, the terminal is still alive here, so we
	 * call ui.stop() to restore cooked mode, the cursor, and disable bracketed
	 * paste / Kitty / modifyOtherKeys sequences.
	 */
	private uncaughtCrash(error: Error): never {
		if (this.isShuttingDown) {
			process.exit(1);
		}
		this.isShuttingDown = true;
		try {
			this.unregisterSignalHandlers();
		} catch {}
		try {
			killTrackedDetachedChildren();
		} catch {}
		try {
			this.ui.stop();
		} catch {}
		console.error(`${APP_NAME} exiting due to uncaughtException:`);
		console.error(error);
		process.exit(1);
	}

	/**
	 * Check if shutdown was requested and perform shutdown if so.
	 */
	private async checkShutdownRequested(): Promise<void> {
		if (!this.shutdownRequested) return;
		await this.shutdown();
	}

	private registerSignalHandlers(): void {
		this.unregisterSignalHandlers();

		const signals: NodeJS.Signals[] = ["SIGTERM"];
		if (process.platform !== "win32") {
			signals.push("SIGHUP");
		}

		for (const signal of signals) {
			const handler = () => {
				// SIGHUP no longer hard-exits: graceful shutdown emits session_shutdown
				// first, then attempts terminal restore. A genuinely dead terminal
				// surfaces as an EIO on the restore writes, which the stdout/stderr
				// error handler converts into emergencyTerminalExit (see #4144, #5080).
				killTrackedDetachedChildren();
				void this.shutdown({ fromSignal: true });
			};
			process.prependListener(signal, handler);
			this.signalCleanupHandlers.push(() => process.off(signal, handler));
		}

		const terminalErrorHandler = (error: Error) => {
			if (isDeadTerminalError(error)) {
				this.emergencyTerminalExit();
			}
			throw error;
		};
		process.stdout.on("error", terminalErrorHandler);
		process.stderr.on("error", terminalErrorHandler);
		this.signalCleanupHandlers.push(() => process.stdout.off("error", terminalErrorHandler));
		this.signalCleanupHandlers.push(() => process.stderr.off("error", terminalErrorHandler));

		// Restore the terminal before the process dies on any uncaught throw.
		// Without this, an unhandled exception from extension code (or anywhere
		// in pi) leaves the terminal in raw mode with no cursor.
		const uncaughtExceptionHandler = (error: Error) => this.uncaughtCrash(error);
		process.prependListener("uncaughtException", uncaughtExceptionHandler);
		this.signalCleanupHandlers.push(() => process.off("uncaughtException", uncaughtExceptionHandler));
	}

	private unregisterSignalHandlers(): void {
		for (const cleanup of this.signalCleanupHandlers) {
			cleanup();
		}
		this.signalCleanupHandlers = [];
	}

	private handleCtrlZ(): void {
		if (process.platform === "win32") {
			this.showStatus("Windows 暂不支持挂起到后台");
			return;
		}

		// Keep the event loop alive while suspended. Without this, stopping the TUI
		// can leave Node with no ref'ed handles, causing the process to exit on fg
		// before the SIGCONT handler gets a chance to restore the terminal.
		const suspendKeepAlive = setInterval(() => {}, 2 ** 30);

		// Ignore SIGINT while suspended so Ctrl+C in the terminal does not
		// kill the backgrounded process. The handler is removed on resume.
		const ignoreSigint = () => {};
		process.on("SIGINT", ignoreSigint);

		// Set up handler to restore TUI when resumed
		process.once("SIGCONT", () => {
			clearInterval(suspendKeepAlive);
			process.removeListener("SIGINT", ignoreSigint);
			this.ui.start();
			this.ui.requestRender(true);
		});

		try {
			// Stop the TUI (restore terminal to normal mode)
			this.ui.stop();

			// Send SIGTSTP to process group (pid=0 means all processes in group)
			process.kill(0, "SIGTSTP");
		} catch (error) {
			clearInterval(suspendKeepAlive);
			process.removeListener("SIGINT", ignoreSigint);
			throw error;
		}
	}

	private async handleFollowUp(): Promise<void> {
		const text = (this.editor.getExpandedText?.() ?? this.editor.getText()).trim();
		if (!text) return;

		// Queue input during compaction (extension commands execute immediately)
		if (this.session.isCompacting) {
			if (this.isExtensionCommand(text)) {
				this.editor.addToHistory?.(text);
				this.editor.setText("");
				await this.session.prompt(text);
			} else {
				this.queueCompactionMessage(text, "followUp");
			}
			return;
		}

		// Alt+Enter queues a follow-up message (waits until agent finishes)
		// This handles extension commands (execute immediately), prompt template expansion, and queueing
		if (this.session.isStreaming) {
			this.editor.addToHistory?.(text);
			this.editor.setText("");
			await this.session.prompt(text, { streamingBehavior: "followUp" });
			this.updatePendingMessagesDisplay();
			this.ui.requestRender();
		}
		// If not streaming, Alt+Enter acts like regular Enter (trigger onSubmit)
		else if (this.editor.onSubmit) {
			this.editor.setText("");
			this.editor.onSubmit(text);
		}
	}

	private handleDequeue(): void {
		const restored = this.restoreQueuedMessagesToEditor();
		if (restored === 0) {
			this.showStatus("没有可恢复的排队消息");
		} else {
			this.showStatus(`已将 ${restored} 条排队消息恢复到输入框`);
		}
	}

	private updateEditorBorderColor(): void {
		if (this.isBashMode) {
			this.editor.borderColor = theme.getBashModeBorderColor();
		} else {
			const level = this.session.thinkingLevel || "off";
			this.editor.borderColor = theme.getThinkingBorderColor(level);
		}
		this.ui.requestRender();
	}

	private cycleThinkingLevel(): void {
		const newLevel = this.session.cycleThinkingLevel();
		if (newLevel === undefined) {
			this.showStatus("当前模型不支持思考");
		} else {
			this.footer.invalidate();
			this.updateEditorBorderColor();
			this.showStatus(`思考强度：${formatThinkingLevel(newLevel)}`);
		}
	}

	private async cycleModel(direction: "forward" | "backward"): Promise<void> {
		try {
			const result = await this.session.cycleModel(direction);
			if (result === undefined) {
				const msg = this.session.scopedModels.length > 0 ? "当前范围内只有一个模型" : "当前只有一个可用模型";
				this.showStatus(msg);
			} else {
				this.footer.invalidate();
				this.updateEditorBorderColor();
				const thinkingStr =
					result.model.reasoning && result.thinkingLevel !== "off"
						? `（思考强度：${formatThinkingLevel(result.thinkingLevel)}）`
						: "";
				this.showStatus(`已切换到 ${result.model.name || result.model.id}${thinkingStr}`);
				void this.maybeWarnAboutAnthropicSubscriptionAuth(result.model);
			}
		} catch (error) {
			this.showError(error instanceof Error ? error.message : String(error));
		}
	}

	private toggleToolOutputExpansion(): void {
		this.setToolsExpanded(!this.toolOutputExpanded);
	}

	private setToolsExpanded(expanded: boolean): void {
		if (expanded === this.toolOutputExpanded) return;

		this.toolOutputExpanded = expanded;
		const activeHeader = this.customHeader ?? this.builtInHeader;
		if (isExpandable(activeHeader)) {
			activeHeader.setExpanded(expanded);
		}
		for (const container of [this.loadedResourcesContainer, this.chatContainer]) {
			visitInteractiveCards(container.children, (card) => {
				card.setExpanded(expanded);
				this.rememberCardExpansion(card);
			});
			for (const child of container.children) {
				if (!isInteractiveCard(child) && isExpandable(child)) child.setExpanded(expanded);
			}
		}
		this.showStatus(`详情已${expanded ? "展开" : "折叠"}`);
	}

	private syncCardExpansionSession(): void {
		const sessionId = this.sessionManager.getSessionId();
		if (this.cardExpansionSessionId === sessionId) return;
		this.cardExpansionSessionId = sessionId;
		this.cardExpansion.clear();
	}

	private rememberCardExpansion(card: { isExpanded(): boolean; getCardStateKey?(): string | undefined }): void {
		this.syncCardExpansionSession();
		const key = card.getCardStateKey?.();
		if (key) this.cardExpansion.set(key, card.isExpanded());
	}

	private restoreCardExpansion(components: readonly Component[]): void {
		this.syncCardExpansionSession();
		visitInteractiveCards(components, (card) => {
			const key = card.getCardStateKey?.();
			if (key !== undefined && this.cardExpansion.has(key)) card.setExpanded(this.cardExpansion.get(key)!);
		});
	}

	private toggleThinkingBlockVisibility(): void {
		this.hideThinkingBlock = !this.hideThinkingBlock;
		this.settingsManager.setHideThinkingBlock(this.hideThinkingBlock);

		// Rebuild chat from session messages
		if (typeof this.rebuildChatFromMessages === "function") {
			this.chatContainer.clear();
			this.rebuildChatFromMessages();
		}

		// If streaming, re-add the streaming component with updated visibility and re-render
		if (this.streamingComponent && this.streamingMessage) {
			this.streamingComponent.setHideThinkingBlock(this.hideThinkingBlock);
			this.streamingComponent.updateContent(this.streamingMessage);
			this.chatContainer.addChild(this.streamingComponent);
		}

		this.showStatus(`思考过程：${this.hideThinkingBlock ? "已折叠" : "已展开"}`);
	}

	private async handleOpenExternalEditor(): Promise<void> {
		const editorCmd = this.settingsManager.getExternalEditorCommand();
		const content = this.editor.getExpandedText?.() ?? this.editor.getText();
		this.ui.stop();
		try {
			const result = await editInExternalEditor({
				command: editorCmd,
				content,
			});
			if (result.status === "complete") {
				this.editor.setText(result.content);
			}
		} finally {
			this.ui.start();
			this.ui.requestRender(true);
		}
	}

	// =========================================================================
	// UI helpers
	// =========================================================================

	clearEditor(): void {
		this.editor.setText("");
		this.ui.requestRender();
	}

	showError(errorMessage: string): void {
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(
			new Text(theme.fg("error", t("common.error", { message: errorMessage })), this.outputPad, 0),
		);
		this.ui.requestRender();
	}

	showWarning(warningMessage: string): void {
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(
			new Text(theme.fg("warning", t("common.warning", { message: warningMessage })), 1, 0),
		);
		this.ui.requestRender();
	}

	showNewVersionNotification(release: LatestPiRelease): void {
		const action = theme.fg("accent", `${APP_NAME} update`);
		const updateInstruction = theme.fg(
			"muted",
			t("update.instruction", { version: release.version, command: action }),
		);
		const changelogUrl = `https://github.com/${RELEASE_REPOSITORY}/releases`;
		const changelogLink = getCapabilities().hyperlinks
			? hyperlink(theme.fg("accent", changelogUrl), changelogUrl)
			: theme.fg("accent", changelogUrl);
		const changelogLine = theme.fg("muted", t("update.changelog")) + changelogLink;
		const note = release.note?.trim();

		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new DynamicBorder((text) => theme.fg("warning", text)));
		this.chatContainer.addChild(
			new Text(`${theme.bold(theme.fg("warning", t("update.available")))}\n${updateInstruction}`, 1, 0),
		);
		if (note) {
			this.chatContainer.addChild(new Spacer(1));
			this.chatContainer.addChild(
				new Markdown(note, 1, 0, this.getMarkdownThemeWithSettings(), {
					color: (text) => theme.fg("muted", text),
				}),
			);
			this.chatContainer.addChild(new Spacer(1));
		}
		this.chatContainer.addChild(new Text(changelogLine, 1, 0));
		this.chatContainer.addChild(new DynamicBorder((text) => theme.fg("warning", text)));
		this.ui.requestRender();
	}

	showPackageUpdateNotification(packages: string[]): void {
		const action = theme.fg("accent", `${APP_NAME} update --extensions`);
		const updateInstruction = theme.fg("muted", t("update.packagesInstruction", { command: action }));
		const packageLines = packages.map((pkg) => `- ${pkg}`).join("\n");

		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new DynamicBorder((text) => theme.fg("warning", text)));
		this.chatContainer.addChild(
			new Text(
				`${theme.bold(theme.fg("warning", t("update.packagesAvailable")))}\n${updateInstruction}\n${theme.fg("muted", t("update.packages"))}\n${packageLines}`,
				1,
				0,
			),
		);
		this.chatContainer.addChild(new DynamicBorder((text) => theme.fg("warning", text)));
		this.ui.requestRender();
	}

	/**
	 * Get all queued messages (read-only).
	 * Combines session queue and compaction queue.
	 */
	private getAllQueuedMessages(): { steering: string[]; followUp: string[] } {
		return {
			steering: [
				...this.session.getSteeringMessages(),
				...this.compactionQueuedMessages.filter((msg) => msg.mode === "steer").map((msg) => msg.text),
			],
			followUp: [
				...this.session.getFollowUpMessages(),
				...this.compactionQueuedMessages.filter((msg) => msg.mode === "followUp").map((msg) => msg.text),
			],
		};
	}

	/**
	 * Clear all queued messages and return their contents.
	 * Clears both session queue and compaction queue.
	 */
	private clearAllQueues(): { steering: string[]; followUp: string[] } {
		const { steering, followUp } = this.session.clearQueue();
		const compactionSteering = this.compactionQueuedMessages
			.filter((msg) => msg.mode === "steer")
			.map((msg) => msg.text);
		const compactionFollowUp = this.compactionQueuedMessages
			.filter((msg) => msg.mode === "followUp")
			.map((msg) => msg.text);
		this.compactionQueuedMessages = [];
		return {
			steering: [...steering, ...compactionSteering],
			followUp: [...followUp, ...compactionFollowUp],
		};
	}

	private updatePendingMessagesDisplay(): void {
		this.pendingMessagesContainer.clear();
		const { steering: steeringMessages, followUp: followUpMessages } = this.getAllQueuedMessages();
		if (steeringMessages.length > 0 || followUpMessages.length > 0) {
			this.pendingMessagesContainer.addChild(new Spacer(1));
			for (const message of steeringMessages) {
				const text = theme.fg("dim", `引导消息：${message}`);
				this.pendingMessagesContainer.addChild(new TruncatedText(text, 1, 0));
			}
			for (const message of followUpMessages) {
				const text = theme.fg("dim", `后续消息：${message}`);
				this.pendingMessagesContainer.addChild(new TruncatedText(text, 1, 0));
			}
			const dequeueHint = this.getAppKeyDisplay("app.message.dequeue");
			const hintText = theme.fg("dim", `${uiGlyphs.branch} ${dequeueHint} 编辑全部排队消息`);
			this.pendingMessagesContainer.addChild(new TruncatedText(hintText, 1, 0));
		}
	}

	private restoreQueuedMessagesToEditor(options?: { abort?: boolean; currentText?: string }): number {
		const { steering, followUp } = this.clearAllQueues();
		const allQueued = [...steering, ...followUp];
		if (allQueued.length === 0) {
			this.updatePendingMessagesDisplay();
			if (options?.abort) {
				this.agent.abort();
			}
			return 0;
		}
		const queuedText = allQueued.join("\n\n");
		const currentText = options?.currentText ?? this.editor.getText();
		const combinedText = [queuedText, currentText].filter((t) => t.trim()).join("\n\n");
		this.editor.setText(combinedText);
		this.updatePendingMessagesDisplay();
		if (options?.abort) {
			this.agent.abort();
		}
		return allQueued.length;
	}

	private queueCompactionMessage(text: string, mode: "steer" | "followUp"): void {
		this.compactionQueuedMessages.push({ text, mode });
		this.editor.addToHistory?.(text);
		this.editor.setText("");
		this.updatePendingMessagesDisplay();
		this.showStatus("消息已排队，将在压缩完成后发送");
	}

	private isExtensionCommand(text: string): boolean {
		if (!text.startsWith("/")) return false;

		const extensionRunner = this.session.extensionRunner;

		const spaceIndex = text.indexOf(" ");
		const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
		return !!extensionRunner.getCommand(commandName);
	}

	private async flushCompactionQueue(options?: { willRetry?: boolean }): Promise<void> {
		if (this.compactionQueuedMessages.length === 0) {
			return;
		}

		const queuedMessages = [...this.compactionQueuedMessages];
		this.compactionQueuedMessages = [];
		this.updatePendingMessagesDisplay();

		const restoreQueue = (error: unknown) => {
			this.session.clearQueue();
			this.compactionQueuedMessages = queuedMessages;
			this.updatePendingMessagesDisplay();
			this.showError(
				`发送 ${queuedMessages.length} 条排队消息失败：${error instanceof Error ? error.message : String(error)}`,
			);
		};

		try {
			if (options?.willRetry) {
				// When retry is pending, queue messages for the retry turn
				for (const message of queuedMessages) {
					if (this.isExtensionCommand(message.text)) {
						await this.session.prompt(message.text);
					} else if (message.mode === "followUp") {
						await this.session.followUp(message.text);
					} else {
						await this.session.steer(message.text);
					}
				}
				this.updatePendingMessagesDisplay();
				return;
			}

			// Find first non-extension-command message to use as prompt
			const firstPromptIndex = queuedMessages.findIndex((message) => !this.isExtensionCommand(message.text));
			if (firstPromptIndex === -1) {
				// All extension commands - execute them all
				for (const message of queuedMessages) {
					await this.session.prompt(message.text);
				}
				return;
			}

			// Execute any extension commands before the first prompt
			const preCommands = queuedMessages.slice(0, firstPromptIndex);
			const firstPrompt = queuedMessages[firstPromptIndex];
			const rest = queuedMessages.slice(firstPromptIndex + 1);

			for (const message of preCommands) {
				await this.session.prompt(message.text);
			}

			// Start a prompt when idle, or queue it into a run still finishing compaction.
			const promptPromise = this.session
				.prompt(firstPrompt.text, { streamingBehavior: firstPrompt.mode })
				.catch((error) => {
					restoreQueue(error);
				});

			// Queue remaining messages
			for (const message of rest) {
				if (this.isExtensionCommand(message.text)) {
					await this.session.prompt(message.text);
				} else if (message.mode === "followUp") {
					await this.session.followUp(message.text);
				} else {
					await this.session.steer(message.text);
				}
			}
			this.updatePendingMessagesDisplay();
			void promptPromise;
		} catch (error) {
			restoreQueue(error);
		}
	}

	/** Move pending bash components from pending area to chat */
	private flushPendingBashComponents(): void {
		for (const component of this.pendingBashComponents) {
			this.pendingMessagesContainer.removeChild(component);
			this.chatContainer.addChild(component);
		}
		this.pendingBashComponents = [];
	}

	// =========================================================================
	// Selectors
	// =========================================================================

	private disposeActiveSelector(): void {
		const dispose = this.activeSelectorDispose;
		this.activeSelectorToken = undefined;
		this.activeSelectorDispose = undefined;
		dispose?.();
	}

	/**
	 * Shows a selector component in place of the editor.
	 * @param create Factory that receives a `done` callback and returns the component and focus target
	 */
	private showSelector(
		create: (done: () => void) => { component: Component; focus: Component; dispose?: () => void },
	): void {
		const token = {};
		let dispose: (() => void) | undefined;
		const done = () => {
			dispose?.();
			if (this.activeSelectorToken !== token) return;
			this.activeSelectorToken = undefined;
			this.activeSelectorDispose = undefined;
			this.editorContainer.clear();
			this.editorContainer.addChild(this.editor);
			this.ui.setFocus(this.editor);
		};
		const created = create(done);
		dispose = created.dispose;
		this.disposeActiveSelector();
		this.activeSelectorToken = token;
		this.activeSelectorDispose = dispose;
		this.editorContainer.clear();
		this.editorContainer.addChild(created.component);
		this.ui.setFocus(created.focus);
		this.ui.requestRender();
	}

	private showSettingsSelector(): void {
		this.showSelector((done) => {
			const selector = new SettingsSelectorComponent(
				{
					settingsManager: this.settingsManager,
					autoCompact: this.session.autoCompactionEnabled,
					steeringMode: this.session.steeringMode,
					followUpMode: this.session.followUpMode,
					currentTheme: this.themeController.getThemeSelection() || "dark",
					terminalTheme: this.themeController.getTerminalTheme(),
					availableThemes: getAvailableThemes(),
					tuiMode: this.ui.mode,
					fullscreenExitOutput: this.settingsManager.getFullscreenExitOutput(),
					fullscreenScrollbar: this.settingsManager.getFullscreenScrollbar(),
				},
				{
					onBeforeSettingChange: (id, value) => {
						if (id !== "tui-mode") return true;
						if (this.switchTuiMode(value as TuiMode)) return true;
						this.showStatus("请先关闭当前弹窗，再切换界面模式");
						return false;
					},
					onSettingChange: (id, value) => {
						switch (id) {
							case "autocompact":
								this.session.setAutoCompactionEnabled(value as boolean);
								break;
							case "show-images":
								for (const child of this.chatContainer.children) {
									if (child instanceof ToolExecutionComponent) child.setShowImages(value as boolean);
								}
								break;
							case "image-width-cells":
								for (const child of this.chatContainer.children) {
									if (child instanceof ToolExecutionComponent) child.setImageWidthCells(value as number);
								}
								break;
							case "skill-commands":
								this.setupAutocompleteProvider();
								break;
							case "steering-mode":
								this.session.setSteeringMode(value as "all" | "one-at-a-time");
								break;
							case "follow-up-mode":
								this.session.setFollowUpMode(value as "all" | "one-at-a-time");
								break;
							case "transport":
								this.session.agent.transport = value as Transport;
								break;
							case "http-idle-timeout":
								configureHttpDispatcher(value as number);
								this.showStatus(
									`HTTP 空闲超时：${localizeSettingValue("http-idle-timeout", formatHttpIdleTimeoutMs(value as number))}`,
								);
								break;
							case "theme":
								void this.themeController.setThemeSetting(value as string);
								break;
							case "hide-thinking":
								this.hideThinkingBlock = value as boolean;
								for (const child of this.chatContainer.children) {
									if (child instanceof AssistantMessageComponent) child.setHideThinkingBlock(value as boolean);
								}
								this.chatContainer.clear();
								this.rebuildChatFromMessages();
								break;
							case "thinking-display": {
								const mode = value as ThinkingDisplayMode;
								this.thinkingDisplayMode = mode;
								const showThinking = mode === "transcript";
								for (const child of this.chatContainer.children) {
									if (child instanceof AssistantMessageComponent) child.setShowThinking(showThinking);
								}
								this.streamingComponent?.setShowThinking(showThinking);
								if (this.turnActivity) {
									this.turnActivity.thinking =
										mode === "activity" && this.streamingMessage
											? getLatestThinkingActivityText(this.streamingMessage)
											: undefined;
									this.updateActivityBar();
								}
								this.ui.requestRender();
								break;
							}
							case "mermaid-rendering":
								this.chatContainer.invalidate();
								this.ui.requestRender();
								break;
							case "cache-miss-notices":
								this.rebuildChatFromMessages();
								break;
							case "show-hardware-cursor":
								this.ui.setShowHardwareCursor(value as boolean);
								break;
							case "editor-padding": {
								const effectivePadding = this.getEffectiveEditorPaddingX();
								this.defaultEditor.setPaddingX(effectivePadding);
								if (this.editor !== this.defaultEditor && this.editor.setPaddingX !== undefined) {
									this.editor.setPaddingX(effectivePadding);
								}
								break;
							}
							case "output-padding": {
								const padding = value as 0 | 1;
								this.outputPad = padding;
								if (this.streamingComponent || this.session.isStreaming) {
									for (const child of this.chatContainer.children) {
										if (
											child instanceof AssistantMessageComponent ||
											child instanceof CustomMessageComponent ||
											child instanceof UserMessageComponent
										) {
											child.setOutputPad(padding);
										}
									}
									this.streamingComponent?.setOutputPad(padding);
									this.ui.requestRender();
								} else {
									this.rebuildChatFromMessages();
								}
								break;
							}
							case "markdown-code-fences":
								this.rebuildChatFromMessages();
								break;
							case "autocomplete-max-visible":
								this.defaultEditor.setAutocompleteMaxVisible(value as number);
								if (this.editor !== this.defaultEditor && this.editor.setAutocompleteMaxVisible !== undefined) {
									this.editor.setAutocompleteMaxVisible(value as number);
								}
								break;
							case "clear-on-shrink":
								this.ui.setClearOnShrink(value as boolean);
								if (!value && !this.activeStatusIndicator) this.statusContainer.clear();
								break;
							case "fullscreen-scrollbar":
								this.applyFullscreenScrollbarSetting();
								break;
						}
					},
					onThemePreview: (themeName) => this.themeController.preview(themeName),
					onCancel: () => {
						done();
						this.ui.requestRender();
					},
				},
			);
			return { component: selector, focus: selector.getSettingsList() };
		});
	}

	private async handleModelCommand(searchTerm?: string): Promise<void> {
		if (!searchTerm) {
			this.showModelSelector();
			return;
		}

		const model = await this.findExactModelMatch(searchTerm);
		if (model) {
			try {
				await this.session.setModel(model);
				this.footer.invalidate();
				this.updateEditorBorderColor();
				this.showStatus(`当前模型：${model.id}`);
				void this.maybeWarnAboutAnthropicSubscriptionAuth(model);
				this.checkDaxnutsEasterEgg(model);
			} catch (error) {
				this.showError(error instanceof Error ? error.message : String(error));
			}
			return;
		}

		this.showModelSelector(searchTerm);
	}

	private async findExactModelMatch(searchTerm: string): Promise<Model<any> | undefined> {
		const cachedModels =
			this.session.scopedModels.length > 0
				? this.session.scopedModels.map((scoped) => scoped.model)
				: [...this.session.modelRuntime.getAvailableSnapshot()];
		const cachedMatch = findExactModelReferenceMatch(searchTerm, cachedModels);
		if (cachedMatch || this.session.scopedModels.length > 0) return cachedMatch;

		this.showStatus("正在刷新模型目录...");
		const controller = new AbortController();
		let timedOut = false;
		const timeout = setTimeout(() => {
			timedOut = true;
			controller.abort();
		}, 15_000);
		try {
			const result = await refreshModelCatalogs(this.session.modelRuntime, controller.signal);
			if (result.aborted && timedOut) {
				this.showWarning("刷新模型目录超时，将搜索缓存模型。");
			} else if (result.errors.size > 0) {
				this.showWarning(`无法刷新 ${[...result.errors.keys()].join("、")}，将搜索缓存模型。`);
			}
		} catch (error) {
			this.showWarning(
				timedOut
					? "刷新模型目录超时，将搜索缓存模型。"
					: `无法刷新模型目录：${error instanceof Error ? error.message : String(error)}`,
			);
		} finally {
			clearTimeout(timeout);
		}
		return findExactModelReferenceMatch(searchTerm, [...this.session.modelRuntime.getAvailableSnapshot()]);
	}

	/** Update the footer's available provider count from the current snapshot without refreshing catalogs. */
	private updateAvailableProviderCount(): void {
		const models =
			this.session.scopedModels.length > 0
				? this.session.scopedModels.map((scoped) => scoped.model)
				: this.session.modelRuntime.getAvailableSnapshot();
		const uniqueProviders = new Set(models.map((model) => model.provider));
		this.footerDataProvider.setAvailableProviderCount(uniqueProviders.size);
	}

	private async maybeWarnAboutAnthropicSubscriptionAuth(
		model: Model<any> | undefined = this.session.model,
	): Promise<void> {
		if (this.settingsManager.getWarnings().anthropicExtraUsage === false) {
			return;
		}
		if (this.anthropicSubscriptionWarningShown) {
			return;
		}
		if (!model || model.provider !== "anthropic") {
			return;
		}

		try {
			if ((await this.session.modelRuntime.checkAuth("anthropic"))?.type === "oauth") {
				this.anthropicSubscriptionWarningShown = true;
				this.showWarning(ANTHROPIC_SUBSCRIPTION_AUTH_WARNING);
				return;
			}
			const apiKey = (await this.session.modelRuntime.getAuth(model.provider))?.auth.apiKey;
			if (!isAnthropicSubscriptionAuthKey(apiKey)) {
				return;
			}
			this.anthropicSubscriptionWarningShown = true;
			this.showWarning(ANTHROPIC_SUBSCRIPTION_AUTH_WARNING);
		} catch {
			// Ignore auth lookup failures for warning-only checks.
		}
	}

	private maybeSaveImplicitProjectTrustAfterReload(): boolean {
		const cwd = this.sessionManager.getCwd();
		if (this.autoTrustOnReloadCwd !== cwd) {
			return false;
		}
		if (!this.settingsManager.isProjectTrusted() || !hasTrustRequiringProjectResources(cwd)) {
			return false;
		}

		const trustStore = new ProjectTrustStore(this.runtimeHost.services.agentDir);
		try {
			if (trustStore.get(cwd) !== null) {
				this.autoTrustOnReloadCwd = undefined;
				return false;
			}
			trustStore.set(cwd, true);
			this.autoTrustOnReloadCwd = undefined;
			return true;
		} catch (error) {
			this.showWarning(`重新加载后无法保存项目可信状态：${error instanceof Error ? error.message : String(error)}`);
			return false;
		}
	}

	private showTrustSelector(): void {
		const cwd = this.sessionManager.getCwd();
		const trustStore = new ProjectTrustStore(this.runtimeHost.services.agentDir);
		const savedDecision = trustStore.getEntry(cwd);
		this.showSelector((done) => {
			const selector = new TrustSelectorComponent({
				cwd,
				savedDecision,
				projectTrusted: this.settingsManager.isProjectTrusted(),
				onSelect: (selection) => {
					trustStore.setMany(selection.updates);
					done();
					this.showStatus(
						`已保存项目可信状态：${selection.trusted ? "信任" : "需确认"}。重启 ${APP_NAME} 后生效。`,
					);
				},
				onCancel: () => {
					done();
					this.ui.requestRender();
				},
			});
			return { component: selector, focus: selector };
		});
	}

	private showModelSelector(initialSearchInput?: string): void {
		this.showSelector((done) => {
			const selector = new ModelSelectorComponent(
				this.ui,
				this.session.model,
				this.session.modelRuntime,
				this.session.scopedModels,
				async (model) => {
					try {
						await this.session.setModel(model);
						this.footer.invalidate();
						this.updateEditorBorderColor();
						done();
						this.showStatus(`当前模型：${model.id}`);
						void this.maybeWarnAboutAnthropicSubscriptionAuth(model);
						this.checkDaxnutsEasterEgg(model);
					} catch (error) {
						done();
						this.showError(error instanceof Error ? error.message : String(error));
					}
				},
				() => {
					done();
					this.ui.requestRender();
				},
				initialSearchInput,
			);
			return { component: selector, focus: selector, dispose: () => selector.dispose() };
		});
	}

	private showModelsSelector(): void {
		let availableModels = [...this.session.modelRuntime.getAvailableSnapshot()];
		let availableModelIds = new Set(availableModels.map((model) => `${model.provider}/${model.id}`));
		const configuredPatterns = this.settingsManager.getEnabledModels();
		const sessionScopedModels = this.session.scopedModels;
		const configuredEnabledIds = (models: readonly Model<any>[]): string[] | null => {
			if (!configuredPatterns?.length) return null;
			const resolved = resolveModelScopeFromModels(configuredPatterns, models);
			const ids = resolved.scopedModels.map((scoped) => `${scoped.model.provider}/${scoped.model.id}`);
			for (const diagnostic of resolved.diagnostics) {
				if (diagnostic.code === "no-match" && !ids.includes(diagnostic.pattern)) ids.push(diagnostic.pattern);
			}
			return ids;
		};

		if (availableModels.length === 0 && !configuredPatterns?.length && sessionScopedModels.length === 0) {
			this.showStatus("没有可用模型");
			return;
		}

		let currentEnabledIds =
			sessionScopedModels.length > 0
				? sessionScopedModels.map((scoped) => `${scoped.model.provider}/${scoped.model.id}`)
				: configuredEnabledIds(availableModels);
		let selectionChanged = false;

		const updateSessionModels = (enabledIds: string[] | null): void => {
			currentEnabledIds = enabledIds === null ? null : [...enabledIds];
			const hasEnabledAvailableModel = enabledIds?.some((id) => availableModelIds.has(id)) ?? false;
			const allAvailableModelsEnabled =
				enabledIds !== null && [...availableModelIds].every((id) => enabledIds.includes(id));
			if (enabledIds && hasEnabledAvailableModel && !allAvailableModelsEnabled) {
				const newScopedModels = resolveModelScopeFromModels(enabledIds, availableModels).scopedModels;
				this.session.setScopedModels(
					newScopedModels.map((scoped) => ({
						model: scoped.model,
						thinkingLevel: scoped.thinkingLevel,
					})),
				);
			} else {
				this.session.setScopedModels([]);
			}
			this.updateAvailableProviderCount();
			this.ui.requestRender();
		};

		this.showSelector((done) => {
			let disposed = false;
			let timedOut = false;
			const controller = new AbortController();
			const timeout = setTimeout(() => {
				timedOut = true;
				controller.abort();
			}, 15_000);
			const selector = new ScopedModelsSelectorComponent(
				{
					allModels: availableModels,
					enabledModelIds: currentEnabledIds,
					refreshStatus: "正在刷新模型目录...",
				},
				{
					onChange: (enabledIds) => {
						selectionChanged = true;
						updateSessionModels(enabledIds);
					},
					onPersist: (enabledIds) => {
						const allEnabled =
							enabledIds !== null &&
							enabledIds.length === availableModels.length &&
							enabledIds.every((id) => availableModelIds.has(id));
						const newPatterns = enabledIds === null || allEnabled ? undefined : enabledIds;
						this.settingsManager.setEnabledModels(newPatterns ? [...newPatterns] : undefined);
						this.showStatus("模型范围已保存到设置");
					},
					onCancel: () => {
						done();
						this.ui.requestRender();
					},
				},
			);
			void refreshModelCatalogs(this.session.modelRuntime, controller.signal)
				.then((result) => {
					if (disposed) return;
					availableModels = [...this.session.modelRuntime.getAvailableSnapshot()];
					availableModelIds = new Set(availableModels.map((model) => `${model.provider}/${model.id}`));
					if (!selectionChanged && sessionScopedModels.length === 0) {
						currentEnabledIds = configuredEnabledIds(availableModels);
						selector.updateModels(availableModels, currentEnabledIds);
					} else {
						selector.updateModels(availableModels);
					}
					if (currentEnabledIds !== null) updateSessionModels(currentEnabledIds);
					if (result.aborted && timedOut) {
						selector.setRefreshStatus("刷新模型目录超时，当前显示缓存模型。", "warning");
					} else if (result.errors.size > 0) {
						selector.setRefreshStatus(
							`无法刷新 ${[...result.errors.keys()].join("、")}，当前显示缓存模型。`,
							"warning",
						);
					} else {
						selector.setRefreshStatus("模型目录已刷新。", "success");
					}
					this.ui.requestRender();
				})
				.catch((error: unknown) => {
					if (disposed) return;
					selector.setRefreshStatus(
						timedOut
							? "刷新模型目录超时，当前显示缓存模型。"
							: `无法刷新模型目录：${error instanceof Error ? error.message : String(error)}`,
						"warning",
					);
					this.ui.requestRender();
				})
				.finally(() => clearTimeout(timeout));
			return {
				component: selector,
				focus: selector,
				dispose: () => {
					disposed = true;
					clearTimeout(timeout);
					controller.abort();
				},
			};
		});
	}

	private showUserMessageSelector(): void {
		const userMessages = this.session.getUserMessagesForForking();

		if (userMessages.length === 0) {
			this.showStatus("没有可用于创建分支的消息");
			return;
		}

		const initialSelectedId = userMessages[userMessages.length - 1]?.entryId;

		this.showSelector((done) => {
			const selector = new UserMessageSelectorComponent(
				userMessages.map((m) => ({ id: m.entryId, text: m.text })),
				async (entryId) => {
					done();
					try {
						const result = await this.runtimeHost.fork(entryId);
						if (result.cancelled) {
							this.ui.requestRender();
							return;
						}

						this.editor.setText(result.selectedText ?? "");
						this.showStatus("已创建分支会话");
					} catch (error: unknown) {
						this.showError(error instanceof Error ? error.message : String(error));
					}
				},
				() => {
					done();
					this.ui.requestRender();
				},
				initialSelectedId,
			);
			return { component: selector, focus: selector.getMessageList() };
		});
	}

	private async handleCloneCommand(): Promise<void> {
		const leafId = this.sessionManager.getLeafId();
		if (!leafId) {
			this.showStatus("当前还没有可复制的会话内容");
			return;
		}

		try {
			const result = await this.runtimeHost.fork(leafId, { position: "at" });
			if (result.cancelled) {
				this.ui.requestRender();
				return;
			}

			this.editor.setText("");
			this.showStatus("已复制为新会话");
		} catch (error: unknown) {
			this.showError(error instanceof Error ? error.message : String(error));
		}
	}

	private showTreeSelector(initialSelectedId?: string): void {
		const tree = this.sessionManager.getTree();
		const realLeafId = this.sessionManager.getLeafId();
		const initialFilterMode = this.settingsManager.getTreeFilterMode();

		if (tree.length === 0) {
			this.showStatus("当前会话没有内容");
			return;
		}

		this.showSelector((done) => {
			const selector = new TreeSelectorComponent(
				tree,
				realLeafId,
				this.ui.terminal.rows,
				async (entryId) => {
					// Selecting the current leaf is a no-op (already there)
					if (entryId === this.sessionManager.getLeafId()) {
						done();
						this.showStatus("已经位于该位置");
						return;
					}

					// Ask about summarization
					done(); // Close selector first

					// Loop until user makes a complete choice or cancels to tree
					let wantsSummary = false;
					let customInstructions: string | undefined;

					// Check if we should skip the prompt (user preference to always default to no summary)
					if (!this.settingsManager.getBranchSummarySkipPrompt()) {
						while (true) {
							const summaryChoice = await this.showExtensionSelector("是否生成分支摘要？", [
								"不生成摘要",
								"生成摘要",
								"使用自定义要求生成摘要",
							]);

							if (summaryChoice === undefined) {
								// User pressed escape - re-show tree selector with same selection
								this.showTreeSelector(entryId);
								return;
							}

							wantsSummary = summaryChoice !== "不生成摘要";

							if (summaryChoice === "使用自定义要求生成摘要") {
								customInstructions = await this.showExtensionEditor("分支摘要要求");
								if (customInstructions === undefined) {
									// User cancelled - loop back to summary selector
									continue;
								}
							}

							// User made a complete choice
							break;
						}
					}

					// The user committed to navigating: stop the active response first.
					if (this.session.isStreaming) {
						this.restoreQueuedMessagesToEditor();
						await this.session.abort();
					}

					// Set up escape handler and status indicator if summarizing
					let showingSummaryIndicator = false;
					const originalOnEscape = this.defaultEditor.onEscape;

					if (wantsSummary) {
						this.defaultEditor.onEscape = () => {
							this.session.abortBranchSummary();
						};
						this.chatContainer.addChild(new Spacer(1));
						this.showStatusIndicator(new BranchSummaryStatusIndicator(this.ui));
						showingSummaryIndicator = true;
						this.ui.requestRender();
					}

					try {
						const result = await this.session.navigateTree(entryId, {
							summarize: wantsSummary,
							customInstructions,
						});

						if (result.aborted) {
							// Summarization aborted - re-show tree selector with same selection
							this.showStatus("分支摘要已取消");
							this.showTreeSelector(entryId);
							return;
						}
						if (result.cancelled) {
							this.showStatus("切换位置已取消");
							return;
						}

						// Update UI
						this.workspace.resetScrollback();
						this.chatContainer.clear();
						this.renderInitialMessages();
						if (result.editorText && !this.editor.getText().trim()) {
							this.editor.setText(result.editorText);
						}
						this.showStatus("已切换到所选位置");
						void this.flushCompactionQueue({ willRetry: false });
					} catch (error) {
						this.showError(error instanceof Error ? error.message : String(error));
					} finally {
						if (showingSummaryIndicator) {
							this.clearStatusIndicator("branchSummary");
						}
						this.defaultEditor.onEscape = originalOnEscape;
					}
				},
				() => {
					done();
					this.ui.requestRender();
				},
				(entryId, label) => {
					this.sessionManager.appendLabelChange(entryId, label);
					this.ui.requestRender();
				},
				initialSelectedId,
				initialFilterMode,
			);
			selector.onCopy = async (text) => {
				if (!text) {
					this.showError("所选内容没有可复制的文本");
					return;
				}
				try {
					await copyToClipboard(text);
					this.showStatus("所选消息已复制到剪贴板");
				} catch (error) {
					this.showError(error instanceof Error ? error.message : String(error));
				}
			};
			return { component: selector, focus: selector };
		});
	}

	private showSessionSelector(): void {
		this.showSelector((done) => {
			const selector = new SessionSelectorComponent(
				(onProgress) =>
					SessionManager.list(this.sessionManager.getCwd(), this.sessionManager.getSessionDir(), onProgress),
				(onProgress) =>
					this.sessionManager.usesDefaultSessionDir()
						? SessionManager.listAll(onProgress)
						: SessionManager.listAll(this.sessionManager.getSessionDir(), onProgress),
				async (sessionPath) => {
					done();
					await this.handleResumeSession(sessionPath);
				},
				() => {
					done();
					this.ui.requestRender();
				},
				() => {
					void this.shutdown();
				},
				() => this.ui.requestRender(),
				{
					renameSession: async (sessionFilePath: string, nextName: string | undefined) => {
						const next = (nextName ?? "").trim();
						if (!next) return;
						const mgr = SessionManager.open(sessionFilePath);
						mgr.appendSessionInfo(next);
					},
					showRenameHint: true,
					keybindings: this.keybindings,
					recoveryAgentDir: this.runtimeHost.services.agentDir,
				},

				this.sessionManager.getSessionFile(),
			);
			return { component: selector, focus: selector };
		});
	}

	private async handleResumeSession(
		sessionPath: string,
		options?: Parameters<ExtensionCommandContext["switchSession"]>[1],
	): Promise<{ cancelled: boolean }> {
		this.clearStatusIndicator();
		try {
			const result = await this.runtimeHost.switchSession(sessionPath, {
				withSession: options?.withSession,
				projectTrustContextFactory: (cwd) => this.createProjectTrustContext(cwd),
			});
			if (result.cancelled) {
				return result;
			}
			this.showStatus("已继续该会话");
			return result;
		} catch (error: unknown) {
			if (error instanceof MissingSessionCwdError) {
				const selectedCwd = await this.promptForMissingSessionCwd(error);
				if (!selectedCwd) {
					this.showStatus("继续会话已取消");
					return { cancelled: true };
				}
				const result = await this.runtimeHost.switchSession(sessionPath, {
					cwdOverride: selectedCwd,
					withSession: options?.withSession,
					projectTrustContextFactory: (cwd) => this.createProjectTrustContext(cwd),
				});
				if (result.cancelled) {
					return result;
				}
				this.showStatus("已在当前目录继续会话");
				return result;
			}
			return this.handleFatalRuntimeError("继续会话失败", error);
		}
	}

	private getLoginProviderOptions(authType?: "oauth" | "api_key"): AuthSelectorProvider[] {
		const options: AuthSelectorProvider[] = [];
		for (const provider of this.session.modelRuntime.getProviders()) {
			const authStatus = this.session.modelRuntime.getProviderAuthStatus(provider.id);
			const status = authStatus.configured
				? {
						type: this.session.modelRuntime.isUsingOAuth(provider.id) ? ("oauth" as const) : ("api_key" as const),
						source: authStatus.label ?? authStatus.source,
					}
				: undefined;
			if ((!authType || authType === "oauth") && provider.auth.oauth) {
				options.push({
					id: provider.id,
					name: provider.name,
					authType: "oauth",
					method: provider.auth.oauth,
					status,
				});
			}
			if ((!authType || authType === "api_key") && provider.auth.apiKey) {
				options.push({
					id: provider.id,
					name: provider.name,
					authType: "api_key",
					method: provider.auth.apiKey,
					status,
				});
			}
		}
		return options.sort((a, b) => a.name.localeCompare(b.name));
	}

	private async getLogoutProviderOptions(): Promise<AuthSelectorProvider[]> {
		return (await this.session.modelRuntime.listCredentials({ signal: AbortSignal.timeout(15_000) }))
			.map(({ providerId, type }) => ({
				id: providerId,
				name: this.session.modelRuntime.getProvider(providerId)?.name ?? providerId,
				authType: type,
				status: { type, source: "已保存的凭据" },
			}))
			.sort((a, b) => a.name.localeCompare(b.name));
	}

	private findLoginProviderOptions(providerRef: string): AuthSelectorProvider[] {
		const normalizedProviderRef = providerRef.trim().toLowerCase();
		if (!normalizedProviderRef) {
			return [];
		}

		return this.getLoginProviderOptions().filter(
			(provider) =>
				provider.id.toLowerCase() === normalizedProviderRef ||
				provider.name.toLowerCase() === normalizedProviderRef,
		);
	}

	private async handleLoginCommand(providerRef?: string): Promise<void> {
		if (!providerRef) {
			this.showLoginAuthTypeSelector();
			return;
		}

		const providerOptions = this.findLoginProviderOptions(providerRef);
		if (providerOptions.length === 1) {
			await this.startProviderLogin(providerOptions[0]!);
			return;
		}

		if (providerOptions.length > 1) {
			const providerIds = new Set(providerOptions.map((provider) => provider.id));
			if (providerIds.size === 1) {
				this.showLoginAuthTypeSelector(providerOptions);
				return;
			}
		}

		this.showLoginProviderSelector(undefined, providerRef);
	}

	private async startProviderLogin(providerOption: AuthSelectorProvider): Promise<void> {
		if (providerOption.authType === "oauth") {
			await this.showLoginDialog(providerOption.id, providerOption.name);
		} else if (providerOption.method?.login) {
			await this.showApiKeyLoginDialog(providerOption.id, providerOption.name);
		} else {
			this.showAmbientAuthDialog(providerOption);
		}
	}

	private showLoginAuthTypeSelector(providerOptions?: AuthSelectorProvider[]): void {
		const oauthProvider = providerOptions?.find((provider) => provider.authType === "oauth");
		const oauthLoginLabel =
			oauthProvider?.method && "loginLabel" in oauthProvider.method ? oauthProvider.method.loginLabel : undefined;
		const subscriptionLabel = oauthLoginLabel ?? "使用账号登录";
		const apiKeyLabel = "使用 API key 登录";
		const availableAuthTypes = providerOptions
			? new Set(providerOptions.map((provider) => provider.authType))
			: new Set<AuthSelectorProvider["authType"]>(["oauth", "api_key"]);
		const options: string[] = [];
		if (availableAuthTypes.has("oauth")) {
			options.push(subscriptionLabel);
		}
		if (availableAuthTypes.has("api_key")) {
			options.push(apiKeyLabel);
		}

		if (options.length === 0) {
			this.showStatus("没有可用的登录方式");
			return;
		}

		if (providerOptions && options.length === 1) {
			const providerOption = providerOptions[0];
			if (providerOption) {
				void this.startProviderLogin(providerOption);
			}
			return;
		}

		const title = providerOptions?.[0] ? `选择 ${providerOptions[0].name} 的认证方式：` : "选择认证方式：";
		this.showSelector((done) => {
			const selector = new ExtensionSelectorComponent(
				title,
				options,
				(option) => {
					done();
					const authType = option === subscriptionLabel ? "oauth" : "api_key";
					if (providerOptions) {
						const providerOption = providerOptions.find((provider) => provider.authType === authType);
						if (providerOption) {
							void this.startProviderLogin(providerOption);
						}
						return;
					}
					this.showLoginProviderSelector(authType);
				},
				() => {
					done();
					this.ui.requestRender();
				},
			);
			return { component: selector, focus: selector };
		});
	}

	private showLoginProviderSelector(authType?: AuthSelectorProvider["authType"], initialSearchInput?: string): void {
		const providerOptions = this.getLoginProviderOptions(authType);
		if (providerOptions.length === 0) {
			const message =
				authType === "oauth"
					? "没有支持账号登录的 Provider"
					: authType === "api_key"
						? "没有支持 API key 的 Provider"
						: "没有可登录的 Provider";
			this.showStatus(message);
			return;
		}

		this.showSelector((done) => {
			const selector = new OAuthSelectorComponent(
				"login",
				providerOptions,
				async (providerId, selectedAuthType) => {
					done();

					const providerOption = providerOptions.find(
						(provider) => provider.id === providerId && provider.authType === selectedAuthType,
					);
					if (!providerOption) {
						return;
					}

					await this.startProviderLogin(providerOption);
				},
				() => {
					done();
					if (authType) {
						this.showLoginAuthTypeSelector();
					} else {
						this.ui.requestRender();
					}
				},
				initialSearchInput,
			);
			return { component: selector, focus: selector };
		});
	}

	private async showOAuthSelector(mode: "login" | "logout"): Promise<void> {
		if (mode === "login") {
			this.showLoginAuthTypeSelector();
			return;
		}

		let providerOptions: AuthSelectorProvider[];
		try {
			providerOptions = await this.getLogoutProviderOptions();
		} catch (error) {
			this.showError(`读取已保存凭据失败：${error instanceof Error ? error.message : String(error)}`);
			return;
		}
		if (providerOptions.length === 0) {
			this.showStatus(
				"没有可删除的登录信息。/logout 只删除通过 /login 保存的凭据，环境变量和 models.json 不受影响。",
			);
			return;
		}

		this.showSelector((done) => {
			const selector = new OAuthSelectorComponent(
				mode,
				providerOptions,
				async (providerId: string) => {
					done();

					const providerOption = providerOptions.find((provider) => provider.id === providerId);
					if (!providerOption) {
						return;
					}

					try {
						await this.session.modelRuntime.logout(providerOption.id, {
							signal: AbortSignal.timeout(15_000),
						});
						await this.updateAvailableProviderCount();
						const message =
							providerOption.authType === "oauth"
								? `已退出 ${providerOption.name}`
								: `已删除 ${providerOption.name} 保存的 API key，环境变量和 models.json 不受影响。`;
						this.showStatus(message);
					} catch (error: unknown) {
						const message = error instanceof Error ? error.message : String(error);
						this.showError(
							error instanceof CredentialSynchronizationError
								? `${providerOption.name} 的凭据已删除，但本地模型状态同步失败：${message}`
								: `退出登录失败：${message}`,
						);
					}
				},
				() => {
					done();
					this.ui.requestRender();
				},
			);
			return { component: selector, focus: selector };
		});
	}

	private async completeProviderAuthentication(
		providerId: string,
		providerName: string,
		authType: "oauth" | "api_key",
		previousModel: Model<any> | undefined,
	): Promise<void> {
		const actionLabel = authType === "oauth" ? `已登录 ${providerName}` : `已保存 ${providerName} 的 API key`;

		let selectedModel: Model<any> | undefined;
		let selectionError: string | undefined;
		if (isUnknownModel(previousModel)) {
			const availableModels = this.session.modelRuntime.getAvailableSnapshot();
			const providerModels = availableModels.filter((model) => model.provider === providerId);
			if (!hasDefaultModelProvider(providerId)) {
				selectionError = `${actionLabel}，但 Provider“${providerId}”没有配置默认模型。请使用 /model 选择模型。`;
			} else if (providerModels.length === 0) {
				selectionError = `${actionLabel}，但该 Provider 暂无可用模型。请使用 /model 选择模型。`;
			} else {
				const defaultModelId = defaultModelPerProvider[providerId];
				selectedModel = providerModels.find((model) => model.id === defaultModelId);
				if (!selectedModel) {
					selectionError = `${actionLabel}，但默认模型“${defaultModelId}”不可用。请使用 /model 选择模型。`;
				} else {
					try {
						await this.session.setModel(selectedModel);
					} catch (error: unknown) {
						selectedModel = undefined;
						const errorMessage = error instanceof Error ? error.message : String(error);
						selectionError = `${actionLabel}，但选择默认模型失败：${errorMessage}。请使用 /model 重新选择。`;
					}
				}
			}
		}

		await this.updateAvailableProviderCount();
		this.footer.invalidate();
		this.updateEditorBorderColor();
		if (selectedModel) {
			this.showStatus(`${actionLabel}，已选择 ${selectedModel.id}，凭据保存到 ${getAuthPath()}`);
			void this.maybeWarnAboutAnthropicSubscriptionAuth(selectedModel);
			this.checkDaxnutsEasterEgg(selectedModel);
		} else {
			this.showStatus(`${actionLabel}，凭据保存到 ${getAuthPath()}`);
			if (selectionError) {
				this.showError(selectionError);
			} else {
				void this.maybeWarnAboutAnthropicSubscriptionAuth();
			}
		}

		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 15_000);
		void this.session.modelRuntime
			.refresh({ providers: [providerId], signal: controller.signal })
			.then((result) => {
				if (result.aborted) {
					this.showWarning(`${actionLabel}，但刷新模型目录超时，当前使用缓存模型。`);
				} else if (result.errors.size > 0) {
					this.showWarning(`${actionLabel}，但模型目录刷新失败，当前使用缓存模型。`);
				}
				this.updateAvailableProviderCount();
				this.footer.invalidate();
				this.ui.requestRender();
			})
			.catch((error: unknown) => {
				this.showWarning(
					`${actionLabel}，但模型目录刷新失败：${error instanceof Error ? error.message : String(error)}`,
				);
			})
			.finally(() => clearTimeout(timeout));
	}

	private showAmbientAuthDialog(providerOption: AuthSelectorProvider): void {
		const restoreEditor = () => {
			this.editorContainer.clear();
			this.editorContainer.addChild(this.editor);
			this.ui.setFocus(this.editor);
			this.ui.requestRender();
		};

		const dialog = new LoginDialogComponent(
			this.ui,
			providerOption.id,
			() => restoreEditor(),
			providerOption.name,
			`${providerOption.name} 设置`,
		);
		dialog.showInfo(`${providerOption.method?.name ?? "认证"} 由 ${APP_NAME} 外部配置。`, [], true);

		this.editorContainer.clear();
		this.editorContainer.addChild(dialog);
		this.ui.setFocus(dialog);
		this.ui.requestRender();
	}

	private async showApiKeyLoginDialog(providerId: string, providerName: string): Promise<void> {
		const previousModel = this.session.model;

		const dialog = new LoginDialogComponent(
			this.ui,
			providerId,
			(_success, _message) => {
				// Completion handled below
			},
			providerName,
		);

		if (providerId === "amazon-bedrock") {
			dialog.showDetails([
				theme.fg("text", "也可以使用 AWS Profile、IAM key 或基于角色的凭据。"),
				theme.fg("muted", "参考："),
				theme.fg("accent", `  ${path.join(getDocsPath(), "providers.md")}`),
			]);
		}

		this.editorContainer.clear();
		this.editorContainer.addChild(dialog);
		this.ui.setFocus(dialog);
		this.ui.requestRender();

		const restoreEditor = () => {
			this.editorContainer.clear();
			this.editorContainer.addChild(this.editor);
			this.ui.setFocus(this.editor);
			this.ui.requestRender();
		};

		try {
			await this.loginProvider(dialog, providerId, "api_key");
			restoreEditor();
			await this.completeProviderAuthentication(providerId, providerName, "api_key", previousModel);
		} catch (error: unknown) {
			restoreEditor();
			const errorMsg = error instanceof Error ? error.message : String(error);
			if (error instanceof CredentialSynchronizationError) {
				this.showError(`已保存 ${providerName} 的 API key，但本地模型状态同步失败：${errorMsg}`);
			} else if (errorMsg !== "Login cancelled") {
				this.showError(`保存 ${providerName} 的 API key 失败：${errorMsg}`);
			}
		}
	}

	private showAuthSelect(
		dialog: LoginDialogComponent,
		prompt: Extract<AuthPrompt, { type: "select" }>,
	): Promise<string> {
		return new Promise((resolve, reject) => {
			const restoreDialog = () => {
				this.editorContainer.clear();
				this.editorContainer.addChild(dialog);
				this.ui.setFocus(dialog);
				this.ui.requestRender();
			};
			const labels = prompt.options.map((option) => option.label);
			const selector = new ExtensionSelectorComponent(
				prompt.message,
				labels,
				(optionLabel) => {
					restoreDialog();
					const id = prompt.options.find((option) => option.label === optionLabel)?.id;
					if (id) resolve(id);
					else reject(new Error("Login cancelled"));
				},
				() => {
					restoreDialog();
					reject(new Error("Login cancelled"));
				},
			);
			this.editorContainer.clear();
			this.editorContainer.addChild(selector);
			this.ui.setFocus(selector);
			this.ui.requestRender();
		});
	}

	private async showAuthPrompt(dialog: LoginDialogComponent, prompt: AuthPrompt): Promise<string> {
		let response: Promise<string>;
		if (prompt.type === "select") {
			response = this.showAuthSelect(dialog, prompt);
		} else if (prompt.type === "manual_code") {
			response = dialog.showManualInput(prompt.message);
		} else {
			response = dialog.showPrompt(prompt.message, prompt.placeholder);
		}
		if (!prompt.signal) return response;
		if (prompt.signal.aborted) throw new Error("Login cancelled");
		const signal = prompt.signal;
		let onAbort: (() => void) | undefined;
		const aborted = new Promise<string>((_resolve, reject) => {
			onAbort = () => reject(new Error("Login cancelled"));
			signal.addEventListener("abort", onAbort, { once: true });
		});
		try {
			return await Promise.race([response, aborted]);
		} finally {
			if (onAbort) signal.removeEventListener("abort", onAbort);
		}
	}

	private notifyAuthDialog(dialog: LoginDialogComponent, event: AuthEvent): void {
		if (event.type === "auth_url") {
			dialog.showAuth(event.url, event.instructions);
		} else if (event.type === "device_code") {
			dialog.showDeviceCode(event);
			dialog.showWaiting("正在等待认证...");
		} else if (event.type === "info") {
			dialog.showInfo(event.message, event.links);
		} else {
			dialog.showProgress(event.message);
		}
	}

	private async loginProvider(
		dialog: LoginDialogComponent,
		providerId: string,
		method: "api_key" | "oauth",
	): Promise<void> {
		await this.session.modelRuntime.login(providerId, method, {
			signal: dialog.signal,
			prompt: (prompt) => this.showAuthPrompt(dialog, prompt),
			notify: (event) => this.notifyAuthDialog(dialog, event),
		});
	}

	private async showLoginDialog(providerId: string, providerName: string): Promise<void> {
		const previousModel = this.session.model;
		const dialog = new LoginDialogComponent(this.ui, providerId, (_success, _message) => {}, providerName);
		this.editorContainer.clear();
		this.editorContainer.addChild(dialog);
		this.ui.setFocus(dialog);
		this.ui.requestRender();

		const restoreEditor = () => {
			this.editorContainer.clear();
			this.editorContainer.addChild(this.editor);
			this.ui.setFocus(this.editor);
			this.ui.requestRender();
		};

		try {
			await this.loginProvider(dialog, providerId, "oauth");
			restoreEditor();
			await this.completeProviderAuthentication(providerId, providerName, "oauth", previousModel);
		} catch (error: unknown) {
			restoreEditor();
			const errorMsg = error instanceof Error ? error.message : String(error);
			if (error instanceof CredentialSynchronizationError) {
				this.showError(`已登录 ${providerName}，但本地模型状态同步失败：${errorMsg}`);
			} else if (errorMsg !== "Login cancelled") {
				this.showError(`登录 ${providerName} 失败：${errorMsg}`);
			}
		}
	}

	// =========================================================================
	// Command handlers
	// =========================================================================

	private async handleReloadCommand(): Promise<void> {
		if (this.session.isStreaming) {
			this.showWarning("请等待当前回复完成后再重新加载。");
			return;
		}
		if (this.session.isCompacting) {
			this.showWarning("请等待上下文压缩完成后再重新加载。");
			return;
		}

		this.resetExtensionUI();

		const reloadBox = new Container();
		const borderColor = (s: string) => theme.fg("border", s);
		reloadBox.addChild(new DynamicBorder(borderColor));
		reloadBox.addChild(new Spacer(1));
		reloadBox.addChild(
			new Text(theme.fg("muted", "正在重新加载快捷键、Extension、Skill、Prompt、Theme 和上下文文件..."), 1, 0),
		);
		reloadBox.addChild(new Spacer(1));
		reloadBox.addChild(new DynamicBorder(borderColor));

		const previousEditor = this.editor;
		this.editorContainer.clear();
		this.editorContainer.addChild(reloadBox);
		this.ui.setFocus(reloadBox);
		this.ui.requestRender(true);
		await new Promise((resolve) => process.nextTick(resolve));

		const dismissReloadBox = (editor: Component) => {
			this.editorContainer.clear();
			this.editorContainer.addChild(editor);
			this.ui.setFocus(editor);
			this.ui.requestRender();
		};

		let chatRestoredBeforeSessionStart = false;
		let reloadBoxDismissed = false;
		const restoreChatBeforeSessionStart = () => {
			if (chatRestoredBeforeSessionStart) {
				return;
			}
			this.hideThinkingBlock = this.settingsManager.getHideThinkingBlock();
			this.thinkingDisplayMode = this.settingsManager.getThinkingDisplayMode();
			this.outputPad = this.settingsManager.getOutputPad();
			this.rebuildChatFromMessages();
			chatRestoredBeforeSessionStart = true;
		};

		try {
			await this.session.reload({ beforeSessionStart: restoreChatBeforeSessionStart });
			restoreChatBeforeSessionStart();
			this.keybindings.reload();
			const activeHeader = this.customHeader ?? this.builtInHeader;
			if (isExpandable(activeHeader)) {
				activeHeader.setExpanded(this.toolOutputExpanded);
			}
			setRegisteredThemes(this.session.resourceLoader.getThemes().themes);
			await this.themeController.applyFromSettings();
			this.applyRuntimeSettings();
			this.setupAutocompleteProvider();
			const runner = this.session.extensionRunner;
			this.setupExtensionShortcuts(runner);
			this.showLoadedResources({
				force: false,
				showDiagnosticsWhenQuiet: true,
				summary: true,
			});
			const savedImplicitProjectTrust = this.maybeSaveImplicitProjectTrustAfterReload();
			const modelsJsonError = this.session.modelRuntime.getError();
			if (modelsJsonError) {
				this.showError(`models.json 错误：${modelsJsonError}`);
			}
			this.showStatus(
				savedImplicitProjectTrust
					? "已重新加载快捷键、Extension、Skill、Prompt、Theme 和上下文文件，并保存项目可信状态"
					: "已重新加载快捷键、Extension、Skill、Prompt、Theme 和上下文文件",
			);
			dismissReloadBox(this.editor as Component);
			reloadBoxDismissed = true;
		} catch (error) {
			if (!reloadBoxDismissed) {
				dismissReloadBox(previousEditor as Component);
			}
			this.showError(`重新加载失败：${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private async handleExportCommand(text: string): Promise<void> {
		const outputPath = this.getPathCommandArgument(text, "/export");

		try {
			if (outputPath?.endsWith(".jsonl")) {
				const filePath = this.session.exportToJsonl(outputPath);
				this.showStatus(`会话已导出到：${filePath}`);
			} else {
				const filePath = await this.session.exportToHtml(outputPath, {
					themeName: theme.name,
				});
				this.showStatus(`会话已导出到：${filePath}`);
			}
		} catch (error: unknown) {
			this.showError(`导出会话失败：${error instanceof Error ? error.message : t("status.unknownError")}`);
		}
	}

	private getPathCommandArgument(text: string, command: "/export" | "/import"): string | undefined {
		if (text === command) {
			return undefined;
		}
		if (!text.startsWith(`${command} `)) {
			return undefined;
		}

		const argsString = text.slice(command.length + 1).trimStart();
		if (!argsString) {
			return undefined;
		}

		const firstChar = argsString[0];
		if (firstChar === '"' || firstChar === "'") {
			const closingQuoteIndex = argsString.indexOf(firstChar, 1);
			if (closingQuoteIndex < 0) {
				return undefined;
			}
			return argsString.slice(1, closingQuoteIndex);
		}

		const firstWhitespaceIndex = argsString.search(/\s/);
		if (firstWhitespaceIndex < 0) {
			return argsString;
		}
		return argsString.slice(0, firstWhitespaceIndex);
	}

	private async handleImportCommand(text: string): Promise<void> {
		const inputPath = this.getPathCommandArgument(text, "/import");
		if (!inputPath) {
			this.showError("用法：/import <path.jsonl>");
			return;
		}

		const confirmed = await this.showExtensionConfirm("导入会话", `用 ${inputPath} 替换当前会话？`);
		if (!confirmed) {
			this.showStatus("导入已取消");
			return;
		}

		try {
			this.clearStatusIndicator();
			const result = await this.runtimeHost.importFromJsonl(inputPath);
			if (result.cancelled) {
				this.showStatus("导入已取消");
				return;
			}
			this.showStatus(`已从 ${inputPath} 导入会话`);
		} catch (error: unknown) {
			if (error instanceof MissingSessionCwdError) {
				const selectedCwd = await this.promptForMissingSessionCwd(error);
				if (!selectedCwd) {
					this.showStatus("导入已取消");
					return;
				}
				const result = await this.runtimeHost.importFromJsonl(inputPath, selectedCwd);
				if (result.cancelled) {
					this.showStatus("导入已取消");
					return;
				}
				this.showStatus(`已从 ${inputPath} 导入会话`);
				return;
			}
			if (error instanceof SessionImportFileNotFoundError) {
				this.showError(`导入会话失败：${error.message}`);
				return;
			}
			await this.handleFatalRuntimeError("导入会话失败", error);
		}
	}

	private async handleShareCommand(): Promise<void> {
		const loader = new BorderedLoader(this.ui, theme, "正在创建 gist...");
		this.editorContainer.clear();
		this.editorContainer.addChild(loader);
		this.ui.setFocus(loader);
		this.ui.requestRender();
		const controller = new AbortController();
		let restored = false;
		const restoreEditor = () => {
			if (restored) return;
			restored = true;
			loader.dispose();
			this.editorContainer.clear();
			this.editorContainer.addChild(this.editor);
			this.ui.setFocus(this.editor);
			this.ui.requestRender();
		};
		loader.onAbort = () => controller.abort();

		try {
			const result = await this.runtimeHost.shareViaPrivateGist({
				signal: controller.signal,
				themeName: theme.name,
			});
			this.showStatus(`分享地址：${result.previewUrl}\nGist：${result.gistUrl}`);
		} catch (error: unknown) {
			if (controller.signal.aborted) this.showStatus("分享已取消");
			else this.showError(error instanceof Error ? error.message : t("status.unknownError"));
		} finally {
			restoreEditor();
		}
	}

	private async handleCopyCommand(
		options: { flashConfirmation?: boolean; preferSelection?: boolean } = {},
	): Promise<void> {
		if (
			options.preferSelection &&
			this.renderer instanceof LystarTUI &&
			!this.renderer.getCopyOnSelect() &&
			this.renderer.hasActiveSelection()
		) {
			await this.renderer.copyActiveSelectionToClipboard();
			return;
		}

		const text = this.session.getLastAssistantText();
		if (!text) {
			this.showError("还没有可复制的 Agent 消息");
			return;
		}

		try {
			await copyToClipboard(text);
			if (options.flashConfirmation && this.renderer instanceof LystarTUI) {
				this.renderer.flash("已复制");
			} else {
				this.showStatus("最近一条 Agent 消息已复制到剪贴板");
			}
		} catch (error) {
			this.showError(error instanceof Error ? error.message : String(error));
		}
	}

	private handleNameCommand(text: string): void {
		const name = text.replace(/^\/name\s*/, "").trim();
		if (!name) {
			const currentName = this.sessionManager.getSessionName();
			if (currentName) {
				this.chatContainer.addChild(new Spacer(1));
				this.chatContainer.addChild(new Text(theme.fg("dim", `会话名称：${currentName}`), 1, 0));
			} else {
				this.showWarning("用法：/name <name>");
			}
			this.ui.requestRender();
			return;
		}

		this.session.setSessionName(name);
		const sessionName = this.sessionManager.getSessionName();
		if (sessionName !== name) {
			this.showWarning(`会话名称已从 ${JSON.stringify(name)} 规范化为 ${JSON.stringify(sessionName)}`);
		}
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Text(theme.fg("dim", `会话名称已设置：${sessionName ?? name}`), 1, 0));
		this.ui.requestRender();
	}

	private handleSessionCommand(): void {
		const sessionInfo = this.session.getSessionInfo();

		let info = `${theme.bold("会话信息")}\n\n`;
		if (sessionInfo.name) {
			info += `${theme.fg("dim", "名称：")} ${sessionInfo.name}\n`;
		}
		info += `${theme.fg("dim", "文件：")} ${sessionInfo.sessionFile ?? "仅存于内存"}\n`;
		info += `${theme.fg("dim", "ID：")} ${sessionInfo.sessionId}\n\n`;
		info += `${theme.bold("消息")}\n`;
		info += `${theme.fg("dim", "总数：")} ${sessionInfo.messages.total}\n`;
		info += `${theme.fg("dim", "用户：")} ${sessionInfo.messages.user}\n`;
		info += `${theme.fg("dim", "Agent：")} ${sessionInfo.messages.agent}\n`;
		info += `${theme.fg("dim", "工具：")} ${sessionInfo.messages.toolCalls} 次调用，${sessionInfo.messages.toolResults} 次返回\n\n`;
		info += `${theme.bold("Token 用量（会话累计）")}\n`;
		// "Input" is the full prompt volume. With cache activity, split it into
		// cached (served from cache) vs uncached (everything else) - the only
		// provider-independent split. Cache writes, where reported, are a detail
		// of the uncached portion.
		const { input, cacheRead, cacheWrite } = sessionInfo.tokens;
		const promptTokens = input + cacheRead + cacheWrite;
		info += `${theme.fg("dim", "输入：")} ${promptTokens.toLocaleString()}\n`;
		if (promptTokens > 0 && (cacheRead > 0 || cacheWrite > 0)) {
			const hitRate = theme.fg("dim", `（${((cacheRead / promptTokens) * 100).toFixed(1)}%）`);
			info += `  ${theme.fg("dim", "缓存命中：")} ${cacheRead.toLocaleString()} ${hitRate}\n`;
			const written = cacheWrite > 0 ? ` ${theme.fg("dim", `（写入缓存 ${cacheWrite.toLocaleString()}）`)}` : "";
			info += `  ${theme.fg("dim", "未缓存：")} ${(input + cacheWrite).toLocaleString()}${written}\n`;
		}
		info += `${theme.fg("dim", "输出：")} ${sessionInfo.tokens.output.toLocaleString()}\n`;
		info += `${theme.fg("dim", "合计：")} ${sessionInfo.tokens.total.toLocaleString()}\n`;

		if (sessionInfo.cost > 0 || sessionInfo.cacheWaste.missedTokens > 0) {
			info += `\n${theme.bold("费用")}\n`;
			info += `${theme.fg("dim", "合计：")} $${sessionInfo.cost.toFixed(3)}`;
			if (sessionInfo.usageBreakdown.length > 1) {
				for (const entry of sessionInfo.usageBreakdown) {
					info += `\n  ${theme.fg("dim", `${entry.key}:`)} $${entry.cost.toFixed(3)} ${theme.fg("dim", `（${formatTokens(entry.tokens)} Token）`)}`;
				}
			}
			if (sessionInfo.cacheWaste.missedTokens > 0) {
				const detail = `${sessionInfo.cacheWaste.missedTokens.toLocaleString()} Token，${sessionInfo.cacheWaste.missCount} 次未命中`;
				info +=
					sessionInfo.cacheWaste.missedCost >= 0.0001
						? `\n${theme.fg("dim", "Cache 重复计费：")} $${sessionInfo.cacheWaste.missedCost.toFixed(3)} ${theme.fg("dim", `（${detail}）`)}`
						: `\n${theme.fg("dim", "Cache 重复计费：")} ${detail}`;
			}
		}

		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Text(info, 1, 0));
		this.ui.requestRender();
	}

	private runGit(args: string[]): string | undefined {
		const git = getGitRuntime();
		const result = spawnSync(git.command, ["--no-optional-locks", ...args], {
			cwd: this.sessionManager.getCwd(),
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			maxBuffer: 16 * 1024 * 1024,
			env: git.env,
		});
		return result.status === 0 ? result.stdout : undefined;
	}

	private getWorkspaceChanges(): { gitAvailable: boolean; files: WorkspaceChangeFile[] } {
		if (this.runGit(["rev-parse", "--is-inside-work-tree"])?.trim() !== "true") {
			return { gitAvailable: false, files: [] };
		}
		const statusOutput = this.runGit(["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", "."]);
		if (statusOutput === undefined) return { gitAvailable: false, files: [] };

		const numstat = new Map<string, { additions: number; deletions: number }>();
		for (const line of (this.runGit(["diff", "--numstat", "HEAD", "--", "."]) ?? "").split("\n")) {
			const [added, deleted, filePath] = line.split("\t");
			if (!filePath || added === "-" || deleted === "-") continue;
			const additions = Number.parseInt(added ?? "", 10);
			const deletions = Number.parseInt(deleted ?? "", 10);
			if (Number.isFinite(additions) && Number.isFinite(deletions)) {
				numstat.set(filePath, { additions, deletions });
			}
		}

		const files: WorkspaceChangeFile[] = [];
		const records = statusOutput.split("\0").filter(Boolean);
		for (let index = 0; index < records.length; index++) {
			const record = records[index]!;
			const status = record.slice(0, 2);
			const filePath = record.slice(3);
			if (!filePath) continue;
			const stats = numstat.get(filePath);
			files.push({ path: filePath, status, ...stats });
			if (status.includes("R") || status.includes("C")) index++;
		}
		return { gitAvailable: true, files };
	}

	private async loadWorkspaceDiff(filePath: string): Promise<string | undefined> {
		return new Promise((resolve) => {
			const git = getGitRuntime();
			execFile(
				git.command,
				["--no-optional-locks", "diff", "--no-ext-diff", "--unified=3", "HEAD", "--", filePath],
				{
					cwd: this.sessionManager.getCwd(),
					encoding: "utf8",
					maxBuffer: 16 * 1024 * 1024,
					env: git.env,
				},
				(error, stdout) => resolve(error ? undefined : stdout.trimEnd() || undefined),
			);
		});
	}

	private collectAgentWorkbenchAgents(): AgentWorkbenchAgent[] {
		const agents = new Map<string, AgentWorkbenchAgent>();
		for (const entry of this.sessionManager.getBranch()) {
			if (entry.type !== "message" || entry.message.role !== "toolResult") continue;
			if (entry.message.toolName !== "subagent") continue;
			const details = entry.message.details as Partial<SubagentDetails> | undefined;
			if (!Array.isArray(details?.results)) continue;
			for (let index = 0; index < details.results.length; index++) {
				const result = details.results[index] as Partial<SingleResult>;
				if (typeof result.agent !== "string") continue;
				const agentId = result.agentId ?? `${details.runId ?? entry.id}:${index + 1}`;
				const state: AgentRunState =
					result.state ?? (result.exitCode === -1 ? "running" : result.exitCode === 0 ? "succeeded" : "failed");
				const messages = Array.isArray(result.messages) ? result.messages : [];
				const detail =
					result.errorMessage ||
					result.stderr ||
					result.finalOutput ||
					getSubagentFinalOutput(messages) ||
					(result.currentAction ? `正在执行 ${result.currentAction}` : undefined);
				agents.set(agentId, {
					agentId,
					agent: result.agent,
					task: result.task,
					state,
					controllable: Boolean(result.session),
					detail,
					agentSource: result.agentSource,
					agentScope: details.agentScope,
					session: result.session,
					legacyMessages: result.messages,
				});
			}
		}

		for (const snapshot of getCurrentSubagentRuns()) {
			const persisted = agents.get(snapshot.agentId);
			agents.set(snapshot.agentId, {
				agentId: snapshot.agentId,
				agent: snapshot.agent,
				task: snapshot.task,
				state: snapshot.state,
				controllable: snapshot.controllable || Boolean(snapshot.session ?? persisted?.session),
				detail: snapshot.currentAction ? `正在执行 ${snapshot.currentAction}` : persisted?.detail,
				agentSource: snapshot.agentSource ?? persisted?.agentSource,
				agentScope: persisted?.agentScope,
				session: snapshot.session ?? persisted?.session,
				legacyMessages: persisted?.legacyMessages,
			});
		}
		return [...agents.values()];
	}

	private subagentStatusLabel(state: AgentRunState): string {
		if (state === "queued") return "排队中";
		if (state === "running") return "运行中";
		if (state === "waiting") return "等待中";
		if (state === "succeeded") return "已完成";
		if (state === "failed") return "失败";
		return "已取消";
	}

	private async loadSubagentMessages(target: SubagentRunTarget): Promise<AgentMessage[]> {
		try {
			const live = await getLiveSubagentMessages(target.agentId);
			if (live) return live;
		} catch {}
		if (target.session && fs.existsSync(target.session.sessionFile)) {
			const session = SessionManager.open(target.session.sessionFile);
			return session.getBranch().flatMap((entry) => sessionEntryToContextMessages(entry)) as AgentMessage[];
		}
		return (target.legacyMessages ?? []) as AgentMessage[];
	}

	private openSubagentSession(target: SubagentRunTarget): void {
		let handle: OverlayHandle | undefined;
		let unsubscribe: (() => void) | undefined;
		let refreshTimer: NodeJS.Timeout | undefined;
		let closed = false;
		const editor = target.session
			? new CustomEditor(this.ui, getEditorTheme(), this.keybindings, {
					paddingX: this.workspace.isFullscreen() ? 2 : 1,
					autocompleteMaxVisible: this.settingsManager.getAutocompleteMaxVisible(),
				})
			: undefined;
		const editorContainer = editor ? new Container() : undefined;
		if (editor && editorContainer) editorContainer.addChild(editor);
		const composer = editorContainer
			? new WorkspaceComposer({
					editor: editorContainer,
					brand: APP_TITLE,
					getInfo: () => this.getWorkspaceComposerInfo(),
					fullscreen: this.workspace.isFullscreen(),
				})
			: undefined;
		const close = () => {
			closed = true;
			if (refreshTimer) clearTimeout(refreshTimer);
			unsubscribe?.();
			handle?.hide();
		};
		const view = new SubagentSessionViewComponent({
			agent: target.agent,
			status: this.subagentStatusLabel(target.state),
			readOnly: !target.session,
			editor,
			composer,
			getHeight: () => this.ui.terminal.rows,
			requestRender: () => this.ui.requestRender(),
			renderMessages: (messages) =>
				this.materializeSubagentMessages(messages, target.session?.cwd ?? this.sessionManager.getCwd()),
			onOpenSubagent: (nestedTarget) => this.openSubagentSession(nestedTarget),
			getLinkAtScreenPosition: (row, column) =>
				this.ui instanceof LystarTUI ? this.ui.getLinkAtScreenPosition(row, column) : undefined,
			openLinkAtScreenPosition: (row, column) =>
				this.ui instanceof LystarTUI && this.ui.openLinkAtScreenPosition(row, column),
			onReturn: close,
			onAbort: () => {
				void abortSubagent(target.agentId).catch((error) =>
					view.setStatus(`取消失败：${error instanceof Error ? error.message : String(error)}`),
				);
			},
			overlayTop: 1,
		});
		const refresh = async () => {
			if (closed) return;
			const messages = await this.loadSubagentMessages(target);
			if (closed) return;
			view.setMessages(messages);
			const snapshot = getCurrentSubagentRuns().find((run) => run.agentId === target.agentId);
			view.setStatus(snapshot ? this.subagentStatusLabel(snapshot.state) : this.subagentStatusLabel(target.state));
		};
		const scheduleRefresh = () => {
			if (refreshTimer || closed) return;
			refreshTimer = setTimeout(() => {
				refreshTimer = undefined;
				void refresh();
			}, 32);
		};
		const bindEvents = () => {
			unsubscribe?.();
			unsubscribe = subscribeSubagent(target.agentId, scheduleRefresh);
		};
		if (editor && target.session) {
			editor.onSubmit = (text) => {
				const message = text.trim();
				if (!message) return;
				editor.setText("");
				const descriptor: SubagentSessionDescriptor = {
					agentId: target.agentId,
					agent: target.agent,
					agentSource: target.agentSource,
					task: target.task,
					agentScope: target.agentScope,
					session: target.session!,
				};
				view.setStatus("发送中");
				void continueSubagentSession(descriptor, message)
					.then(() => {
						bindEvents();
						void refresh();
					})
					.catch((error) => view.setStatus(`发送失败：${error instanceof Error ? error.message : String(error)}`));
			};
		}
		handle = this.ui.showOverlay(view, {
			row: 1,
			col: 1,
			width: Math.max(1, this.ui.terminal.columns - 2),
			maxHeight: Math.max(1, this.ui.terminal.rows - 2),
		});
		bindEvents();
		void refresh();
	}

	private handleAgentsCommand(initialAgentId?: string): void {
		const data = { agents: this.collectAgentWorkbenchAgents() };
		let handle: OverlayHandle | undefined;
		const workbench = new AgentWorkbenchComponent({
			data,
			getAgents: () => this.collectAgentWorkbenchAgents(),
			initialAgentId,
			getHeight: () => this.ui.terminal.rows,
			requestRender: () => this.ui.requestRender(),
			onReturn: () => handle?.hide(),
			onOpen: (agent) => {
				handle?.hide();
				this.openSubagentSession({
					agentId: agent.agentId,
					agent: agent.agent,
					agentSource: agent.agentSource ?? "unknown",
					agentScope: agent.agentScope ?? "user",
					task: agent.task ?? "",
					state: agent.state,
					finalOutput: agent.detail,
					session: agent.session,
					legacyMessages: agent.legacyMessages,
				});
			},
			onAbort: (agent) => {
				void abortSubagent(agent.agentId)
					.then(() => this.showStatus(`已取消 ${agent.agent}`))
					.catch((error) =>
						this.showError(`取消 ${agent.agent} 失败：${error instanceof Error ? error.message : String(error)}`),
					);
			},
			overlayTop: 1,
		});
		handle = this.ui.showOverlay(workbench, {
			row: 1,
			col: 1,
			width: Math.max(1, this.ui.terminal.columns - 2),
			maxHeight: Math.max(1, this.ui.terminal.rows - 2),
		});
		this.ui.requestRender();
	}

	private handleChangesCommand(): void {
		const workspace = this.getWorkspaceChanges();
		const turnFiles = this.getCurrentTurnFiles();
		let handle: OverlayHandle | undefined;
		const selector = new ChangesSelectorComponent({
			data: {
				turnFiles,
				workspaceFiles: workspace.files,
				gitAvailable: workspace.gitAvailable,
				loadWorkspaceDiff: (filePath) => this.loadWorkspaceDiff(filePath),
			},
			getHeight: () => this.ui.terminal.rows,
			requestRender: () => this.ui.requestRender(),
			onCancel: () => handle?.hide(),
			overlayTop: 1,
		});
		handle = this.ui.showOverlay(selector, {
			row: 1,
			col: 1,
			width: Math.max(1, this.ui.terminal.columns - 2),
			maxHeight: Math.max(1, this.ui.terminal.rows - 2),
		});
		this.ui.requestRender();
	}

	private handleChangelogCommand(): void {
		const changelogMarkdown = getFullChangelogMarkdown();

		if (this.workspace.isFullscreen()) {
			let handle: OverlayHandle | undefined;
			const viewer = new ChangelogViewerComponent({
				markdown: changelogMarkdown,
				title: t("update.changelogTitle", { app: APP_TITLE }),
				markdownTheme: this.getMarkdownThemeWithSettings(),
				getHeight: () => this.ui.terminal.rows,
				requestRender: () => this.ui.requestRender(),
				onCancel: () => handle?.hide(),
			});
			handle = this.ui.showOverlay(viewer, {
				row: 1,
				col: 1,
				width: Math.max(1, this.ui.terminal.columns - 2),
				maxHeight: Math.max(1, this.ui.terminal.rows - 2),
			});
			this.ui.requestRender();
			return;
		}

		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new DynamicBorder());
		this.chatContainer.addChild(
			new Text(theme.bold(theme.fg("accent", t("update.changelogTitle", { app: APP_TITLE }))), 1, 0),
		);
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Markdown(changelogMarkdown, 1, 1, this.getMarkdownThemeWithSettings()));
		this.chatContainer.addChild(new DynamicBorder());
		this.ui.requestRender();
	}

	/**
	 * Get capitalized display string for an app keybinding action.
	 */
	private getAppKeyDisplay(action: AppKeybinding): string {
		return keyDisplayText(action);
	}

	/**
	 * Get capitalized display string for an editor keybinding action.
	 */
	private getEditorKeyDisplay(action: Keybinding): string {
		return keyDisplayText(action);
	}

	private handleHotkeysCommand(): void {
		// Navigation keybindings
		const cursorUp = this.getEditorKeyDisplay("tui.editor.cursorUp");
		const cursorDown = this.getEditorKeyDisplay("tui.editor.cursorDown");
		const cursorLeft = this.getEditorKeyDisplay("tui.editor.cursorLeft");
		const cursorRight = this.getEditorKeyDisplay("tui.editor.cursorRight");
		const cursorWordLeft = this.getEditorKeyDisplay("tui.editor.cursorWordLeft");
		const cursorWordRight = this.getEditorKeyDisplay("tui.editor.cursorWordRight");
		const cursorLineStart = this.getEditorKeyDisplay("tui.editor.cursorLineStart");
		const cursorLineEnd = this.getEditorKeyDisplay("tui.editor.cursorLineEnd");
		const jumpForward = this.getEditorKeyDisplay("tui.editor.jumpForward");
		const jumpBackward = this.getEditorKeyDisplay("tui.editor.jumpBackward");
		const pageUp = this.getEditorKeyDisplay("tui.editor.pageUp");
		const pageDown = this.getEditorKeyDisplay("tui.editor.pageDown");

		// Editing keybindings
		const submit = this.getEditorKeyDisplay("tui.input.submit");
		const newLine = this.getEditorKeyDisplay("tui.input.newLine");
		const deleteWordBackward = this.getEditorKeyDisplay("tui.editor.deleteWordBackward");
		const deleteWordForward = this.getEditorKeyDisplay("tui.editor.deleteWordForward");
		const deleteToLineStart = this.getEditorKeyDisplay("tui.editor.deleteToLineStart");
		const deleteToLineEnd = this.getEditorKeyDisplay("tui.editor.deleteToLineEnd");
		const yank = this.getEditorKeyDisplay("tui.editor.yank");
		const yankPop = this.getEditorKeyDisplay("tui.editor.yankPop");
		const undo = this.getEditorKeyDisplay("tui.editor.undo");
		const tab = this.getEditorKeyDisplay("tui.input.tab");

		// App keybindings
		const interrupt = this.getAppKeyDisplay("app.interrupt");
		const clear = this.getAppKeyDisplay("app.clear");
		const exit = this.getAppKeyDisplay("app.exit");
		const suspend = this.getAppKeyDisplay("app.suspend");
		const cycleThinkingLevel = this.getAppKeyDisplay("app.thinking.cycle");
		const cycleModelForward = this.getAppKeyDisplay("app.model.cycleForward");
		const selectModel = this.getAppKeyDisplay("app.model.select");
		const expandTools = this.getAppKeyDisplay("app.tools.expand");
		const toggleThinking = this.getAppKeyDisplay("app.thinking.toggle");
		const externalEditor = this.getAppKeyDisplay("app.editor.external");
		const cycleModelBackward = this.getAppKeyDisplay("app.model.cycleBackward");
		const copyMessage = this.getAppKeyDisplay("app.message.copy");
		const followUp = this.getAppKeyDisplay("app.message.followUp");
		const dequeue = this.getAppKeyDisplay("app.message.dequeue");
		const pasteImage = this.getAppKeyDisplay("app.clipboard.pasteImage");

		let hotkeys = `
**导航**
| 按键 | 操作 |
|-----|------|
| \`${cursorUp}\` / \`${cursorDown}\` / \`${cursorLeft}\` / \`${cursorRight}\` | 移动光标 / 浏览历史 |
| \`${cursorWordLeft}\` / \`${cursorWordRight}\` | 按单词移动 |
| \`${cursorLineStart}\` | 跳到行首 |
| \`${cursorLineEnd}\` | 跳到行尾 |
| \`${jumpForward}\` | 向前跳到指定字符 |
| \`${jumpBackward}\` | 向后跳到指定字符 |
| \`${pageUp}\` / \`${pageDown}\` | 按页滚动 |

**编辑**
| 按键 | 操作 |
|-----|------|
| \`${submit}\` | 发送消息 |
| \`${newLine}\` | 换行${process.platform === "win32" ? "（Windows Terminal 使用 Ctrl+Enter）" : ""} |
| \`${deleteWordBackward}\` | 删除前一个单词 |
| \`${deleteWordForward}\` | 删除后一个单词 |
| \`${deleteToLineStart}\` | 删除到行首 |
| \`${deleteToLineEnd}\` | 删除到行尾 |
| \`${yank}\` | 粘贴最近删除的文本 |
| \`${yankPop}\` | 粘贴后切换删除记录 |
| \`${undo}\` | 撤销 |

**其他**
| 按键 | 操作 |
|-----|------|
| \`${tab}\` | 补全路径 / 接受补全项 |
| \`${interrupt}\` | 关闭补全 / 取消当前回复 |
| \`${clear}\` | 第一次清空输入，第二次退出 |
| \`${exit}\` | 输入框为空时退出 |
| \`${suspend}\` | 挂起到后台 |
| \`${cycleThinkingLevel}\` | 切换思考强度 |
| \`${cycleModelForward}\` / \`${cycleModelBackward}\` | 切换模型 |
| \`${selectModel}\` | 打开模型选择器 |
| \`${expandTools}\` | 展开或折叠 Tool 输出 |
| \`${toggleThinking}\` | 展开或折叠思考过程 |
| \`${externalEditor}\` | 使用外部编辑器编辑消息 |
| \`${copyMessage}\` | 复制最近一条 Agent 消息 |
| \`${followUp}\` | 添加后续消息 |
| \`${dequeue}\` | 恢复排队消息 |
| \`${pasteImage}\` | 从剪贴板粘贴图片或文本 |
| \`/\` | 斜杠命令 |
| \`!\` | 运行 Shell 命令 |
| \`!!\` | 运行不写入上下文的 Shell 命令 |
`;

		// Add extension-registered shortcuts
		const extensionRunner = this.session.extensionRunner;
		const shortcuts = extensionRunner.getShortcuts(this.keybindings.getEffectiveConfig());
		if (shortcuts.size > 0) {
			hotkeys += `
**Extension 快捷键**
| 按键 | 操作 |
|-----|------|
`;
			for (const [key, shortcut] of shortcuts) {
				const description = shortcut.description ?? shortcut.extensionPath;
				const keyDisplay = formatKeyText(key, { capitalize: true });
				hotkeys += `| \`${keyDisplay}\` | ${description} |\n`;
			}
		}

		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new DynamicBorder());
		this.chatContainer.addChild(new Text(theme.bold(theme.fg("accent", "快捷键")), 1, 0));
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Markdown(hotkeys.trim(), 1, 1, this.getMarkdownThemeWithSettings()));
		this.chatContainer.addChild(new DynamicBorder());
		this.ui.requestRender();
	}

	private async handleClearCommand(): Promise<void> {
		this.clearStatusIndicator();
		try {
			const result = await this.runtimeHost.newSession();
			if (result.cancelled) {
				return;
			}
			this.chatContainer.addChild(new Spacer(1));
			this.chatContainer.addChild(new Text(`${theme.fg("accent", `${uiGlyphs.success} 已新建会话`)}`, 1, 1));
			this.ui.requestRender();
		} catch (error: unknown) {
			await this.handleFatalRuntimeError("新建会话失败", error);
		}
	}

	private handleDebugCommand(): void {
		const width = this.ui.terminal.columns;
		const height = this.ui.terminal.rows;
		const allLines = this.ui.render(width);

		const debugLogPath = getDebugLogPath();
		const debugData = [
			`Debug output at ${new Date().toISOString()}`,
			`Terminal: ${width}x${height}`,
			`Total lines: ${allLines.length}`,
			"",
			"=== All rendered lines with visible widths ===",
			...allLines.map((line, idx) => {
				const vw = visibleWidth(line);
				const escaped = JSON.stringify(line);
				return `[${idx}] (w=${vw}) ${escaped}`;
			}),
			"",
			"=== Agent messages (JSONL) ===",
			...this.session.messages.map((msg) => JSON.stringify(msg)),
			"",
		].join("\n");

		fs.mkdirSync(path.dirname(debugLogPath), { recursive: true });
		fs.writeFileSync(debugLogPath, debugData);

		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(
			new Text(
				`${theme.fg("accent", `${uiGlyphs.success} Debug log written`)}\n${theme.fg("muted", debugLogPath)}`,
				1,
				1,
			),
		);
		this.ui.requestRender();
	}

	private handleArminSaysHi(): void {
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new ArminComponent(this.ui));
		this.ui.requestRender();
	}

	private handleDementedDelves(): void {
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new EarendilAnnouncementComponent());
		this.ui.requestRender();
	}

	private handleDaxnuts(): void {
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new DaxnutsComponent(this.ui));
		this.ui.requestRender();
	}

	private checkDaxnutsEasterEgg(model: { provider: string; id: string }): void {
		if (model.provider === "opencode" && model.id.toLowerCase().includes("kimi-k2.5")) {
			this.handleDaxnuts();
		}
	}

	private async handleBashCommand(command: string, excludeFromContext = false): Promise<void> {
		const extensionRunner = this.session.extensionRunner;

		// Emit user_bash event to let extensions intercept
		const eventResult = await extensionRunner.emitUserBash({
			type: "user_bash",
			command,
			excludeFromContext,
			cwd: this.sessionManager.getCwd(),
		});

		// If extension returned a full result, use it directly
		if (eventResult?.result) {
			const result = eventResult.result;

			// Create UI component for display
			this.bashComponent = new BashExecutionComponent(command, this.ui, excludeFromContext);
			this.bashComponent.setExpanded(this.toolOutputExpanded);
			if (this.session.isStreaming) {
				this.pendingMessagesContainer.addChild(this.bashComponent);
				this.pendingBashComponents.push(this.bashComponent);
			} else {
				this.chatContainer.addChild(this.bashComponent);
			}

			// Show output and complete
			if (result.output) {
				this.bashComponent.appendOutput(result.output);
			}
			this.bashComponent.setComplete(
				result.exitCode,
				result.cancelled,
				result.truncated ? ({ truncated: true, content: result.output } as TruncationResult) : undefined,
				result.fullOutputPath,
			);

			// Record the result in session
			this.session.recordBashResult(command, result, { excludeFromContext });
			this.bashComponent = undefined;
			this.ui.requestRender();
			return;
		}

		// Normal execution path (possibly with custom operations)
		const isDeferred = this.session.isStreaming;
		this.bashComponent = new BashExecutionComponent(command, this.ui, excludeFromContext);
		this.bashComponent.setExpanded(this.toolOutputExpanded);

		if (isDeferred) {
			// Show in pending area when agent is streaming
			this.pendingMessagesContainer.addChild(this.bashComponent);
			this.pendingBashComponents.push(this.bashComponent);
		} else {
			// Show in chat immediately when agent is idle
			this.chatContainer.addChild(this.bashComponent);
		}
		this.ui.requestRender();

		try {
			const result = await this.session.executeBash(
				command,
				(chunk) => {
					if (this.bashComponent?.appendOutput(chunk)) {
						this.ui.requestRender();
					}
				},
				{ excludeFromContext, operations: eventResult?.operations },
			);

			if (this.bashComponent) {
				this.bashComponent.setComplete(
					result.exitCode,
					result.cancelled,
					result.truncated ? ({ truncated: true, content: result.output } as TruncationResult) : undefined,
					result.fullOutputPath,
				);
			}
		} catch (error) {
			if (this.bashComponent) {
				this.bashComponent.setComplete(undefined, false);
			}
			this.showError(`Shell 命令执行失败：${error instanceof Error ? error.message : t("status.unknownError")}`);
		}

		this.bashComponent = undefined;
		this.ui.requestRender();
	}

	private async handleCompactCommand(customInstructions?: string): Promise<void> {
		this.clearStatusIndicator();

		try {
			await this.session.compact(customInstructions);
		} catch {
			// Ignore, will be emitted as an event
		}
	}

	stop(fullscreenExitOutput = this.settingsManager.getFullscreenExitOutput()): void {
		this.disposeActiveSelector();
		if (this.settingsManager.getShowTerminalProgress()) {
			this.ui.terminal.setProgress(false);
		}
		this.clearStatusIndicator();
		this.themeController.disableAutoSync();
		this.clearExtensionTerminalInputListeners();
		this.activityBar.dispose();
		this.footer.dispose();
		this.footerDataProvider.dispose();
		if (this.unsubscribe) {
			this.unsubscribe();
		}
		if (this.isInitialized) {
			this.stopInteractiveTui(fullscreenExitOutput);
			this.isInitialized = false;
		}
		this.unregisterSignalHandlers();
	}
}
