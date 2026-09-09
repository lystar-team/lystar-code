import { Check, Download, Maximize2, Minimize2, Smartphone } from "lucide-react";
import { useState } from "react";
import type { AppInstallState } from "../../../state/use-app-install";
import { Button } from "../../ui/button";
import { Card, CardContent } from "../../ui/card";
import { SettingSection } from "./shared";

export function AppInstallSettings({ appInstall }: { appInstall: AppInstallState }) {
	const [installing, setInstalling] = useState(false);

	const handleInstall = async () => {
		setInstalling(true);
		try {
			await appInstall.install();
		} finally {
			setInstalling(false);
		}
	};

	return (
		<div className="grid min-w-0 gap-6">
			<SettingSection title="应用安装">
				<Card className="min-w-0 shadow-none">
					<CardContent className="grid gap-4 p-4 sm:p-5">
						<div className="flex items-start justify-between gap-4">
							<div className="flex min-w-0 gap-3">
								<div className="grid size-10 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary">
									<Smartphone className="size-5" aria-hidden="true" />
								</div>
								<div className="min-w-0">
									<p className="font-medium">安装 LYStar Code</p>
									<p className="mt-1 text-sm leading-6 text-muted-foreground">
										从主屏幕打开后，LYStar Code 会以独立应用方式运行，不显示浏览器地址栏。
									</p>
								</div>
							</div>
							{appInstall.isInstalled ? (
								<span className="inline-flex shrink-0 items-center gap-1 text-sm text-emerald-600 dark:text-emerald-400">
									<Check className="size-4" aria-hidden="true" />
									已安装
								</span>
							) : null}
						</div>

						{!appInstall.isInstalled && appInstall.canInstall ? (
							<Button className="w-full sm:w-auto" onClick={() => void handleInstall()} disabled={installing}>
								<Download className="size-4" aria-hidden="true" />
								{installing ? "正在安装" : "安装应用"}
							</Button>
						) : null}

						{!appInstall.isInstalled && appInstall.isIos && appInstall.isSecureContext ? (
							<p className="rounded-lg bg-muted/60 px-3 py-2 text-sm leading-6 text-muted-foreground">
								请打开浏览器的分享菜单，选择“添加到主屏幕”。
						</p>
						) : null}

						{!appInstall.isInstalled && !appInstall.isSecureContext ? (
							<p className="rounded-lg bg-muted/60 px-3 py-2 text-sm leading-6 text-muted-foreground">
								当前地址使用 HTTP，页面仍可使用；使用 HTTPS 后才能安装为独立应用。
							</p>
						) : null}

						{!appInstall.isInstalled && !appInstall.isIos && appInstall.isSecureContext && !appInstall.canInstall ? (
							<p className="rounded-lg bg-muted/60 px-3 py-2 text-sm leading-6 text-muted-foreground">
								如果浏览器支持安装，请从地址栏或浏览器菜单选择“安装 LYStar Code”。
							</p>
						) : null}
					</CardContent>
				</Card>
			</SettingSection>

			{appInstall.canFullscreen ? (
				<SettingSection title="沉浸模式">
					<Card className="min-w-0 shadow-none">
						<CardContent className="flex flex-wrap items-center justify-between gap-3 p-4 sm:p-5">
							<div>
								<p className="font-medium">隐藏浏览器导航界面</p>
								<p className="mt-1 text-sm leading-6 text-muted-foreground">
									只在当前页面生效，需要用户点击开启；浏览器不支持时不会影响正常使用。
								</p>
							</div>
							<Button
								variant="outline"
								onClick={() => void appInstall.toggleFullscreen()}
								aria-label={appInstall.isFullscreen ? "退出沉浸模式" : "开启沉浸模式"}
							>
								{appInstall.isFullscreen ? (
									<Minimize2 className="size-4" aria-hidden="true" />
								) : (
									<Maximize2 className="size-4" aria-hidden="true" />
								)}
								{appInstall.isFullscreen ? "退出沉浸模式" : "开启沉浸模式"}
							</Button>
						</CardContent>
					</Card>
				</SettingSection>
			) : null}
		</div>
	);
}
