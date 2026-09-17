import { ArrowDownToLine, Bot, FileText, LoaderCircle, RefreshCw, WandSparkles } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import type { HarnessId, HarnessImportItem, HarnessImportSource } from "../../../types";
import type { WorkbenchState } from "../../../state/use-workbench";
import { Alert, AlertDescription, AlertTitle } from "../../ui/alert";
import { Badge } from "../../ui/badge";
import { Button } from "../../ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../ui/dialog";
import { SettingSection } from "./shared";
import type { WorkbenchActions } from "../types";

const harnessOrder: HarnessId[] = ["codex", "opencode", "claude-code"];
const harnessLabels: Record<HarnessId, string> = {
	codex: "Codex",
	opencode: "OpenCode",
	"claude-code": "Claude Code",
};
const resourceOrder: HarnessImportItem["resourceType"][] = ["instruction", "skill", "agent", "prompt", "reference"];
const resourceLabels: Record<HarnessImportItem["resourceType"], string> = {
	instruction: "全局规则",
	skill: "Skill",
	agent: "子代理",
	prompt: "提示词",
	reference: "引用文件",
};
const scopeLabels: Record<HarnessImportItem["sourceScope"], string> = {
	user: "个人",
	project: "项目",
};

function resourceIcon(type: HarnessImportItem["resourceType"]): ReactNode {
	if (type === "skill") return <WandSparkles className="size-4" />;
	if (type === "agent") return <Bot className="size-4" />;
	return <FileText className="size-4" />;
}

function sourceCount(sources: HarnessImportSource[], scope: "user" | "project"): number {
	return sources
		.filter((source) => source.scope === scope)
		.reduce((total, source) => total + source.resourceCount, 0);
}

function resourceSummary(sources: HarnessImportSource[]): string {
	const totals = sources.reduce(
		(result, source) => ({
			skills: result.skills + source.resourceTypes.skills,
			agents: result.agents + source.resourceTypes.agents,
			prompts: result.prompts + source.resourceTypes.prompts,
			instructions: result.instructions + source.resourceTypes.instructions,
			references: result.references + source.resourceTypes.references,
		}),
		{ skills: 0, agents: 0, prompts: 0, instructions: 0, references: 0 },
	);
	const parts = ([
		["Skill", totals.skills],
		["子代理", totals.agents],
		["提示词", totals.prompts],
		["全局规则", totals.instructions],
		["引用文件", totals.references],
	] satisfies Array<[string, number]>)
		.filter((entry) => entry[1] > 0)
		.map(([label, count]) => `${label} ${count}`);
	return parts.length > 0 ? parts.join(" · ") : "未发现可迁移资源";
}

function includeReferencedItems(selectedIds: Set<string>, items: HarnessImportItem[]): Set<string> {
	const next = new Set(selectedIds);
	for (const item of items) {
		if (item.resourceType !== "instruction" || !next.has(item.id)) continue;
		for (const referencedItemId of item.referencedItemIds ?? []) next.add(referencedItemId);
	}
	return next;
}

export function HarnessImportsSettings({ state, actions }: { state: WorkbenchState; actions: WorkbenchActions }) {
	const [pendingHarness, setPendingHarness] = useState<HarnessId | undefined>();
	const [activeHarness, setActiveHarness] = useState<HarnessId | undefined>();
	const [selectedItemIds, setSelectedItemIds] = useState<Set<string>>(new Set());
	const items = state.harnessImports?.items ?? [];
	const sources = state.harnessImports?.sources ?? [];
	const pendingItems = pendingHarness ? items.filter((item) => item.harness === pendingHarness) : [];
	const selectedCount = pendingItems.filter((item) => selectedItemIds.has(item.id)).length;
	const allSelected = pendingItems.length > 0 && selectedCount === pendingItems.length;
	const requiredReferenceIds = useMemo(() => {
		const required = new Set<string>();
		for (const item of pendingItems) {
			if (item.resourceType !== "instruction" || !selectedItemIds.has(item.id)) continue;
			for (const referencedItemId of item.referencedItemIds ?? []) required.add(referencedItemId);
		}
		return required;
	}, [pendingItems, selectedItemIds]);
	const resourceGroups = resourceOrder
		.map((resourceType) => ({
			resourceType,
			items: pendingItems.filter((item) => item.resourceType === resourceType),
		}))
		.filter((group) => group.items.length > 0);

	const openHarnessDialog = (harness: HarnessId) => {
		const harnessItems = items.filter((item) => item.harness === harness);
		setSelectedItemIds(includeReferencedItems(new Set(harnessItems.map((item) => item.id)), harnessItems));
		setPendingHarness(harness);
	};

	const closeHarnessDialog = () => {
		if (state.harnessImporting) return;
		setPendingHarness(undefined);
		setSelectedItemIds(new Set());
	};

	const toggleItem = (item: HarnessImportItem) => {
		if (requiredReferenceIds.has(item.id)) return;
		setSelectedItemIds((current) => {
			const next = new Set(current);
			if (next.has(item.id)) next.delete(item.id);
			else next.add(item.id);
			return includeReferencedItems(next, pendingItems);
		});
	};

	const toggleItems = (groupItems: HarnessImportItem[]) => {
		const groupIds = groupItems.map((item) => item.id);
		setSelectedItemIds((current) => {
			const next = new Set(current);
			const selected = groupIds.every((id) => next.has(id));
			for (const id of groupIds) {
				if (selected) next.delete(id);
				else next.add(id);
			}
			return includeReferencedItems(next, pendingItems);
		});
	};

	const toggleAll = () => {
		setSelectedItemIds(
			allSelected ? new Set() : includeReferencedItems(new Set(pendingItems.map((item) => item.id)), pendingItems),
		);
	};

	const migrateHarness = async () => {
		if (!pendingHarness || selectedCount === 0) return;
		setActiveHarness(pendingHarness);
		try {
			await actions.importHarnessResources(
				pendingItems.filter((item) => selectedItemIds.has(item.id)).map((item) => item.id),
			);
			setPendingHarness(undefined);
			setSelectedItemIds(new Set());
		} finally {
			setActiveHarness(undefined);
		}
	};

	return (
		<div className="grid min-w-0 gap-6">
			<SettingSection title="迁移导入">
				<div className="grid gap-4">
					<Alert>
						<AlertTitle>同名内容会被替换</AlertTitle>
						<AlertDescription>
							迁移会覆盖 {state.branding.name} 中的同名 Skill、子代理、提示词和引用文件。全局规则会完整覆盖 AGENTS.md，项目规则不会迁移，来源文件不会修改。覆盖前会自动备份现有内容。
						</AlertDescription>
					</Alert>

					<div className="flex flex-wrap items-center justify-between gap-3">
						<p className="text-sm text-muted-foreground">选择一个 Harness，再勾选要迁移的资源。</p>
						<Button
							variant="outline"
							onClick={() => void actions.refreshHarnessImports()}
							disabled={state.harnessImportsLoading || state.harnessImporting}
						>
							<RefreshCw className={state.harnessImportsLoading ? "size-4 animate-spin" : "size-4"} />
							重新扫描
						</Button>
					</div>

					{state.harnessImportsError ? (
						<Alert variant="destructive">
							<AlertTitle>迁移失败</AlertTitle>
							<AlertDescription>{state.harnessImportsError}</AlertDescription>
						</Alert>
					) : null}

					{state.harnessImportResult ? (
						<Alert variant={state.harnessImportResult.failed > 0 ? "destructive" : "default"}>
							<AlertTitle>{state.harnessImportResult.failed > 0 ? "迁移未全部完成" : "迁移完成"}</AlertTitle>
							<AlertDescription className="grid gap-1">
								<span>成功 {state.harnessImportResult.imported} 项，失败 {state.harnessImportResult.failed} 项。</span>
								{state.harnessImportResult.backupPath ? (
									<span className="break-all font-mono text-xs">覆盖前的内容已备份到 {state.harnessImportResult.backupPath}</span>
								) : null}
							</AlertDescription>
						</Alert>
					) : null}

					<div className="grid items-stretch gap-4 lg:grid-cols-3">
						{harnessOrder.map((harness) => {
							const harnessSources = sources.filter((source) => source.harness === harness);
							const harnessItems = items.filter((item) => item.harness === harness);
							const userCount = sourceCount(harnessSources, "user");
							const projectCount = sourceCount(harnessSources, "project");
							const migrating = activeHarness === harness && state.harnessImporting;
							return (
								<Card className="flex h-full min-w-0 flex-col shadow-none" key={harness}>
									<CardHeader className="flex-1 gap-3">
										<div className="flex items-start justify-between gap-3">
											<div className="min-w-0">
												<CardTitle className="text-base">{harnessLabels[harness]}</CardTitle>
												<CardDescription className="mt-1">{resourceSummary(harnessSources)}</CardDescription>
											</div>
											<ArrowDownToLine className="size-5 shrink-0 text-muted-foreground" />
										</div>
										<div className="flex flex-wrap gap-2">
											<Badge variant={userCount > 0 ? "secondary" : "outline"}>个人 {userCount}</Badge>
											<Badge variant={projectCount > 0 ? "secondary" : "outline"}>项目 {projectCount}</Badge>
										</div>
									</CardHeader>
									<CardContent className="mt-auto">
										<Button
											className="w-full"
											onClick={() => openHarnessDialog(harness)}
											disabled={harnessItems.length === 0 || state.harnessImportsLoading || state.harnessImporting}
										>
											{migrating ? <LoaderCircle className="size-4 animate-spin" /> : <ArrowDownToLine className="size-4" />}
											{migrating ? "正在迁移" : `从 ${harnessLabels[harness]} 迁移`}
										</Button>
									</CardContent>
								</Card>
							);
						})}
					</div>

					{state.harnessImportsLoading ? (
						<div className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
							<LoaderCircle className="size-4 animate-spin" />正在扫描本机配置
						</div>
					) : null}
				</div>
			</SettingSection>

			<Dialog
				open={pendingHarness !== undefined}
				onOpenChange={(open) => {
					if (!open) closeHarnessDialog();
				}}
			>
				<DialogContent className="flex h-[min(800px,calc(100dvh-2rem))] w-[calc(100%-1rem)] max-w-[calc(100%-1rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-3xl">
					<DialogHeader className="shrink-0 border-b px-4 py-5 pr-12 sm:px-6">
						<DialogTitle>{pendingHarness ? `从 ${harnessLabels[pendingHarness]} 迁移` : "选择迁移资源"}</DialogTitle>
						<DialogDescription>
							勾选要同步到 {state.branding.name} 的内容。全局规则会完整覆盖 AGENTS.md，不做 Diff 或合并。
						</DialogDescription>
					</DialogHeader>

					<div className="flex min-h-0 flex-1 flex-col">
						<div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b px-4 py-3 sm:px-6">
							<span className="text-sm text-muted-foreground">已选择 {selectedCount} / {pendingItems.length} 项</span>
							<Button variant="ghost" size="sm" onClick={toggleAll} disabled={pendingItems.length === 0 || state.harnessImporting}>
								{allSelected ? "取消全选" : "全选"}
							</Button>
						</div>

						<div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-6">
							<div className="grid gap-4">
								{resourceGroups.map((group) => {
									const groupSelected = group.items.every((item) => selectedItemIds.has(item.id));
									return (
										<section className="grid gap-2" key={group.resourceType}>
											<div className="flex items-center justify-between gap-3">
												<h3 className="text-sm font-medium">{resourceLabels[group.resourceType]} · {group.items.length}</h3>
												<Button variant="ghost" size="sm" onClick={() => toggleItems(group.items)} disabled={state.harnessImporting}>
													{groupSelected ? "取消" : "全选"}
												</Button>
											</div>
											<div className="overflow-hidden rounded-lg border">
												{group.items.map((item) => {
													const required = requiredReferenceIds.has(item.id);
													return (
														<label
															className="flex min-w-0 items-start gap-3 border-b p-3 last:border-b-0 hover:bg-muted/30"
															key={item.id}
														>
															<input
																aria-label={`选择 ${item.name}`}
																checked={selectedItemIds.has(item.id)}
																className="mt-1 size-4 shrink-0 accent-primary"
																disabled={required || state.harnessImporting}
																onChange={() => toggleItem(item)}
																type="checkbox"
															/>
															<span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground">
																{resourceIcon(item.resourceType)}
															</span>
															<span className="min-w-0 flex-1">
																<span className="flex flex-wrap items-center gap-2">
																	<strong className="truncate text-sm font-medium">{item.name}</strong>
																	<Badge variant="outline">{scopeLabels[item.sourceScope]}</Badge>
																</span>
																<span className="mt-1 block break-all font-mono text-[11px] text-muted-foreground">
																	{item.sourceRelativePath} → {item.targetRelativePath}
																</span>
																{required ? (
																	<span className="mt-1 block text-xs text-muted-foreground">由所选全局规则引用，将一并迁移。</span>
																) : item.warnings.length > 0 ? (
																	<span className="mt-1 block text-xs text-muted-foreground">{item.warnings.join("；")}</span>
																) : null}
															</span>
														</label>
													);
												})}
											</div>
										</section>
									);
								})}
							</div>
						</div>
					</div>

					<div className="shrink-0 border-t px-4 py-4 sm:px-6">
						<Alert variant="destructive" className="mb-4">
							<AlertTitle>所选同名内容会被覆盖</AlertTitle>
							<AlertDescription>覆盖前会自动备份现有内容，来源 Harness 不会修改。</AlertDescription>
						</Alert>
						<DialogFooter>
							<Button variant="outline" onClick={closeHarnessDialog} disabled={state.harnessImporting}>
								取消
							</Button>
							<Button variant="destructive" onClick={() => void migrateHarness()} disabled={state.harnessImporting || selectedCount === 0}>
								{state.harnessImporting ? <LoaderCircle className="size-4 animate-spin" /> : <ArrowDownToLine className="size-4" />}
								{state.harnessImporting ? "正在迁移" : `迁移 ${selectedCount} 项`}
							</Button>
						</DialogFooter>
					</div>
				</DialogContent>
			</Dialog>
		</div>
	);
}
