import { Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "../../../lib/utils";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { VirtualList } from "../../ui/virtual-list";

type CapabilityOption = { name: string; description: string };

function CapabilityDescription({
	description,
	expanded,
	onToggle,
}: {
	description: string;
	expanded: boolean;
	onToggle: () => void;
}) {
	const ref = useRef<HTMLParagraphElement>(null);
	const [truncated, setTruncated] = useState(false);
	useEffect(() => {
		const element = ref.current;
		// 折叠态按两行截断，只有真实被截断的说明才提供展开入口。
		if (!element || expanded) return;
		const measure = () => setTruncated(element.scrollHeight > element.clientHeight + 1);
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(element);
		return () => observer.disconnect();
	}, [description, expanded]);
	return (
		<>
			<p
				className={cn(
					"whitespace-pre-wrap break-words text-xs leading-5 text-muted-foreground",
					!expanded && "line-clamp-2",
				)}
				ref={ref}
			>
				{description}
			</p>
			{truncated || expanded ? (
				<Button
					className="h-7 px-1.5 font-normal"
					size="xs"
					variant="ghost"
					aria-expanded={expanded}
					onClick={onToggle}
				>
					{expanded ? "收起说明" : "展开说明"}
				</Button>
			) : null}
		</>
	);
}
export function AgentCapabilityPicker({
	options,
	selected,
	onToggle,
	disabled,
	kind,
	selectedLabel,
	defaultLabel,
}: {
	options: readonly CapabilityOption[];
	selected: readonly string[];
	onToggle: (name: string, checked: boolean) => void;
	disabled?: boolean;
	kind: "工具" | "技能";
	selectedLabel: string;
	defaultLabel: string;
}) {
	const [query, setQuery] = useState("");
	const [onlySelected, setOnlySelected] = useState(false);
	const [expanded, setExpanded] = useState<Set<string>>(new Set());
	const selection = useMemo(() => new Set(selected), [selected]);
	const selectedCount = options.filter((option) => selection.has(option.name)).length;
	const visible = useMemo(() => {
		const text = query.trim().toLocaleLowerCase();
		return options.filter(
			(option) =>
				(!onlySelected || selection.has(option.name)) &&
				(!text || `${option.name}\n${option.description}`.toLocaleLowerCase().includes(text)),
		);
	}, [options, onlySelected, query, selection]);
	return (
		<div className="grid min-w-0 gap-3">
			<div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
				<div className="relative w-full sm:w-80">
					<Search aria-hidden className="pointer-events-none absolute left-3 top-3 size-4 text-muted-foreground" />
					<Input
						aria-label={`搜索${kind}`}
						className="h-10 pl-9"
						placeholder={`搜索${kind}名称或用途`}
						value={query}
						onChange={(event) => setQuery(event.target.value)}
					/>
				</div>
				<div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
					<div className="flex rounded-md border border-input p-0.5" role="group" aria-label={`${kind}筛选`}>
						<Button
							variant={onlySelected ? "ghost" : "secondary"}
							size="sm"
							aria-pressed={!onlySelected}
							onClick={() => setOnlySelected(false)}
						>
							全部 {options.length}
						</Button>
						<Button
							variant={onlySelected ? "secondary" : "ghost"}
							size="sm"
							aria-pressed={onlySelected}
							onClick={() => setOnlySelected(true)}
						>
							已选择 {selectedCount}
						</Button>
					</div>
					<span aria-live="polite">{disabled ? defaultLabel : `${selectedLabel} ${selectedCount} 个${kind}`}</span>
				</div>
			</div>
			{visible.length ? (
				<div className="min-w-0 rounded-md border border-border">
					<div className="hidden grid-cols-[minmax(0,224px)_minmax(0,1fr)_88px] gap-4 border-b border-border bg-muted/50 px-4 py-2 text-xs text-muted-foreground lg:grid">
						<span>{kind}名称</span>
						<span>用途</span>
						<span>生效结果</span>
					</div>
					<div className="h-[min(52dvh,32rem)] min-h-48">
						<VirtualList
							items={visible}
							getKey={(option) => option.name}
							estimateSize={() => 76}
							renderItem={(option) => {
								const checked = selection.has(option.name);
								const full = expanded.has(option.name);
								return (
									<div
										className={`grid min-w-0 gap-x-4 gap-y-1 border-b border-border/60 px-4 py-3 lg:grid-cols-[minmax(0,224px)_minmax(0,1fr)_88px] ${checked ? "bg-muted/50" : ""}`}
									>
										<label className="flex min-h-8 min-w-0 cursor-pointer items-start gap-3 text-sm">
											<input
												aria-label={`选择${kind} ${option.name}`}
												className="mt-1 size-4 shrink-0 accent-foreground focus-visible:ring-2 focus-visible:ring-ring"
												type="checkbox"
												checked={checked}
												disabled={disabled}
												onChange={(event) => onToggle(option.name, event.target.checked)}
											/>
											<span className="min-w-0 break-all font-mono text-xs leading-5">{option.name}</span>
										</label>
										<div className="min-w-0 pl-7 lg:pl-0">
											<CapabilityDescription
												description={option.description}
												expanded={full}
												onToggle={() =>
													setExpanded((current) => {
														const next = new Set(current);
														if (full) next.delete(option.name);
														else next.add(option.name);
														return next;
													})
												}
											/>
										</div>
										<span className="pl-7 text-xs leading-6 text-muted-foreground lg:pl-0">
											{checked ? selectedLabel : defaultLabel}
										</span>
									</div>
								);
							}}
						/>
					</div>
				</div>
			) : (
				<p className="py-10 text-center text-sm text-muted-foreground" role="status">
					{!options.length
						? `当前项目没有可选${kind}`
						: onlySelected
							? `没有符合条件的已选${kind}`
							: `没有符合条件的${kind}`}
				</p>
			)}
		</div>
	);
}
