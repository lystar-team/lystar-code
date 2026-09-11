import { BrandLogo } from "../../brand-logo";
import type { WorkbenchState } from "../../../state/use-workbench";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../ui/card";
import { SettingSection } from "./shared";

export function AboutSettings({ state }: { state: WorkbenchState }) {
	const productVersion = typeof state.about?.productVersion === "string" ? state.about.productVersion : "—";
	const piVersion = typeof state.about?.piVersion === "string" ? state.about.piVersion : undefined;

	return (
		<div className="grid min-w-0 gap-4">
			<Card className="min-w-0 gap-2 shadow-none">
				<CardHeader className="gap-2 pb-2">
					<div className="flex items-center gap-4">
						<BrandLogo logo={state.branding.logo} className="size-14 rounded-xl object-contain" />
						<div className="min-w-0">
							<CardTitle className="text-xl">{state.branding.name}</CardTitle>
							<CardDescription className="mt-2">浏览器里的中文编码 Agent 工作台</CardDescription>
						</div>
					</div>
				</CardHeader>
				<CardContent className="pt-0">
					<p className="text-sm leading-6 text-muted-foreground">
						在这里管理项目与会话，查看 Agent 运行状态。{state.branding.name} 基于 Pi 构建。
					</p>
				</CardContent>
			</Card>

			<SettingSection title="应用信息">
				<div className="grid gap-3 sm:grid-cols-2">
					<Card className="min-w-0 rounded-xl py-3 shadow-none">
						<CardContent className="px-4">
								<p className="text-xs text-muted-foreground">{state.branding.name} 版本</p>
							<p className="mt-1 break-all font-mono text-sm">{productVersion}</p>
						</CardContent>
					</Card>
					{piVersion ? (
						<Card className="min-w-0 rounded-xl py-3 shadow-none">
							<CardContent className="px-4">
								<p className="text-xs text-muted-foreground">Pi 版本</p>
								<p className="mt-1 break-all font-mono text-sm">{piVersion}</p>
							</CardContent>
						</Card>
					) : null}
				</div>
			</SettingSection>

		</div>
	);
}
