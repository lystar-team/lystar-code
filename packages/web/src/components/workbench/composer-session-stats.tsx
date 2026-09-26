import type { SessionInfoResult } from "@lystar/code-web-protocol";
import { useEffect, useState } from "react";
import { webApi } from "../../adapters/host-protocol/api";
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from "../ui/popover";

type Metric = "tps" | "cache" | "input" | "output";
type Tokens = SessionInfoResult["tokens"];
type OutputSpeed = { outputTokens: number; elapsedMs: number };

const metrics: Metric[] = ["tps", "cache", "input", "output"];
const labels: Record<Metric, string> = { tps: "TPS", cache: "缓存命中", input: "输入", output: "输出" };

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
					<DetailRow label="最近一次输出" value={lastOutputSpeed && speed !== undefined ? exactTokens(lastOutputSpeed.outputTokens) : "—"} />
					<DetailRow label="输出耗时" value={lastOutputSpeed && speed !== undefined ? `${(lastOutputSpeed.elapsedMs / 1_000).toFixed(1)} 秒` : "—"} />
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
		if (!ready || !connected || (phase !== "idle" && phase !== "waiting_for_input" && phase !== "interrupted")) return;
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
	const speed = lastOutputSpeed?.elapsedMs && phase !== "turn"
		? Math.round(lastOutputSpeed.outputTokens * 1_000 / lastOutputSpeed.elapsedMs)
		: undefined;
	const values: Record<Metric, string> = {
		tps: phase === "turn" ? "计算中" : speed === undefined ? "—" : `${speed} tok/s`,
		cache: cacheHit === undefined ? "—" : `${cacheHit}%`,
		input: totalInput === undefined ? "—" : compactTokens(totalInput),
		output: tokens === undefined ? "—" : compactTokens(tokens.output),
	};

	return (
		<div aria-label="会话统计" className="min-w-0 shrink-0 md:flex-1 md:overflow-x-auto" role="group">
			<Popover>
				<PopoverTrigger asChild>
					<button
						type="button"
						className="inline-flex h-8 items-center rounded-md px-2 text-xs text-muted-foreground hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:bg-muted data-[state=open]:text-foreground md:hidden"
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
					className="max-h-[70dvh] w-72 max-w-[calc(100vw-1rem)] overflow-y-auto rounded-xl border-border bg-popover p-3 shadow-md md:hidden"
				>
					<div className="mb-2 text-sm font-medium">会话统计</div>
					<div className="grid grid-cols-2 gap-1.5" role="group" aria-label="选择统计项">
						{metrics.map((metric) => (
							<button
								key={metric}
								type="button"
								aria-pressed={mobileMetric === metric}
								className={`min-w-0 rounded-lg border p-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${mobileMetric === metric ? "border-border bg-muted" : "border-border/70 hover:bg-muted/60"}`}
								onClick={() => setMobileMetric(metric)}
							>
								<span className="block text-xs text-muted-foreground">{labels[metric]}</span>
								<span className="block truncate text-sm font-medium tabular-nums text-foreground">{values[metric]}</span>
							</button>
						))}
					</div>
					<div className="mt-3 border-t border-border pt-3">
						<MetricBreakdown metric={mobileMetric} tokens={tokens} totalInput={totalInput} lastOutputSpeed={lastOutputSpeed} speed={speed} />
					</div>
				</PopoverContent>
			</Popover>
			<div className="hidden items-center gap-0.5 whitespace-nowrap text-xs md:flex">
				{metrics.map((metric) => (
					<Popover key={metric} open={openMetric === metric} onOpenChange={(open) => setOpenMetric(open ? metric : undefined)}>
						<PopoverTrigger asChild>
							<button
								type="button"
								className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-1.5 text-muted-foreground hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:bg-muted data-[state=open]:text-foreground"
								aria-label={`${labels[metric]} ${values[metric]}，查看详情`}
							>
								<span>{labels[metric]}</span>
								<span className="tabular-nums text-foreground">{values[metric]}</span>
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
