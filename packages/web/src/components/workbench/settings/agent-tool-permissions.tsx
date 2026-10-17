import { AgentCapabilityPicker } from "./agent-capability-picker";
import { SettingSection } from "./shared";

export interface AgentToolSelection {
	toolMode: "default" | "allow" | "deny";
	tools: string[];
	excludeTools: string[];
}

export type AgentToolOption = { name: string; description: string };

const TOOL_PURPOSES: Record<string, string> = {
	read: "读取文件内容，查看代码与文档",
	grep: "在文件中搜索文本内容",
	find: "按名称或条件查找文件",
	ls: "列出目录中的文件与文件夹",
	bash: "运行终端命令，执行脚本或检查项目",
	powershell: "运行 PowerShell 命令",
	edit: "修改已有文件中的指定内容",
	write: "创建文件或写入完整内容",
	mcp: "调用已连接服务提供的工具",
	image_gen: "生成图片或编辑已有图片",
	apply_patch: "按补丁内容修改文件",
	subagent: "委派任务给子智能体",
	session_create: "创建下级会话并派发任务",
	session_send: "向下级会话发送消息",
	session_wait: "等待子会话返回结果",
	session_list: "查看会话与子会话",
	session_profiles: "查看可用智能体配置",
	session_stop: "停止子会话",
	room_create: "创建协作空间",
	room_join: "加入协作空间",
	room_leave: "退出协作空间",
	room_list: "查看协作空间",
	room_send: "发送协作消息",
	room_read: "读取协作消息",
	room_task_list: "查看协作任务",
	room_task_create: "创建协作任务",
	room_task_update: "更新协作任务",
	room_claim: "领取协作任务",
	create_agent: "创建可用于会话和协作的智能体",
	step_start: "标记当前任务步骤开始",
	step_end: "标记当前任务步骤完成",
};

export function AgentToolPermissions({
	draft,
	toolOptions,
	onChange,
}: {
	draft: AgentToolSelection;
	toolOptions: readonly AgentToolOption[];
	onChange: (draft: AgentToolSelection) => void;
}) {
	const selected = draft.toolMode === "default" ? [] : draft.toolMode === "allow" ? draft.tools : draft.excludeTools;
	return (
		<SettingSection id="agent-config-tools" title="工具权限">
			<div className="grid min-w-0 gap-5">
				<label className="grid min-w-0 gap-2 text-sm font-medium sm:grid-cols-[100px_minmax(0,280px)] sm:items-center">
					使用规则
					<select
						aria-label="工具使用规则"
						className="h-10 min-w-0 rounded-md border border-input bg-background px-3 text-sm focus-visible:ring-2 focus-visible:ring-ring"
						value={draft.toolMode}
						onChange={(event) =>
							onChange({ ...draft, toolMode: event.target.value as AgentToolSelection["toolMode"] })
						}
					>
						<option value="default">沿用默认工具</option>
						<option value="allow">仅允许所选工具</option>
						<option value="deny">禁用所选工具</option>
					</select>
				</label>
				<p className="text-xs leading-5 text-muted-foreground">
					{draft.toolMode === "default"
						? "沿用默认工具配置。"
						: draft.toolMode === "allow"
							? selected.length
								? "只允许使用勾选的工具。"
								: "尚未选择工具，保存后沿用默认工具配置。"
							: "勾选的工具不可使用，其余工具沿用默认配置。"}
				</p>
				<AgentCapabilityPicker
					kind="工具"
					options={toolOptions.map((tool) => ({
						...tool,
						description: TOOL_PURPOSES[tool.name] ?? tool.description,
					}))}
					selected={selected}
					disabled={draft.toolMode === "default"}
					selectedLabel={draft.toolMode === "deny" ? "已禁用" : "已允许"}
					defaultLabel={draft.toolMode === "allow" && selected.length ? "未允许" : "沿用默认"}
					onToggle={(name, checked) =>
						onChange({
							...draft,
							[draft.toolMode === "allow" ? "tools" : "excludeTools"]: checked
								? [...selected, name]
								: selected.filter((item) => item !== name),
						})
					}
				/>
			</div>
		</SettingSection>
	);
}
