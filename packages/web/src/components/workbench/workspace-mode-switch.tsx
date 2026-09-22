import { cn } from "../../lib/utils";

export type WorkspaceMode = "sessions" | "rooms";

export function WorkspaceModeSwitch({ mode, onChange }: { mode: WorkspaceMode; onChange: (mode: WorkspaceMode) => void }) {
	return (
		<div className="flex rounded-lg bg-muted/45 p-0.5" role="tablist" aria-label="工作区类型">
			{([
				["sessions", "会话"],
				["rooms", "Room"],
			] as const).map(([value, label]) => (
				<button
					aria-selected={mode === value}
					className={cn(
						"h-8 flex-1 rounded-md px-3 text-xs font-medium text-muted-foreground transition-colors",
						"focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
						mode === value && "bg-background text-foreground shadow-sm",
					)}
					key={value}
					onClick={() => onChange(value)}
					role="tab"
					type="button"
				>
					{label}
				</button>
			))}
		</div>
	);
}
