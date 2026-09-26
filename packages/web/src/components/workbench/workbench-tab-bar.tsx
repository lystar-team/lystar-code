import type { LucideProps } from "lucide-react";
import type { ComponentType } from "react";
import { cn } from "../../lib/utils";
import {
	ExpandableActionBar,
	ExpandableActionBarHighlight,
	ExpandableActionBarLabel,
	useExpandableActionBarItem,
} from "../motion/expandable-action-bar";
import { Badge } from "../ui/badge";
import { TabsList, TabsTrigger } from "../ui/tabs";

export type WorkbenchTabOption<Value extends string> = {
	icon: ComponentType<LucideProps>;
	label: string;
	value: Value;
	count?: number;
};

function WorkbenchTabTrigger<Value extends string>({ icon: Icon, label, value, count, compact }: WorkbenchTabOption<Value> & { compact: boolean }) {
	const item = useExpandableActionBarItem(value);

	return (
		<TabsTrigger
			value={value}
			aria-label={count === undefined ? label : `${label}，${count} 个会话`}
			title={item.labelVisible ? undefined : label}
			onFocus={item.onFocus}
			onPointerEnter={item.onPointerEnter}
			className={cn(
				"isolate relative !h-7 !min-w-0 !gap-0 !rounded-full !border-0 !py-0 !text-xs !font-medium !text-muted-foreground after:!hidden",
				compact ? "!flex-auto !px-0.5" : "!flex-1 !px-1.5",
				"data-[state=active]:!bg-transparent data-[state=active]:!text-foreground",
			)}
		>
			<ExpandableActionBarHighlight itemId={value} />
			<Icon className={cn("shrink-0", compact ? "size-3" : "size-3.5")} aria-hidden="true" />
			<ExpandableActionBarLabel visible={item.labelVisible} gap={compact ? 4 : 8}>{label}</ExpandableActionBarLabel>
			{count !== undefined ? (
				<Badge
					aria-hidden="true"
					variant="secondary"
					className={cn("h-4 min-w-4 py-0 text-[10px] leading-none tabular-nums", compact ? "ml-0.5 !px-0.5" : "ml-1 !px-1")}
				>
					{count}
				</Badge>
			) : null}
		</TabsTrigger>
	);
}

export function WorkbenchTabBar<Value extends string>({
	activeId,
	className,
	compact = false,
	label,
	tabs,
}: {
	activeId: Value;
	className?: string;
	compact?: boolean;
	label: string;
	tabs: readonly WorkbenchTabOption<Value>[];
}) {
	return (
		<TabsList
			aria-label={label}
			className={cn("!h-auto !w-auto min-w-0 self-stretch !justify-start !gap-0 !rounded-none !border-0 !bg-transparent !p-0", className)}
		>
			<ExpandableActionBar activeId={activeId} defaultExpanded expandOnFocus={false} expandOnHover={false} size="sm">
				{tabs.map((tab) => <WorkbenchTabTrigger key={tab.value} {...tab} compact={compact} />)}
			</ExpandableActionBar>
		</TabsList>
	);
}
