import { formatThinkingLevel } from "./zh-CN.ts";

export const SETTINGS_ZH_CN = {
	"anthropic-extra-usage": ["Anthropic 额外用量", "订阅认证可能产生额外付费用量时提醒"],
	autocompact: ["自动压缩上下文", "接近上下文上限时自动压缩会话"],
	"autocomplete-max-visible": ["补全列表高度", "自动补全列表最多显示的条目数"],
	"auto-resize-images": ["自动缩放图片", "上传前缩小大图以满足 Provider 限制"],
	"block-images": ["阻止图片输入", "不向模型发送图片"],
	"cache-miss-notices": ["Prompt Cache 提示", "出现明显 Prompt Cache miss 时在会话中提示"],
	"clear-on-shrink": ["缩小时清屏", "终端高度缩小时清除旧内容"],
	"collapse-changelog": ["折叠更新记录", "更新后只显示精简记录"],
	"default-project-trust": ["默认项目可信状态", "没有其他规则时如何处理项目本地文件"],
	"double-escape-action": ["双击 Escape", "输入框为空时连续按两次 Escape 执行的操作"],
	"editor-padding": ["输入框横向留白", "输入区左右保留的列数"],
	"follow-up-mode": ["后续消息处理", "当前回复完成后如何处理排队消息"],
	"hide-thinking": ["折叠思考过程", "对话区显示思考内容时默认折叠完整过程"],
	"http-idle-timeout": ["HTTP 空闲超时", "流式响应没有新数据时等待多久"],
	"image-width-cells": ["图片显示宽度", "终端内图片预览占用的列数"],
	"light-theme": ["浅色主题", "终端为浅色外观时使用的主题"],
	"dark-theme": ["深色主题", "终端为深色外观时使用的主题"],
	"output-padding": ["输出留白", "Agent 输出左右保留的列数"],
	"markdown-code-fences": ["Markdown 代码围栏", "显示代码块开头和结尾的反引号标记"],
	"mermaid-rendering": ["Mermaid 图表", "把 Mermaid 代码块显示为 Unicode 图表"],
	"quiet-startup": ["安静启动", "启动时隐藏详细加载信息"],
	"show-hardware-cursor": ["硬件光标", "在输入框中显示终端原生光标"],
	"show-images": ["显示图片", "在支持的终端里显示图片预览"],
	"skill-commands": ["Skill 命令", "把 Skill 注册为斜杠命令"],
	"steering-mode": ["引导消息处理", "模型运行时如何处理排队的引导消息"],
	"terminal-progress": ["终端进度状态", "工作时更新终端进度指示"],
	theme: ["主题", "选择界面主题或跟随终端外观"],
	thinking: ["思考强度", "控制模型思考强度"],
	"thinking-display": ["思考内容位置", "选择在左下角实时状态或对话输出中显示模型思考"],
	transport: ["传输方式", "选择 Provider 的请求传输方式"],
	"tui-mode": ["界面模式", "切换普通终端和全屏工作区"],
	"fullscreen-scrollbar": ["全屏滚动条", "控制全屏历史区滚动条的显示方式"],
	"tree-filter-mode": ["会话树筛选", "打开 /tree 时默认显示哪些消息"],
	warnings: ["警告设置", "配置运行时警告"],
	apply: ["应用", "保存主题设置并返回"],
	"single-mode": ["主题模式", "切换为固定主题"],
} as const;

export type SettingTextId = keyof typeof SETTINGS_ZH_CN;

const SETTING_VALUE_ZH_CN: Partial<Record<SettingTextId, Record<string, string>>> = {
	"steering-mode": { "one-at-a-time": "逐条处理", all: "全部处理" },
	"follow-up-mode": { "one-at-a-time": "逐条处理", all: "全部处理" },
	transport: { auto: "自动", sse: "SSE", websocket: "WebSocket", "websocket-cached": "WebSocket（缓存）" },
	"http-idle-timeout": {
		"30 sec": "30 秒",
		"1 min": "1 分钟",
		"2 min": "2 分钟",
		"5 min": "5 分钟",
		disabled: "关闭",
	},
	"default-project-trust": { ask: "每次询问", always: "始终信任", never: "始终不信任" },
	"double-escape-action": { tree: "打开会话树", fork: "创建分支", none: "不执行" },
	"tree-filter-mode": {
		default: "默认",
		"no-tools": "隐藏工具",
		"user-only": "仅用户消息",
		"labeled-only": "仅标签消息",
		all: "全部消息",
	},
	warnings: { configure: "打开设置" },
	thinking: {
		off: formatThinkingLevel("off"),
		minimal: formatThinkingLevel("minimal"),
		low: formatThinkingLevel("low"),
		medium: formatThinkingLevel("medium"),
		high: formatThinkingLevel("high"),
		xhigh: formatThinkingLevel("xhigh"),
		max: formatThinkingLevel("max"),
	},
	"thinking-display": { activity: "左下角实时显示", transcript: "对话输出中显示" },
	theme: { dark: "深色", light: "浅色" },
	apply: { "save and go back": "保存并返回" },
	"single-mode": { "switch to single theme": "使用固定主题" },
	"mermaid-rendering": { off: "关闭", final: "完成后渲染", streaming: "流式渲染" },
	"tui-mode": { regular: "普通", fullscreen: "全屏" },
	"fullscreen-scrollbar": { auto: "自动", always: "始终显示", hidden: "隐藏" },
};

export function localizeSettingValue(id: string, value: string): string {
	if (value === "true") return "开启";
	if (value === "false") return "关闭";
	return SETTING_VALUE_ZH_CN[id as SettingTextId]?.[value] ?? value;
}

export function localizeSetting<T extends { id: string; label: string; description?: string }>(
	item: T,
): T & { formatValue: (value: string) => string } {
	const text = SETTINGS_ZH_CN[item.id as SettingTextId];
	return {
		...item,
		...(text && { label: text[0], description: text[1] }),
		formatValue: (value) => localizeSettingValue(item.id, value),
	};
}
