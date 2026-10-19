import type { SessionUsage } from "@lystar/code-web-protocol";
import { ArrowDown, ArrowUp, Gauge, Layers3 } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";

type Metric = "tps" | "cache" | "input" | "output";
type Tokens = SessionUsage["tokens"];
type OutputSpeed = SessionUsage["outputSpeed"];

const metrics: Metric[] = ["tps", "cache", "input", "output"];
const labels: Record<Metric, string> = { tps: "平均 TPS", cache: "缓存命中", input: "输入", output: "输出" };
const metricIcons = { tps: Gauge, cache: Layers3, input: ArrowDown, output: ArrowUp };

function compactTokens(value: number): string {
	if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1).replace(/\.0$/u, "")}M`;
	if (value >= 1_000) return `${(value / 1_000).toFixed(1).replace(/\.0$/u, "")}K`;
	return value.toLocaleString("zh-CN");
}

function exactTokens(value: number): string {
	return `${value.toLocaleString("zh-CN")} tok`;
}

function DetailRow({ label, value }: { label: string; value: string }) {
	return (
		<div className="flex justify-between gap-4 text-xs">
			<span className="text-muted-foreground">{label}</span>
			<span className="tabular-nums text-foreground">{value}</span>
		</div>
	);
}

function MetricBreakdown({
	metric,
	tokens,
	totalInput,
	lastOutputSpeed,
	speed,
	estimatedInput,
	estimatedOutput,
}: {
	metric: Metric;
	tokens?: Tokens;
	totalInput?: number;
	lastOutputSpeed?: OutputSpeed;
	speed?: number;
	estimatedInput?: boolean;
	estimatedOutput?: boolean;
}) {
	return (
		<div className="space-y-2">
			{metric === "tps" ? (
				<>
					<DetailRow label="累计输出" value={lastOutputSpeed && speed !== undefined ? `${estimatedOutput && lastOutputSpeed.streaming ? "≈" : ""}${exactTokens(lastOutputSpeed.outputTokens)}` : "—"} />
					<DetailRow label="累计生成耗时" value={lastOutputSpeed && speed !== undefined ? `${(lastOutputSpeed.elapsedMs / 1_000).toFixed(1)} 秒` : "—"} />
				</>
			) : metric === "cache" ? (
				<>
					<DetailRow label="缓存读取" value={tokens ? exactTokens(tokens.cacheRead) : "—"} />
					<DetailRow label="输入总量" value={totalInput === undefined ? "—" : `${estimatedInput ? "≈" : ""}${exactTokens(totalInput)}`} />
					<p className="pt-1 text-xs text-muted-foreground">缓存读取 ÷ 输入总量</p>
				</>
			) : metric === "input" ? (
				<>
					<DetailRow label={estimatedInput ? "普通输入（含估算）" : "普通输入"} value={tokens ? `${estimatedInput ? "≈" : ""}${exactTokens(tokens.input)}` : "—"} />
					<DetailRow label="缓存读取" value={tokens ? exactTokens(tokens.cacheRead) : "—"} />
					<DetailRow label="缓存写入" value={tokens ? exactTokens(tokens.cacheWrite) : "—"} />
				</>
			) : (
				<DetailRow label={estimatedOutput ? "会话累计输出（估算）" : "会话累计输出"} value={tokens ? `${estimatedOutput ? "≈" : ""}${exactTokens(tokens.output)}` : "—"} />
			)}
		</div>
	);
}

export function ComposerSessionStats({
	usage,
	align = "start",
}: {
	usage?: SessionUsage;
	align?: "start" | "end";
}) {
	const tokens = usage?.tokens;
	const speedSample = usage?.outputSpeed;
	const [liveSample, setLiveSample] = useState<{ speed: OutputSpeed; elapsedMs: number }>();
	const lastOutputSpeed = speedSample ? {
		...speedSample,
		elapsedMs: speedSample.elapsedMs + (speedSample.streaming && liveSample?.speed === speedSample ? liveSample.elapsedMs : 0),
	} : undefined;
	useEffect(() => {
		if (!speedSample?.streaming) return;
		const receivedAt = performance.now();
		const timer = window.setInterval(() => {
			setLiveSample({ speed: speedSample, elapsedMs: performance.now() - receivedAt });
		}, 100);
		return () => window.clearInterval(timer);
	}, [speedSample]);
	const [openMetric, setOpenMetric] = useState<Metric>();
	const [selectedMetric, setSelectedMetric] = useState<Metric>("tps");
	const [visibleMetricCount, setVisibleMetricCount] = useState(0);
	const [statsOpen, setStatsOpen] = useState(false);
	const containerRef = useRef<HTMLDivElement>(null);
	const metricRowRef = useRef<HTMLDivElement>(null);
	const statsButtonRef = useRef<HTMLButtonElement>(null);

	useLayoutEffect(() => {
		const container = containerRef.current;
		const row = metricRowRef.current;
		const statsButton = statsButtonRef.current;
		if (!container || !row || !statsButton) return;
		const buttons = [...row.querySelectorAll<HTMLButtonElement>("button")];
		const measure = () => {
			const available = container.getBoundingClientRect().width;
			const widths = [...row.querySelectorAll<HTMLButtonElement>("button")].map((button) => button.getBoundingClientRect().width);
			const metricGap = Number.parseFloat(getComputedStyle(row).columnGap);
			const groupGap = Number.parseFloat(getComputedStyle(container).columnGap);
			const fullWidth = widths.reduce((sum, width) => sum + width, 0) + metricGap * (widths.length - 1);
			let count = widths.length;
			if (fullWidth > available) {
				count = 0;
				let used = statsButton.getBoundingClientRect().width + groupGap;
				for (const width of widths) {
					const nextWidth = used + width + (count > 0 ? metricGap : 0);
					if (nextWidth > available) break;
					used = nextWidth;
					count++;
				}
			}
			setVisibleMetricCount(count);
		};
		measure();
		const observer = new ResizeObserver(measure);
		for (const element of [container, row, statsButton, ...buttons]) observer.observe(element);
		return () => observer.disconnect();
	}, [visibleMetricCount]);

	useEffect(() => {
		if (visibleMetricCount === metrics.length) setStatsOpen(false);
		if (openMetric && metrics.indexOf(openMetric) >= visibleMetricCount) setOpenMetric(undefined);
	}, [openMetric, visibleMetricCount]);

	const totalInput = tokens ? tokens.input + tokens.cacheRead + tokens.cacheWrite : undefined;
	const cacheHit = totalInput ? Math.round((tokens?.cacheRead ?? 0) / totalInput * 100) : undefined;
	const speed = lastOutputSpeed?.elapsedMs
		? Math.round(lastOutputSpeed.outputTokens * 1_000 / lastOutputSpeed.elapsedMs * 10) / 10
		: undefined;
	const values: Record<Metric, string> = {
		tps: speed === undefined ? "—" : `${usage?.estimatedOutput && speedSample?.streaming ? "≈" : ""}${speed} tok/s`,
		cache: cacheHit === undefined ? "—" : `${usage?.estimatedInput ? "≈" : ""}${cacheHit}%`,
		input: totalInput === undefined ? "—" : `${usage?.estimatedInput ? "≈" : ""}${compactTokens(totalInput)}`,
		output: tokens === undefined ? "—" : `${usage?.estimatedOutput ? "≈" : ""}${compactTokens(tokens.output)}`,
	};

	return (
		<div ref={containerRef} aria-label="会话统计" className={`relative flex w-full min-w-12 items-center gap-0.5 ${align === "end" ? "justify-end" : "justify-start"}`} role="group">
			<Popover open={statsOpen} onOpenChange={setStatsOpen}>
				<PopoverTrigger asChild>
					<button
						ref={statsButtonRef}
						type="button"
						className={`order-last inline-flex h-8 min-w-max shrink-0 items-center whitespace-nowrap rounded-md px-2 text-xs text-muted-foreground hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:bg-muted data-[state=open]:text-foreground ${visibleMetricCount === metrics.length ? "pointer-events-none invisible absolute" : ""}`}
						aria-hidden={visibleMetricCount === metrics.length}
						tabIndex={visibleMetricCount === metrics.length ? -1 : undefined}
						aria-label="查看会话统计"
					>
						统计
					</button>
				</PopoverTrigger>
				<PopoverContent
					align="end"
					aria-label="会话统计"
					collisionPadding={8}
					side="top"
					sideOffset={8}
					className="max-h-[70dvh] w-72 max-w-[calc(100vw-1rem)] overflow-y-auto rounded-xl border-border bg-popover p-3 shadow-md"
				>
					<div className="mb-2 text-sm font-medium">会话统计</div>
					<div role="group" aria-label="选择统计项" className="grid min-w-0 grid-cols-2 gap-1">
						{metrics.map((metric) => {
							const Icon = metricIcons[metric];
							return (
								<button
									key={metric}
									type="button"
									aria-pressed={selectedMetric === metric}
									onClick={() => setSelectedMetric(metric)}
									className="flex min-w-0 flex-col items-start gap-1 rounded-md px-2 py-2 text-left text-[11px]! leading-4! text-muted-foreground hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring aria-pressed:bg-muted aria-pressed:text-foreground"
								>
									<span className="flex items-center gap-1.5">
										<Icon className="size-3.5 shrink-0" aria-hidden="true" />
										{labels[metric]}
									</span>
									<span className="max-w-full break-words font-medium tabular-nums text-foreground">{values[metric]}</span>
								</button>
							);
						})}
					</div>
					<div className="mt-3 border-t border-border pt-3">
						<MetricBreakdown metric={selectedMetric} tokens={tokens} totalInput={totalInput} lastOutputSpeed={lastOutputSpeed} speed={speed} estimatedInput={usage?.estimatedInput} estimatedOutput={usage?.estimatedOutput} />
					</div>
				</PopoverContent>
			</Popover>
			<div ref={metricRowRef} className="flex w-max shrink-0 items-center gap-0.5 whitespace-nowrap text-xs">
				{metrics.map((metric, index) => (
					<Popover key={metric} open={openMetric === metric} onOpenChange={(open) => setOpenMetric(open ? metric : undefined)}>
						<PopoverTrigger asChild>
							<button
								type="button"
								className={`inline-flex h-7 w-max shrink-0 items-center gap-1 whitespace-nowrap rounded-md px-1.5 text-muted-foreground hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:bg-muted data-[state=open]:text-foreground ${index >= visibleMetricCount ? "pointer-events-none invisible absolute left-0 top-0" : ""}`}
								aria-hidden={index >= visibleMetricCount}
								tabIndex={index >= visibleMetricCount ? -1 : undefined}
								aria-label={`${labels[metric]} ${values[metric]}，查看详情`}
							>
								<span className="shrink-0">{labels[metric]}</span>
								<span className="tabular-nums text-foreground">{values[metric]}</span>
							</button>
						</PopoverTrigger>
						<PopoverContent align="start" collisionPadding={8} side="top" sideOffset={8} className="w-72 max-w-[calc(100vw-1rem)] rounded-xl border-border bg-popover p-3 shadow-md">
							<div className="mb-2 text-sm font-medium">{labels[metric]}</div>
							<div className="mb-3 text-lg font-semibold tabular-nums">{values[metric]}</div>
							<MetricBreakdown metric={metric} tokens={tokens} totalInput={totalInput} lastOutputSpeed={lastOutputSpeed} speed={speed} estimatedInput={usage?.estimatedInput} estimatedOutput={usage?.estimatedOutput} />
						</PopoverContent>
					</Popover>
				))}
			</div>
		</div>
	);
}
