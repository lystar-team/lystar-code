import type { SettingsManager } from "./settings-manager.ts";

export type LystarSettingValue = boolean | number | string;
export type LystarSettingKind = "boolean" | "enum" | "integer" | "string";

export interface LystarIntegerRange {
	min: number;
	max: number;
}

export interface LystarSettingDefinition {
	id: string;
	label: string;
	description: string;
	kind: LystarSettingKind;
	options?: readonly LystarSettingValue[];
	range?: LystarIntegerRange;
	scope: "global" | "project";
	restartRequired: boolean;
	uiVisible: boolean;
	get(settings: SettingsManager): LystarSettingValue;
	set(settings: SettingsManager, value: LystarSettingValue): void;
	format(value: LystarSettingValue): string;
}

const MAX_INTEGER = Number.MAX_SAFE_INTEGER;
const BOOLEAN_OPTIONS = [true, false] as const;

function invalidValue(id: string): never {
	throw new Error(`设置 ${id} 的值无效`);
}

function booleanSetting(
	id: string,
	label: string,
	description: string,
	get: (settings: SettingsManager) => boolean,
	set: (settings: SettingsManager, value: boolean) => void,
	options: { restartRequired?: boolean; uiVisible?: boolean } = {},
): LystarSettingDefinition {
	return {
		id,
		label,
		description,
		kind: "boolean",
		options: BOOLEAN_OPTIONS,
		scope: "global",
		restartRequired: options.restartRequired === true,
		uiVisible: options.uiVisible !== false,
		get,
		set: (settings, value) => {
			if (typeof value !== "boolean") invalidValue(id);
			set(settings, value);
		},
		format: (value) => (value === true ? "开启" : "关闭"),
	};
}

function enumSetting<T extends string>(
	id: string,
	label: string,
	description: string,
	options: readonly T[],
	get: (settings: SettingsManager) => T,
	set: (settings: SettingsManager, value: T) => void,
	settings: { restartRequired?: boolean; uiVisible?: boolean; format?: (value: T) => string } = {},
): LystarSettingDefinition {
	return {
		id,
		label,
		description,
		kind: "enum",
		options,
		scope: "global",
		restartRequired: settings.restartRequired === true,
		uiVisible: settings.uiVisible !== false,
		get,
		set: (manager, value) => {
			if (typeof value !== "string" || !options.includes(value as T)) invalidValue(id);
			set(manager, value as T);
		},
		format: (value) => settings.format?.(value as T) ?? String(value),
	};
}

function integerSetting(
	id: string,
	label: string,
	description: string,
	range: LystarIntegerRange,
	get: (settings: SettingsManager) => number,
	set: (settings: SettingsManager, value: number) => void,
	settings: { restartRequired?: boolean; uiVisible?: boolean; format?: (value: number) => string } = {},
): LystarSettingDefinition {
	return {
		id,
		label,
		description,
		kind: "integer",
		range,
		scope: "global",
		restartRequired: settings.restartRequired === true,
		uiVisible: settings.uiVisible !== false,
		get,
		set: (manager, value) => {
			if (typeof value !== "number" || !Number.isInteger(value) || value < range.min || value > range.max)
				invalidValue(id);
			set(manager, value);
		},
		format: (value) => settings.format?.(value as number) ?? String(value),
	};
}

function stringSetting(
	id: string,
	label: string,
	description: string,
	get: (settings: SettingsManager) => string,
	set: (settings: SettingsManager, value: string) => void,
	settings: { restartRequired?: boolean; uiVisible?: boolean } = {},
): LystarSettingDefinition {
	return {
		id,
		label,
		description,
		kind: "string",
		scope: "global",
		restartRequired: settings.restartRequired === true,
		uiVisible: settings.uiVisible !== false,
		get,
		set: (manager, value) => {
			if (typeof value !== "string") invalidValue(id);
			set(manager, value);
		},
		format: (value) => String(value),
	};
}

const thinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export const LYSTAR_SETTINGS_CATALOG: readonly LystarSettingDefinition[] = [
	stringSetting(
		"theme",
		"主题",
		"选择界面主题，或跟随终端浅色和深色外观。",
		(settings) => settings.getThemeSetting() ?? "dark",
		(settings, value) => settings.setTheme(value),
	),
	enumSetting(
		"default-thinking",
		"默认思考强度",
		"新会话和未单独指定思考强度的模型使用的默认值。",
		thinkingLevels,
		(settings) => settings.getDefaultThinkingLevel() ?? "off",
		(settings, value) => settings.setDefaultThinkingLevel(value),
	),
	booleanSetting(
		"anthropic-extra-usage",
		"Anthropic 额外用量提醒",
		"订阅认证可能产生额外付费用量时提醒。",
		(settings) => settings.getWarnings().anthropicExtraUsage ?? true,
		(settings, value) => settings.setWarnings({ ...settings.getWarnings(), anthropicExtraUsage: value }),
	),
	booleanSetting(
		"autocompact",
		"自动压缩上下文",
		"接近上下文上限时自动压缩会话。",
		(settings) => settings.getCompactionEnabled(),
		(settings, value) => settings.setCompactionEnabled(value),
	),
	integerSetting(
		"compaction-reserve-tokens",
		"压缩保留 Token",
		"触发上下文压缩前预留的 Token 数。",
		{ min: 0, max: MAX_INTEGER },
		(settings) => settings.getCompactionReserveTokens(),
		(settings, value) => settings.setCompactionReserveTokens(value),
	),
	integerSetting(
		"compaction-keep-recent-tokens",
		"压缩保留最近 Token",
		"压缩时尽量保留最近消息的 Token 数。",
		{ min: 0, max: MAX_INTEGER },
		(settings) => settings.getCompactionKeepRecentTokens(),
		(settings, value) => settings.setCompactionKeepRecentTokens(value),
	),
	booleanSetting(
		"retry-enabled",
		"自动重试",
		"模型请求失败时按退避策略自动重试。",
		(settings) => settings.getRetryEnabled(),
		(settings, value) => settings.setRetryEnabled(value),
	),
	integerSetting(
		"retry-max-retries",
		"最大重试次数",
		"单次模型请求允许的最大重试次数。",
		{ min: 0, max: MAX_INTEGER },
		(settings) => settings.getRetrySettings().maxRetries,
		(settings, value) => settings.setRetryMaxRetries(value),
	),
	integerSetting(
		"retry-base-delay-ms",
		"重试基础延迟",
		"自动重试的初始退避延迟，单位为毫秒。",
		{ min: 0, max: MAX_INTEGER },
		(settings) => settings.getRetrySettings().baseDelayMs,
		(settings, value) => settings.setRetryBaseDelayMs(value),
		{ format: (value) => `${value} ms` },
	),
	enumSetting(
		"steering-mode",
		"引导消息处理",
		"模型运行时如何处理排队的引导消息。",
		["one-at-a-time", "all"],
		(settings) => settings.getSteeringMode(),
		(settings, value) => settings.setSteeringMode(value),
		{ format: (value) => (value === "all" ? "全部处理" : "逐条处理") },
	),
	enumSetting(
		"follow-up-mode",
		"后续消息处理",
		"当前回复完成后如何处理排队消息。",
		["one-at-a-time", "all"],
		(settings) => settings.getFollowUpMode(),
		(settings, value) => settings.setFollowUpMode(value),
		{ format: (value) => (value === "all" ? "全部处理" : "逐条处理") },
	),
	enumSetting(
		"transport",
		"传输方式",
		"选择 Provider 的请求传输方式。",
		["auto", "sse", "websocket", "websocket-cached"],
		(settings) => settings.getTransport(),
		(settings, value) => settings.setTransport(value),
		{
			format: (value) =>
				({ auto: "自动", sse: "SSE", websocket: "WebSocket", "websocket-cached": "WebSocket（缓存）" })[value],
		},
	),
	integerSetting(
		"http-idle-timeout",
		"HTTP 空闲超时",
		"流式响应没有新数据时等待多久；0 表示关闭。",
		{ min: 0, max: MAX_INTEGER },
		(settings) => settings.getHttpIdleTimeoutMs(),
		(settings, value) => settings.setHttpIdleTimeoutMs(value),
		{ format: (value) => (value === 0 ? "关闭" : `${value} ms`) },
	),
	booleanSetting(
		"show-images",
		"显示图片",
		"在支持的终端里显示图片预览。",
		(settings) => settings.getShowImages(),
		(settings, value) => settings.setShowImages(value),
		{ restartRequired: true },
	),
	integerSetting(
		"image-width-cells",
		"图片显示宽度",
		"终端内图片预览占用的列数。",
		{ min: 1, max: MAX_INTEGER },
		(settings) => settings.getImageWidthCells(),
		(settings, value) => settings.setImageWidthCells(value),
		{ restartRequired: true },
	),
	booleanSetting(
		"auto-resize-images",
		"自动缩放图片",
		"上传前缩小大图以满足 Provider 限制。",
		(settings) => settings.getImageAutoResize(),
		(settings, value) => settings.setImageAutoResize(value),
	),
	booleanSetting(
		"block-images",
		"阻止图片输入",
		"不向模型发送图片。",
		(settings) => settings.getBlockImages(),
		(settings, value) => settings.setBlockImages(value),
	),
	booleanSetting(
		"skill-commands",
		"Skill 命令",
		"把 Skill 注册为斜杠命令。",
		(settings) => settings.getEnableSkillCommands(),
		(settings, value) => settings.setEnableSkillCommands(value),
		{ restartRequired: true },
	),
	booleanSetting(
		"show-hardware-cursor",
		"硬件光标",
		"在输入框中显示终端原生光标。",
		(settings) => settings.getShowHardwareCursor(),
		(settings, value) => settings.setShowHardwareCursor(value),
		{ restartRequired: true },
	),
	integerSetting(
		"editor-padding",
		"输入框横向留白",
		"输入区左右保留的列数。",
		{ min: 0, max: 3 },
		(settings) => settings.getEditorPaddingX(),
		(settings, value) => settings.setEditorPaddingX(value),
		{ restartRequired: true },
	),
	integerSetting(
		"output-padding",
		"输出留白",
		"Agent 输出左右保留的列数。",
		{ min: 0, max: 1 },
		(settings) => settings.getOutputPad(),
		(settings, value) => settings.setOutputPad(value as 0 | 1),
		{ restartRequired: true },
	),
	stringSetting(
		"markdown-code-indent",
		"Markdown 代码缩进",
		"代码块渲染时每行开头使用的缩进。",
		(settings) => settings.getCodeBlockIndent(),
		(settings, value) => settings.setCodeBlockIndent(value),
		{ restartRequired: true },
	),
	booleanSetting(
		"markdown-code-fences",
		"Markdown 代码围栏",
		"显示代码块开头和结尾的反引号标记。",
		(settings) => settings.getShowMarkdownCodeBlockFences(),
		(settings, value) => settings.setShowMarkdownCodeBlockFences(value),
		{ restartRequired: true },
	),
	enumSetting(
		"mermaid-rendering",
		"Mermaid 图表",
		"把 Mermaid 代码块显示为 Unicode 图表。",
		["off", "final", "streaming"],
		(settings) => settings.getMermaidRenderingMode(),
		(settings, value) => settings.setMermaidRenderingMode(value),
		{
			restartRequired: true,
			format: (value) => ({ off: "关闭", final: "完成后渲染", streaming: "流式渲染" })[value],
		},
	),
	integerSetting(
		"autocomplete-max-visible",
		"补全列表高度",
		"自动补全列表最多显示的条目数。",
		{ min: 3, max: 20 },
		(settings) => settings.getAutocompleteMaxVisible(),
		(settings, value) => settings.setAutocompleteMaxVisible(value),
		{ restartRequired: true },
	),
	booleanSetting(
		"clear-on-shrink",
		"缩小时清屏",
		"终端高度缩小时清除旧内容。",
		(settings) => settings.getClearOnShrink(),
		(settings, value) => settings.setClearOnShrink(value),
		{ restartRequired: true },
	),
	booleanSetting(
		"terminal-progress",
		"终端进度状态",
		"工作时更新终端进度指示。",
		(settings) => settings.getShowTerminalProgress(),
		(settings, value) => settings.setShowTerminalProgress(value),
		{ restartRequired: true },
	),
	booleanSetting(
		"hide-thinking",
		"折叠思考过程",
		"对话区显示思考内容时默认折叠完整过程。",
		(settings) => settings.getHideThinkingBlock(),
		(settings, value) => settings.setHideThinkingBlock(value),
		{ restartRequired: true },
	),
	enumSetting(
		"thinking-display",
		"思考内容位置",
		"选择在左下角实时状态或对话输出中显示模型思考。",
		["activity", "transcript"],
		(settings) => settings.getThinkingDisplayMode(),
		(settings, value) => settings.setThinkingDisplayMode(value),
		{
			restartRequired: true,
			format: (value) => (value === "activity" ? "左下角实时显示" : "对话输出中显示"),
		},
	),
	booleanSetting(
		"cache-miss-notices",
		"Prompt Cache 提示",
		"出现明显 Prompt Cache miss 时在会话中提示。",
		(settings) => settings.getShowCacheMissNotices(),
		(settings, value) => settings.setShowCacheMissNotices(value),
	),
	booleanSetting(
		"collapse-changelog",
		"折叠更新记录",
		"更新后只显示精简记录。",
		(settings) => settings.getCollapseChangelog(),
		(settings, value) => settings.setCollapseChangelog(value),
	),
	booleanSetting(
		"quiet-startup",
		"安静启动",
		"启动时隐藏详细加载信息。",
		(settings) => settings.getQuietStartup(),
		(settings, value) => settings.setQuietStartup(value),
		{ restartRequired: true },
	),
	enumSetting(
		"default-project-trust",
		"默认项目可信状态",
		"没有其他规则时如何处理项目本地文件。",
		["ask", "always", "never"],
		(settings) => settings.getDefaultProjectTrust(),
		(settings, value) => settings.setDefaultProjectTrust(value),
		{ format: (value) => ({ ask: "每次询问", always: "始终信任", never: "始终不信任" })[value] },
	),
	enumSetting(
		"double-escape-action",
		"双击 Escape",
		"输入框为空时连续按两次 Escape 执行的操作。",
		["tree", "fork", "none"],
		(settings) => settings.getDoubleEscapeAction(),
		(settings, value) => settings.setDoubleEscapeAction(value),
		{ restartRequired: true, format: (value) => ({ tree: "打开会话树", fork: "创建分支", none: "不执行" })[value] },
	),
	enumSetting(
		"tree-filter-mode",
		"会话树筛选",
		"打开 /tree 时默认显示哪些消息。",
		["default", "no-tools", "user-only", "labeled-only", "all"],
		(settings) => settings.getTreeFilterMode(),
		(settings, value) => settings.setTreeFilterMode(value),
		{ restartRequired: true },
	),
	enumSetting(
		"tui-mode",
		"界面模式",
		"切换普通终端和全屏工作区。",
		["regular", "fullscreen"],
		(settings) => settings.getTuiMode(),
		(settings, value) => settings.setTuiMode(value),
		{ restartRequired: true, format: (value) => (value === "regular" ? "普通" : "全屏") },
	),
	enumSetting(
		"fullscreen-exit-output",
		"全屏退出输出",
		"退出全屏时输出完整对话记录或会话恢复提示。",
		["transcript", "resume-hint"],
		(settings) => settings.getFullscreenExitOutput(),
		(settings, value) => settings.setFullscreenExitOutput(value),
		{ restartRequired: true },
	),
	enumSetting(
		"fullscreen-scrollbar",
		"全屏滚动条",
		"控制全屏历史区滚动条的显示方式。",
		["auto", "always", "hidden"],
		(settings) => settings.getFullscreenScrollbar(),
		(settings, value) => settings.setFullscreenScrollbar(value),
		{ restartRequired: true },
	),
	stringSetting(
		"external-editor",
		"外部编辑器",
		"按外部编辑器快捷键时执行的命令；留空后使用 VISUAL 或 EDITOR。",
		(settings) => settings.getConfiguredExternalEditorCommand() ?? "",
		(settings, value) => settings.setExternalEditorCommand(value.trim() || undefined),
		{ restartRequired: true },
	),
	stringSetting(
		"shell-path",
		"Shell 路径",
		"执行 Bash 工具时使用的 Shell 路径；留空使用系统默认值。",
		(settings) => settings.getShellPath() ?? "",
		(settings, value) => settings.setShellPath(value.trim() || undefined),
		{ restartRequired: true },
	),
	stringSetting(
		"shell-command-prefix",
		"Shell 命令前缀",
		"执行每条 Bash 命令前附加的 Shell 语句；留空关闭。",
		(settings) => settings.getShellCommandPrefix() ?? "",
		(settings, value) => settings.setShellCommandPrefix(value || undefined),
		{ restartRequired: true },
	),
	booleanSetting(
		"analytics",
		"分析数据共享",
		"允许发送匿名产品分析数据。",
		(settings) => settings.getEnableAnalytics(),
		(settings, value) => settings.setEnableAnalytics(value),
	),
];

const BY_ID = new Map(LYSTAR_SETTINGS_CATALOG.map((setting) => [setting.id, setting]));

export function getLystarSetting(id: string): LystarSettingDefinition | undefined {
	return BY_ID.get(id);
}

export function getLystarSettingsForUi(): readonly LystarSettingDefinition[] {
	return LYSTAR_SETTINGS_CATALOG.filter((setting) => setting.uiVisible);
}

export const SETTINGS_SELECTOR_PERSISTENT_IDS = getLystarSettingsForUi().map((setting) => setting.id);
