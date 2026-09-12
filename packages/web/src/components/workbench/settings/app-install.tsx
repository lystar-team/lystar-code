import { Check, Download, LoaderCircle, Menu, Share2, Smartphone } from "lucide-react";
import { useState } from "react";
import type { AppInstallState } from "../../../state/use-app-install";
import { Button } from "../../ui/button";
import { Card, CardContent } from "../../ui/card";
import { SettingSection } from "./shared";

function InstallSteps({ appInstall, productName }: { appInstall: AppInstallState; productName: string }) {
	if (!appInstall.isSecureContext) {
		return (
			<div className="rounded-lg bg-muted/60 px-3 py-2.5 text-sm leading-6 text-muted-foreground">
				请使用 HTTPS 地址打开当前页面。浏览器确认连接安全后，才能把 {productName} 安装到设备。
			</div>
		);
	}

	const steps = appInstall.isIos
		? ["点击浏览器工具栏中的分享按钮", "选择“添加到主屏幕”", `返回主屏幕打开 ${productName}`]
		: ["打开浏览器右上角菜单", `选择“安装 ${productName}”或“添加到主屏幕”`, `安装完成后从桌面或应用列表打开 ${productName}`];
	const StepIcon = appInstall.isIos ? Share2 : Menu;
	return (
		<div className="grid gap-3 rounded-lg bg-muted/50 p-3">
			<div className="flex items-center gap-2 text-sm font-medium">
				<StepIcon className="size-4" aria-hidden="true" />
				按下面步骤安装
			</div>
			<ol className="grid gap-2">
				{steps.map((step, index) => (
					<li className="flex items-start gap-2 text-sm leading-5 text-muted-foreground" key={step}>
						<span className="grid size-5 shrink-0 place-items-center rounded-full bg-background text-[11px] font-semibold text-foreground">
							{index + 1}
						</span>
						<span>{step}</span>
					</li>
				))}
			</ol>
		</div>
	);
}

export function AppInstallSettings({ appInstall, productName }: { appInstall: AppInstallState; productName: string }) {
	const [installing, setInstalling] = useState(false);
	const [showInstructions, setShowInstructions] = useState(false);
	const [installMessage, setInstallMessage] = useState<string>();

	const handleInstall = async () => {
		setInstallMessage(undefined);
		if (!appInstall.canInstall) {
			setShowInstructions((visible) => !visible);
			return;
		}

		setInstalling(true);
		try {
			const outcome = await appInstall.install();
			if (outcome === "accepted") setInstallMessage("安装请求已提交，请按浏览器提示完成安装。");
			if (outcome === "dismissed") setInstallMessage("安装窗口已关闭，你可以再次点击快捷安装。");
			if (outcome === "unavailable") setShowInstructions(true);
		} finally {
			setInstalling(false);
		}
	};

	return (
		<div className="grid min-w-0 gap-5">
			<SettingSection title="应用安装">
				<Card className="min-w-0 overflow-hidden rounded-xl bg-muted/10 py-0 shadow-none">
					<CardContent className="p-0">
						<div className="flex min-w-0 flex-col gap-4 p-4 sm:flex-row sm:items-center sm:justify-between sm:p-5">
							<div className="flex min-w-0 items-start gap-3">
								<div className="grid size-10 shrink-0 place-items-center rounded-xl bg-muted text-muted-foreground">
									<Smartphone className="size-5" aria-hidden="true" />
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
									<p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">
										安装后可以从桌面或主屏幕直接打开，不显示浏览器地址栏。
									</p>
								</div>
							</div>

							{!appInstall.isInstalled ? (
								<Button className="w-full shrink-0 sm:w-auto" onClick={() => void handleInstall()} disabled={installing}>
									{installing ? <LoaderCircle className="size-4 animate-spin" aria-hidden="true" /> : <Download className="size-4" aria-hidden="true" />}
									{installing ? "正在打开安装窗口" : appInstall.canInstall ? "快捷安装" : showInstructions ? "收起安装步骤" : "查看安装步骤"}
								</Button>
							) : null}
						</div>

						{!appInstall.isInstalled && appInstall.canInstall ? (
							<div className="border-t border-border/70 bg-muted/20 px-4 py-3 text-xs leading-5 text-muted-foreground sm:px-5">
								点击“快捷安装”后，在浏览器弹出的窗口中确认即可。
							</div>
						) : null}

						{!appInstall.isInstalled && !appInstall.canInstall && showInstructions ? (
							<div className="border-t border-border/70 p-4 sm:p-5">
								<InstallSteps appInstall={appInstall} productName={productName} />
							</div>
						) : null}

						{installMessage ? (
							<p className="border-t border-border/70 bg-muted/20 px-4 py-3 text-xs leading-5 text-muted-foreground sm:px-5" role="status">
								{installMessage}
							</p>
						) : null}
					</CardContent>
				</Card>
			</SettingSection>
		</div>
	);
}
