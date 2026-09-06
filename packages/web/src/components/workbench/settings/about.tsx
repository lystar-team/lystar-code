import type { WorkbenchState } from "../../../state/use-workbench";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../ui/card";
import { SettingSection } from "./shared";

export function AboutSettings({ state }: { state: WorkbenchState }) {
	const productVersion = typeof state.about?.productVersion === "string" ? state.about.productVersion : "LYStar Code";
	return (
		<div className="grid gap-6">
			<Card className="shadow-none">
				<CardHeader>
					<div className="flex items-center gap-3">
						<img className="size-12 rounded-lg object-contain" src="/brand/lystar-mark.png" alt="" />
						<div>
							<CardTitle>LYStar Code</CardTitle>
							<CardDescription>本机 Agent 工作台</CardDescription>
						</div>
					</div>
				</CardHeader>
				<CardContent>
					<p className="text-sm leading-6 text-muted-foreground">
						让 Session、运行状态和项目上下文在浏览器里保持清晰可见。
					</p>
				</CardContent>
			</Card>
			<SettingSection title="版本信息">
				<div className="flex items-center justify-between rounded-md border px-3 py-3 text-sm">
					<span className="text-muted-foreground">产品版本</span>
					<span className="font-mono">{productVersion}</span>
				</div>
			</SettingSection>
		</div>
	);
}
