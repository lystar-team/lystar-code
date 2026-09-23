import type { SubagentConfig } from "../../types";
import { cn } from "../../lib/utils";
import { Badge } from "../ui/badge";
import { AgentIdentityIcon } from "./collaboration-session";

export function AgentTagList({
	tags,
	className,
	limit = 5,
}: {
	tags?: readonly string[];
	className?: string;
	limit?: number;
}) {
	const normalizedTags = [...new Set((tags ?? []).map((tag) => tag.trim()).filter(Boolean))];
	if (!normalizedTags.length) return null;
	const visibleTags = normalizedTags.slice(0, limit);
	const hiddenCount = normalizedTags.length - visibleTags.length;
	return (
		<span className={cn("flex min-w-0 max-w-full flex-wrap gap-1.5 overflow-hidden", className)} aria-label="擅长标签">
			{visibleTags.map((tag) => (
				<Badge className="max-w-full truncate px-2 py-0.5 text-[11px] leading-4" key={tag} variant="secondary" title={tag}>
					{tag}
				</Badge>
			))}
			{hiddenCount > 0 ? (
				<Badge className="shrink-0 px-2 py-0.5 text-[11px] leading-4" variant="secondary">
					+{hiddenCount}
				</Badge>
			) : null}
		</span>
	);
}

export function AgentProfileCard({
	profile,
	selected,
	disabled,
	status,
	onClick,
}: {
	profile: SubagentConfig;
	selected: boolean;
	disabled?: boolean;
	status?: string;
	onClick: () => void;
}) {
	const capabilityCount = (profile.tools?.length ?? 0) + (profile.skills?.length ?? 0);
	return (
		<button
			aria-pressed={selected}
			className={cn(
				"flex min-h-48 min-w-0 flex-col overflow-hidden rounded-xl border bg-background p-4 text-left transition-colors",
				"hover:border-foreground/30 hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
				selected ? "border-foreground bg-muted/45" : "border-border/70",
				disabled && "cursor-not-allowed opacity-55 hover:border-border/70 hover:bg-background",
			)}
			disabled={disabled}
			onClick={onClick}
			type="button"
		>
			<span className="flex min-w-0 shrink-0 items-start justify-between gap-3">
				<span className="grid size-10 shrink-0 place-items-center overflow-hidden rounded-lg border border-border/70 bg-muted/40 text-foreground">
					<AgentIdentityIcon iconKey={profile.icon} className="size-5 object-contain" />
				</span>
				{status ? <span className="min-w-0 truncate text-xs text-muted-foreground">{status}</span> : null}
			</span>
			<span className="mt-3 min-w-0 shrink-0 truncate text-sm font-semibold">{profile.name}</span>
			<span className="mt-1 min-h-10 min-w-0 shrink-0 line-clamp-2 overflow-hidden text-xs leading-5 text-muted-foreground">
				{profile.description}
			</span>
			<AgentTagList className="mt-2 min-h-5 max-h-8 shrink-0" tags={profile.tags} />
			<span className="mt-auto flex min-w-0 shrink-0 flex-wrap gap-1.5 pt-3 text-[11px] text-muted-foreground">
				{capabilityCount ? <span>{capabilityCount} 项能力</span> : null}
			</span>
		</button>
	);
}
