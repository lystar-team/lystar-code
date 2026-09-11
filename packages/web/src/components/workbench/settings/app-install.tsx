import { Check, Download, Smartphone } from "lucide-react";
import { useState } from "react";
import type { AppInstallState } from "../../../state/use-app-install";
import { Button } from "../../ui/button";
import { Card, CardContent } from "../../ui/card";
import { SettingSection } from "./shared";

export function AppInstallSettings({ appInstall, productName }: { appInstall: AppInstallState; productName: string }) {
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
		<div className="grid min-w-0 gap-5">
			<SettingSection title="应用安装">
				<Card className="min-w-0 rounded-xl bg-muted/10 py-3 shadow-none">
					<CardContent className="grid gap-3 px-4">
						<div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
							<div className="flex min-w-0 items-center gap-3">
								<div className="grid size-8 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
									<Smartphone className="size-4" aria-hidden="true" />
								</div>
								<div className="min-w-0">
									<div className="flex flex-wrap items-center gap-x-2 gap-y-1">
										<p className="font-medium">安装 {productName}</p>
										{appInstall.isInstalled ? (
											<span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-600 dark:text-emerald-400">
												<Check className="size-3.5" aria-hidden="true" />
												已安装
											</span>
										) : null}
									</div>
									<p className="mt-0.5 text-sm leading-5 text-muted-foreground">
										从主屏幕打开后，{productName} 会以独立应用方式运行，不显示浏览器地址栏。
									</p>
								</div>
							</div>

							{!appInstall.isInstalled && appInstall.canInstall ? (
								<Button className="w-full shrink-0 sm:w-auto" size="sm" variant="outline" onClick={() => void handleInstall()} disabled={installing}>
									<Download className="size-4" aria-hidden="true" />
									{installing ? "正在安装" : "安装应用"}
								</Button>
							) : null}
						</div>

						{!appInstall.isInstalled && appInstall.isIos && appInstall.isSecureContext ? (
							<p className="rounded-lg bg-muted/60 px-3 py-2 text-xs leading-5 text-muted-foreground">
								请打开浏览器的分享菜单，选择“添加到主屏幕”。
							</p>
						) : null}

						{!appInstall.isInstalled && !appInstall.isSecureContext ? (
							<p className="rounded-lg bg-muted/60 px-3 py-2 text-xs leading-5 text-muted-foreground">
								当前地址使用 HTTP，页面仍可使用；使用 HTTPS 后才能安装为独立应用。
							</p>
						) : null}

						{!appInstall.isInstalled && !appInstall.isIos && appInstall.isSecureContext && !appInstall.canInstall ? (
							<p className="rounded-lg bg-muted/60 px-3 py-2 text-xs leading-5 text-muted-foreground">
								如果浏览器支持安装，请从地址栏或浏览器菜单选择“安装 {productName}”。
							</p>
						) : null}
					</CardContent>
				</Card>
			</SettingSection>
		</div>
	);
}
