import { ArrowDownToLine, ArrowLeft, BookOpen, Bot, CircleHelp, RefreshCw, Search, ShieldCheck, Sparkles, SunMoon, WandSparkles } from "lucide-react";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { useAppInstall } from "../../../state/use-app-install";
import type { SettingsTab, WorkbenchState } from "../../../state/use-workbench";
import { Button } from "../../ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../../ui/dialog";
import { Input } from "../../ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../ui/tabs";
import { AboutSettings } from "./about";
import { AppearanceSettings } from "./appearance";
import { DiagnosticsSettings } from "./diagnostics";
import { GlobalInstructionsSettings } from "./global-instructions";
import { HarnessImportsSettings } from "./imports";
import { ModelSettings } from "./model-settings";
import { SecuritySettings } from "./security";
import { SkillsSettings } from "./skills";
import type { WorkbenchActions } from "../types";

export function SettingsDialog({ state, actions }: { state: WorkbenchState; actions: WorkbenchActions }) {
	const [query, setQuery] = useState("");
	const [isMobile, setIsMobile] = useState(false);
	const appInstall = useAppInstall();
	useEffect(() => {
		const media = window.matchMedia("(max-width: 639px)");
		const update = () => setIsMobile(media.matches);
		update();
		media.addEventListener("change", update);
		return () => media.removeEventListener("change", update);
	}, []);
	const settingItems: Array<{ value: SettingsTab; label: string; icon: ReactNode; section: string }> = [
		{ value: "appearance", label: "外观", icon: <SunMoon className="size-4" />, section: "个人" },
		{ value: "instructions", label: "全局提示词", icon: <BookOpen className="size-4" />, section: "个人" },
		{ value: "models", label: "模型与认证", icon: <Bot className="size-4" />, section: "工作区" },
		{ value: "skills", label: "技能", icon: <WandSparkles className="size-4" />, section: "工作区" },
		{ value: "imports", label: "迁移导入", icon: <ArrowDownToLine className="size-4" />, section: "工作区" },
		{ value: "diagnostics", label: "诊断", icon: <CircleHelp className="size-4" />, section: "工作区" },
		{ value: "security", label: "安全与访问", icon: <ShieldCheck className="size-4" />, section: "系统" },
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
			<DialogContent className="inset-0 h-dvh w-screen max-w-none translate-x-0 translate-y-0 rounded-none border-0 bg-background p-0 pt-[env(safe-area-inset-top)] sm:max-w-none">
				<DialogHeader className="sr-only">
					<DialogTitle>设置</DialogTitle>
					<DialogDescription>工作台外观、模型、访问控制、诊断和版本信息</DialogDescription>
				</DialogHeader>
				<Tabs
					value={state.settingsTab}
					onValueChange={(value) => void actions.openSettings(value as SettingsTab)}
					orientation={isMobile ? "horizontal" : "vertical"}
					className="flex h-full min-h-0 w-full min-w-0 max-w-full flex-col overflow-hidden sm:flex-row"
				>
					<aside className="flex min-w-0 w-full shrink-0 flex-col border-b border-border/60 bg-background sm:w-[var(--sidebar-width)] sm:border-r sm:border-b-0">
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
							className="mx-4 mt-3 min-h-0 w-auto min-w-0 max-w-[calc(100%-2rem)] flex-none !flex-row flex-nowrap items-center justify-start gap-1 overflow-x-auto rounded-none bg-transparent p-0 sm:mx-0 sm:mt-0 sm:w-full sm:max-w-none sm:flex-1 sm:!flex-col sm:items-stretch sm:overflow-auto sm:rounded-none sm:px-5 sm:pb-5"
							variant="line"
						>
							{["个人", "工作区", "系统", "其他"].map((section) => {
								const items = visibleItems.filter((item) => item.section === section);
								if (!items.length) return null;
								return (
									<div className="contents sm:grid sm:w-full sm:gap-1" key={section}>
										<p className="hidden px-3 pb-2 pt-4 text-xs font-medium text-muted-foreground sm:block">{section}</p>
										{items.map((item) => (
											<TabsTrigger
													className="h-9 !w-auto !min-w-max !flex-none !justify-center whitespace-nowrap rounded-xl border-0 px-2 text-xs font-medium text-muted-foreground after:hidden data-[state=active]:bg-accent data-[state=active]:text-foreground data-[state=active]:shadow-none sm:h-10 sm:!w-full sm:!min-w-0 sm:!justify-start sm:gap-3 sm:rounded-md sm:border-0 sm:px-3 sm:text-sm sm:whitespace-normal sm:data-[state=active]:bg-accent"
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
					<section className="min-h-0 w-full min-w-0 max-w-full flex-1 overflow-x-hidden overflow-y-auto">
						<div className="mx-auto w-full min-w-0 max-w-[1120px] p-5 sm:p-12 lg:p-16">
							<div className="mb-8 sm:mb-12">
								<div className="flex items-center justify-between gap-4">
									<div className="min-w-0">
										<h1 className="text-2xl font-semibold tracking-tight sm:text-4xl">{currentLabel}</h1>
										<p className="mt-2 max-w-2xl text-base leading-7 text-muted-foreground sm:mt-3">
											{state.settingsTab === "instructions"
												? "为所有项目的任务提供说明和上下文。"
												: state.settingsTab === "skills"
													? "查看和管理当前项目可用的 Skill。"
													: state.settingsTab === "imports"
														? "把其他 Harness 的资源导入 LYStar Code。"
												: state.settingsTab === "security"
													? "配置 Web Gateway 的监听 IP、白名单、Web/Runtime 端口和密码。"
													: state.settingsTab === "appearance"
														? "配置工作台的外观和应用安装。"
														: "配置工作台的外观、模型连接和运行信息。"}
										</p>
									</div>
								{state.settingsTab === "diagnostics" ? (
									<Button className="shrink-0 self-center" variant="outline" size="sm" onClick={() => void actions.refreshDiagnostics()}>
										<RefreshCw className="size-4" aria-hidden="true" />
										刷新
									</Button>
								) : null}
								</div>
							</div>
							<TabsContent className="m-0 w-full min-w-0 max-w-full" value="appearance">
								<AppearanceSettings state={state} actions={actions} appInstall={appInstall} />
							</TabsContent>
							<TabsContent className="m-0 w-full min-w-0 max-w-full" value="instructions">
								<GlobalInstructionsSettings state={state} actions={actions} />
							</TabsContent>
							<TabsContent className="m-0 w-full min-w-0 max-w-full" value="models">
								<ModelSettings state={state} actions={actions} />
							</TabsContent>
							<TabsContent className="m-0 w-full min-w-0 max-w-full" value="skills">
								<SkillsSettings state={state} actions={actions} />
							</TabsContent>
							<TabsContent className="m-0 w-full min-w-0 max-w-full" value="imports">
								<HarnessImportsSettings state={state} actions={actions} />
							</TabsContent>
							<TabsContent className="m-0 w-full min-w-0 max-w-full" value="diagnostics">
								<DiagnosticsSettings state={state} actions={actions} />
							</TabsContent>
							<TabsContent className="m-0 w-full min-w-0 max-w-full" value="security">
								<SecuritySettings state={state} actions={actions} />
							</TabsContent>
							<TabsContent className="m-0 w-full min-w-0 max-w-full" value="about">
								<AboutSettings state={state} />
							</TabsContent>
						</div>
					</section>
				</Tabs>
			</DialogContent>
		</Dialog>
	);
}
