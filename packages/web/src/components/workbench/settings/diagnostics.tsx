import { cn } from "../../../lib/utils";
import type { WorkbenchState } from "../../../state/use-workbench";
import { Alert, AlertDescription, AlertTitle } from "../../ui/alert";
import { Card, CardContent } from "../../ui/card";
import { SettingSection, StatText } from "./shared";

export function DiagnosticsSettings({ state }: { state: WorkbenchState }) {
	const diagnostics = state.diagnostics ?? {};
	const checks = Array.isArray(diagnostics.checks) ? diagnostics.checks : [];
	return (
		<div className="grid gap-6">
			<SettingSection title="运行环境">
				<div className="grid gap-2 sm:grid-cols-2">
					<StatText label="前端" value="React" />
					<StatText
						label="平台"
						value={typeof diagnostics.platform === "string" ? diagnostics.platform : "Web Host"}
					/>
					<StatText label="连接" value={state.connected ? "已连接" : "离线"} />
				</div>
			</SettingSection>
			<SettingSection title="检查结果">
				{checks.length ? (
					<div className="grid gap-1">
						{checks.map((check, index) => {
							const item = check as { id?: string; status?: string; message?: string };
							const ok = item.status === "ok" || item.status === "pass";
							return (
								<div className="flex items-start gap-2 rounded-md px-3 py-2 text-sm" key={item.id ?? index}>
									<span
										className={cn(
											"mt-1.5 size-2 shrink-0 rounded-full",
											ok ? "bg-emerald-500" : "bg-amber-500",
										)}
									/>
									<span>{item.message ?? "检查完成"}</span>
								</div>
							);
						})}
					</div>
				) : (
					<Card>
						<CardContent className="py-6 text-center text-sm text-muted-foreground">暂无诊断信息</CardContent>
					</Card>
				)}
			</SettingSection>
		</div>
	);
}
