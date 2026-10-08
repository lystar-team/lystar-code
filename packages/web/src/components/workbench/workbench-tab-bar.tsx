import type { LucideProps } from "lucide-react";
import { Fragment, type ComponentType } from "react";
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
	countLabel?: string;
	section?: string;
};

function WorkbenchTabTrigger<Value extends string>({ icon: Icon, label, value, count, countLabel = "会话", compact, orientation }: WorkbenchTabOption<Value> & { compact: boolean; orientation: "horizontal" | "vertical" }) {
	const item = useExpandableActionBarItem(value);

	return (
		<TabsTrigger
			value={value}
			aria-label={count === undefined ? label : `${label}，${count} 个${countLabel}`}
			title={item.labelVisible ? undefined : label}
			onFocus={item.onFocus}
			onPointerEnter={item.onPointerEnter}
			className={cn(
				"isolate relative !h-7 !gap-0 !rounded-full !border-0 !py-0 !text-xs !font-medium !text-muted-foreground after:!hidden",
				compact ? "!min-w-0 !flex-auto !px-0.5" : "!min-w-max !flex-1 !shrink-0 !px-1.5",
				orientation === "vertical" && "!w-full !flex-none !justify-start !px-3",
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
	orientation = "horizontal",
	tabs,
}: {
	activeId: Value;
	className?: string;
	compact?: boolean;
	label: string;
	orientation?: "horizontal" | "vertical";
	tabs: readonly WorkbenchTabOption<Value>[];
}) {
	return (
		<TabsList
			data-workbench-tab-bar
			aria-label={label}
			className={cn("!h-auto !w-auto min-w-0 self-stretch !justify-start !gap-0 !rounded-none !border-0 !bg-transparent !p-0", orientation === "vertical" && "min-h-0 !w-full", className)}
		>
			<ExpandableActionBar activeId={activeId} defaultExpanded expandOnFocus={false} expandOnHover={false} orientation={orientation} size="sm">
				{tabs.map((tab, index) => (
					<Fragment key={tab.value}>
						{orientation === "vertical" && tab.section && tab.section !== tabs[index - 1]?.section ? (
							<p className="px-3 pb-1 pt-3 text-xs font-medium text-muted-foreground">{tab.section}</p>
						) : null}
						<WorkbenchTabTrigger {...tab} compact={compact} orientation={orientation} />
					</Fragment>
				))}
			</ExpandableActionBar>
		</TabsList>
	);
}
