import { LogOut, MessageSquare, PanelLeft, Settings, Users } from "lucide-react";
import type { Ref } from "react";
import type { WorkbenchState } from "../../state/use-workbench";
import { cn } from "../../lib/utils";
import { BrandLogo } from "../brand-logo";
import { Button } from "../ui/button";
import { SettingsShortcuts } from "./settings-shortcuts";
import type { WorkbenchActions } from "./types";
import type { WorkspaceMode } from "./workspace-mode-switch";

export function WorkspaceNavigationRail({
	branding,
	mode,
	panelOpen,
	onModeChange,
	onPanelOpen,
	expandButtonRef,
	actions,
}: {
	branding: WorkbenchState["branding"];
	mode: WorkspaceMode;
	panelOpen: boolean;
	onModeChange: (mode: WorkspaceMode) => void;
	onPanelOpen: () => void;
	expandButtonRef: Ref<HTMLButtonElement>;
	actions: Pick<WorkbenchActions, "openSettings" | "signOut">;
}) {
	return (
		<nav aria-label="工作区导航" className="workspace-navigation-rail relative z-50 flex h-full w-16 shrink-0 flex-col items-center gap-2 overflow-y-auto border-r border-border/60 bg-background py-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))]">
			<BrandLogo logo={branding.logo} className="mb-2 size-7 rounded-md object-contain" />
			{!panelOpen ? (
				<Button ref={expandButtonRef} size="icon" variant="ghost" className="size-11 text-muted-foreground" onClick={onPanelOpen} aria-label="展开项目栏" title="展开项目栏">
					<PanelLeft className="size-5" />
				</Button>
			) : null}
			{([
				["sessions", "会话", MessageSquare],
				["rooms", "Room", Users],
			] as const).map(([value, label, Icon]) => (
				<Button
					key={value}
					type="button"
					size="icon"
					variant="ghost"
					aria-pressed={mode === value}
					className={cn(
						"h-14 w-14 flex-col gap-1 text-[10px] text-muted-foreground",
						mode === value && "bg-muted text-foreground",
					)}
					onClick={() => onModeChange(value)}
				>
					<Icon className="size-[18px]" aria-hidden="true" />
					<span>{label}</span>
				</Button>
			))}
			<SettingsShortcuts openSettings={actions.openSettings} />
			<div className="flex-1" />
			<Button size="icon" variant="ghost" className="h-14 w-14 flex-col gap-1 text-[10px] text-muted-foreground" onClick={() => void actions.openSettings("appearance")}>
				<Settings className="size-[18px]" aria-hidden="true" />
				<span>设置</span>
			</Button>
			<Button size="icon" variant="ghost" className="h-14 w-14 flex-col gap-1 text-[10px] text-muted-foreground" onClick={actions.signOut}>
				<LogOut className="size-[18px]" aria-hidden="true" />
				<span>退出</span>
			</Button>
		</nav>
	);
}
