import { LoaderCircle, RefreshCw, Search, WandSparkles } from "lucide-react";
import { useState } from "react";
import { cn } from "../../../lib/utils";
import type { WorkbenchState } from "../../../state/use-workbench";
import { Alert, AlertDescription, AlertTitle } from "../../ui/alert";
import { Badge } from "../../ui/badge";
import { Button } from "../../ui/button";
import { Card, CardContent } from "../../ui/card";
import { Input } from "../../ui/input";
import { Switch } from "../../ui/switch";
import { SettingSection } from "./shared";
import type { WorkbenchActions } from "../types";

export function SkillsSettings({ state, actions }: { state: WorkbenchState; actions: WorkbenchActions }) {
	const [query, setQuery] = useState("");
	const [scope, setScope] = useState<"all" | "user" | "project">("all");
	const currentProject = state.projects.find((project) => project.id === state.currentProjectId);
	const visibleSkills = state.skills
		.filter((skill) => scope === "all" || skill.scope === scope)
		.filter((skill) => `${skill.name} ${skill.description}`.toLowerCase().includes(query.trim().toLowerCase()));
	const counts = {
		all: state.skills.length,
		user: state.skills.filter((skill) => skill.scope === "user").length,
		project: state.skills.filter((skill) => skill.scope === "project").length,
	};
	const scopeLabel = (value: "user" | "project" | "temporary") =>
		value === "user" ? "个人" : value === "project" ? "项目" : "临时";

	return (
		<div className="grid gap-6">
			<SettingSection title="技能">
				<div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
					<div className="flex flex-wrap gap-1 rounded-lg bg-muted/60 p-1">
						{(["all", "user", "project"] as const).map((value) => (
							<Button key={value} size="sm" variant={scope === value ? "secondary" : "ghost"} onClick={() => setScope(value)}>
								{value === "all" ? "全部" : value === "user" ? "个人" : "项目"} {counts[value]}
							</Button>
						))}
					</div>
					<div className="flex items-center gap-2">
						<div className="relative w-full sm:w-64">
							<Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
							<Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索技能" aria-label="搜索技能" className="pl-9" />
						</div>
						<Button variant="outline" size="icon" onClick={() => void actions.refreshSkills()} disabled={state.skillsLoading} aria-label="重新加载技能" title="重新加载技能">
							<RefreshCw className={cn("size-4", state.skillsLoading && "animate-spin")} />
						</Button>
					</div>
				</div>
				{!currentProject ? (
					<Card className="shadow-none">
						<CardContent className="py-10 text-center text-sm text-muted-foreground">请先选择一个项目，再查看该项目可用的 Skill。</CardContent>
					</Card>
				) : state.skillsLoading ? (
					<Card className="shadow-none">
						<CardContent className="flex min-h-48 items-center justify-center gap-2 text-sm text-muted-foreground" role="status">
							<LoaderCircle className="size-4 animate-spin" />正在读取技能
						</CardContent>
					</Card>
				) : state.skillsError ? (
					<Alert variant="destructive">
						<AlertTitle>技能读取失败</AlertTitle>
						<AlertDescription>{state.skillsError}</AlertDescription>
					</Alert>
				) : (
					<Card className="shadow-none">
						<CardContent className="p-0">
							{visibleSkills.length ? visibleSkills.map((skill) => {
								const updating = state.skillUpdatingPath === skill.path;
								const editable = skill.scope !== "temporary";
								return (
									<div className="flex items-center gap-3 border-b px-4 py-4 last:border-b-0 sm:gap-4 sm:px-5" key={`${skill.scope}:${skill.path}`}>
										<div className="grid size-10 shrink-0 place-items-center rounded-full border bg-muted/30 text-muted-foreground">
											<WandSparkles className="size-4" />
										</div>
										<div className="min-w-0 flex-1">
											<div className="flex min-w-0 items-center gap-2">
												<strong className="truncate text-sm font-medium">{skill.name}</strong>
												<Badge variant="outline" className="shrink-0">{scopeLabel(skill.scope)}</Badge>
											</div>
											<p className="mt-1 line-clamp-2 text-sm leading-5 text-muted-foreground" title={skill.description}>{skill.description || "暂无描述"}</p>
										</div>
										<Switch checked={skill.enabled} disabled={!editable || updating} onCheckedChange={() => void actions.toggleSkill(skill)} aria-label={`${skill.enabled ? "停用" : "启用"} ${skill.name}`} />
									</div>
								);
							}) : (
								<div className="py-10 text-center text-sm text-muted-foreground">没有找到匹配的 Skill。</div>
							)}
						</CardContent>
					</Card>
				)}
				{Array.isArray(state.skillDiagnostics) && state.skillDiagnostics.length > 0 ? (
					<Alert>
						<AlertTitle>发现 {state.skillDiagnostics.length} 条加载诊断</AlertTitle>
						<AlertDescription>部分 Skill 可能无法加载，请检查 Skill 文件和配置。</AlertDescription>
					</Alert>
				) : null}
			</SettingSection>
		</div>
	);
}
