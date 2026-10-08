import type { SessionInfoResult } from "@lystar/code-web-protocol";
import { ArrowDown, ArrowUp, Gauge, Layers3 } from "lucide-react";
import { useEffect, useState } from "react";
import { webApi } from "../../adapters/host-protocol/api";
import type { WorkbenchState } from "../../state/workbench-types";
import { Tabs, TabsContent } from "../ui/tabs";
import { WorkbenchTabBar } from "./workbench-tab-bar";
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from "../ui/popover";

type Metric = "tps" | "cache" | "input" | "output";
type Tokens = SessionInfoResult["tokens"];
type OutputSpeed = WorkbenchState["lastOutputSpeed"];

const metrics: Metric[] = ["tps", "cache", "input", "output"];
const labels: Record<Metric, string> = { tps: "TPS", cache: "缓存命中", input: "输入", output: "输出" };
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
}: {
	metric: Metric;
	tokens?: Tokens;
	totalInput?: number;
	lastOutputSpeed?: OutputSpeed;
	speed?: number;
}) {
	return (
		<div className="space-y-2">
			{metric === "tps" ? (
				<>
					<DetailRow label={lastOutputSpeed?.streaming ? "当前输出（估算）" : "最近一次可见输出"} value={lastOutputSpeed && speed !== undefined ? exactTokens(lastOutputSpeed.outputTokens) : "—"} />
					<DetailRow label="输出耗时" value={lastOutputSpeed && speed !== undefined ? `${(lastOutputSpeed.elapsedMs / 1_000).toFixed(1)} 秒` : "—"} />
					{lastOutputSpeed?.estimated && speed !== undefined ? <p className="pt-1 text-xs text-muted-foreground">流式输出期间为估算值，完成后按模型用量校正。</p> : null}
				</>
			) : metric === "cache" ? (
				<>
					<DetailRow label="缓存读取" value={tokens ? exactTokens(tokens.cacheRead) : "—"} />
					<DetailRow label="输入总量" value={totalInput === undefined ? "—" : exactTokens(totalInput)} />
					<p className="pt-1 text-xs text-muted-foreground">缓存读取 ÷ 输入总量</p>
				</>
			) : metric === "input" ? (
				<>
					<DetailRow label="普通输入" value={tokens ? exactTokens(tokens.input) : "—"} />
					<DetailRow label="缓存读取" value={tokens ? exactTokens(tokens.cacheRead) : "—"} />
					<DetailRow label="缓存写入" value={tokens ? exactTokens(tokens.cacheWrite) : "—"} />
				</>
			) : (
				<DetailRow label="会话累计输出" value={tokens ? exactTokens(tokens.output) : "—"} />
			)}
		</div>
	);
}

export function ComposerSessionStats({
	sessionId,
	revision,
	ready,
	connected,
	phase,
	lastOutputSpeed,
}: {
	sessionId: string;
	revision?: number;
	ready: boolean;
	connected: boolean;
	phase?: string;
	lastOutputSpeed?: OutputSpeed;
}) {
	const [tokens, setTokens] = useState<Tokens>();
	const [openMetric, setOpenMetric] = useState<Metric>();
	const [mobileMetric, setMobileMetric] = useState<Metric>("tps");

	useEffect(() => {
		if (
			!ready ||
			!connected ||
			(phase !== "idle" && phase !== "waiting_for_input" && phase !== "interrupted")
		)
			return;
		let cancelled = false;
		void webApi.sessionUsage(sessionId).then(
			(result) => {
				if (!cancelled) setTokens(result.tokens);
			},
			() => {
				if (!cancelled) setTokens(undefined);
			},
		);
		return () => { cancelled = true; };
	}, [connected, phase, ready, revision, sessionId]);

	const totalInput = tokens ? tokens.input + tokens.cacheRead + tokens.cacheWrite : undefined;
	const cacheHit = totalInput ? Math.round((tokens?.cacheRead ?? 0) / totalInput * 100) : undefined;
	const speed = lastOutputSpeed?.elapsedMs && (phase !== "turn" || lastOutputSpeed.streaming !== undefined)
		? Math.round(lastOutputSpeed.outputTokens * 1_000 / lastOutputSpeed.elapsedMs)
		: undefined;
	const values: Record<Metric, string> = {
		tps: speed === undefined ? phase === "turn" ? "计算中" : "—" : `${lastOutputSpeed?.estimated ? "≈" : ""}${speed} tok/s`,
		cache: cacheHit === undefined ? "—" : `${cacheHit}%`,
		input: totalInput === undefined ? "—" : compactTokens(totalInput),
		output: tokens === undefined ? "—" : compactTokens(tokens.output),
	};

	return (
		<div aria-label="会话统计" className="@container/stats w-14 min-w-12 shrink-0 md:w-auto md:flex-1" role="group">
			<Popover>
				<PopoverTrigger asChild>
					<button
						type="button"
						className="inline-flex h-8 min-w-max shrink-0 items-center whitespace-nowrap rounded-md px-2 text-xs text-muted-foreground hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:bg-muted data-[state=open]:text-foreground @min-[22rem]/stats:hidden"
						aria-label="查看会话统计"
					>
						统计
					</button>
				</PopoverTrigger>
				<PopoverAnchor asChild>
					<span aria-hidden="true" className="pointer-events-none absolute left-3 top-2 size-px" />
				</PopoverAnchor>
				<PopoverContent
					align="start"
					aria-label="会话统计"
					collisionPadding={8}
					side="top"
					sideOffset={16}
					className="max-h-[70dvh] w-72 max-w-[calc(100vw-1rem)] overflow-y-auto rounded-xl border-border bg-popover p-3 shadow-md"
				>
					<div className="mb-2 text-sm font-medium">会话统计</div>
					<Tabs value={mobileMetric} onValueChange={(value) => setMobileMetric(value as Metric)} className="min-w-0 gap-0">
						<WorkbenchTabBar
							activeId={mobileMetric}
							tabs={metrics.map((metric) => ({ value: metric, icon: metricIcons[metric], label: `${labels[metric]} ${values[metric]}` }))}
							label="选择统计项"
						/>
						<TabsContent value={mobileMetric} className="mt-3 border-t border-border pt-3">
							<MetricBreakdown metric={mobileMetric} tokens={tokens} totalInput={totalInput} lastOutputSpeed={lastOutputSpeed} speed={speed} />
						</TabsContent>
					</Tabs>
				</PopoverContent>
			</Popover>
			<div className="hidden w-full items-center gap-0.5 whitespace-nowrap text-xs @min-[22rem]/stats:flex">
				{metrics.map((metric) => (
					<Popover key={metric} open={openMetric === metric} onOpenChange={(open) => setOpenMetric(open ? metric : undefined)}>
						<PopoverTrigger asChild>
							<button
								type="button"
								className="inline-flex h-7 min-w-0 items-center gap-1 rounded-md px-1.5 text-muted-foreground hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:bg-muted data-[state=open]:text-foreground"
								aria-label={`${labels[metric]} ${values[metric]}，查看详情`}
							>
								<span className="shrink-0">{labels[metric]}</span>
								<span className="min-w-0 truncate tabular-nums text-foreground">{values[metric]}</span>
							</button>
						</PopoverTrigger>
						<PopoverContent align="start" collisionPadding={8} side="top" sideOffset={8} className="w-72 max-w-[calc(100vw-1rem)] rounded-xl border-border bg-popover p-3 shadow-md">
							<div className="mb-2 text-sm font-medium">{labels[metric]}</div>
							<div className="mb-3 text-lg font-semibold tabular-nums">{values[metric]}</div>
							<MetricBreakdown metric={metric} tokens={tokens} totalInput={totalInput} lastOutputSpeed={lastOutputSpeed} speed={speed} />
						</PopoverContent>
					</Popover>
				))}
			</div>
		</div>
	);
}
