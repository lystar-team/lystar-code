import { ArrowDownToLine, ArrowLeft, BookOpen, Bot, BrainCircuit, CircleHelp, KeyRound, RefreshCw, Search, Settings2, ShieldCheck, Sparkles, SunMoon, WandSparkles } from "lucide-react";
import { lazy, Suspense, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { webApi } from "../../../adapters/host-protocol/api";
import { useAppInstall } from "../../../state/use-app-install";
import type { SettingsTab, WorkbenchState } from "../../../state/use-workbench";
import { Button } from "../../ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../../ui/dialog";
import { Input } from "../../ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../ui/tabs";
import { GsapReveal } from "../../ui/gsap-reveal";
import { AboutSettings } from "./about";
import { AppearanceSettings } from "./appearance";
import { GlobalInstructionsSettings } from "./global-instructions";
import { HarnessImportsSettings } from "./imports";
import { ModelSettings } from "./model-settings";
import { SystemPermissionsSettings } from "./permissions";
import { SecuritySettings } from "./security";
import { SkillsSettings } from "./skills";
import { SubagentSettings } from "./subagents";
import { SystemSettings } from "./system";
import type { WorkbenchActions } from "../types";

const DiagnosticsSettings = lazy(() =>
	import("./diagnostics").then((module) => ({ default: module.DiagnosticsSettings })),
);

export function SettingsDialog({ state, actions }: { state: WorkbenchState; actions: WorkbenchActions }) {
	const [query, setQuery] = useState("");
	const [isMobile, setIsMobile] = useState(false);
	const [permissionsSupported, setPermissionsSupported] = useState(false);
	const appInstall = useAppInstall();
	useEffect(() => {
		const media = window.matchMedia("(max-width: 767px)");
		const update = () => setIsMobile(media.matches);
		update();
		media.addEventListener("change", update);
		return () => media.removeEventListener("change", update);
	}, []);
	useEffect(() => {
		if (!state.settingsOpen) return;
		let active = true;
		void webApi
			.systemPermissions()
			.then((result) => {
				if (active) setPermissionsSupported(result.supported);
			})
			.catch(() => {
				if (active) setPermissionsSupported(false);
			});
		return () => {
			active = false;
		};
	}, [state.settingsOpen]);
	const settingItems: Array<{ value: SettingsTab; label: string; icon: ReactNode; section: string }> = [
		{ value: "appearance", label: "外观", icon: <SunMoon className="size-4" />, section: "个人" },
		{ value: "instructions", label: "全局提示词", icon: <BookOpen className="size-4" />, section: "个人" },
		{ value: "models", label: "模型与认证", icon: <Bot className="size-4" />, section: "工作区" },
		{ value: "skills", label: "技能", icon: <WandSparkles className="size-4" />, section: "工作区" },
		{ value: "subagents", label: "智能体", icon: <BrainCircuit className="size-4" />, section: "工作区" },
		{ value: "imports", label: "迁移导入", icon: <ArrowDownToLine className="size-4" />, section: "工作区" },
		{ value: "diagnostics", label: "诊断", icon: <CircleHelp className="size-4" />, section: "工作区" },
		{ value: "system", label: "系统", icon: <Settings2 className="size-4" />, section: "系统" },
		...(permissionsSupported
			? [{ value: "permissions" as const, label: "系统授权", icon: <KeyRound className="size-4" />, section: "系统" }]
			: []),
		{ value: "security", label: "安全与访问", icon: <ShieldCheck className="size-4" />, section: "系统" },
		{ value: "about", label: "关于", icon: <Sparkles className="size-4" />, section: "其他" },
	];
	const visibleItems = settingItems.filter((item) => item.label.toLowerCase().includes(query.toLowerCase()));
	const currentLabel = settingItems.find((item) => item.value === state.settingsTab)?.label ?? "设置";
	const hostInstructionFile = state.hostInstructions.find((candidate) => candidate.fileName === "AGENTS.md");
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
					data-settings-root
					value={state.settingsTab}
					onValueChange={(value) => void actions.openSettings(value as SettingsTab)}
					orientation={isMobile ? "horizontal" : "vertical"}
					className="flex h-full min-h-0 w-full min-w-0 max-w-full flex-col gap-0 overflow-hidden md:flex-row"
				>
					<aside className="flex min-w-0 w-full shrink-0 flex-col border-b border-border/60 bg-background md:w-[clamp(13rem,24vw,17rem)] md:border-r md:border-b-0">
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
							className="mx-4 mt-3 min-h-0 w-auto min-w-0 max-w-[calc(100%-2rem)] flex-none !flex-row flex-nowrap items-center justify-start gap-1 overflow-x-auto rounded-none bg-transparent p-0 md:mx-0 md:mt-0 md:w-full md:max-w-none md:flex-1 md:!flex-col md:items-stretch md:overflow-auto md:rounded-none md:px-5 md:pb-5"
							variant="line"
						>
							{["个人", "工作区", "系统", "其他"].map((section) => {
								const items = visibleItems.filter((item) => item.section === section);
								if (!items.length) return null;
								return (
									<div className="contents md:grid md:w-full md:gap-1" key={section}>
										<p className="hidden px-3 pb-2 pt-4 text-xs font-medium text-muted-foreground md:block">{section}</p>
										{items.map((item) => (
											<TabsTrigger
													className="h-9 !w-auto !min-w-max !flex-none !justify-center whitespace-nowrap rounded-xl border-0 px-2 text-xs font-medium text-muted-foreground after:hidden data-[state=active]:bg-accent data-[state=active]:text-foreground data-[state=active]:shadow-none md:h-10 md:!w-full md:!min-w-0 md:!justify-start md:gap-3 md:rounded-md md:border-0 md:px-3 md:text-sm md:whitespace-normal md:data-[state=active]:bg-accent"
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
					<section data-settings-content className="min-h-0 w-full min-w-0 max-w-full flex-1 overflow-x-hidden overflow-y-auto">
						<GsapReveal animationKey={state.settingsTab} className="min-h-0 w-full" distance={16} duration={0.32}>
							<div className="mx-auto w-full min-w-0 max-w-[1120px] p-5 sm:p-8 lg:p-12 xl:p-16">
							<div className={state.settingsTab === "instructions" || state.settingsTab === "skills" ? "mb-5 sm:mb-6" : "mb-8 sm:mb-12"}>
								<div className="flex items-center justify-between gap-4">
									<div className="min-w-0">
										<div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
											<h1 className="text-2xl font-semibold tracking-tight sm:text-4xl">{currentLabel}</h1>
											{state.settingsTab === "instructions" ? (
												<>
													<span className="font-mono text-sm font-medium text-muted-foreground">AGENTS.md</span>
													<span className={hostInstructionFile?.active ? "text-xs font-medium text-emerald-600 dark:text-emerald-400" : "text-xs text-muted-foreground"}>
														{hostInstructionFile?.active ? "生效中" : "未创建"}
													</span>
												</>
											) : null}
										</div>
										<p className="mt-2 max-w-2xl text-base leading-7 text-muted-foreground sm:mt-3">
											{state.settingsTab === "system"
								? "修改应用名称和 Logo，并保存到本机配置文件。"
								: state.settingsTab === "instructions"
												? "为所有项目的任务提供说明和上下文。"
											: state.settingsTab === "skills"
												? "查看和管理当前项目可用的 Skill。"
												: state.settingsTab === "subagents"
													? "配置个人和项目范围的智能体。"
													: state.settingsTab === "imports"
														? `把其他 Harness 的资源导入 ${state.branding.name}。`
												: state.settingsTab === "permissions"
											? "检查并完成 macOS Web 后台任务需要的系统授权。"
										: state.settingsTab === "security"
													? "配置 Web Gateway 的监听 IP、白名单、Web/Runtime 端口和密码。"
													: state.settingsTab === "about"
														? `查看 ${state.branding.name} 的版本信息。`
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
							<TabsContent className="m-0 w-full min-w-0 max-w-full" value="system">
								<SystemSettings state={state} actions={actions} />
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
							<TabsContent className="m-0 w-full min-w-0 max-w-full" value="subagents">
								<SubagentSettings state={state} actions={actions} />
							</TabsContent>
							<TabsContent className="m-0 w-full min-w-0 max-w-full" value="imports">
								<HarnessImportsSettings state={state} actions={actions} />
							</TabsContent>
							<TabsContent className="m-0 w-full min-w-0 max-w-full" value="diagnostics">
								<Suspense fallback={<p role="status" className="text-sm text-muted-foreground">正在加载诊断…</p>}>
									<DiagnosticsSettings state={state} actions={actions} />
								</Suspense>
							</TabsContent>
							<TabsContent className="m-0 w-full min-w-0 max-w-full" value="permissions">
								<SystemPermissionsSettings />
							</TabsContent>
							<TabsContent className="m-0 w-full min-w-0 max-w-full" value="security">
								<SecuritySettings state={state} actions={actions} />
							</TabsContent>
							<TabsContent className="m-0 w-full min-w-0 max-w-full" value="about">
								<AboutSettings state={state} />
							</TabsContent>
							</div>
						</GsapReveal>
					</section>
				</Tabs>
			</DialogContent>
		</Dialog>
	);
}
