import { MoreHorizontal, Plus, RefreshCw, Search, Trash2 } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { WorkbenchState } from "../../../state/use-workbench";
import type { SubagentConfig } from "../../../types";
import { Button } from "../../ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../../ui/dropdown-menu";
import { Input } from "../../ui/input";
import { Spinner } from "../../ui/spinner";
import { Tabs, TabsContent } from "../../ui/tabs";
import { AgentTagList } from "../agent-profile-card";
import { AgentIdentityIcon } from "../collaboration-session";
import { workspaceModeLabel } from "../session-workspaces";
import type { WorkbenchActions } from "../types";
import { WorkbenchTabBar } from "../workbench-tab-bar";
import { AgentEditor, type AgentLeaveGuard } from "./agent-editor";
import { AgentNicknameDialog } from "./agent-nickname-dialog";
import { SubagentBatchDialog } from "./subagent-batch-dialog";

const LIST_COLUMNS =
	"@min-[900px]/agents:grid-cols-[24px_minmax(0,1fr)_56px_176px_80px_80px_88px]";

type ScopeFilter = "all" | "user" | "project";

export function SubagentSettings({
	state,
	actions,
	onLeaveGuardChange,
}: {
	state: WorkbenchState;
	actions: WorkbenchActions;
	onLeaveGuardChange: (guard: AgentLeaveGuard | undefined) => void;
}) {
	const [editor, setEditor] = useState<{ config?: SubagentConfig; scope: SubagentConfig["scope"] }>();
	const [query, setQuery] = useState("");
	const [scope, setScope] = useState<ScopeFilter>("all");
	const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
	const [batchOpen, setBatchOpen] = useState(false);
	const [nicknameOpen, setNicknameOpen] = useState(false);
	const scrollRef = useRef<HTMLDivElement>(null);
	const listOffset = useRef(0);
	const returnKey = useRef<string>();
	const closeEditor = useCallback(() => setEditor(undefined), []);
	useEffect(() => {
		setSelectedKeys(new Set());
		setBatchOpen(false);
		setEditor(undefined);
		listOffset.current = 0;
	}, [state.currentProjectId]);
	useLayoutEffect(() => {
		if (editor || !scrollRef.current) return;
		scrollRef.current.scrollTop = listOffset.current;
		if (returnKey.current) {
			for (const row of scrollRef.current.querySelectorAll<HTMLElement>("[data-agent-key]")) {
				if (row.dataset.agentKey === returnKey.current)
					row.querySelector<HTMLButtonElement>("[data-agent-open]")?.focus({ preventScroll: true });
			}
			returnKey.current = undefined;
		}
	}, [editor]);
	const editableConfigs = state.subagentConfigs.filter((config) => config.editable);
	const selectedConfigs = editableConfigs.filter((config) => selectedKeys.has(`${config.scope}:${config.id}`));
	const visible = state.subagentConfigs.filter(
		(config) =>
			(scope === "all" || config.scope === scope) &&
			`${config.name}\n${config.description}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
	);
	const visibleEditable = visible.filter((config) => config.editable);
	const allSelected =
		visibleEditable.length > 0 && visibleEditable.every((config) => selectedKeys.has(`${config.scope}:${config.id}`));
	const busy = state.subagentConfigsSaving || state.subagentConfigsLoading;
	const openEditor = (config?: SubagentConfig) => {
		listOffset.current = scrollRef.current?.scrollTop ?? 0;
		returnKey.current = config ? `${config.scope}:${config.id}` : undefined;
		setEditor({ config, scope: scope === "project" ? "project" : "user" });
	};
	const remove = async (config: SubagentConfig) => {
		if (!window.confirm(`确定删除 ${config.name} 配置吗？`)) return;
		await actions.deleteSubagentConfig(config);
	};
	if (editor)
		return (
			<AgentEditor
				config={editor.config}
				defaultScope={editor.scope}
				state={state}
				actions={actions}
				onClose={closeEditor}
				onLeaveGuardChange={onLeaveGuardChange}
			/>
		);
	const scopeTabs = [
		{
			value: "all" as const,
			label: "全部",
			count: state.subagentConfigs.length,
			countLabel: "智能体",
		},
		{
			value: "user" as const,
			label: "个人",
			count: state.subagentConfigs.filter((config) => config.scope === "user").length,
			countLabel: "智能体",
		},
		{
			value: "project" as const,
			label: "项目",
			count: state.subagentConfigs.filter((config) => config.scope === "project").length,
			countLabel: "智能体",
		},
	];
	return (
		<div className="@container/agents flex h-full min-h-0 min-w-0 flex-col gap-3">
			<div className="flex shrink-0 flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
				<Tabs className="shrink-0" value={scope} onValueChange={(value) => setScope(value as ScopeFilter)}>
					<WorkbenchTabBar activeId={scope} label="智能体范围" tabs={scopeTabs} variant="navigation" className="h-8" />
					{(["all", "user", "project"] as const)
						.filter((option) => option !== scope)
						.map((option) => (
							<TabsContent key={option} value={option} forceMount className="hidden" />
						))}
				</Tabs>
				<div className="flex min-w-0 flex-1 flex-wrap items-center justify-end gap-2 lg:flex-none">
					<div className="relative w-full min-w-0 sm:w-64 sm:flex-none">
						<Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
						<Input
							className="h-8 rounded-md pl-9 !text-sm !leading-5"
							aria-label="搜索智能体"
							placeholder="搜索名称或描述"
							value={query}
							onChange={(event) => setQuery(event.target.value)}
						/>
					</div>
					<Button
						variant="outline"
						size="icon-sm"
						aria-label="刷新智能体"
						title="刷新智能体"
						onClick={() => void actions.refreshSubagentConfigs()}
						disabled={state.subagentConfigsLoading}
					>
						<RefreshCw className={`size-4 ${state.subagentConfigsLoading ? "animate-spin" : ""}`} />
					</Button>
					<Button variant="outline" size="sm" className="!text-sm !leading-5" onClick={() => setNicknameOpen(true)}>
						协作昵称
					</Button>
					<Button size="sm" className="!text-sm !leading-5" onClick={() => openEditor()} disabled={busy}>
						<Plus className="size-4" aria-hidden />
						新建智能体
					</Button>
				</div>
			</div>
			<div className="flex shrink-0 flex-wrap items-center justify-between gap-2 text-xs">
				<div className="flex flex-wrap items-center gap-3">
					<label className="flex min-h-11 items-center gap-2 sm:min-h-7">
						<input
							aria-label="全选可修改的智能体"
							className="size-4 accent-foreground focus-visible:ring-2 focus-visible:ring-ring"
							type="checkbox"
							checked={allSelected}
							disabled={busy || !visibleEditable.length}
							ref={(element) => {
								if (element)
									element.indeterminate =
										!allSelected &&
										visibleEditable.some((config) => selectedKeys.has(`${config.scope}:${config.id}`));
							}}
							onChange={(event) => {
								const checked = event.target.checked;
								setSelectedKeys((current) => {
									const next = new Set(current);
									for (const config of visibleEditable) {
										const key = `${config.scope}:${config.id}`;
										if (checked) next.add(key);
										else next.delete(key);
									}
									return next;
								});
							}}
						/>
						全选
					</label>
					<span className="text-muted-foreground" aria-live="polite">
						{selectedConfigs.length ? `已选择 ${selectedConfigs.length} 个` : `${visible.length} 个智能体`}
					</span>
					{selectedConfigs.length ? (
						<Button
							variant="ghost"
							size="xs"
							className="min-h-11 sm:min-h-6"
							onClick={() => setSelectedKeys(new Set())}
							disabled={busy}
						>
							取消选择
						</Button>
					) : null}
				</div>
				<Button
					variant="outline"
					size="xs"
					className="min-h-11 sm:min-h-7"
					onClick={() => setBatchOpen(true)}
					disabled={!selectedConfigs.length || busy}
				>
					批量设置
				</Button>
			</div>
			{state.subagentConfigsError ? (
				<p className="shrink-0 break-words text-sm text-destructive" role="alert">
					{state.subagentConfigsError}
				</p>
			) : null}
			<div
				className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
				ref={scrollRef}
				onScroll={(event) => {
					listOffset.current = event.currentTarget.scrollTop;
				}}
			>
				<div
					aria-hidden
					className={`sticky top-0 z-10 hidden h-9 items-center gap-4 border-b border-border bg-muted px-3 text-xs text-muted-foreground @min-[900px]/agents:grid ${LIST_COLUMNS}`}
				>
					<span />
					<span>名称与职责</span>
					<span>范围</span>
					<span>模型</span>
					<span>工作区</span>
					<span>工具</span>
					<span className="text-right">操作</span>
				</div>
				{state.subagentConfigsLoading && !state.subagentConfigs.length ? (
					<div className="flex min-h-48 items-center justify-center" role="status" aria-label="正在加载智能体">
						<Spinner className="size-5" />
					</div>
				) : !visible.length ? (
					<p className="py-12 text-center text-sm text-muted-foreground" role="status">
						{state.subagentConfigs.length ? "没有符合条件的智能体" : "没有可用的智能体"}
					</p>
				) : (
					<ul className="min-w-0">
						{visible.map((config) => {
							const key = `${config.scope}:${config.id}`;
							const tools = config.excludeTools?.length
								? `禁用 ${config.excludeTools.length} 个`
								: config.tools?.length
									? `允许 ${config.tools.length} 个`
									: "默认工具";
							const modelLabel = config.model
								? `${config.provider ? `${config.provider}/` : ""}${config.model}`
								: "继承当前模型";
							return (
								<li
									data-agent-key={key}
									key={key}
									className={`grid min-w-0 grid-cols-[24px_minmax(0,1fr)_auto] items-start gap-3 border-b border-border px-2 py-3 sm:gap-4 sm:px-3 @min-[900px]/agents:min-h-[72px] @min-[900px]/agents:items-center @min-[900px]/agents:py-3.5 ${LIST_COLUMNS} ${selectedKeys.has(key) ? "bg-muted/50" : ""}`}
								>
									<label className="flex min-h-11 items-center @min-[900px]/agents:min-h-0">
										<input
											aria-label={`选择${config.scope === "user" ? "个人" : "项目"}智能体 ${config.name}`}
											className="size-4 accent-foreground focus-visible:ring-2 focus-visible:ring-ring"
											type="checkbox"
											checked={selectedKeys.has(key)}
											disabled={!config.editable || busy}
											onChange={(event) => {
												const checked = event.target.checked;
												setSelectedKeys((current) => {
													const next = new Set(current);
													if (checked) next.add(key);
													else next.delete(key);
													return next;
												});
											}}
										/>
									</label>
									<div className="min-w-0">
										<button
											type="button"
											data-agent-open
											className="flex min-w-0 items-center gap-2 rounded-sm text-left !text-sm !font-medium leading-[22px] hover:underline focus-visible:ring-2 focus-visible:ring-ring"
											onClick={() => openEditor(config)}
										>
											<AgentIdentityIcon
												iconKey={config.icon}
												className="size-4 shrink-0 object-contain text-muted-foreground"
											/>
											<span className="min-w-0 truncate">{config.name}</span>
										</button>
										<p
											className="truncate text-xs leading-[18px] text-muted-foreground"
											title={config.description}
										>
											{config.description}
										</p>
										<AgentTagList className="mt-1" tags={config.tags} />
										<div className="mt-1 flex min-w-0 flex-wrap gap-x-3 text-xs leading-[18px] text-muted-foreground @min-[900px]/agents:hidden">
											<span>{config.scope === "user" ? "个人" : "项目"}</span>
											<span>{workspaceModeLabel(config.workspaceMode ?? "direct")}</span>
											<span>{tools}</span>
										</div>
										<div className="flex min-w-0 flex-wrap gap-x-2 text-xs leading-[18px] @min-[900px]/agents:hidden">
											<span className="min-w-0 truncate font-mono" title={modelLabel}>
												{modelLabel}
											</span>
											{config.thinkingLevel ? (
												<span className="text-muted-foreground">思考 {config.thinkingLevel}</span>
											) : null}
										</div>
									</div>
									<span className="hidden text-xs leading-[18px] @min-[900px]/agents:block">
										{config.scope === "user" ? "个人" : "项目"}
									</span>
									<div className="hidden min-w-0 text-xs leading-[18px] @min-[900px]/agents:block">
										<span className="block truncate font-mono" title={modelLabel}>
											{modelLabel}
										</span>
										{config.thinkingLevel ? (
											<span className="block text-muted-foreground">思考 {config.thinkingLevel}</span>
										) : null}
									</div>
									<span className="hidden text-xs leading-[18px] @min-[900px]/agents:block">
										{workspaceModeLabel(config.workspaceMode ?? "direct")}
									</span>
									<span className="hidden text-xs leading-[18px] text-muted-foreground @min-[900px]/agents:block">
										{tools}
									</span>
									<div className="flex items-center justify-end gap-1">
										<Button
											variant="ghost"
											size="xs"
											className="min-h-11 sm:min-h-7"
											onClick={() => openEditor(config)}
										>
											{config.editable ? "编辑" : "查看"}
										</Button>
										{config.editable ? (
											<DropdownMenu>
												<DropdownMenuTrigger asChild>
													<Button
														variant="ghost"
														size="icon-xs"
														className="min-h-11 min-w-11 sm:size-7"
														aria-label={`${config.name}，更多操作`}
														disabled={busy}
													>
														<MoreHorizontal className="size-4" />
													</Button>
												</DropdownMenuTrigger>
												<DropdownMenuContent align="end">
													<DropdownMenuItem variant="destructive" onSelect={() => void remove(config)}>
														<Trash2 className="size-4" />
														删除
													</DropdownMenuItem>
												</DropdownMenuContent>
											</DropdownMenu>
										) : null}
									</div>
								</li>
							);
						})}
					</ul>
				)}
			</div>
			{nicknameOpen ? <AgentNicknameDialog onClose={() => setNicknameOpen(false)} /> : null}
			{batchOpen ? (
				<SubagentBatchDialog
					configs={selectedConfigs}
					state={state}
					actions={actions}
					onSaved={(keys) =>
						setSelectedKeys((current) => new Set([...current].filter((key) => !keys.includes(key))))
					}
					onClose={() => setBatchOpen(false)}
				/>
			) : null}
		</div>
	);
}
