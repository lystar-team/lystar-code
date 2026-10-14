import { Line } from "@ant-design/plots";
import type { LineConfig } from "@ant-design/plots";
import { CheckCircle2, ChevronDown, CircleAlert, RotateCw, XCircle } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { webApi } from "../../../adapters/host-protocol/api.ts";
import { cn } from "../../../lib/utils";
import type { WorkbenchState } from "../../../state/use-workbench";
import { Alert, AlertDescription, AlertTitle } from "../../ui/alert";
import { Button } from "../../ui/button";
import { Collapsible, CollapsibleTrigger } from "../../ui/collapsible";
import { GsapCollapsibleContent } from "../../ui/gsap-collapsible-content";
import { Progress } from "../../ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../ui/select";
import type { WorkbenchActions } from "../types";

type DiagnosticsSnapshot = {
	generatedAt?: number;
	product?: { version?: string };
	web?: { port?: number; ipAddresses?: string[] };
	gateway?: ServiceSnapshot;
	runtime?: ServiceSnapshot & { processMemory?: ProcessMemory };
	host?: { platform?: string; arch?: string; uptimeSeconds?: number };
	cpu?: { cores?: number; usagePercent?: number; loadAverage?: number[] };
	memory?: ResourceSnapshot;
	disk?: ResourceSnapshot & { path?: string; available?: boolean };
	processMemory?: { totalRssBytes?: number; processes?: ProcessSnapshot[] };
	checks?: Array<{ id?: string; status?: string; message?: string }>;
	runtimeReadConcurrency?: {
		configured?: number;
		suggested?: number;
		effective?: number;
		source?: "auto" | "manual";
		cpuCores?: number;
		totalMemoryBytes?: number;
	};
};

type ServiceSnapshot = {
	status?: string;
	reachable?: boolean;
	pid?: number;
	port?: number;
	host?: string;
	uptimeSeconds?: number;
	rssBytes?: number;
	manager?: string;
	persistent?: boolean;
	installed?: boolean;
	message?: string;
};

type ResourceSnapshot = {
	totalBytes?: number;
	freeBytes?: number;
	usedBytes?: number;
	usedPercent?: number;
};

type ProcessMemory = {
	rssBytes?: number;
	heapUsedBytes?: number;
	externalBytes?: number;
};

type ProcessSnapshot = {
	name?: string;
	role?: string;
	pid?: number;
	rssBytes?: number;
};

type ChartSample = {
	at: number;
	cpu: number;
	memory: number;
	processMemory: number;
};

type ChartPalette = {
	isDark: boolean;
	border: string;
	primary: string;
	muted: string;
};

function numberValue(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function boundedPercent(value: number | undefined): number | undefined {
	if (value === undefined) return undefined;
	return Math.max(0, Math.min(100, value));
}

function ratioPercent(numerator: number | undefined, denominator: number | undefined): number | undefined {
	if (numerator === undefined || denominator === undefined || denominator <= 0) return undefined;
	return boundedPercent((numerator / denominator) * 100);
}

function formatBytes(value: number | undefined): string {
	if (value === undefined || !Number.isFinite(value)) return "—";
	if (value < 1024) return `${Math.round(value)} B`;
	const units = ["KB", "MB", "GB", "TB"];
	let current = value;
	let unit = -1;
	while (current >= 1024 && unit < units.length - 1) {
		current /= 1024;
		unit += 1;
	}
	return `${current >= 100 ? current.toFixed(0) : current.toFixed(1)} ${units[unit]}`;
}

function formatBytesValue(value: number | undefined): { value: string; unit: string } {
	const formatted = formatBytes(value);
	if (formatted === "—") return { value: "—", unit: "" };
	const [amount, unit = ""] = formatted.split(" ");
	return { value: amount, unit };
}

function formatPercent(value: number | undefined): string {
	return value === undefined ? "—" : `${value.toFixed(1)}%`;
}

function formatDuration(seconds: number | undefined): string {
	if (seconds === undefined) return "—";
	const days = Math.floor(seconds / 86400);
	const hours = Math.floor((seconds % 86400) / 3600);
	const minutes = Math.floor((seconds % 3600) / 60);
	if (days > 0) return `${days} 天 ${hours} 小时`;
	if (hours > 0) return `${hours} 小时 ${minutes} 分钟`;
	return `${minutes} 分钟`;
}

function formatAxisTime(value: unknown): string {
	const timestamp = value instanceof Date ? value.getTime() : Number(value);
	return Number.isFinite(timestamp) ? new Date(timestamp).toLocaleTimeString() : String(value);
}

function readChartPalette(): ChartPalette {
	const styles = getComputedStyle(document.documentElement);
	const theme = document.documentElement.dataset.theme;
	const isDark = theme === "dark" || (theme === "" && window.matchMedia("(prefers-color-scheme: dark)").matches);
	return {
		isDark,
		border: styles.getPropertyValue("--border").trim(),
		primary: styles.getPropertyValue("--foreground").trim(),
		muted: styles.getPropertyValue("--muted-foreground").trim(),
	};
}

function useChartPalette(theme: string): ChartPalette {
	const [palette, setPalette] = useState<ChartPalette>(() => readChartPalette());
	useEffect(() => {
		const update = () => setPalette(readChartPalette());
		const media = window.matchMedia("(prefers-color-scheme: dark)");
		const observer = new MutationObserver(update);
		update();
		media.addEventListener("change", update);
		observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
		return () => {
			media.removeEventListener("change", update);
			observer.disconnect();
		};
	}, [theme]);
	return palette;
}

function usePrefersReducedMotion(): boolean {
	const [reducedMotion, setReducedMotion] = useState(() => window.matchMedia("(prefers-reduced-motion: reduce)").matches);
	useEffect(() => {
		const media = window.matchMedia("(prefers-reduced-motion: reduce)");
		const update = () => setReducedMotion(media.matches);
		media.addEventListener("change", update);
		return () => media.removeEventListener("change", update);
	}, []);
	return reducedMotion;
}

function StatusBadge({ status }: { status: ServiceSnapshot | undefined }) {
	const running = status?.status === "running" || status?.reachable;
	const unavailable = status?.status === "unavailable";
	return (
		<span className={cn("inline-flex items-center gap-1.5 text-xs font-medium", running ? "text-[var(--success)]" : unavailable ? "text-destructive" : "text-[var(--warning)]")}>
			{running ? <CheckCircle2 className="size-4" aria-hidden="true" /> : unavailable ? <XCircle className="size-4" aria-hidden="true" /> : <CircleAlert className="size-4" aria-hidden="true" />}
			{running ? "运行中" : unavailable ? "不可用" : "未知"}
		</span>
	);
}

function ServiceRow({ name, status, metadata, restarting, onRestart }: {
	name: string;
	status: ServiceSnapshot | undefined;
	metadata: Array<{ label: string; value: string }>;
	restarting: boolean;
	onRestart: () => void;
}) {
	return (
		<div className="grid min-h-12 min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2 px-4 py-3 lg:grid-cols-[20%_10%_10%_minmax(0,1fr)_auto] lg:gap-x-0 lg:py-2">
			<p className="text-sm font-medium">{name}</p>
			<div className="lg:pl-2"><StatusBadge status={status} /></div>
			<p className="font-mono text-xs leading-[18px] text-muted-foreground lg:pl-2">PID <span className="text-foreground">{status?.pid ?? "—"}</span></p>
			<dl className="col-span-2 flex min-w-0 flex-wrap gap-x-4 gap-y-1 text-xs leading-[18px] lg:col-span-1 lg:row-start-auto lg:pl-2">
				{metadata.map((item) => (
					<div className="flex min-w-0 gap-2" key={item.label}>
						<dt className="shrink-0 text-muted-foreground">{item.label}</dt>
						<dd className="min-w-0 break-all font-mono">{item.value}</dd>
					</div>
				))}
			</dl>
			<Button className="col-start-2 row-start-2 h-7 gap-1.5 rounded-md px-2 !text-xs !leading-[18px] lg:col-start-auto lg:row-start-auto" variant="outline" size="sm" aria-label={`重启 ${name}`} disabled={restarting} onClick={onRestart}>
				<RotateCw className={cn("size-3.5", restarting && "animate-spin")} aria-hidden="true" />
				{restarting ? "重启中" : "重启"}
			</Button>
		</div>
	);
}

function ResourceMetric({ label, value, unit, detail, children }: { label: string; value: string; unit: string; detail: ReactNode; children: ReactNode }) {
	return (
		<article className="flex min-h-56 min-w-0 flex-col p-4">
			<div className="h-[88px] shrink-0">
				<h3 className="text-xs leading-[18px]">{label}</h3>
				<p className="flex items-baseline gap-1 font-mono">
					<span className="text-[28px] leading-[34px] font-semibold tracking-tight">{value}</span>
					{unit ? <span className="text-xs">{unit}</span> : null}
				</p>
				<div className="text-xs leading-[18px] text-muted-foreground">{detail}</div>
			</div>
			<div className="mt-2 min-w-0">{children}</div>
		</article>
	);
}

function chartDomainMax(values: number[]): number {
	const maximum = Math.max(...values, 0);
	if (maximum <= 5) return 5;
	const step = maximum <= 10 ? 2 : maximum <= 25 ? 5 : maximum <= 50 ? 10 : 20;
	return Math.min(100, Math.max(step, Math.ceil((maximum * 1.15) / step) * step));
}

function ResourceTrendChart({ title, history, field, palette, reducedMotion }: {
	title: string;
	history: ChartSample[];
	field: "cpu" | "memory" | "processMemory";
	palette: ChartPalette;
	reducedMotion: boolean;
}) {
	const chartData = useMemo(() => history.map((sample) => ({ at: new Date(sample.at), value: sample[field] })), [history, field]);
	const domainMax = useMemo(() => chartDomainMax(chartData.map((point) => point.value)), [chartData]);
	const chartConfig = useMemo<LineConfig>(() => ({
		data: chartData,
		height: 96,
		autoFit: true,
		xField: "at",
		yField: "value",
		theme: { type: palette.isDark ? "classicDark" : "classic" },
		paddingTop: 4,
		paddingRight: 8,
		paddingBottom: 20,
		paddingLeft: 32,
		scale: { x: { type: "time" }, y: { domain: [0, domainMax], nice: false } },
		axis: {
			x: { title: false, labelAutoHide: true, labelAutoRotate: false, labelFormatter: formatAxisTime, tickCount: 2, labelFontSize: 11, labelFill: palette.muted, labelOpacity: 1, tickStroke: palette.border, lineStroke: palette.border },
			y: { title: false, labelFormatter: (value: unknown) => `${value}%`, tickCount: 2, labelFontSize: 11, labelFill: palette.muted, labelOpacity: 1, tickStroke: palette.border, gridStroke: palette.border, gridLineDash: [3, 3] },
		},
		legend: false,
		tooltip: {
			title: (datum: unknown) => {
				const timestamp = datum && typeof datum === "object" && "at" in datum ? (datum as { at?: unknown }).at : undefined;
				return `采样时间：${formatAxisTime(timestamp)}`;
			},
			items: [{ channel: "y", name: title, valueFormatter: (value: unknown) => formatPercent(numberValue(value)) }],
		},
		interaction: { tooltip: { crosshairs: true } },
		style: { stroke: palette.primary, lineWidth: 1.5 },
		animate: reducedMotion ? false : { update: { duration: 360, easing: "ease-out" } },
	}), [chartData, domainMax, palette, reducedMotion, title]);
	return (
		<div className="h-24 min-w-0 w-full" role="img" aria-label={`${title}最近 ${history.length} 个采样点的使用趋势，当前 ${formatPercent(history.at(-1)?.[field])}`}>
			{history.length ? <Line {...chartConfig} /> : <div className="grid h-full place-items-center text-xs text-muted-foreground">等待诊断数据</div>}
		</div>
	);
}

function RuntimeReadConcurrencyPanel({ state, actions, value }: { state: WorkbenchState; actions: WorkbenchActions; value: DiagnosticsSnapshot["runtimeReadConcurrency"] }) {
	const configured = value?.configured ?? 0;
	const canEdit = Boolean(state.sessionId) && !state.readOnly;
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string>();
	const update = async (nextValue: string) => {
		if (!canEdit) return;
		setSaving(true);
		setError(undefined);
		try {
			await webApi.setSetting(state.sessionId!, "runtime-read-concurrency", Number(nextValue));
			await actions.refreshDiagnostics();
			actions.showToast("Runtime 读取并发已更新", "success");
		} catch (updateError) {
			setError(updateError instanceof Error ? updateError.message : String(updateError));
		} finally {
			setSaving(false);
		}
	};
	return (
		<section className="grid min-w-0 content-start gap-3" aria-labelledby="runtime-queue-title">
			<h2 id="runtime-queue-title" className="text-sm leading-5 font-semibold">Runtime 读取队列</h2>
			<div className="grid min-h-48 content-start gap-3 rounded-lg border p-4" aria-busy={saving}>
				<dl className="grid grid-cols-2 gap-3">
					<div>
						<dt className="text-xs text-muted-foreground">当前生效</dt>
						<dd className="mt-1 text-sm leading-5 font-medium">{value?.effective === undefined ? "—" : `${value.effective} 个读槽`}</dd>
					</div>
					<div>
						<dt className="text-xs text-muted-foreground">建议值</dt>
						<dd className="mt-1 text-sm leading-5 font-medium">{value?.suggested === undefined ? "—" : `${value.suggested} 个读槽`}</dd>
					</div>
				</dl>
				<dl className="flex flex-wrap gap-x-4 gap-y-1 border-t pt-2 text-xs leading-[18px]">
					<div className="flex gap-2"><dt className="text-muted-foreground">计算依据</dt><dd className="font-mono">{value?.cpuCores ?? "—"} 核 / {formatBytes(value?.totalMemoryBytes)}</dd></div>
					<div className="flex gap-2"><dt className="text-muted-foreground">来源</dt><dd>{value?.source === "manual" ? "手动" : value?.source === "auto" ? "自动" : "—"}</dd></div>
				</dl>
				<div className="flex items-center justify-between gap-3 border-t pt-2">
					<label className="text-xs text-muted-foreground" htmlFor="runtime-read-concurrency">设置方式</label>
					<Select value={String(configured)} onValueChange={(nextValue) => void update(nextValue)} disabled={!canEdit || saving}>
						<SelectTrigger id="runtime-read-concurrency" size="sm" className="w-28 rounded-md !text-sm !leading-5 focus-visible:ring-2 focus-visible:ring-ring"><SelectValue /></SelectTrigger>
						<SelectContent>
							<SelectItem value="0">自动</SelectItem>
							{Array.from({ length: 15 }, (_, index) => index + 2).map((option) => <SelectItem key={option} value={String(option)}>固定 {option} 个</SelectItem>)}
						</SelectContent>
					</Select>
				</div>
				<p className="text-xs leading-[18px] text-muted-foreground">手动值在下次读批次开始时生效。</p>
				{!canEdit ? <p className="text-xs text-muted-foreground">需要当前会话的控制权才能修改。</p> : null}
				{error ? <p className="text-xs text-destructive" role="alert">{error}</p> : null}
			</div>
		</section>
	);
}

function ChecksSummary({ checks }: { checks: NonNullable<DiagnosticsSnapshot["checks"]> }) {
	const passed = checks.filter((check) => check.status === "ok" || check.status === "pass").length;
	const hasIssues = checks.length > passed;
	const [open, setOpen] = useState(hasIssues);
	useEffect(() => {
		if (hasIssues) setOpen(true);
	}, [hasIssues]);
	return (
		<Collapsible open={open} onOpenChange={setOpen} className="min-w-0">
			<div className="flex min-h-11 flex-wrap items-center justify-between gap-2 rounded-md bg-muted/60 px-4 py-2">
				<p className="flex items-center gap-2 text-sm font-medium" role="status">
					{checks.length ? hasIssues ? <CircleAlert className="size-4 text-[var(--warning)]" aria-hidden="true" /> : <CheckCircle2 className="size-4 text-[var(--success)]" aria-hidden="true" /> : null}
					{checks.length ? `${passed} / ${checks.length} 项检查通过` : "等待诊断数据"}
				</p>
				{checks.length ? <CollapsibleTrigger asChild><Button variant="ghost" size="sm" className="h-7 gap-1 rounded-md px-0 !text-sm !leading-5" aria-label={open ? "收起检查明细" : "查看检查明细"}>{open ? "收起检查明细" : "查看检查明细"}<ChevronDown className={cn("size-4 transition-transform", open && "rotate-180")} aria-hidden="true" /></Button></CollapsibleTrigger> : null}
			</div>
			<GsapCollapsibleContent open={open}>
				<div className="mt-2 divide-y divide-border rounded-lg border px-4">
					{checks.map((check, index) => {
						const ok = check.status === "ok" || check.status === "pass";
						return <div key={check.id ?? index} className="flex min-w-0 items-start gap-2 py-2 text-xs leading-5">{ok ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-[var(--success)]" aria-hidden="true" /> : <CircleAlert className="mt-0.5 size-4 shrink-0 text-[var(--warning)]" aria-hidden="true" />}<span className="min-w-0 break-words">{check.message ?? "检查完成"}</span></div>;
					})}
				</div>
			</GsapCollapsibleContent>
		</Collapsible>
	);
}

function HostConnections({ diagnostics }: { diagnostics: DiagnosticsSnapshot }) {
	const [open, setOpen] = useState(false);
	const addresses = diagnostics.web?.ipAddresses ?? [];
	const port = diagnostics.web?.port;
	const rows = [
		{ label: "版本", value: diagnostics.product?.version ?? "—" },
		{ label: "平台 / 架构", value: `${diagnostics.host?.platform ?? "—"} / ${diagnostics.host?.arch ?? "—"}` },
		{ label: "Host 运行时间", value: formatDuration(diagnostics.host?.uptimeSeconds) },
		{ label: "Runtime 持久化", value: diagnostics.runtime?.persistent ? "已启用" : "未启用" },
	];
	return (
		<section className="grid min-w-0 content-start gap-3" aria-labelledby="host-connections-title">
			<h2 id="host-connections-title" className="text-sm leading-5 font-semibold">主机与连接</h2>
			<div className="min-w-0 rounded-lg border px-4 py-2">
				<dl className="grid min-w-0 sm:grid-cols-2">
					{rows.map((row) => <div key={row.label} className="flex min-h-8 min-w-0 items-center gap-2 border-b py-1 sm:even:pl-4"><dt className="shrink-0 text-xs leading-[18px] text-muted-foreground">{row.label}</dt><dd className={cn("min-w-0 break-words text-[13px] leading-5", row.label === "版本" || row.label === "平台 / 架构" ? "font-mono text-xs leading-[18px]" : undefined)}>{row.value}</dd></div>)}
					<div className="flex min-h-8 min-w-0 items-center gap-2 border-b py-1 sm:col-span-2"><dt className="shrink-0 text-xs leading-[18px] text-muted-foreground">磁盘路径</dt><dd className="min-w-0 break-all font-mono text-xs leading-[18px]">{diagnostics.disk?.path ?? "—"}</dd></div>
				</dl>
				<Collapsible open={open} onOpenChange={setOpen}>
					<div className="flex min-h-8 min-w-0 flex-wrap items-center gap-x-2 gap-y-1 py-1">
						<span className="shrink-0 text-xs text-muted-foreground">可访问地址</span>
						{addresses[0] && port !== undefined ? <a className="min-w-0 break-all font-mono text-xs leading-[18px] underline-offset-4 hover:underline" href={`http://${addresses[0]}:${port}`}>http://{addresses[0]}:{port}</a> : <span className="text-xs">—</span>}
						{addresses.length > 1 ? <CollapsibleTrigger asChild><Button variant="ghost" size="sm" className="ml-auto h-7 gap-1 px-0 !text-[13px] !leading-5" aria-label={open ? "收起可访问地址" : `展开全部 ${addresses.length} 个地址`}>{open ? "收起地址" : `全部 ${addresses.length} 个地址`}<ChevronDown className={cn("size-3.5 transition-transform", open && "rotate-180")} aria-hidden="true" /></Button></CollapsibleTrigger> : null}
					</div>
					<GsapCollapsibleContent open={open}>
						<div className="grid min-w-0 gap-2 border-t py-2">
							{port !== undefined ? addresses.slice(1).map((address) => <a key={address} className="break-all font-mono text-xs underline underline-offset-4" href={`http://${address}:${port}`}>http://{address}:{port}</a>) : null}
						</div>
					</GsapCollapsibleContent>
				</Collapsible>
			</div>
		</section>
	);
}

export function DiagnosticsSettings({ state, actions }: { state: WorkbenchState; actions: WorkbenchActions }) {
	const diagnostics = (state.diagnostics ?? {}) as DiagnosticsSnapshot;
	const [history, setHistory] = useState<ChartSample[]>([]);
	const [activeAction, setActiveAction] = useState<"gateway" | "runtime">();
	const [refreshError, setRefreshError] = useState<string>();
	const palette = useChartPalette(state.theme);
	const reducedMotion = usePrefersReducedMotion();
	useEffect(() => {
		if (!state.settingsOpen || state.settingsTab !== "diagnostics") return;
		let active = true;
		const refresh = async () => {
			try {
				await actions.refreshDiagnostics();
				if (active) setRefreshError(undefined);
			} catch (error) {
				if (active) setRefreshError(error instanceof Error ? error.message : String(error));
			}
		};
		void refresh();
		const timer = window.setInterval(() => void refresh(), 2000);
		return () => {
			active = false;
			window.clearInterval(timer);
		};
	}, [actions.refreshDiagnostics, state.settingsOpen, state.settingsTab]);
	useEffect(() => {
		if (!diagnostics.generatedAt) return;
		const totalMemory = numberValue(diagnostics.memory?.totalBytes) ?? 0;
		const processMemory = numberValue(diagnostics.processMemory?.totalRssBytes) ?? 0;
		setHistory((previous) => {
			if (previous.at(-1)?.at === diagnostics.generatedAt) return previous;
			return [...previous, {
				at: diagnostics.generatedAt ?? Date.now(),
				cpu: boundedPercent(numberValue(diagnostics.cpu?.usagePercent)) ?? 0,
				memory: boundedPercent(numberValue(diagnostics.memory?.usedPercent)) ?? 0,
				processMemory: ratioPercent(processMemory, totalMemory) ?? 0,
			}].slice(-30);
		});
	}, [diagnostics.generatedAt, diagnostics.cpu?.usagePercent, diagnostics.memory?.usedPercent, diagnostics.memory?.totalBytes, diagnostics.processMemory?.totalRssBytes]);
	const runtimeProcess = useMemo(() => diagnostics.processMemory?.processes?.find((processInfo) => processInfo.role === "runtime"), [diagnostics.processMemory?.processes]);
	const processMemoryPercent = ratioPercent(diagnostics.processMemory?.totalRssBytes, diagnostics.memory?.totalBytes);
	const memoryValue = formatBytesValue(diagnostics.memory?.usedBytes);
	const processMemoryValue = formatBytesValue(diagnostics.processMemory?.totalRssBytes);
	const diskValue = formatBytesValue(diagnostics.disk?.usedBytes);
	const runServiceAction = async (service: "gateway" | "runtime") => {
		setActiveAction(service);
		try {
			await actions.restartDiagnosticService(service);
		} catch {
			// 操作错误已由状态层转成 Toast，这里只结束按钮的忙碌状态。
		} finally {
			setActiveAction(undefined);
		}
	};
	const checks = Array.isArray(diagnostics.checks) ? diagnostics.checks : [];
	return (
		<div className="grid min-w-0 gap-6">
			{refreshError ? <Alert variant="destructive"><CircleAlert className="size-4" aria-hidden="true" /><AlertTitle>诊断数据获取失败</AlertTitle><AlertDescription>{refreshError}</AlertDescription></Alert> : null}
			<ChecksSummary checks={checks} />
			<section className="grid min-w-0 gap-3" aria-labelledby="diagnostic-services-title">
				<h2 id="diagnostic-services-title" className="text-sm leading-5 font-semibold">服务状态</h2>
				<div className="divide-y divide-border rounded-lg border">
					<ServiceRow name="Web Gateway" status={diagnostics.gateway} metadata={[{ label: "端口", value: String(diagnostics.gateway?.port ?? "—") }, { label: "运行", value: formatDuration(diagnostics.gateway?.uptimeSeconds) }]} restarting={activeAction === "gateway"} onRestart={() => void runServiceAction("gateway")} />
					<ServiceRow name="Web Runtime" status={diagnostics.runtime} metadata={[{ label: "管理器", value: diagnostics.runtime?.manager ?? "—" }, { label: "持久化", value: diagnostics.runtime?.persistent ? "已启用" : "未启用" }]} restarting={activeAction === "runtime"} onRestart={() => void runServiceAction("runtime")} />
				</div>
			</section>
			<section className="grid min-w-0 gap-3" aria-labelledby="diagnostic-resources-title">
				<div className="flex flex-wrap items-center justify-between gap-2">
					<h2 id="diagnostic-resources-title" className="text-sm leading-5 font-semibold">实时资源</h2>
					<p className="text-xs text-muted-foreground">最近 {history.length} 次采样 / 约 2 秒更新</p>
				</div>
				<div className="grid min-w-0 grid-cols-1 overflow-hidden rounded-lg border sm:grid-cols-2 xl:grid-cols-4 [&>article]:border-border [&>article+article]:border-t sm:[&>article+article]:border-t-0 sm:[&>article:nth-child(even)]:border-l sm:[&>article:nth-child(n+3)]:border-t xl:[&>article:nth-child(n+3)]:border-t-0 xl:[&>article+article]:border-l">
					<ResourceMetric label="CPU 使用率" value={diagnostics.cpu?.usagePercent === undefined ? "—" : diagnostics.cpu.usagePercent.toFixed(1)} unit="%" detail={<span>{diagnostics.cpu?.cores ?? "—"} 核 <span className="ml-2">负载 {diagnostics.cpu?.loadAverage?.[0]?.toFixed(2) ?? "—"}</span></span>}>
						<ResourceTrendChart title="CPU 使用率" field="cpu" history={history} palette={palette} reducedMotion={reducedMotion} />
					</ResourceMetric>
					<ResourceMetric label="系统运行内存" value={memoryValue.value} unit={memoryValue.unit} detail={`${formatPercent(diagnostics.memory?.usedPercent)} 已用 / 共 ${formatBytes(diagnostics.memory?.totalBytes)}`}>
						<ResourceTrendChart title="系统内存使用率" field="memory" history={history} palette={palette} reducedMotion={reducedMotion} />
					</ResourceMetric>
					<ResourceMetric label={`${state.branding.name} 相关进程`} value={processMemoryValue.value} unit={processMemoryValue.unit} detail={<><p>{formatPercent(processMemoryPercent)} 系统内存</p><p className="truncate" title={`Gateway ${formatBytes(diagnostics.gateway?.rssBytes)}${runtimeProcess ? ` / Runtime ${formatBytes(runtimeProcess.rssBytes)}` : ""}`}>Gateway {formatBytes(diagnostics.gateway?.rssBytes)}{runtimeProcess ? ` / Runtime ${formatBytes(runtimeProcess.rssBytes)}` : ""}</p></>}>
						<ResourceTrendChart title={`${state.branding.name} 进程内存占比`} field="processMemory" history={history} palette={palette} reducedMotion={reducedMotion} />
					</ResourceMetric>
					<ResourceMetric label="磁盘使用" value={diskValue.value} unit={diskValue.unit} detail={`${formatPercent(diagnostics.disk?.usedPercent)} 已用 / 共 ${formatBytes(diagnostics.disk?.totalBytes)}`}>
						<div className="grid h-24 content-start gap-3 pt-3">
							<div className="flex items-center gap-2"><Progress value={diagnostics.disk?.usedPercent} className="h-1.5 flex-1 bg-muted [&_[data-slot=progress-indicator]]:bg-muted-foreground" aria-label="磁盘使用率" /><span className="font-mono text-xs">{formatPercent(diagnostics.disk?.usedPercent)}</span></div>
							<dl className="grid gap-1 text-xs"><div className="flex gap-2"><dt className="text-muted-foreground">已用</dt><dd>{formatBytes(diagnostics.disk?.usedBytes)}</dd></div><div className="flex gap-2"><dt className="text-muted-foreground">总量</dt><dd>{formatBytes(diagnostics.disk?.totalBytes)}</dd></div></dl>
						</div>
					</ResourceMetric>
				</div>
			</section>
			<div className="grid min-w-0 gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
				<HostConnections diagnostics={diagnostics} />
				<RuntimeReadConcurrencyPanel state={state} actions={actions} value={diagnostics.runtimeReadConcurrency} />
			</div>
		</div>
	);
}
