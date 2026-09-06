import { Check, Sun, SunMoon } from "lucide-react";
import type { ThemeMode, WorkbenchState } from "../../../state/use-workbench";
import { Button } from "../../ui/button";
import { SettingSection } from "./shared";
import type { WorkbenchActions } from "../types";

export function AppearanceSettings({ state, actions }: { state: WorkbenchState; actions: WorkbenchActions }) {
	return (
		<div className="grid gap-6">
			<SettingSection title="主题">
				<div className="grid gap-2 sm:grid-cols-3">
					{(["system", "light", "dark"] as ThemeMode[]).map((theme) => (
						<Button
							key={theme}
							className="h-auto justify-between p-3"
							variant={state.theme === theme ? "secondary" : "outline"}
							onClick={() => actions.setTheme(theme)}
						>
							<span className="flex items-center gap-2">
								{theme === "light" ? <Sun className="size-4" /> : <SunMoon className="size-4" />}
								{theme === "system" ? "跟随系统" : theme === "light" ? "浅色" : "深色"}
							</span>
							{state.theme === theme ? <Check className="size-4" /> : null}
						</Button>
					))}
				</div>
			</SettingSection>
		</div>
	);
}
