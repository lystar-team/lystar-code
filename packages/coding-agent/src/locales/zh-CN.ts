import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

export const THINKING_LEVEL_ZH_CN: Record<ThinkingLevel, string> = {
	off: "关闭",
	minimal: "极简",
	low: "低",
	medium: "中",
	high: "高",
	xhigh: "超高",
	max: "最大",
	ultra: "极致",
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
	"status.webSearchSourceList": "来源",
	"status.citations": "引用：",
	"tool.applyPatch.running": "正在应用补丁",
	"tool.applyPatch.success": "已应用补丁",
	"tool.applyPatch.error": "应用补丁失败",
	"subagent.title": "Subagent",
	"subagent.mode.single": "单任务",
	"subagent.mode.parallel": "并行",
	"subagent.mode.chain": "串行",
	"subagent.scope.user": "用户级",
	"subagent.scope.project": "项目级",
	"subagent.scope.both": "用户级 + 项目级",
	"subagent.source.builtin": "内置",
	"subagent.source.user": "用户级",
	"subagent.source.project": "项目级",
	"subagent.source.unknown": "未知",
	"subagent.state.queued": "排队中",
	"subagent.state.running": "运行中",
	"subagent.state.waiting": "等待中",
	"subagent.state.succeeded": "已完成",
	"subagent.state.failed": "失败",
	"subagent.state.cancelled": "已取消",
	"subagent.confirm.projectTitle": "运行项目 Agent？",
	"subagent.confirm.projectMessage":
		"Agent：{agents}\n来源：{source}\n\n项目 Agent 由仓库控制，只在信任当前仓库时继续。",
	"subagent.error.projectNotApproved": "已取消：未批准运行项目 Agent。",
	"subagent.error.invalidMode": "参数无效，请只提供一种执行模式。",
	"subagent.error.availableAgents": "可用 Agent：{agents}",
	"subagent.error.tooManyParallel": "并行任务过多（{count} 个），最多允许 {max} 个。",
	"subagent.error.chainStopped": "串行任务在第 {step} 步停止（{agent}）：{error}",
	"subagent.error.agentFailed": "Agent 执行失败（{reason}）：{error}",
	"subagent.error.unknownAgent": '未知 Agent："{agent}"。可用 Agent：{agents}。',
	"subagent.error.noActiveRegistry": "当前没有可用的 Subagent 运行记录。",
	"subagent.error.notAvailable": 'Subagent "{agentId}" 已不可用。',
	"subagent.error.controllerStarted": "Subagent 控制器已经启动。",
	"subagent.error.sessionMissing": 'Subagent "{agentId}" 未创建持久会话。',
	"subagent.error.alreadySettledFollowUp": 'Subagent "{agentId}" 已结束，请改用后续任务。',
	"subagent.error.stillActiveSteer": 'Subagent "{agentId}" 仍在运行，请改用引导消息。',
	"subagent.error.alreadySettled": 'Subagent "{agentId}" 已结束。',
	"subagent.error.definitionUnavailable": 'Subagent 定义 "{agent}"（{source}）已不可用。',
	"subagent.progress.parallel": "并行进度：已完成 {done}/{total}，运行中 {running}",
	"subagent.result.parallel": "并行结果：成功 {success}/{total}",
	"subagent.result.completed": "已完成",
	"subagent.result.failed": "失败",
	"subagent.output.empty": "（无输出）",
	"subagent.output.running": "（运行中）",
	"subagent.output.truncated": "输出已截断：省略 {bytes} 字节，完整内容保留在 Tool details 中。",
	"status.compacting": "正在压缩上下文...",
	"status.retrying": "正在重试...",
	"status.noModel": "未选择模型",
	"status.operationAborted": "操作已取消",
	"status.unknownError": "发生未知错误",
	"status.maxOutput": "回复在完成前已被截断。",
	"status.thinkingLevel": "思考强度：{level}",
	"update.changelog": "更新记录：",
	"update.changelogTitle": "{app} 更新记录",
	"update.productUpdated": "{app} 已更新到 v{version}。",
	"update.productChangelog": "使用 /changelog 查看 {app} 更新记录。",
	"update.packages": "Package：",
	"update.available": "发现新版本",
	"update.instruction": "新版本 {version} 已发布。运行 {command} 更新。",
	"update.packagesAvailable": "发现 Package 更新",
	"update.packagesInstruction": "运行 {command} 更新 Pi Package。",
	"setup.welcome": "欢迎使用 LYStar Code。",
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
	"doctor.title": "LYStar Code 诊断",
	"doctor.help": "只读输出当前进程、恢复机制与恢复经验的诊断信息。",
	"doctor.unsupportedOption": "doctor 不支持参数“{option}”",
	"doctor.parseFailed": "解析 doctor 命令失败",
	"doctor.product": "产品",
	"doctor.frontend": "前端",
	"doctor.node": "Node.js",
	"doctor.runtimeProtocol": "Web Runtime Protocol",
	"doctor.cwd": "当前目录",
	"doctor.agentDir": "Agent 目录",
	"doctor.platform": "平台",
	"doctor.recovery": "恢复模式",
	"doctor.sessionActive": "当前进程会话活跃",
	"doctor.activeCircuits": "活跃熔断",
	"doctor.metrics": "恢复指标",
	"doctor.lessons": "恢复经验计数",
	"doctor.recentConnectionErrors": "最近连接错误",
	"doctor.terminalRepairHistory": "终端修复历史",
	"doctor.unavailable": "不可用（{reason}）",
	"doctor.noPersistentFactSource": "当前没有持久化事实源",
	"doctor.noActiveSession": "无活跃会话（仅当前进程）",
	"doctor.lessonStoreError": "恢复经验 Store 无法读取（{code}）",
} as const;

export type MessageKey = keyof typeof zhCN;

type MessageValues = Record<string, string | number>;

export function t(key: MessageKey, values: MessageValues = {}): string {
	return zhCN[key].replace(/\{(\w+)\}/g, (placeholder, name: string) =>
		Object.hasOwn(values, name) ? String(values[name]) : placeholder,
	);
}

const SUBAGENT_MODE_KEYS = {
	single: "subagent.mode.single",
	parallel: "subagent.mode.parallel",
	chain: "subagent.mode.chain",
} as const satisfies Record<string, MessageKey>;

const SUBAGENT_SCOPE_KEYS = {
	user: "subagent.scope.user",
	project: "subagent.scope.project",
	both: "subagent.scope.both",
} as const satisfies Record<string, MessageKey>;

const SUBAGENT_SOURCE_KEYS = {
	builtin: "subagent.source.builtin",
	user: "subagent.source.user",
	project: "subagent.source.project",
	unknown: "subagent.source.unknown",
} as const satisfies Record<string, MessageKey>;

const SUBAGENT_STATE_KEYS = {
	queued: "subagent.state.queued",
	running: "subagent.state.running",
	waiting: "subagent.state.waiting",
	succeeded: "subagent.state.succeeded",
	failed: "subagent.state.failed",
	cancelled: "subagent.state.cancelled",
} as const satisfies Record<string, MessageKey>;

function formatMappedValue(value: string, keys: Record<string, MessageKey>): string {
	const key = Object.hasOwn(keys, value) ? keys[value] : undefined;
	return key ? t(key) : value;
}

export function formatSubagentMode(mode: string): string {
	return formatMappedValue(mode, SUBAGENT_MODE_KEYS);
}

export function formatSubagentScope(scope: string): string {
	return formatMappedValue(scope, SUBAGENT_SCOPE_KEYS);
}

export function formatSubagentSource(source: string): string {
	return formatMappedValue(source, SUBAGENT_SOURCE_KEYS);
}

export function formatSubagentState(state: string): string {
	return formatMappedValue(state, SUBAGENT_STATE_KEYS);
}
