import { Line } from "@ant-design/plots";
import type { LineConfig } from "@ant-design/plots";
import { Activity, CheckCircle2, CircleAlert, Cpu, HardDrive, MemoryStick, RotateCw, Server, XCircle } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { cn } from "../../../lib/utils";
import type { WorkbenchActions } from "../types";
import type { WorkbenchState } from "../../../state/use-workbench";
import { Alert, AlertDescription, AlertTitle } from "../../ui/alert";
import { Button } from "../../ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../../ui/card";
import { Progress } from "../../ui/progress";
import { Separator } from "../../ui/separator";
import { SettingSection, StatText } from "./shared";

type DiagnosticsSnapshot = {
	generatedAt?: number;
	product?: { version?: string };
	web?: { host?: string; port?: number; ipAddresses?: string[] };
	gateway?: ServiceSnapshot;
	runtime?: ServiceSnapshot & { processMemory?: ProcessMemory };
	host?: { platform?: string; arch?: string; uptimeSeconds?: number };
	cpu?: { cores?: number; usagePercent?: number; loadAverage?: number[] };
	memory?: ResourceSnapshot;
	disk?: ResourceSnapshot & { path?: string; available?: boolean };
	processMemory?: { totalRssBytes?: number; processes?: ProcessSnapshot[] };
	checks?: Array<{ id?: string; status?: string; message?: string }>;
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
};

type ServiceCardProps = {
	icon: ReactNode;
	name: string;
	description: string;
	status: ServiceSnapshot | undefined;
	metadata: Array<{ label: string; value: string }>;
	restarting: boolean;
	onRestart: () => void;
};

type MetricValue = {
	value: string;
	unit: string;
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

function formatBytesValue(value: number | undefined): MetricValue {
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

function formatTime(timestamp: number | undefined): string {
	return timestamp ? new Date(timestamp).toLocaleTimeString() : "等待数据";
}

function formatAxisTime(value: unknown): string {
	const timestamp = value instanceof Date ? value.getTime() : Number(value);
	return Number.isFinite(timestamp) ? formatTime(timestamp) : String(value);
}

function readChartPalette(): ChartPalette {
	const styles = getComputedStyle(document.documentElement);
	const read = (name: string, fallback: string) => styles.getPropertyValue(name).trim() || fallback;
	const theme = document.documentElement.dataset.theme;
	const isDark = theme === "dark" || (theme === "" && window.matchMedia("(prefers-color-scheme: dark)").matches);
	return {
		isDark,
		border: read("--border", isDark ? "#3b3b3b" : "#eeeeee"),
		primary: isDark ? "#f5f5f5" : "#111111",
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
		update();
		media.addEventListener("change", update);
		return () => media.removeEventListener("change", update);
	}, []);

	return reducedMotion;
}

function serviceLabel(status: ServiceSnapshot | undefined): string {
	if (status?.status === "running" || status?.reachable) return "运行中";
	if (status?.status === "unavailable") return "不可用";
	return "未知";
}

function serviceTone(status: ServiceSnapshot | undefined): "success" | "warning" | "error" {
	if (status?.status === "running" || status?.reachable) return "success";
	if (status?.status === "unavailable") return "error";
	return "warning";
}

function StatusBadge({ status }: { status: ServiceSnapshot | undefined }) {
	const tone = serviceTone(status);
	return (
		<span
			className={cn(
				"inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium",
				tone === "success" && "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
				tone === "warning" && "bg-amber-500/10 text-amber-700 dark:text-amber-300",
				tone === "error" && "bg-destructive/10 text-destructive",
			)}
		>
			{tone === "success" ? <CheckCircle2 className="size-3.5" aria-hidden="true" /> : tone === "error" ? <XCircle className="size-3.5" aria-hidden="true" /> : <CircleAlert className="size-3.5" aria-hidden="true" />}
			{serviceLabel(status)}
		</span>
	);
}

function ServiceCard({ icon, name, description, status, metadata, restarting, onRestart }: ServiceCardProps) {
	return (
		<Card className="min-w-0 rounded-xl py-3 shadow-none">
			<CardContent className="grid min-w-0 gap-3 px-4">
				<div className="flex min-w-0 items-start justify-between gap-3">
					<div className="flex min-w-0 gap-2.5">
						<span className="grid size-8 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">{icon}</span>
						<div className="min-w-0">
							<div className="flex flex-wrap items-center gap-x-2 gap-y-1">
								<p className="font-medium">{name}</p>
								<StatusBadge status={status} />
							</div>
							<p className="mt-1 text-xs leading-5 text-muted-foreground">{description}</p>
						</div>
					</div>
				</div>

				<div className="flex min-w-0 flex-wrap items-center justify-between gap-3 border-t pt-3">
					<dl className="flex min-w-0 flex-wrap gap-x-4 gap-y-1 text-xs">
						{metadata.map((item) => (
							<div className="min-w-0 max-w-full" key={item.label}>
								<dt className="inline text-muted-foreground">{item.label} </dt>
								<dd className="inline break-all font-mono text-foreground">{item.value}</dd>
							</div>
						))}
					</dl>
					<Button className="shrink-0" variant="outline" size="sm" disabled={restarting} onClick={onRestart}>
						<RotateCw className={cn("size-3.5", restarting && "animate-spin")} aria-hidden="true" />
						{restarting ? "重启中" : "重启"}
					</Button>
				</div>
			</CardContent>
		</Card>
	);
}

function ResourceSummaryCard({ icon, label, value, unit, detail }: { icon: ReactNode; label: string; value: string; unit: string; detail: string }) {
	return (
		<Card className="min-w-0 rounded-xl py-0 shadow-none">
			<CardContent className="flex min-h-32 min-w-0 items-center gap-3 px-4 py-4 sm:min-h-36 sm:gap-4 sm:px-5">
				<span className="grid size-10 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">{icon}</span>
				<div className="min-w-0">
					<p className="truncate text-sm font-medium text-muted-foreground">{label}</p>
					<p className="mt-1 flex min-w-0 items-baseline gap-1 font-mono tracking-tight">
						<span className="truncate text-2xl font-semibold sm:text-3xl">{value}</span>
						{unit ? <span className="shrink-0 text-base font-semibold text-muted-foreground sm:text-lg">{unit}</span> : null}
					</p>
					<p className="mt-1 line-clamp-2 text-xs leading-5 text-muted-foreground">{detail}</p>
				</div>
			</CardContent>
		</Card>
	);
}

function chartDomainMax(values: number[]): number {
	const maximum = Math.max(...values, 0);
	if (maximum <= 5) return 5;
	const step = maximum <= 10 ? 2 : maximum <= 25 ? 5 : maximum <= 50 ? 10 : 20;
	return Math.min(100, Math.max(step, Math.ceil((maximum * 1.15) / step) * step));
}

function ResourceTrendChart({ icon, title, currentValue, history, selectValue, palette, reducedMotion, first }: { icon: ReactNode; title: string; currentValue: string; history: ChartSample[]; selectValue: (sample: ChartSample) => number; palette: ChartPalette; reducedMotion: boolean; first: boolean }) {
	const chartData = useMemo(() => history.map((sample) => ({ at: new Date(sample.at), value: boundedPercent(selectValue(sample)) ?? 0 })), [history, selectValue]);
	const domainMax = useMemo(() => chartDomainMax(chartData.map((point) => point.value)), [chartData]);
	const chartConfig = useMemo<LineConfig>(
		() => ({
			data: chartData,
			height: 208,
			autoFit: true,
			xField: "at",
			yField: "value",
			color: palette.primary,
			theme: { type: palette.isDark ? "classicDark" : "classic" },
			padding: [8, 16, 32, 52],
			scale: {
				x: { type: "time" },
				y: { domain: [0, domainMax], nice: false },
			},
			axis: {
				x: { labelAutoHide: true, labelAutoRotate: false, labelFormatter: formatAxisTime, tickCount: 5 },
				y: {
					labelFormatter: (value: unknown) => `${value}%`,
					tickCount: 4,
					grid: { line: { style: { stroke: palette.border, lineDash: [4, 4] } } },
				},
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
			style: { lineWidth: 2 },
			point: { size: 2.5 },
			animate: reducedMotion ? false : { update: { duration: 360, easing: "ease-out" } },
		}),
		[chartData, domainMax, palette.border, palette.isDark, palette.primary, reducedMotion, title],
	);

	return (
		<section className={cn("grid gap-3", !first && "border-t pt-5")}>
			<div className="flex flex-wrap items-center justify-between gap-2">
				<div className="flex min-w-0 items-center gap-2">
					<span className="grid size-7 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground">{icon}</span>
					<h3 className="truncate text-sm font-medium">{title}</h3>
				</div>
				<span className="shrink-0 font-mono text-sm text-muted-foreground">{currentValue}</span>
			</div>
			<div className="h-52 min-w-0 w-full" role="img" aria-label={`${title}最近 ${history.length} 个采样点的使用趋势`}>
				<Line {...chartConfig} />
			</div>
		</section>
	);
}

function ResourceTrendPanel({ history, palette, reducedMotion }: { history: ChartSample[]; palette: ChartPalette; reducedMotion: boolean }) {
	return (
		<Card className="min-w-0 rounded-xl shadow-none">
			<CardHeader className="gap-2 px-4 pb-3 sm:px-6">
				<div className="flex flex-wrap items-end justify-between gap-2">
					<div>
						<CardTitle className="text-base">资源趋势</CardTitle>
						<p className="mt-1 text-xs text-muted-foreground">最近 {history.length} 个采样点，约每 2 秒更新</p>
					</div>
					<span className="rounded-md bg-muted px-2 py-1 text-xs font-medium text-foreground">实时采样</span>
				</div>
			</CardHeader>
			<CardContent className="px-4 pb-5 sm:px-6 sm:pb-6">
				{history.length ? (
					<div>
						<ResourceTrendChart
							icon={<Cpu className="size-4" aria-hidden="true" />}
							title="CPU 使用率"
							currentValue={formatPercent(history.at(-1)?.cpu)}
							history={history}
							selectValue={(sample) => sample.cpu}
							palette={palette}
							reducedMotion={reducedMotion}
							first
						/>
						<ResourceTrendChart
							icon={<MemoryStick className="size-4" aria-hidden="true" />}
							title="系统内存使用率"
							currentValue={formatPercent(history.at(-1)?.memory)}
							history={history}
							selectValue={(sample) => sample.memory}
							palette={palette}
							reducedMotion={reducedMotion}
							first={false}
						/>
						<ResourceTrendChart
							icon={<Server className="size-4" aria-hidden="true" />}
							title="LYStar 进程内存占比"
							currentValue={formatPercent(history.at(-1)?.processMemory)}
							history={history}
							selectValue={(sample) => sample.processMemory}
							palette={palette}
							reducedMotion={reducedMotion}
							first={false}
						/>
					</div>
				) : (
					<div className="grid h-52 place-items-center rounded-lg border bg-muted/20 text-sm text-muted-foreground">等待诊断数据</div>
				)}
			</CardContent>
		</Card>
	);
}

function ChecksSummary({ checks }: { checks: Array<{ id?: string; status?: string; message?: string }> }) {
	if (!checks.length) {
		return <Card className="min-w-0 rounded-xl shadow-none"><CardContent className="py-6 text-center text-sm text-muted-foreground">等待诊断数据</CardContent></Card>;
	}

	const passed = checks.filter((check) => check.status === "ok" || check.status === "pass").length;
	const ratio = (passed / checks.length) * 100;

	return (
		<Card className="min-w-0 rounded-xl shadow-none">
			<CardContent className="grid gap-3 p-3 sm:p-4">
				<div className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-muted/30 px-3 py-2.5">
					<div>
						<p className="text-sm font-medium">检查通过率</p>
						<p className="mt-0.5 text-xs text-muted-foreground">{passed} / {checks.length} 项通过</p>
					</div>
					<div className="flex w-48 max-w-full shrink-0 items-center gap-2">
						<Progress className="bg-muted [&_[data-slot=progress-indicator]]:bg-emerald-600 dark:[&_[data-slot=progress-indicator]]:bg-emerald-400" value={ratio} aria-label="检查通过率" />
						<span className="shrink-0 font-mono text-xs">{ratio.toFixed(0)}%</span>
					</div>
				</div>
				<div className="grid">
					{checks.map((check, index) => {
						const ok = check.status === "ok" || check.status === "pass";
						return (
							<div key={check.id ?? index}>
								{index ? <Separator className="my-1" /> : null}
								<div className="flex min-w-0 items-start gap-2 py-2 text-sm">
									{ok ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden="true" /> : <CircleAlert className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden="true" />}
									<span className="min-w-0 break-words">{check.message ?? "检查完成"}</span>
								</div>
							</div>
						);
					})}
				</div>
			</CardContent>
		</Card>
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
			return [
				...previous,
				{
					at: diagnostics.generatedAt ?? Date.now(),
					cpu: boundedPercent(numberValue(diagnostics.cpu?.usagePercent)) ?? 0,
					memory: boundedPercent(numberValue(diagnostics.memory?.usedPercent)) ?? 0,
					processMemory: ratioPercent(processMemory, totalMemory) ?? 0,
				},
			].slice(-30);
		});
	}, [diagnostics.generatedAt, diagnostics.cpu?.usagePercent, diagnostics.memory?.usedPercent, diagnostics.memory?.totalBytes, diagnostics.processMemory?.totalRssBytes]);

	const runtimeProcess = useMemo(
		() => diagnostics.processMemory?.processes?.find((processInfo) => processInfo.role === "runtime"),
		[diagnostics.processMemory?.processes],
	);
	const ipAddresses = diagnostics.web?.ipAddresses?.[0] ?? "未发现外部 IP";
	const processMemoryDetail = `${formatBytes(diagnostics.processMemory?.totalRssBytes)} · Gateway ${formatBytes(diagnostics.gateway?.rssBytes)}${runtimeProcess ? ` · Runtime ${formatBytes(runtimeProcess.rssBytes)}` : ""}`;
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
		<div className="grid min-w-0 gap-5">
			{refreshError && (
				<Alert variant="destructive">
					<CircleAlert className="size-4" aria-hidden="true" />
					<AlertTitle>诊断数据获取失败</AlertTitle>
					<AlertDescription>{refreshError}</AlertDescription>
				</Alert>
			)}

			<SettingSection title="服务状态">
				<div className="grid min-w-0 gap-3 lg:grid-cols-2">
					<ServiceCard
						icon={<Server className="size-4" aria-hidden="true" />}
						name="Web Gateway"
						description="负责浏览器连接、页面资源、API 请求和实时消息转发。"
						status={diagnostics.gateway}
						metadata={[
							{ label: "地址", value: `${diagnostics.web?.host ?? "—"}:${diagnostics.web?.port ?? "—"}` },
							{ label: "PID", value: String(diagnostics.gateway?.pid ?? "—") },
						]}
						restarting={activeAction === "gateway"}
						onRestart={() => void runServiceAction("gateway")}
					/>
					<ServiceCard
						icon={<Activity className="size-4" aria-hidden="true" />}
						name="Web Runtime"
						description="负责 Agent 会话、文件与 Git 访问、任务持久化和运行恢复。"
						status={diagnostics.runtime}
						metadata={[
							{ label: "PID", value: String(diagnostics.runtime?.pid ?? "—") },
							{ label: "管理器", value: diagnostics.runtime?.manager ?? "—" },
						]}
						restarting={activeAction === "runtime"}
						onRestart={() => void runServiceAction("runtime")}
					/>
				</div>
			</SettingSection>

			<SettingSection title="主机信息">
				<div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
					<StatText label="Host IP" value={ipAddresses} />
					<StatText label="Web 服务端口" value={diagnostics.web?.port ? String(diagnostics.web.port) : "—"} />
					<StatText label={`${state.branding.name} 版本`} value={diagnostics.product?.version ?? "—"} />
					<StatText label="平台 / 架构" value={`${diagnostics.host?.platform ?? "—"} / ${diagnostics.host?.arch ?? "—"}`} />
				</div>
			</SettingSection>

			<SettingSection title="实时资源">
				<div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
					<ResourceSummaryCard
						icon={<Cpu className="size-5" aria-hidden="true" />}
						label="CPU 使用率"
						value={diagnostics.cpu?.usagePercent === undefined ? "—" : diagnostics.cpu.usagePercent.toFixed(1)}
						unit="%"
						detail={`${diagnostics.cpu?.cores ?? "—"} 核 · 负载 ${diagnostics.cpu?.loadAverage?.[0]?.toFixed(2) ?? "—"}`}
					/>
					<ResourceSummaryCard
						icon={<MemoryStick className="size-5" aria-hidden="true" />}
						label="系统运行内存"
						value={memoryValue.value}
						unit={memoryValue.unit}
						detail={`${formatPercent(diagnostics.memory?.usedPercent)} 已用 · ${formatBytes(diagnostics.memory?.totalBytes)}`}
					/>
					<ResourceSummaryCard
						icon={<Server className="size-5" aria-hidden="true" />}
						label="LYStar 相关进程"
						value={processMemoryValue.value}
						unit={processMemoryValue.unit}
						detail={`${formatPercent(processMemoryPercent)} 系统内存 · ${processMemoryDetail}`}
					/>
					<ResourceSummaryCard
						icon={<HardDrive className="size-5" aria-hidden="true" />}
						label="磁盘使用"
						value={diskValue.value}
						unit={diskValue.unit}
						detail={`${formatPercent(diagnostics.disk?.usedPercent)} 已用 · ${formatBytes(diagnostics.disk?.totalBytes)}`}
					/>
				</div>
				<ResourceTrendPanel history={history} palette={palette} reducedMotion={reducedMotion} />
			</SettingSection>

			<SettingSection title="运行详情">
				<div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
					<StatText label="Host 运行时间" value={formatDuration(diagnostics.host?.uptimeSeconds)} />
					<StatText label="Gateway 运行时间" value={formatDuration(diagnostics.gateway?.uptimeSeconds)} />
					<StatText label="Runtime 持久化" value={diagnostics.runtime?.persistent ? "已启用" : "未启用"} />
					<StatText label="磁盘路径" value={diagnostics.disk?.path ?? "—"} />
				</div>
			</SettingSection>

			<SettingSection title="检查结果">
				<ChecksSummary checks={checks} />
			</SettingSection>
		</div>
	);
}
