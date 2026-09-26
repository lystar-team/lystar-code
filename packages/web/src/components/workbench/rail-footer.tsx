import { LogOut, SunMoon } from "lucide-react";
import { cn } from "../../lib/utils";
import { connectionPresentation, type ConnectionRecoveryState } from "../../state/connection-recovery";
import type { WorkbenchActions } from "./types";
import { Button } from "../ui/button";
import { ProductUpdateControl } from "./product-update-control";

export function RailFooter({
	actions,
	connectionState,
	updatesOnly = false,
}: {
	actions: Pick<WorkbenchActions, "openSettings" | "signOut">;
	connectionState: ConnectionRecoveryState;
	updatesOnly?: boolean;
}) {
	const connection = connectionPresentation(connectionState);
	const status = (
		<span className="ml-auto inline-flex shrink-0 items-center gap-2" role="status" aria-label={`连接状态：${connection.label}`}>
			<span
				className={cn(
					"size-1.5 rounded-full",
					connection.tone === "connected"
						? "bg-[var(--success)]"
						: connection.tone === "reconnecting"
							? "bg-[var(--warning)]"
							: "bg-destructive",
				)}
			/>
			<span className="text-xs font-medium tracking-tight text-muted-foreground">{connection.label}</span>
		</span>
	);

	return (
		<div className="grid shrink-0 gap-1 border-t p-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))]">
			<div className="flex min-w-0 items-center gap-2">
				{!updatesOnly ? (
					<Button
						className="min-w-0 flex-1 justify-start gap-2"
						variant="ghost"
						onClick={() => void actions.openSettings("appearance")}
					>
						<SunMoon className="size-4 shrink-0" />
						<span className="project-list-item-label min-w-0 truncate">偏好设置</span>
					</Button>
				) : null}
				<ProductUpdateControl />
				{updatesOnly ? status : null}
			</div>
			{!updatesOnly ? (
				<div className="flex items-center justify-between gap-2">
					<Button className="justify-start gap-2" variant="ghost" onClick={actions.signOut}>
						<LogOut className="size-4" />
						<span className="project-list-item-label">退出</span>
					</Button>
					{status}
				</div>
			) : null}
		</div>
	);
}
