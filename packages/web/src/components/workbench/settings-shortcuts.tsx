import { Bot, BrainCircuit, WandSparkles } from "lucide-react";
import type { WorkbenchActions } from "./types";
import { Button } from "../ui/button";

const shortcuts = [
	{ tab: "skills", label: "技能", Icon: WandSparkles },
	{ tab: "subagents", label: "智能体", Icon: BrainCircuit },
	{ tab: "models", label: "模型与认证", Icon: Bot },
] as const;

export function SettingsShortcuts({
	openSettings,
	mobile = false,
}: {
	openSettings: WorkbenchActions["openSettings"];
	mobile?: boolean;
}) {
	return (
		<div
			role="group"
			aria-label="设置快捷入口"
			className={mobile ? "grid grid-cols-3 gap-1" : "flex w-full flex-col items-center gap-1 border-t border-border/60 pt-2"}
		>
			{shortcuts.map(({ tab, label, Icon }) => (
				<Button
					key={tab}
					type="button"
					variant="ghost"
					className={mobile
						? "h-11 min-w-0 flex-col gap-1 px-1 text-xs text-muted-foreground"
						: "h-14 w-14 flex-col gap-1 text-[10px] text-muted-foreground"}
					onClick={() => void openSettings(tab)}
				>
					<Icon className={mobile ? "size-4" : "size-[18px]"} aria-hidden="true" />
					<span className="whitespace-nowrap">{label}</span>
				</Button>
			))}
		</div>
	);
}
