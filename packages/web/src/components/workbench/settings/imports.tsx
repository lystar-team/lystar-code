import {
	ArrowDownToLine,
	Bot,
	Check,
	ChevronDown,
	ChevronRight,
	FileDiff,
	FileText,
	Folder,
	FolderOpen,
	Info,
	LoaderCircle,
	RefreshCw,
	WandSparkles,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ChangeEvent, type ReactNode } from "react";
import type { HarnessId, HarnessImportInstructionHunk, HarnessImportItem, HarnessImportSource } from "../../../types";
import type { WorkbenchState } from "../../../state/use-workbench";
import { Alert, AlertDescription, AlertTitle } from "../../ui/alert";
import { Badge } from "../../ui/badge";
import { Button } from "../../ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../ui/select";
import { SettingSection } from "./shared";
import type { WorkbenchActions } from "../types";

type ResourceFilter = "all" | HarnessImportItem["resourceType"];

const harnessOrder: HarnessId[] = ["codex", "opencode", "claude-code"];
const harnessLabels: Record<HarnessId, string> = {
	codex: "Codex",
	opencode: "OpenCode",
	"claude-code": "Claude Code",
};
const resourceLabels: Record<HarnessImportItem["resourceType"], string> = {
	agent: "子代理",
	reference: "引用文件",
	skill: "Skill",
	prompt: "提示词模板",
	instruction: "规则文件",
};
const scopeLabels: Record<HarnessImportItem["sourceScope"], string> = {
	user: "个人来源",
	project: "项目来源",
};

function resourceIcon(type: HarnessImportItem["resourceType"]): ReactNode {
	if (type === "agent") return <Bot className="size-4" />;
	if (type === "skill") return <WandSparkles className="size-4" />;
	if (type === "instruction") return <FileDiff className="size-4" />;
	return <FileText className="size-4" />;
}

function sourceSummary(sources: HarnessImportSource[]) {
	const detected = sources.filter((source) => source.detected);
	if (!detected.length) return "未发现配置";
	return detected
		.map((source) => `${source.scope === "user" ? "个人" : "项目"} ${source.resourceCount} 项`)
		.join(" · ");
}

function itemStatusLabel(item: HarnessImportItem) {
	if (item.status === "ready") return item.resourceType === "instruction" ? "查看 Diff" : "可导入";
	if (item.status === "already-imported") return "已导入";
	if (item.status === "conflict") return "有冲突";
	return "不支持";
}

function itemStatusVariant(item: HarnessImportItem): "secondary" | "destructive" | "outline" {
	if (item.status === "ready") return "secondary";
	if (item.status === "conflict") return "destructive";
	return "outline";
}

function isSelectableItem(item: HarnessImportItem): boolean {
	return item.status === "ready" && item.resourceType !== "instruction";
}

interface ResourceTreeNode {
	id: string;
	label: string;
	path: string;
	children: ResourceTreeNode[];
	itemIds: string[];
	item?: HarnessImportItem;
}

function buildResourceTree(items: HarnessImportItem[]): ResourceTreeNode[] {
	const roots: ResourceTreeNode[] = [];
	for (const item of items) {
		const segments = item.targetRelativePath.split("/").filter(Boolean);
		if (segments.length === 0) continue;
		let currentChildren = roots;
		let parentPath = "";
		for (const [index, segment] of segments.entries()) {
			const isLeaf = index === segments.length - 1;
			const path = parentPath ? `${parentPath}/${segment}` : segment;
			if (isLeaf) {
				currentChildren.push({
					id: `item:${item.id}`,
					label: item.resourceType === "instruction" ? "AGENTS.md" : item.name || segment,
					path,
					children: [],
					itemIds: [item.id],
					item,
				});
				break;
			}
			let group = currentChildren.find((candidate) => !candidate.item && candidate.path === path);
			if (!group) {
				group = { id: `group:${path}`, label: segment, path, children: [], itemIds: [] };
				currentChildren.push(group);
			}
			group.itemIds.push(item.id);
			currentChildren = group.children;
			parentPath = path;
		}
	}
	return sortResourceTree(roots);
}

function sortResourceTree(nodes: ResourceTreeNode[]): ResourceTreeNode[] {
	const preferredOrder = ["agents", "rules", "skills", "prompts"];
	return nodes
		.slice()
		.sort((left, right) => {
			const leftItem = left.item !== undefined;
			const rightItem = right.item !== undefined;
			if (leftItem !== rightItem) return Number(leftItem) - Number(rightItem);
			const leftPriority = preferredOrder.indexOf(left.label.toLowerCase());
			const rightPriority = preferredOrder.indexOf(right.label.toLowerCase());
			if (leftPriority !== rightPriority) {
				return (leftPriority < 0 ? preferredOrder.length : leftPriority) - (rightPriority < 0 ? preferredOrder.length : rightPriority);
			}
			return left.label.localeCompare(right.label, "zh-CN");
		})
		.map((node) => ({ ...node, children: sortResourceTree(node.children) }));
}

export function HarnessImportsSettings({ state, actions }: { state: WorkbenchState; actions: WorkbenchActions }) {
	const [dialogOpen, setDialogOpen] = useState(false);
	const sources = state.harnessImports?.sources.filter((source) => source.detected) ?? [];
	const totalReady =
		state.harnessImports?.items.filter((item) => item.status === "ready" && item.resourceType !== "instruction").length ?? 0;

	return (
		<div className="grid min-w-0 gap-6">
			<SettingSection title="迁移导入">
				<Card className="min-w-0 shadow-none">
					<CardHeader className="gap-2">
						<div className="flex items-start justify-between gap-4">
							<div className="min-w-0">
								<CardTitle className="text-base">从其他 Harness 导入资源</CardTitle>
								<CardDescription>扫描本机配置，按 Harness 选择要迁移到 {state.branding.name} 的资源。</CardDescription>
							</div>
							<ArrowDownToLine className="size-5 shrink-0 text-muted-foreground" />
						</div>
					</CardHeader>
					<CardContent className="grid gap-4">
						{state.harnessImportsLoading ? (
							<div className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
								<LoaderCircle className="size-4 animate-spin" />正在扫描本机配置
							</div>
						) : state.harnessImportsError ? (
							<Alert variant="destructive">
								<AlertTitle>扫描失败</AlertTitle>
								<AlertDescription>{state.harnessImportsError}</AlertDescription>
							</Alert>
						) : (
							<div className="grid gap-2 sm:grid-cols-3">
								{harnessOrder.map((harness) => {
									const harnessSources = sources.filter((source) => source.harness === harness);
									const count = harnessSources.reduce((total, source) => total + source.resourceCount, 0);
									return (
										<div className="rounded-lg border bg-muted/20 p-3" key={harness}>
											<div className="flex items-center justify-between gap-2">
												<strong className="text-sm font-medium">{harnessLabels[harness]}</strong>
												<Badge variant={count > 0 ? "secondary" : "outline"}>{count}</Badge>
											</div>
											<p className="mt-1 text-xs text-muted-foreground">{sourceSummary(harnessSources)}</p>
										</div>
									);
								})}
							</div>
						)}
						<div className="flex flex-wrap items-center justify-between gap-3">
							<p className="text-sm text-muted-foreground">
								{totalReady ? `${totalReady} 项资源可迁移` : "没有发现可直接迁移的新资源"}
							</p>
							<div className="flex gap-2">
								<Button variant="outline" onClick={() => void actions.refreshHarnessImports()} disabled={state.harnessImportsLoading}>
									<RefreshCw className="size-4" />重新扫描
								</Button>
								<Button onClick={() => setDialogOpen(true)} disabled={!state.harnessImports || state.harnessImportsLoading || !state.currentProjectId}>
									选择资源
								</Button>
							</div>
						</div>
					</CardContent>
				</Card>
			</SettingSection>
			<HarnessImportDialog open={dialogOpen} onOpenChange={setDialogOpen} state={state} actions={actions} />
		</div>
	);
}

function HarnessImportDialog({
	open,
	onOpenChange,
	state,
	actions,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	state: WorkbenchState;
	actions: WorkbenchActions;
}) {
	const [activeHarness, setActiveHarness] = useState<HarnessId>("codex");
	const [filter, setFilter] = useState<ResourceFilter>("all");
	const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
	const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
	const [ruleItem, setRuleItem] = useState<HarnessImportItem | undefined>();
	const targetScope = state.harnessImportScope;
	const items = state.harnessImports?.items ?? [];
	const detectedHarnesses = useMemo(
		() => harnessOrder.filter((harness) => state.harnessImports?.sources.some((source) => source.harness === harness && source.detected)),
		[state.harnessImports],
	);
	const harnessItems = useMemo(() => items.filter((item) => item.harness === activeHarness), [activeHarness, items]);
	const visibleItems = useMemo(
		() => harnessItems.filter((item) => filter === "all" || item.resourceType === filter),
		[filter, harnessItems],
	);
	const resourceTree = useMemo(() => buildResourceTree(visibleItems), [visibleItems]);
	const selectableItems = visibleItems.filter(isSelectableItem);
	const selectedCount = items.filter((item) => selectedIds.has(item.id)).length;

	useEffect(() => {
		if (!detectedHarnesses.includes(activeHarness)) setActiveHarness(detectedHarnesses[0] ?? "codex");
	}, [activeHarness, detectedHarnesses]);

	useEffect(() => {
		if (!open) return;
		setSelectedIds(new Set(items.filter(isSelectableItem).map((item) => item.id)));
		setFilter("all");
	}, [open, state.harnessImports, targetScope, items]);

	useEffect(() => {
		if (!open) return;
		setExpandedIds(new Set(resourceTree.filter((node) => node.item === undefined).map((node) => node.id)));
	}, [open, resourceTree]);

	const changeScope = (value: "user" | "project") => {
		setSelectedIds(new Set());
		void actions.refreshHarnessImports(value);
	};

	const toggleItem = (item: HarnessImportItem) => {
		if (!isSelectableItem(item)) return;
		setSelectedIds((current) => {
			const next = new Set(current);
			if (next.has(item.id)) next.delete(item.id);
			else next.add(item.id);
			return next;
		});
	};

	const toggleItems = (itemIds: string[]) => {
		const selectableIds = itemIds.filter((id) => {
			const item = items.find((candidate) => candidate.id === id);
			return item !== undefined && isSelectableItem(item);
		});
		if (selectableIds.length === 0) return;
		setSelectedIds((current) => {
			const next = new Set(current);
			const allSelected = selectableIds.every((id) => next.has(id));
			for (const id of selectableIds) {
				if (allSelected) next.delete(id);
				else next.add(id);
			}
			return next;
		});
	};

	const toggleVisible = () => toggleItems(selectableItems.map((item) => item.id));

	const importRule = (mode: "merge" | "replace", hunkIds: string[]) => {
		if (!ruleItem) return;
		const itemIds = [ruleItem.id, ...(ruleItem.referencedItemIds ?? [])];
		if (mode === "replace") void actions.importHarnessResources(targetScope, itemIds, undefined, [ruleItem.id]);
		else void actions.importHarnessResources(targetScope, itemIds, { [ruleItem.id]: hunkIds });
		setRuleItem(undefined);
	};

	return (
		<>
			<Dialog open={open} onOpenChange={onOpenChange}>
				<DialogContent className="flex h-[min(800px,calc(100dvh-2rem))] w-[calc(100%-1rem)] max-w-[calc(100%-1rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-5xl">
					<DialogHeader className="shrink-0 border-b px-4 py-5 pr-12 sm:px-6">
						<DialogTitle>选择要迁移到 {state.branding.name} 的资源</DialogTitle>
						<DialogDescription>
							AGENTS.md 引用的文件和子代理会按目录列出；路径只在 {state.branding.name} 的目标副本中更新，来源 Harness 文件不会被修改。
						</DialogDescription>
					</DialogHeader>
					<div className="flex min-h-0 flex-1 flex-col">
						<div className="grid shrink-0 gap-4 border-b px-4 py-4 sm:px-6">
							<div className="flex flex-wrap items-center justify-between gap-3">
								<Select value={targetScope} onValueChange={(value) => changeScope(value as "user" | "project")}>
									<SelectTrigger aria-label="导入目标" className="w-44">
										<SelectValue placeholder="导入到" />
									</SelectTrigger>
									<SelectContent>
										<SelectItem value="user">个人资源</SelectItem>
										<SelectItem value="project">当前项目</SelectItem>
									</SelectContent>
								</Select>
								<Button variant="outline" size="sm" onClick={() => void actions.refreshHarnessImports(targetScope)} disabled={state.harnessImportsLoading}>
									<RefreshCw className={state.harnessImportsLoading ? "size-4 animate-spin" : "size-4"} />重新扫描
								</Button>
							</div>
							<div className="grid grid-cols-1 gap-2 sm:grid-cols-3" role="tablist" aria-label="Harness">
								{harnessOrder.map((harness) => {
									const harnessItemsCount = items.filter((item) => item.harness === harness).length;
									const detected = detectedHarnesses.includes(harness);
									return (
										<button
											aria-selected={activeHarness === harness}
											className={`flex min-w-0 items-center justify-between gap-2 rounded-lg border px-3 py-2 text-left text-sm transition-colors ${activeHarness === harness ? "border-primary bg-accent" : "hover:bg-muted/40"} ${!detected ? "opacity-50" : ""}`}
											disabled={!detected}
											key={harness}
											onClick={() => setActiveHarness(harness)}
											type="button"
										>
											<span className="truncate font-medium">{harnessLabels[harness]}</span>
											<Badge variant={harnessItemsCount > 0 ? "secondary" : "outline"}>{harnessItemsCount}</Badge>
										</button>
									);
								})}
							</div>
						</div>
						<div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-6">
							<div className="grid gap-4">
								<div className="flex flex-wrap items-center justify-between gap-3">
									<div className="flex max-w-full gap-1 overflow-x-auto rounded-lg bg-muted/60 p-1">
										{(["all", "agent", "reference", "skill", "prompt", "instruction"] as const).map((value) => (
											<Button key={value} size="sm" variant={filter === value ? "secondary" : "ghost"} onClick={() => setFilter(value)}>
												{value === "all" ? "全部" : resourceLabels[value]}
											</Button>
										))}
									</div>
									<div className="flex items-center gap-3 text-sm">
										<span className="text-muted-foreground">已选择 {selectedCount} 项</span>
										<Button variant="ghost" size="sm" onClick={toggleVisible} disabled={selectableItems.length === 0}>
											{selectableItems.length > 0 && selectableItems.every((item) => selectedIds.has(item.id)) ? "取消全选" : "选择当前列表"}
										</Button>
									</div>
								</div>
								{state.harnessImportsLoading ? (
									<div className="flex min-h-56 items-center justify-center gap-2 text-sm text-muted-foreground" role="status">
										<LoaderCircle className="size-4 animate-spin" />正在更新资源列表
									</div>
								) : resourceTree.length ? (
									<ResourceTree
										expandedIds={expandedIds}
										items={items}
						nodes={resourceTree}
						productName={state.branding.name}
						onOpenInstruction={(item) => setRuleItem(item)}
										onToggleExpanded={(nodeId) =>
											setExpandedIds((current) => {
												const next = new Set(current);
												if (next.has(nodeId)) next.delete(nodeId);
												else next.add(nodeId);
												return next;
											})
										}
										onToggleItems={toggleItems}
										onToggleItem={toggleItem}
										selectedIds={selectedIds}
									/>
								) : (
									<div className="rounded-lg border border-dashed py-12 text-center text-sm text-muted-foreground">
										{detectedHarnesses.length ? `没有找到 ${harnessLabels[activeHarness]} 的资源` : "没有找到可迁移的资源"}
									</div>
								)}
								{state.harnessImportResult ? (
									<Alert>
										<AlertTitle>迁移完成</AlertTitle>
										<AlertDescription>
											成功 {state.harnessImportResult.imported} 项，跳过 {state.harnessImportResult.skipped} 项，失败 {state.harnessImportResult.failed} 项。
										</AlertDescription>
									</Alert>
								) : null}
								{state.harnessImportsError ? (
									<Alert variant="destructive">
										<AlertTitle>迁移失败</AlertTitle>
										<AlertDescription>{state.harnessImportsError}</AlertDescription>
									</Alert>
								) : null}
							</div>
						</div>
					</div>
					<DialogFooter className="shrink-0 border-t px-4 py-4 sm:px-6">
						<Button variant="outline" onClick={() => onOpenChange(false)}>
							取消
						</Button>
						<Button onClick={() => void actions.importHarnessResources(targetScope, [...selectedIds])} disabled={selectedCount === 0 || state.harnessImporting}>
							{state.harnessImporting ? <LoaderCircle className="size-4 animate-spin" /> : <ArrowDownToLine className="size-4" />}
							{state.harnessImporting ? "正在迁移" : `迁移 ${selectedCount} 项`}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
			<RuleMergeDialog
				item={ruleItem}
				open={ruleItem !== undefined}
				onOpenChange={(nextOpen) => {
					if (!nextOpen) setRuleItem(undefined);
				}}
				onConfirm={importRule}
				busy={state.harnessImporting}
				productName={state.branding.name}
			/>
		</>
	);
}

function ResourceTree({
	nodes,
	items,
	selectedIds,
	expandedIds,
	onToggleItem,
	onToggleItems,
	onToggleExpanded,
	onOpenInstruction,
	productName,
}: {
	nodes: ResourceTreeNode[];
	items: HarnessImportItem[];
	selectedIds: Set<string>;
	expandedIds: Set<string>;
	onToggleItem: (item: HarnessImportItem) => void;
	onToggleItems: (itemIds: string[]) => void;
	onToggleExpanded: (nodeId: string) => void;
	onOpenInstruction: (item: HarnessImportItem) => void;
	productName: string;
}) {
	const itemsById = useMemo(() => new Map(items.map((item) => [item.id, item])), [items]);
	return (
		<div aria-label="迁移资源目录" className="rounded-lg border bg-background p-2" role="tree">
			{nodes.map((node) => (
				<ResourceTreeNodeView
					expandedIds={expandedIds}
					itemsById={itemsById}
					key={node.id}
					level={1}
					node={node}
					productName={productName}
					onOpenInstruction={onOpenInstruction}
					onToggleExpanded={onToggleExpanded}
					onToggleItems={onToggleItems}
					onToggleItem={onToggleItem}
					selectedIds={selectedIds}
				/>
			))}
		</div>
	);
}

function ResourceTreeNodeView({
	node,
	level,
	itemsById,
	selectedIds,
	expandedIds,
	onToggleItem,
	onToggleItems,
	onToggleExpanded,
	onOpenInstruction,
	productName,
}: {
	node: ResourceTreeNode;
	level: number;
	itemsById: Map<string, HarnessImportItem>;
	selectedIds: Set<string>;
	expandedIds: Set<string>;
	onToggleItem: (item: HarnessImportItem) => void;
	onToggleItems: (itemIds: string[]) => void;
	onToggleExpanded: (nodeId: string) => void;
	onOpenInstruction: (item: HarnessImportItem) => void;
	productName: string;
}) {
	if (node.item) {
		const item = node.item;
		const selectable = isSelectableItem(item);
		const clickable = item.status === "ready";
		const selected = selectedIds.has(item.id);
		return (
			<div aria-level={level} className="flex min-w-0 items-start gap-1 rounded-md px-1 py-0.5" role="treeitem">
				{selectable ? (
					<TreeCheckbox checked={selected} label={`选择 ${item.name}`} onChange={() => onToggleItem(item)} />
				) : item.resourceType === "instruction" && clickable ? (
					<span className="mt-2 grid size-4 shrink-0 place-items-center text-muted-foreground" title="查看 Diff">
						<FileDiff className="size-3.5" />
					</span>
				) : (
					<span className="mt-2 grid size-4 shrink-0 place-items-center text-muted-foreground/60">
						{item.status === "already-imported" ? <Check className="size-3.5" /> : null}
					</span>
				)}
				<button
					aria-pressed={selectable ? selected : undefined}
					className="flex min-w-0 flex-1 items-start gap-2 rounded-md px-2 py-2 text-left transition-colors hover:bg-muted/50 disabled:cursor-default disabled:opacity-65"
					disabled={!clickable}
					onClick={() => (item.resourceType === "instruction" ? onOpenInstruction(item) : onToggleItem(item))}
					type="button"
				>
					<span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground">{resourceIcon(item.resourceType)}</span>
					<span className="min-w-0 flex-1">
						<span className="flex flex-wrap items-center gap-2">
							<strong className="min-w-0 truncate text-sm font-medium">{item.name}</strong>
							<Badge variant="outline">{scopeLabels[item.sourceScope]}</Badge>
							<Badge variant={itemStatusVariant(item)}>{itemStatusLabel(item)}</Badge>
						</span>
						<span className="mt-1 flex min-w-0 items-center gap-1 truncate font-mono text-[11px] text-muted-foreground">
							<span className="truncate">{item.sourceRelativePath}</span>
							<span aria-hidden="true">→</span>
							<span className="truncate">{productName} / {item.targetRelativePath}</span>
						</span>
						{item.warnings.length ? (
							<span className="mt-1 flex items-start gap-1 text-xs text-muted-foreground">
								<Info className="mt-0.5 size-3.5 shrink-0" />
								<span>{item.warnings.join("；")}</span>
							</span>
						) : null}
					</span>
				</button>
			</div>
		);
	}

	const expanded = expandedIds.has(node.id);
	const selectableIds = node.itemIds.filter((id) => {
		const item = itemsById.get(id);
		return item !== undefined && isSelectableItem(item);
	});
	const checked = selectableIds.length > 0 && selectableIds.every((id) => selectedIds.has(id));
	const mixed = selectableIds.some((id) => selectedIds.has(id)) && !checked;
	return (
		<div aria-level={level} className="min-w-0" role="treeitem" aria-expanded={expanded}>
			<div className="flex min-w-0 items-center gap-1 rounded-md px-1 py-0.5 hover:bg-muted/40">
				<TreeCheckbox
					checked={checked}
					disabled={selectableIds.length === 0}
					label={`选择目录 ${node.label}`}
					mixed={mixed}
					onChange={() => onToggleItems(node.itemIds)}
				/>
				<button
					aria-expanded={expanded}
					className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-2 text-left text-sm font-medium"
					onClick={() => onToggleExpanded(node.id)}
					type="button"
				>
					{expanded ? <ChevronDown className="size-4 shrink-0 text-muted-foreground" /> : <ChevronRight className="size-4 shrink-0 text-muted-foreground" />}
					{expanded ? <FolderOpen className="size-4 shrink-0 text-muted-foreground" /> : <Folder className="size-4 shrink-0 text-muted-foreground" />}
					<span className="min-w-0 truncate">{node.label}</span>
					<span className="ml-auto shrink-0 text-xs font-normal text-muted-foreground">{node.itemIds.length}</span>
				</button>
			</div>
			{expanded && node.children.length ? (
				<div className="ml-5 border-l border-border pl-2" role="group">
					{node.children.map((child) => (
						<ResourceTreeNodeView
							expandedIds={expandedIds}
							itemsById={itemsById}
							key={child.id}
							level={level + 1}
							node={child}
							productName={productName}
							onOpenInstruction={onOpenInstruction}
							onToggleExpanded={onToggleExpanded}
							onToggleItems={onToggleItems}
							onToggleItem={onToggleItem}
							selectedIds={selectedIds}
						/>
					))}
				</div>
			) : null}
		</div>
	);
}

function TreeCheckbox({
	checked,
	mixed = false,
	disabled = false,
	label,
	onChange,
}: {
	checked: boolean;
	mixed?: boolean;
	disabled?: boolean;
	label: string;
	onChange: (event: ChangeEvent<HTMLInputElement>) => void;
}) {
	const ref = useRef<HTMLInputElement>(null);
	useEffect(() => {
		if (ref.current) ref.current.indeterminate = mixed;
	}, [mixed]);
	return (
		<input
			aria-checked={mixed ? "mixed" : checked}
			aria-label={label}
			checked={checked}
			className="mt-2 size-4 shrink-0 accent-primary"
			disabled={disabled}
			onChange={onChange}
			ref={ref}
			type="checkbox"
		/>
	);
}

function RuleMergeDialog({
	item,
	open,
	onOpenChange,
	onConfirm,
	busy,
	productName,
}: {
	item?: HarnessImportItem;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onConfirm: (mode: "merge" | "replace", hunkIds: string[]) => void;
	busy: boolean;
	productName: string;
}) {
	const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
	const [mode, setMode] = useState<"merge" | "replace">("merge");
	const hunks: HarnessImportInstructionHunk[] = item?.instructionHunks ?? [];
	const sourceContent = item?.instructionSourceContent ?? hunks.map((hunk) => hunk.lines.join("\n")).join("\n\n");
	const targetContent = item?.instructionTargetContent ?? "";

	useEffect(() => {
		if (open) {
			setMode("merge");
			setSelectedIds(new Set(hunks.map((hunk) => hunk.id)));
		}
	}, [open, item, hunks]);

	const toggleHunk = (hunkId: string) => {
		setSelectedIds((current) => {
			const next = new Set(current);
			if (next.has(hunkId)) next.delete(hunkId);
			else next.add(hunkId);
			return next;
		});
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="flex h-[min(760px,calc(100dvh-2rem))] w-[calc(100%-1rem)] max-w-[calc(100%-1rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-4xl">
				<DialogHeader className="shrink-0 border-b px-4 py-5 pr-12 sm:px-6">
					<DialogTitle>合并到 {productName} 的 AGENTS.md</DialogTitle>
					<DialogDescription>
						{item?.harnessLabel} · {item?.sourceRelativePath} → {productName} / {item?.targetRelativePath}
					</DialogDescription>
				</DialogHeader>
				<div className="min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:px-6">
					<div className="grid gap-4">
						<div className="flex flex-wrap items-center gap-1 rounded-lg bg-muted/60 p-1">
							<Button variant={mode === "merge" ? "secondary" : "ghost"} size="sm" onClick={() => setMode("merge")}>
								按 Diff 合并
							</Button>
							<Button variant={mode === "replace" ? "secondary" : "ghost"} size="sm" onClick={() => setMode("replace")}>
								完整覆盖
							</Button>
						</div>
						{mode === "replace" ? (
							<>
								<Alert variant="destructive">
									<AlertTitle>完整覆盖 {productName} 的目标规则文件</AlertTitle>
									<AlertDescription>确认后，只覆盖 {productName} 的目标 AGENTS.md；来源 Harness 文件和原有 Harness 内容不会被修改。</AlertDescription>
								</Alert>
								<div className="grid gap-3 md:grid-cols-2">
									<RuleContentPreview title="来源完整内容（只读）" content={sourceContent} tone="source" />
									<RuleContentPreview title={`${productName} 当前内容`} content={targetContent} tone="target" />
								</div>
							</>
						) : (
							<>
								<Alert>
									<AlertTitle>只追加选择的规则块</AlertTitle>
									<AlertDescription>
										只修改 {productName} 的目标 AGENTS.md，来源文件保持不变。
										{item?.referencedItemIds?.length ? `检测到 ${item.referencedItemIds.length} 个引用文件，确认后会一并迁移。` : ""}
									</AlertDescription>
								</Alert>
								<div className="flex items-center justify-between gap-3 text-sm">
									<span className="text-muted-foreground">已选择 {selectedIds.size} / {hunks.length} 个规则块</span>
									<Button
										variant="ghost"
										size="sm"
										onClick={() => setSelectedIds(selectedIds.size === hunks.length ? new Set() : new Set(hunks.map((hunk) => hunk.id)))}
									>
										{selectedIds.size === hunks.length ? "取消全选" : "全选新增块"}
									</Button>
								</div>
								{hunks.length ? (
									<div className="grid gap-3">
										{hunks.map((hunk) => (
											<label className="grid cursor-pointer gap-3 rounded-lg border p-4 transition-colors has-[:checked]:border-primary has-[:checked]:bg-accent/40" key={hunk.id}>
												<span className="flex items-start gap-3">
													<input
														checked={selectedIds.has(hunk.id)}
														className="mt-1 size-4 accent-primary"
														onChange={() => toggleHunk(hunk.id)}
														type="checkbox"
													/>
													<span className="min-w-0 flex-1">
														<strong className="block truncate text-sm font-medium">{hunk.title}</strong>
														<span className="text-xs text-muted-foreground">新增 {hunk.lines.length} 行</span>
													</span>
												</span>
												<pre className="overflow-x-auto rounded-md bg-muted/50 p-3 text-xs leading-5 text-foreground">
													{hunk.lines.map((line, index) => (
														<div className="flex min-w-max" key={`${hunk.id}-${index}`}>
															<span className="mr-3 select-none text-muted-foreground">+</span>
															<span>{line || " "}</span>
														</div>
													))}
												</pre>
											</label>
										))}
									</div>
								) : (
									<div className="rounded-lg border border-dashed py-12 text-center text-sm text-muted-foreground">没有新的规则块可合并</div>
								)}
							</>
						)}
					</div>
				</div>
				<DialogFooter className="shrink-0 border-t px-4 py-4 sm:px-6">
					<Button variant="outline" onClick={() => onOpenChange(false)}>
						取消
					</Button>
					<Button
						variant={mode === "replace" ? "destructive" : "default"}
						onClick={() => onConfirm(mode, [...selectedIds])}
						disabled={(mode === "merge" && selectedIds.size === 0) || !item || busy}
					>
						{busy ? <LoaderCircle className="size-4 animate-spin" /> : mode === "replace" ? <FileDiff className="size-4" /> : <Check className="size-4" />}
						{busy ? "正在处理" : mode === "replace" ? "确认完整覆盖" : `合并 ${selectedIds.size} 个规则块`}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

function RuleContentPreview({ title, content, tone }: { title: string; content: string; tone: "source" | "target" }) {
	return (
		<section className="grid min-h-0 gap-2">
			<h3 className="text-sm font-medium">{title}</h3>
			<pre className={`max-h-96 min-h-48 overflow-auto rounded-md border p-3 text-xs leading-5 ${tone === "source" ? "bg-muted/40 text-foreground" : "bg-background text-foreground"}`}>
				{content || "（文件不存在或为空）"}
			</pre>
		</section>
	);
}
