import type { ToolBatchTool } from "../../types.ts";
import {
	isSessionTool,
	parseSessionToolInput,
	parseSessionToolResult,
	sessionToolAgent,
	sessionToolAction,
} from "../../state/tool-batching.ts";
import { commandRowLabel } from "./command-presentation.ts";

function record(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function inputRecord(summary: string): Record<string, unknown> | undefined {
	try {
		return record(JSON.parse(summary));
	} catch {
		return undefined;
	}
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringList(value: unknown): string[] {
	return Array.isArray(value) ? value.flatMap((entry) => {
		const text = stringValue(entry);
		return text ? [text] : [];
	}) : [];
}

export function filePathFromTool(tool: ToolBatchTool): string | undefined {
	const input = inputRecord(tool.summary);
	const path = stringValue(input?.path) ?? stringValue(input?.file_path) ?? stringValue(input?.filename) ?? tool.diff?.files[0]?.path;
	if (path) return path;
	if (tool.name !== "read" && tool.name !== "edit" && tool.name !== "write") return undefined;
	return !input && tool.summary !== tool.name ? stringValue(tool.summary) : undefined;
}

export function commandFromToolSummary(summary: string): string {
	const input = inputRecord(summary);
	if (typeof input?.command === "string") return input.command;
	return summary === "bash" ? "" : summary;
}

function webTitle(tool: ToolBatchTool, input: Record<string, unknown> | undefined): string {
	const legacy = input?.type === "webSearchCall" ? record(input.action) : undefined;
	const action = tool.webSearch?.action ?? stringValue(legacy?.type);
	const url = tool.webSearch?.url ?? stringValue(legacy?.url);
	const pattern = tool.webSearch?.pattern ?? stringValue(legacy?.pattern);
	if (action === "open_page") return url ? `打开网页 ${url}` : "打开网页";
	if (action === "find_in_page") {
		if (url && pattern) return `在 ${url} 查找 ${pattern}`;
		return `在网页查找${pattern || url ? ` ${pattern ?? url}` : "内容"}`;
	}
	const query = (tool.webSearch?.query ?? stringValue(legacy?.query) ?? stringList(legacy?.queries).join("、")) ||
		(!input && tool.summary !== "网页搜索" && tool.summary !== tool.name ? tool.summary.trim() : "");
	if (!query) return "搜索网页";
	const site = query.match(/(?:^|\s)site:([^\s]+)/u);
	if (site) {
		const terms = query.replace(site[0], " ").trim();
		return terms ? `在 ${site[1]} 搜索 ${terms}` : `搜索 ${site[1]} 的网页`;
	}
	return `搜索网页 ${query}`;
}

function sessionTitle(tool: ToolBatchTool, input: Record<string, unknown> | undefined): string {
	const nickname = sessionToolAgent(tool.summary, tool.detail)?.nickname ?? sessionToolAgent(tool.summary, tool.progress)?.nickname;
	const agent = nickname ?? stringValue(input?.profileName) ?? "智能体";
	if (tool.name === "session_create") return `派发任务给 ${agent}`;
	if (tool.name === "session_send") {
		if (input?.mode === "steer") return `调整 ${agent} 的任务`;
		if (input?.mode === "follow_up") return `向 ${agent} 追加任务`;
		return `向 ${agent} 发送消息`;
	}
	if (tool.name === "session_wait") {
		const count = Array.isArray(input?.sessionIds) ? input.sessionIds.length : 0;
		return `等待${count > 1 ? ` ${count} 个智能体` : nickname ? ` ${nickname} ` : "智能体"}返回结果`;
	}
	if (tool.name === "session_stop") return `停止 ${agent} 的任务`;
	return sessionToolAction(tool.name) ?? tool.name;
}

function collaborationRoomTitle(tool: ToolBatchTool, input: Record<string, unknown> | undefined): string | undefined {
	const result = record(parseSessionToolResult(tool.detail));
	const room = record(result?.room);
	return (tool.name === "room_create" ? stringValue(input?.title) : undefined) ??
		stringValue(input?.roomTitle) ?? stringValue(room?.title) ?? stringValue(result?.title);
}

function roomToolTitle(tool: ToolBatchTool, input: Record<string, unknown> | undefined): string {
	const roomTitle = collaborationRoomTitle(tool, input);
	const room = roomTitle ? `「${roomTitle}」` : "协作空间";
	if (tool.name === "room_create") return `创建协作空间${roomTitle ? ` ${room}` : ""}`;
	if (tool.name === "room_join") return `加入${room}`;
	if (tool.name === "room_leave") return `退出${room}`;
	if (tool.name === "room_list") return "查看协作空间";
	if (tool.name === "room_send") return `向${room}发送协作消息`;
	if (tool.name === "room_read") return `读取${room}消息`;
	if (tool.name === "room_task_list") return `查看${room}任务`;
	if (tool.name === "room_task_create") {
		const title = stringValue(input?.title);
		return title ? `创建协作任务「${title}」` : `在${room}创建任务`;
	}
	if (tool.name === "room_task_update") {
		const result = record(parseSessionToolResult(tool.detail));
		const task = record(result?.task);
		const title = stringValue(input?.taskTitle) ?? stringValue(task?.title) ?? stringValue(result?.title);
		return title ? `更新协作任务「${title}」` : `更新${room}任务`;
	}
	if (tool.name === "room_claim") {
		const result = record(parseSessionToolResult(tool.detail));
		const task = record(result?.task);
		const title = stringValue(task?.title) ?? stringValue(result?.title);
		return title ? `领取协作任务「${title}」` : `领取${room}任务`;
	}
	return sessionToolAction(tool.name) ?? tool.name;
}

export function toolPresentationTitle(tool: ToolBatchTool): string {
	if (tool.name === "codemode") return "执行 JavaScript 脚本";
	const input = inputRecord(tool.summary);
	if (tool.images?.length && tool.name !== "image_gen") return `已查看 ${tool.images.length} 张图像`;
	if (tool.name === "bash") {
		const command = commandFromToolSummary(tool.summary);
		return command ? commandRowLabel(command, "input-available") : tool.preparing ? "生成命令参数" : "命令内容未记录";
	}
	if (tool.name === "web_search") return webTitle(tool, input);
	if (isSessionTool(tool.name)) {
		const collaborationInput = parseSessionToolInput(tool.summary) ?? input;
		return tool.name.startsWith("room_") ? roomToolTitle(tool, collaborationInput) : sessionTitle(tool, collaborationInput);
	}
	if (tool.name === "subagent" && tool.subagents?.length) {
		return `派发任务给 ${tool.subagents.map((agent) => agent.agent).join("、")}`;
	}
	if (tool.name === "image_gen") {
		if (tool.images?.length) return `已生成 ${tool.images.length} 张图片`;
		const prompt = stringValue(input?.prompt);
		return prompt ? `生成图片 ${prompt}` : "生成图片";
	}
	if (tool.images?.length) return `已查看 ${tool.images.length} 张图像`;
	const path = stringValue(input?.path) ?? stringValue(input?.file_path) ?? stringValue(input?.filename) ?? tool.diff?.files[0]?.path;
	const pattern = stringValue(input?.pattern);
	if (tool.name === "grep" || tool.name === "find") {
		const action = tool.name === "find" ? "查找文件" : "搜索";
		if (path && pattern) return `在 ${path} ${action} ${pattern}`;
		if (pattern) return `${action} ${pattern}`;
		return `${action}${tool.summary && tool.summary !== tool.name && !input ? ` ${tool.summary}` : ""}`;
	}
	if (tool.name === "ls") {
		const directory = path ?? (!input && tool.summary !== tool.name ? tool.summary.trim() : undefined);
		return directory ? `查看 ${directory} 目录` : "查看目录";
	}
	if (tool.name === "edit" || tool.name === "write") {
		const action = tool.name === "edit" ? "编辑" : "写入";
		const file = filePathFromTool(tool);
		return file ? `${action} ${file}` : `${action}文件`;
	}
	if (tool.name === "apply_patch") {
		const paths = [...new Set((tool.diff?.files ?? []).flatMap((file) => file.path ? [file.path] : []))];
		return paths.length ? `应用补丁修改 ${paths.join("、")}` : "应用补丁";
	}
	if (tool.name === "mcp") {
		if (input?.search) return `搜索 MCP 工具 ${stringValue(input.search) ?? ""}`;
		if (input?.instructions) return `查看 ${stringValue(input.instructions) ?? "MCP 服务"} 的用法`;
		if (input?.connect) return `连接 MCP 服务 ${stringValue(input.connect) ?? ""}`;
		const name = stringValue(input?.tool) ?? stringValue(input?.describe) ?? stringValue(input?.server);
		return name ? `${input?.describe ? "查看" : "调用"} ${name}` : "查看 MCP 连接";
	}
	if (tool.name === "multi_tool_use.parallel" && Array.isArray(input?.tool_uses)) {
		const names = input.tool_uses.flatMap((call) => {
			const name = stringValue(record(call)?.recipient_name);
			return name ? [name] : [];
		});
		if (names.length) return `并行调用 ${names.join("、")}`;
	}
	const target = stringValue(input?.command) ?? stringValue(input?.query) ?? stringValue(input?.q) ?? stringValue(input?.url) ?? path;
	return `调用 ${tool.name}${target ? ` ${target}` : !input && tool.summary !== tool.name && tool.summary.trim() ? ` ${tool.summary.trim()}` : ""}`;
}

export function toolPresentationContext(tool: ToolBatchTool): string | undefined {
	const input = inputRecord(tool.summary);
	if (isSessionTool(tool.name)) return undefined;
	if (tool.name === "subagent") return tool.subagents?.map((agent) => agent.task).join("；");
	if (tool.name === "mcp") {
		const args = record(input?.args);
		if (args) return JSON.stringify(args);
		return stringValue(input?.search) ?? stringValue(input?.instructions);
	}
	if (tool.name === "multi_tool_use.parallel" && Array.isArray(input?.tool_uses)) {
		return input.tool_uses.flatMap((call) => {
			const entry = record(call);
			return entry?.parameters ? [JSON.stringify(entry.parameters)] : [];
		}).join("；") || undefined;
	}
	return undefined;
}
