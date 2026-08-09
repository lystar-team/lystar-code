import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

export const THINKING_LEVEL_ZH_CN: Record<ThinkingLevel, string> = {
	off: "关闭",
	minimal: "极简",
	low: "低",
	medium: "中",
	high: "高",
	xhigh: "超高",
	max: "最大",
};

export function formatThinkingLevel(level: ThinkingLevel | string): string {
	const translated = THINKING_LEVEL_ZH_CN[level as ThinkingLevel];
	return translated ? `${translated}(${level})` : level;
}

export const zhCN = {
	"app.description": "中文编码助手，支持读取、命令执行、编辑和写入文件",
	"common.error": "错误：{message}",
	"common.warning": "警告：{message}",
	"common.cancel": "取消",
	"common.confirm": "确认",
	"common.yes": "是",
	"common.no": "否",
	"workspace.contextUnknown": "上下文 --",
	"workspace.contextPercent": "上下文 {percent}%",
	"workspace.moreLines": "↓ 下方还有 {count} 行，点击或跳到底部继续跟随",
	"workspace.interrupt": "取消",
	"workspace.model": "模型",
	"workspace.expand": "展开",
	"workspace.thinking": "思考",
	"status.working": "正在处理...",
	"status.thinking": "◆ 思考过程",
	"status.webSearchInProgress": "正在搜索网页",
	"status.webSearchCompleted": "已搜索网页",
	"status.webSearchFailed": "网页搜索失败",
	"status.webSearchSources": "{count} 个来源",
	"status.webSearchSourceList": "搜索来源：",
	"status.citations": "引用：",
	"status.compacting": "正在压缩上下文...",
	"status.retrying": "正在重试...",
	"status.noModel": "未选择模型",
	"status.operationAborted": "操作已取消",
	"status.unknownError": "发生未知错误",
	"status.maxOutput": "回复在完成前已被截断。",
	"status.thinkingLevel": "思考强度：{level}",
	"update.changelog": "更新记录：",
	"update.packages": "Package：",
	"update.available": "发现新版本",
	"update.instruction": "新版本 {version} 已发布。运行 {command} 更新。",
	"update.packagesAvailable": "发现 Package 更新",
	"update.packagesInstruction": "运行 {command} 更新 Pi Package。",
	"setup.welcome": "欢迎使用 LYStar Agent。",
	"setup.pickTheme": "选择界面主题",
	"setup.detectedTheme": "检测到系统主题：{theme}",
	"setup.dark": "深色",
	"setup.light": "浅色",
	"setup.navigate": "移动",
	"setup.continue": "继续",
	"setup.skip": "跳过设置",
	"command.settings": "打开设置",
	"command.model": "选择模型",
	"command.scopedModels": "设置模型循环范围",
	"command.export": "导出会话，默认 HTML，也可指定 .html 或 .jsonl",
	"command.import": "从 JSONL 文件导入并继续会话",
	"command.share": "通过私密 GitHub gist 分享会话",
	"command.copy": "复制最近一条 Agent 回复",
	"command.name": "设置会话名称",
	"command.session": "查看会话信息和统计",
	"command.changes": "审阅本轮触及和工作区全部变更",
	"command.agents": "查看和控制当前会话的 Subagent",
	"command.changelog": "查看更新记录",
	"command.hotkeys": "查看全部快捷键",
	"command.fork": "从历史用户消息创建分支会话",
	"command.clone": "从当前位置复制当前会话",
	"command.tree": "浏览并切换会话分支",
	"command.trust": "保存项目可信状态",
	"command.login": "配置 Provider 登录信息",
	"command.logout": "删除 Provider 登录信息",
	"command.new": "新建会话",
	"command.compact": "手动压缩会话上下文",
	"command.resume": "继续其他会话",
	"command.reload": "重新加载快捷键、Extension、Skill、Prompt、Theme 和上下文文件",
	"command.quit": "退出 {app}",
} as const;

export type MessageKey = keyof typeof zhCN;

type MessageValues = Record<string, string | number>;

export function t(key: MessageKey, values: MessageValues = {}): string {
	return zhCN[key].replace(/\{(\w+)\}/g, (placeholder, name: string) =>
		Object.hasOwn(values, name) ? String(values[name]) : placeholder,
	);
}
