import { ArrowLeft, BookOpen, Bot, CircleHelp, Search, Sparkles, SunMoon, WandSparkles } from "lucide-react";
import { useState } from "react";
import type { ReactNode } from "react";
import type { SettingsTab, WorkbenchState } from "../../../state/use-workbench";
import { Button } from "../../ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../../ui/dialog";
import { Input } from "../../ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../ui/tabs";
import { AboutSettings } from "./about";
import { AppearanceSettings } from "./appearance";
import { DiagnosticsSettings } from "./diagnostics";
import { GlobalInstructionsSettings } from "./global-instructions";
import { ModelSettings } from "./model-settings";
import { SkillsSettings } from "./skills";
import type { WorkbenchActions } from "../types";

export function SettingsDialog({ state, actions }: { state: WorkbenchState; actions: WorkbenchActions }) {
	const [query, setQuery] = useState("");
	const settingItems: Array<{ value: SettingsTab; label: string; icon: ReactNode; section: string }> = [
		{ value: "appearance", label: "外观", icon: <SunMoon className="size-4" />, section: "个人" },
		{ value: "instructions", label: "全局提示词", icon: <BookOpen className="size-4" />, section: "个人" },
		{ value: "models", label: "模型与认证", icon: <Bot className="size-4" />, section: "工作区" },
		{ value: "skills", label: "技能", icon: <WandSparkles className="size-4" />, section: "工作区" },
		{ value: "diagnostics", label: "诊断", icon: <CircleHelp className="size-4" />, section: "工作区" },
		{ value: "about", label: "关于", icon: <Sparkles className="size-4" />, section: "其他" },
	];
	const visibleItems = settingItems.filter((item) => item.label.toLowerCase().includes(query.toLowerCase()));
	const currentLabel = settingItems.find((item) => item.value === state.settingsTab)?.label ?? "设置";
	return (
		<Dialog
			open={state.settingsOpen}
			onOpenChange={(open) => {
				if (!open) actions.closeSettings();
			}}
		>
			<DialogContent className="inset-0 h-dvh w-screen max-w-none translate-x-0 translate-y-0 rounded-none border-0 bg-background p-0 sm:max-w-none">
				<DialogHeader className="sr-only">
					<DialogTitle>设置</DialogTitle>
					<DialogDescription>工作台外观、模型、诊断和版本信息</DialogDescription>
				</DialogHeader>
				<Tabs
					value={state.settingsTab}
					onValueChange={(value) => void actions.openSettings(value as SettingsTab)}
					orientation="vertical"
					className="flex h-full min-h-0 flex-col sm:flex-row"
				>
					<aside className="flex w-full shrink-0 flex-col border-b border-border/60 bg-background sm:w-[var(--sidebar-width)] sm:border-r sm:border-b-0">
						<div className="flex h-16 shrink-0 items-center px-5">
							<Button
								className="justify-start gap-2 px-0 text-base font-medium"
								variant="ghost"
								onClick={actions.closeSettings}
							>
								<ArrowLeft className="size-5" />
								返回工作台
							</Button>
						</div>
						<div className="px-5 pb-5">
							<div className="relative">
								<Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
								<Input
									value={query}
									onChange={(event) => setQuery(event.target.value)}
									placeholder="搜索设置"
									aria-label="搜索设置"
									className="h-10 rounded-xl border-0 bg-muted/60 pl-9 shadow-none focus-visible:ring-0"
								/>
							</div>
						</div>
						<TabsList
							className="min-h-0 w-full flex-1 items-stretch justify-start gap-1 overflow-auto px-3 pb-5 sm:flex"
							variant="line"
						>
							{["个人", "工作区", "其他"].map((section) => {
								const items = visibleItems.filter((item) => item.section === section);
								if (!items.length) return null;
								return (
									<div className="grid w-full gap-1" key={section}>
										<p className="px-3 pb-2 pt-4 text-xs font-medium text-muted-foreground">{section}</p>
										{items.map((item) => (
											<TabsTrigger
												className="h-10 w-full justify-start gap-3 px-3 text-sm after:hidden data-[state=active]:bg-accent data-[state=active]:text-foreground"
												key={item.value}
												value={item.value}
											>
												{item.icon}
												{item.label}
											</TabsTrigger>
										))}
									</div>
								);
							})}
						</TabsList>
					</aside>
					<section className="min-w-0 flex-1 overflow-auto">
						<div className="mx-auto max-w-[1120px] p-7 sm:p-12 lg:p-16">
							<div className="mb-12">
								<h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">{currentLabel}</h1>
								<p className="mt-3 max-w-2xl text-base leading-7 text-muted-foreground">
									{state.settingsTab === "instructions"
										? "为所有项目的任务提供说明和上下文。"
										: state.settingsTab === "skills"
											? "查看和管理当前项目可用的 Skill。"
											: "配置工作台的外观、模型连接和运行信息。"}
								</p>
							</div>
							<TabsContent className="m-0" value="appearance">
								<AppearanceSettings state={state} actions={actions} />
							</TabsContent>
							<TabsContent className="m-0" value="instructions">
								<GlobalInstructionsSettings state={state} actions={actions} />
							</TabsContent>
							<TabsContent className="m-0" value="skills">
								<SkillsSettings state={state} actions={actions} />
							</TabsContent>
							<TabsContent className="m-0" value="diagnostics">
								<DiagnosticsSettings state={state} />
							</TabsContent>
							<TabsContent className="m-0" value="about">
								<AboutSettings state={state} />
							</TabsContent>
						</div>
					</section>
				</Tabs>
			</DialogContent>
		</Dialog>
	);
}
