import type { SettingsManager } from "./settings-manager.ts";

export type LystarSettingValue = boolean | number | string;
export type LystarSettingKind = "boolean" | "enum" | "integer" | "string";

export interface LystarSettingDefinition {
	id: string;
	label: string;
	description?: string;
	kind: LystarSettingKind;
	options?: string[];
	scope: "global";
	readOnly?: boolean;
	restartRequired?: boolean;
	get(settings: SettingsManager): LystarSettingValue;
	set(settings: SettingsManager, value: LystarSettingValue): void;
}

const booleanSetting = (
	id: string,
	label: string,
	description: string,
	get: (settings: SettingsManager) => boolean,
	set: (settings: SettingsManager, value: boolean) => void,
	restartRequired = false,
): LystarSettingDefinition => ({
	id,
	label,
	description,
	kind: "boolean",
	scope: "global",
	...(restartRequired ? { restartRequired: true } : {}),
	get,
	set: (settings, value) => {
		if (typeof value !== "boolean") throw new Error(`设置 ${id} 只接受布尔值`);
		set(settings, value);
	},
});

const enumSetting = <T extends string>(
	id: string,
	label: string,
	description: string,
	options: readonly T[],
	get: (settings: SettingsManager) => T,
	set: (settings: SettingsManager, value: T) => void,
	restartRequired = false,
): LystarSettingDefinition => ({
	id,
	label,
	description,
	kind: "enum",
	options: [...options],
	scope: "global",
	...(restartRequired ? { restartRequired: true } : {}),
	get,
	set: (settings, value) => {
		if (typeof value !== "string" || !options.includes(value as T)) {
			throw new Error(`设置 ${id} 的值无效`);
		}
		set(settings, value as T);
	},
});

const integerSetting = (
	id: string,
	label: string,
	description: string,
	options: readonly number[],
	get: (settings: SettingsManager) => number,
	set: (settings: SettingsManager, value: number) => void,
	restartRequired = false,
): LystarSettingDefinition => ({
	id,
	label,
	description,
	kind: "integer",
	options: options.map(String),
	scope: "global",
	...(restartRequired ? { restartRequired: true } : {}),
	get,
	set: (settings, value) => {
		if (typeof value !== "number" || !Number.isInteger(value) || !options.includes(value)) {
			throw new Error(`设置 ${id} 的值无效`);
		}
		set(settings, value);
	},
});

export const LYSTAR_SETTINGS_CATALOG: readonly LystarSettingDefinition[] = [
	booleanSetting(
		"autocompact",
		"自动压缩上下文",
		"接近上下文上限时自动压缩会话",
		(s) => s.getCompactionEnabled(),
		(s, v) => s.setCompactionEnabled(v),
	),
	booleanSetting(
		"show-images",
		"显示图片",
		"在支持的终端里显示图片预览",
		(s) => s.getShowImages(),
		(s, v) => s.setShowImages(v),
		true,
	),
	integerSetting(
		"image-width-cells",
		"图片显示宽度",
		"终端内图片预览占用的列数",
		[60, 80, 120],
		(s) => s.getImageWidthCells(),
		(s, v) => s.setImageWidthCells(v),
		true,
	),
	booleanSetting(
		"auto-resize-images",
		"自动缩放图片",
		"上传前缩小大图以满足 Provider 限制",
		(s) => s.getImageAutoResize(),
		(s, v) => s.setImageAutoResize(v),
	),
	booleanSetting(
		"block-images",
		"阻止图片输入",
		"不向模型发送图片",
		(s) => s.getBlockImages(),
		(s, v) => s.setBlockImages(v),
	),
	booleanSetting(
		"skill-commands",
		"Skill 命令",
		"把 Skill 注册为斜杠命令",
		(s) => s.getEnableSkillCommands(),
		(s, v) => s.setEnableSkillCommands(v),
		true,
	),
	booleanSetting(
		"show-hardware-cursor",
		"硬件光标",
		"在输入框中显示终端原生光标",
		(s) => s.getShowHardwareCursor(),
		(s, v) => s.setShowHardwareCursor(v),
		true,
	),
	integerSetting(
		"editor-padding",
		"输入框横向留白",
		"输入区左右保留的列数",
		[0, 1, 2, 3],
		(s) => s.getEditorPaddingX(),
		(s, v) => s.setEditorPaddingX(v),
		true,
	),
	integerSetting(
		"output-padding",
		"输出留白",
		"Agent 输出左右保留的列数",
		[0, 1],
		(s) => s.getOutputPad(),
		(s, v) => s.setOutputPad(v as 0 | 1),
		true,
	),
	booleanSetting(
		"markdown-code-fences",
		"Markdown 代码围栏",
		"显示代码块开头和结尾的反引号标记",
		(s) => s.getShowMarkdownCodeBlockFences(),
		(s, v) => s.setShowMarkdownCodeBlockFences(v),
		true,
	),
	integerSetting(
		"autocomplete-max-visible",
		"补全列表高度",
		"自动补全列表最多显示的条目数",
		[3, 5, 7, 10, 15, 20],
		(s) => s.getAutocompleteMaxVisible(),
		(s, v) => s.setAutocompleteMaxVisible(v),
		true,
	),
	booleanSetting(
		"clear-on-shrink",
		"缩小时清屏",
		"终端高度缩小时清除旧内容",
		(s) => s.getClearOnShrink(),
		(s, v) => s.setClearOnShrink(v),
		true,
	),
	booleanSetting(
		"terminal-progress",
		"终端进度状态",
		"工作时更新终端进度指示",
		(s) => s.getShowTerminalProgress(),
		(s, v) => s.setShowTerminalProgress(v),
		true,
	),
	enumSetting(
		"steering-mode",
		"引导消息处理",
		"模型运行时如何处理排队的引导消息",
		["one-at-a-time", "all"],
		(s) => s.getSteeringMode(),
		(s, v) => s.setSteeringMode(v),
	),
	enumSetting(
		"follow-up-mode",
		"后续消息处理",
		"当前回复完成后如何处理排队消息",
		["one-at-a-time", "all"],
		(s) => s.getFollowUpMode(),
		(s, v) => s.setFollowUpMode(v),
	),
	enumSetting(
		"transport",
		"传输方式",
		"选择 Provider 的请求传输方式",
		["auto", "sse", "websocket", "websocket-cached"],
		(s) => s.getTransport(),
		(s, v) => s.setTransport(v),
	),
	integerSetting(
		"http-idle-timeout",
		"HTTP 空闲超时",
		"流式响应没有新数据时等待多久",
		[0, 30_000, 60_000, 120_000, 300_000],
		(s) => s.getHttpIdleTimeoutMs(),
		(s, v) => s.setHttpIdleTimeoutMs(v),
	),
	enumSetting(
		"thinking-display",
		"思考内容位置",
		"选择在左下角实时状态或对话输出中显示模型思考",
		["activity", "transcript"],
		(s) => s.getThinkingDisplayMode(),
		(s, v) => s.setThinkingDisplayMode(v),
		true,
	),
	booleanSetting(
		"hide-thinking",
		"折叠思考过程",
		"对话区显示思考内容时默认折叠完整过程",
		(s) => s.getHideThinkingBlock(),
		(s, v) => s.setHideThinkingBlock(v),
		true,
	),
	enumSetting(
		"mermaid-rendering",
		"Mermaid 图表",
		"把 Mermaid 代码块显示为 Unicode 图表",
		["off", "final", "streaming"],
		(s) => s.getMermaidRenderingMode(),
		(s, v) => s.setMermaidRenderingMode(v),
		true,
	),
	booleanSetting(
		"cache-miss-notices",
		"Prompt Cache 提示",
		"出现明显 Prompt Cache miss 时在会话中提示",
		(s) => s.getShowCacheMissNotices(),
		(s, v) => s.setShowCacheMissNotices(v),
	),
	booleanSetting(
		"collapse-changelog",
		"折叠更新记录",
		"更新后只显示精简记录",
		(s) => s.getCollapseChangelog(),
		(s, v) => s.setCollapseChangelog(v),
	),
	booleanSetting(
		"quiet-startup",
		"安静启动",
		"启动时隐藏详细加载信息",
		(s) => s.getQuietStartup(),
		(s, v) => s.setQuietStartup(v),
		true,
	),
	enumSetting(
		"default-project-trust",
		"默认项目可信状态",
		"没有其他规则时如何处理项目本地文件",
		["ask", "always", "never"],
		(s) => s.getDefaultProjectTrust(),
		(s, v) => s.setDefaultProjectTrust(v),
	),
	enumSetting(
		"double-escape-action",
		"双击 Escape",
		"输入框为空时连续按两次 Escape 执行的操作",
		["tree", "fork", "none"],
		(s) => s.getDoubleEscapeAction(),
		(s, v) => s.setDoubleEscapeAction(v),
		true,
	),
	enumSetting(
		"tree-filter-mode",
		"会话树筛选",
		"打开 /tree 时默认显示哪些消息",
		["default", "no-tools", "user-only", "labeled-only", "all"],
		(s) => s.getTreeFilterMode(),
		(s, v) => s.setTreeFilterMode(v),
		true,
	),
	enumSetting(
		"tui-mode",
		"界面模式",
		"切换普通终端和全屏工作区",
		["regular", "fullscreen"],
		(s) => s.getTuiMode(),
		(s, v) => s.setTuiMode(v),
		true,
	),
	enumSetting(
		"fullscreen-exit-output",
		"全屏退出输出",
		"退出全屏时输出完整对话记录或会话恢复提示",
		["transcript", "resume-hint"],
		(s) => s.getFullscreenExitOutput(),
		(s, v) => s.setFullscreenExitOutput(v),
		true,
	),
	enumSetting(
		"fullscreen-scrollbar",
		"全屏滚动条",
		"控制全屏历史区滚动条的显示方式",
		["auto", "always", "hidden"],
		(s) => s.getFullscreenScrollbar(),
		(s, v) => s.setFullscreenScrollbar(v),
		true,
	),
];

const BY_ID = new Map(LYSTAR_SETTINGS_CATALOG.map((setting) => [setting.id, setting]));

export function getLystarSetting(id: string): LystarSettingDefinition | undefined {
	return BY_ID.get(id);
}

export const SETTINGS_SELECTOR_PERSISTENT_IDS = LYSTAR_SETTINGS_CATALOG.map((setting) => setting.id);
