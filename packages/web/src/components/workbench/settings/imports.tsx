import {
	AlertTriangle,
	ArrowDownToLine,
	Check,
	FileDiff,
	FileText,
	FolderSync,
	LoaderCircle,
	RefreshCw,
	WandSparkles,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
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
	skill: "Skill",
	prompt: "提示词模板",
	instruction: "规则文件",
};
const scopeLabels: Record<HarnessImportItem["sourceScope"], string> = {
	user: "个人来源",
	project: "项目来源",
};

function resourceIcon(type: HarnessImportItem["resourceType"]) {
	if (type === "skill") return <WandSparkles className="size-4" />;
	if (type === "prompt") return <FileText className="size-4" />;
	return <FolderSync className="size-4" />;
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
								<CardDescription>扫描本机已存在的配置，按 Harness 选择资源。</CardDescription>
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
								{totalReady ? `${totalReady} 项资源可导入` : "没有发现可直接导入的新资源"}
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
	const selectableItems = visibleItems.filter((item) => item.status === "ready" && item.resourceType !== "instruction");
	const selectedCount = items.filter((item) => selectedIds.has(item.id)).length;

	useEffect(() => {
		if (!detectedHarnesses.includes(activeHarness)) setActiveHarness(detectedHarnesses[0] ?? "codex");
	}, [activeHarness, detectedHarnesses]);

	useEffect(() => {
		if (!open) return;
		setSelectedIds(new Set(items.filter((item) => item.status === "ready" && item.resourceType !== "instruction").map((item) => item.id)));
		setFilter("all");
	}, [open, state.harnessImports, targetScope, items]);

	const changeScope = (value: "user" | "project") => {
		setSelectedIds(new Set());
		void actions.refreshHarnessImports(value);
	};

	const toggleItem = (item: HarnessImportItem) => {
		if (item.status !== "ready" || item.resourceType === "instruction") return;
		setSelectedIds((current) => {
			const next = new Set(current);
			if (next.has(item.id)) next.delete(item.id);
			else next.add(item.id);
			return next;
		});
	};

	const toggleVisible = () => {
		setSelectedIds((current) => {
			const next = new Set(current);
			const allSelected = selectableItems.length > 0 && selectableItems.every((item) => next.has(item.id));
			for (const item of selectableItems) {
				if (allSelected) next.delete(item.id);
				else next.add(item.id);
			}
			return next;
		});
	};

	return (
		<>
			<Dialog open={open} onOpenChange={onOpenChange}>
				<DialogContent className="flex h-[min(760px,calc(100dvh-2rem))] w-[calc(100%-1rem)] max-w-[calc(100%-1rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-4xl">
					<DialogHeader className="shrink-0 border-b px-4 py-5 pr-12 sm:px-6">
						<DialogTitle>选择要导入的资源</DialogTitle>
						<DialogDescription>Skill 和提示词模板可以直接导入；规则文件先查看 Diff，再选择要合并的内容。</DialogDescription>
					</DialogHeader>
					<div className="flex min-h-0 flex-1 flex-col">
						<div className="shrink-0 grid gap-4 border-b px-6 py-4">
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
							<div className="grid grid-cols-3 gap-2" role="tablist" aria-label="Harness">
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
									<div className="flex flex-wrap items-center gap-1 rounded-lg bg-muted/60 p-1">
										{(["all", "skill", "prompt", "instruction"] as const).map((value) => (
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
								) : visibleItems.length ? (
									<div className="grid gap-2">
										{visibleItems.map((item) => {
											const selectable = item.status === "ready" && item.resourceType !== "instruction";
											const isRule = item.resourceType === "instruction";
											const selected = selectedIds.has(item.id);
											return (
												<button
													aria-pressed={selected}
													className={`flex w-full items-start gap-3 rounded-lg border p-3 text-left transition-colors ${selectable || isRule ? "hover:bg-muted/40" : "cursor-default opacity-70"}`}
													disabled={!selectable && !isRule}
													key={item.id}
													onClick={() => (isRule && item.status === "ready" ? setRuleItem(item) : toggleItem(item))}
													type="button"
												>
													<span className={`mt-0.5 grid size-5 shrink-0 place-items-center rounded border ${selected ? "border-primary bg-primary text-primary-foreground" : "text-transparent"}`}>
														{isRule ? <FileDiff className="size-3.5 text-muted-foreground" /> : <Check className="size-3.5" />}
													</span>
													<span className="grid size-8 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground">{resourceIcon(item.resourceType)}</span>
													<span className="min-w-0 flex-1">
														<span className="flex flex-wrap items-center gap-2">
															<strong className="truncate text-sm font-medium">{item.name}</strong>
															<Badge variant="outline">{scopeLabels[item.sourceScope]}</Badge>
															<Badge variant="outline">{item.harnessLabel}</Badge>
															<Badge variant={item.status === "ready" ? "secondary" : "outline"}>{itemStatusLabel(item)}</Badge>
														</span>
														<span className="mt-1 block truncate text-xs text-muted-foreground">
															{item.sourceRelativePath} → {item.targetRelativePath}
														</span>
														{item.warnings.length ? (
															<span className="mt-1 flex items-center gap-1 text-xs text-amber-600">
																<AlertTriangle className="size-3" />
																{isRule ? "点击查看规则 Diff" : item.warnings[0]}
															</span>
														) : null}
													</span>
												</button>
										);
										})}
									</div>
								) : (
									<div className="rounded-lg border border-dashed py-12 text-center text-sm text-muted-foreground">
										{detectedHarnesses.length ? `没有找到 ${harnessLabels[activeHarness]} 的资源` : "没有找到可导入的资源"}
									</div>
								)}
								{state.harnessImportResult ? (
									<Alert>
										<AlertTitle>导入完成</AlertTitle>
										<AlertDescription>
											成功 {state.harnessImportResult.imported} 项，跳过 {state.harnessImportResult.skipped} 项，失败 {state.harnessImportResult.failed} 项。
										</AlertDescription>
									</Alert>
								) : null}
								{state.harnessImportsError ? (
									<Alert variant="destructive">
										<AlertTitle>导入失败</AlertTitle>
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
							{state.harnessImporting ? "正在导入" : `导入 ${selectedCount} 项`}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
			<RuleMergeDialog
				item={ruleItem}
				open={ruleItem !== undefined}
				onOpenChange={(open) => {
					if (!open) setRuleItem(undefined);
				}}
				onConfirm={(mode, hunkIds) => {
					if (!ruleItem) return;
					if (mode === "replace") void actions.importHarnessResources(targetScope, [ruleItem.id], undefined, [ruleItem.id]);
					else void actions.importHarnessResources(targetScope, [ruleItem.id], { [ruleItem.id]: hunkIds });
					setRuleItem(undefined);
				}}
				busy={state.harnessImporting}
			/>
		</>
	);
}

function RuleMergeDialog({
	item,
	open,
	onOpenChange,
	onConfirm,
	busy,
}: {
	item?: HarnessImportItem;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onConfirm: (mode: "merge" | "replace", hunkIds: string[]) => void;
	busy: boolean;
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
	}, [open, item]);

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
					<DialogTitle>合并规则 Diff</DialogTitle>
					<DialogDescription>
						{item?.harnessLabel} · {item?.sourceRelativePath} → {item?.targetRelativePath}
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
									<AlertTitle>完整覆盖目标规则文件</AlertTitle>
									<AlertDescription>确认后，目标 AGENTS.md 会被来源文件全文替换，目标现有内容不会保留。</AlertDescription>
								</Alert>
								<div className="grid gap-3 md:grid-cols-2">
									<RuleContentPreview title="来源完整内容" content={sourceContent} tone="source" />
									<RuleContentPreview title="目标当前内容" content={targetContent} tone="target" />
								</div>
							</>
						) : (
							<>
								<Alert>
									<AlertTitle>只追加你选择的规则块</AlertTitle>
									<AlertDescription>目标 AGENTS.md 已有内容不会被修改。绿色内容是来源文件中待合并的新增块。</AlertDescription>
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
												<pre className="overflow-x-auto rounded-md bg-emerald-50 p-3 text-xs leading-5 text-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-200">
													{hunk.lines.map((line, index) => (
														<div className="flex min-w-max" key={`${hunk.id}-${index}`}>
															<span className="mr-3 select-none text-emerald-600">+</span>
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
			<pre className={`max-h-96 min-h-48 overflow-auto rounded-md border p-3 text-xs leading-5 ${tone === "source" ? "bg-emerald-50 text-emerald-950 dark:bg-emerald-950/30 dark:text-emerald-100" : "bg-muted/40 text-foreground"}`}>
				{content || "（文件不存在或为空）"}
			</pre>
		</section>
	);
}
