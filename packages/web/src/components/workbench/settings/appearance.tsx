import { Bell, Check, Moon, Sun, SunMoon } from "lucide-react";
import type { AppInstallState } from "../../../state/use-app-install";
import { usePushNotifications } from "../../../state/use-push-notifications";
import type { ThemeMode, WorkbenchState } from "../../../state/use-workbench";
import { cn } from "../../../lib/utils";
import { Button } from "../../ui/button";
import { Card, CardContent } from "../../ui/card";
import { AppInstallSettings } from "./app-install";
import { SettingSection } from "./shared";
import type { WorkbenchActions } from "../types";

const themeOptions: Array<{
	value: ThemeMode;
	label: string;
	description: string;
	icon: typeof Sun;
}> = [
	{ value: "system", label: "跟随系统", description: "随设备外观自动切换", icon: SunMoon },
	{ value: "light", label: "浅色", description: "明亮背景和清晰分隔", icon: Sun },
	{ value: "dark", label: "深色", description: "深色背景，降低强光干扰", icon: Moon },
];

function WorkbenchSkeleton({ dark }: { dark: boolean }) {
	const lineClass = dark ? "bg-zinc-700" : "bg-zinc-200";
	return (
		<div className={cn("flex h-full min-w-0", dark ? "bg-zinc-950" : "bg-zinc-100")}>
			<div className={cn("w-[32%] shrink-0 border-r p-2", dark ? "border-zinc-800 bg-zinc-900" : "border-zinc-200 bg-white")}>
				<div className="flex items-center gap-1.5">
					<span className={cn("size-2 rounded-full", dark ? "bg-zinc-500" : "bg-zinc-300")} />
					<span className={cn("h-1.5 w-8 rounded-full", lineClass)} />
				</div>
				<div className="mt-3 grid gap-1.5">
					<span className={cn("h-1.5 w-full rounded-full", lineClass)} />
					<span className={cn("h-1.5 w-4/5 rounded-full", lineClass)} />
					<span className={cn("h-1.5 w-11/12 rounded-full", lineClass)} />
				</div>
			</div>
			<div className={cn("flex min-w-0 flex-1 flex-col p-2", dark ? "bg-zinc-950" : "bg-zinc-50")}>
				<div className="flex items-center justify-between gap-2">
					<span className={cn("h-1.5 w-12 rounded-full", lineClass)} />
					<span className={cn("size-2 rounded-full", dark ? "bg-zinc-700" : "bg-zinc-200")} />
				</div>
				<div className="mt-3 grid gap-1.5">
					<span className={cn("h-2 w-3/4 rounded-full", lineClass)} />
					<span className={cn("h-2 w-1/2 rounded-full opacity-70", lineClass)} />
				</div>
				<div className={cn("mt-auto h-4 rounded-md border", dark ? "border-zinc-700 bg-zinc-900" : "border-zinc-200 bg-white")} />
			</div>
		</div>
	);
}

function ThemePreview({ theme }: { theme: ThemeMode }) {
	return (
		<div className="h-28 overflow-hidden border-b border-border/70" aria-hidden="true">
			{theme === "system" ? (
				<div className="grid h-full grid-cols-2 gap-px bg-border">
					<WorkbenchSkeleton dark={false} />
					<WorkbenchSkeleton dark />
				</div>
			) : (
				<WorkbenchSkeleton dark={theme === "dark"} />
			)}
		</div>
	);
}

export function AppearanceSettings({
	state,
	actions,
	appInstall,
}: {
	state: WorkbenchState;
	actions: WorkbenchActions;
	appInstall: AppInstallState;
}) {
	const push = usePushNotifications();
	const pushUnavailableOnIos = appInstall.isIos && !appInstall.isInstalled;
	return (
		<div className="grid min-w-0 gap-6">
			<SettingSection title="主题">
				<div className="grid gap-3 sm:grid-cols-3">
					{themeOptions.map((theme) => {
						const active = state.theme === theme.value;
						const Icon = theme.icon;
						return (
							<button
								key={theme.value}
								type="button"
								aria-pressed={active}
								className={cn(
									"group min-w-0 overflow-hidden rounded-xl border bg-background text-left transition-colors hover:bg-muted/30",
									active ? "border-foreground/25 bg-muted/20" : "border-border",
								)}
								onClick={() => actions.setTheme(theme.value)}
							>
								<ThemePreview theme={theme.value} />
								<span className="flex min-w-0 items-start justify-between gap-2 p-3">
									<span className="min-w-0">
										<span className="flex items-center gap-2 text-sm font-medium">
											<Icon className="size-4 shrink-0" />
											{theme.label}
										</span>
										<span className="mt-1 block text-xs leading-5 text-muted-foreground">{theme.description}</span>
									</span>
									{active ? <Check className="mt-0.5 size-4 shrink-0" aria-label="当前主题" /> : null}
								</span>
							</button>
						);
					})}
				</div>
			</SettingSection>
			<SettingSection title="回合通知">
				<Card className="py-0 shadow-none">
					<CardContent className="flex flex-col gap-4 p-4 sm:flex-row sm:items-center sm:justify-between sm:p-5">
						<div className="flex items-start gap-3">
							<Bell className="mt-1 size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
							<div>
								<p className="font-medium">浏览器通知</p>
								<p className="mt-1 text-sm leading-6 text-muted-foreground">每轮结束后显示项目、会话和回复摘录。页面关闭后也能收到。</p>
								{pushUnavailableOnIos ? <p className="mt-2 text-sm text-muted-foreground">iPhone 和 iPad 请先把应用添加到主屏幕。</p> : null}
								{!appInstall.isSecureContext ? <p className="mt-2 text-sm text-muted-foreground">请使用 HTTPS 或 localhost 地址打开页面。</p> : null}
								{push.status === "blocked" ? <p className="mt-2 text-sm text-muted-foreground">请在浏览器的网站设置中允许通知。</p> : null}
								{push.error ? <p className="mt-2 text-sm text-destructive" role="alert">{push.error}</p> : null}
							</div>
						</div>
						<Button
							variant={push.status === "on" ? "outline" : "default"}
							className="shrink-0"
							disabled={push.busy || push.status === "loading" || push.status === "blocked" || push.status === "unsupported" || pushUnavailableOnIos}
							onClick={() => void (push.status === "on" ? push.disable() : push.enable())}
						>
							{push.busy ? "正在处理" : push.status === "on" ? "关闭通知" : push.status === "unsupported" ? "浏览器不支持" : push.status === "loading" ? "正在检查" : push.status === "off" && push.error ? "重试开启通知" : "开启通知"}
						</Button>
					</CardContent>
				</Card>
			</SettingSection>
			<AppInstallSettings appInstall={appInstall} productName={state.branding.name} />
		</div>
	);
}
