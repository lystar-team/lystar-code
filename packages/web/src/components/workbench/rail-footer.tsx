import { LogOut, SunMoon } from "lucide-react";
import type { WorkbenchActions } from "./types";
import { Button } from "../ui/button";
import { ProductUpdateControl } from "./product-update-control";

export function RailFooter({
	actions,
}: {
	actions: Pick<WorkbenchActions, "openSettings" | "signOut">;
}) {
	return (
		<div className="grid shrink-0 gap-1 border-t p-3">
			<div className="flex min-w-0 items-center gap-2">
				<Button
					className="min-w-0 flex-1 justify-start gap-2"
					variant="ghost"
					onClick={() => void actions.openSettings("appearance")}
				>
					<SunMoon className="size-4 shrink-0" />
					<span className="project-list-item-label min-w-0 truncate">偏好设置</span>
				</Button>
				<ProductUpdateControl />
			</div>
			<Button className="justify-start gap-2" variant="ghost" onClick={actions.signOut}>
				<LogOut className="size-4" />
				<span className="project-list-item-label">退出</span>
			</Button>
		</div>
	);
}
