import { Activity, CheckCircle2, CircleAlert, Cpu, HardDrive, RefreshCw, RotateCw, Server, XCircle } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { cn } from "../../../lib/utils";
import type { WorkbenchActions } from "../types";
import type { WorkbenchState } from "../../../state/use-workbench";
import { Alert, AlertDescription, AlertTitle } from "../../ui/alert";
import { Button } from "../../ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../../ui/card";
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

function numberValue(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
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
			{tone === "success" ? <CheckCircle2 className="size-3.5" /> : tone === "error" ? <XCircle className="size-3.5" /> : <CircleAlert className="size-3.5" />}
			{serviceLabel(status)}
		</span>
	);
}

function MetricCard({
	icon,
	label,
	value,
	detail,
}: {
	icon: ReactNode;
	label: string;
	value: string;
	detail?: string;
}) {
	return (
		<Card className="shadow-none">
			<CardContent className="p-4">
				<div className="flex items-start justify-between gap-3">
					<div>
						<p className="text-xs text-muted-foreground">{label}</p>
						<p className="mt-1 text-xl font-semibold tracking-tight">{value}</p>
						{detail && <p className="mt-1 text-xs text-muted-foreground">{detail}</p>}
					</div>
					<span className="rounded-md bg-muted p-2 text-muted-foreground">{icon}</span>
				</div>
			</CardContent>
		</Card>
	);
}

function chartPath(values: number[], width: number, height: number): string {
	if (values.length === 0) return "";
	return values
		.map((value, index) => {
			const x = values.length === 1 ? width : (index / (values.length - 1)) * width;
			const y = height - (Math.max(0, Math.min(100, value)) / 100) * height;
			return `${index === 0 ? "M" : "L"} ${x.toFixed(1)} ${y.toFixed(1)}`;
		})
		.join(" ");
}

function ResourceChart({ history }: { history: ChartSample[] }) {
	const width = 640;
	const height = 180;
	const lines = [
		{ label: "CPU", color: "var(--primary)", values: history.map((sample) => sample.cpu) },
		{ label: "系统内存", color: "#0f766e", values: history.map((sample) => sample.memory) },
		{ label: "LYStar 进程内存", color: "#b45309", values: history.map((sample) => sample.processMemory) },
	];
	return (
		<Card className="shadow-none">
			<CardHeader className="gap-3 pb-3">
				<div className="flex flex-wrap items-center justify-between gap-3">
					<div>
						<CardTitle className="text-base">资源趋势</CardTitle>
						<p className="mt-1 text-xs text-muted-foreground">最近 {history.length} 个采样点，约每 2 秒更新</p>
					</div>
					<div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
						{lines.map((line) => (
							<span className="inline-flex items-center gap-1.5" key={line.label}>
								<span className="size-2 rounded-full" style={{ backgroundColor: line.color }} />
								{line.label}
							</span>
						))}
					</div>
				</div>
			</CardHeader>
			<CardContent className="pt-0">
				<div className="overflow-hidden rounded-md border bg-muted/20 p-3" role="img" aria-label="CPU、系统内存和 LYStar Code 进程内存使用趋势">
					<svg className="h-44 w-full" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
						{[0, 25, 50, 75, 100].map((value) => {
							const y = height - (value / 100) * height;
							return <line key={value} x1="0" x2={width} y1={y} y2={y} stroke="var(--border)" strokeDasharray="3 5" />;
						})}
						{lines.map((line) => (
							<path d={chartPath(line.values, width, height)} fill="none" key={line.label} stroke={line.color} strokeLinecap="round" strokeLinejoin="round" strokeWidth="3" />
						))}
					</svg>
					<div className="mt-2 flex justify-between text-[11px] text-muted-foreground">
						<span>{history.length ? formatTime(history[0]?.at) : "等待数据"}</span>
						<span>{history.length ? formatTime(history.at(-1)?.at) : "—"}</span>
					</div>
				</div>
			</CardContent>
		</Card>
	);
}

export function DiagnosticsSettings({ state, actions }: { state: WorkbenchState; actions: WorkbenchActions }) {
	const diagnostics = (state.diagnostics ?? {}) as DiagnosticsSnapshot;
	const [history, setHistory] = useState<ChartSample[]>([]);
	const [refreshing, setRefreshing] = useState(false);
	const [activeAction, setActiveAction] = useState<"gateway" | "runtime">();
	const [refreshError, setRefreshError] = useState<string>();

	useEffect(() => {
		if (!state.settingsOpen || state.settingsTab !== "diagnostics") return;
		let active = true;
		const refresh = async () => {
			setRefreshing(true);
			try {
				await actions.refreshDiagnostics();
				if (active) setRefreshError(undefined);
			} catch (error) {
				if (active) setRefreshError(error instanceof Error ? error.message : String(error));
			} finally {
				if (active) setRefreshing(false);
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
					cpu: numberValue(diagnostics.cpu?.usagePercent) ?? 0,
					memory: numberValue(diagnostics.memory?.usedPercent) ?? 0,
					processMemory: totalMemory > 0 ? Math.min(100, (processMemory / totalMemory) * 100) : 0,
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
		<div className="grid gap-6">
			<div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-muted/20 px-4 py-3">
				<div className="flex items-center gap-2 text-sm">
					<Activity className="size-4 text-muted-foreground" />
					<span>实时诊断</span>
					<span className="text-xs text-foreground">最近更新：{formatTime(diagnostics.generatedAt)}</span>
				</div>
				<Button variant="outline" size="sm" disabled={refreshing} onClick={() => void actions.refreshDiagnostics()}>
					<RefreshCw className={cn("size-4", refreshing && "animate-spin")} />
					刷新
				</Button>
			</div>

			{refreshError && (
				<Alert variant="destructive">
					<CircleAlert className="size-4" />
					<AlertTitle>诊断数据获取失败</AlertTitle>
					<AlertDescription>{refreshError}</AlertDescription>
				</Alert>
			)}

			<SettingSection title="服务状态">
				<div className="grid gap-3 md:grid-cols-2">
					<Card className="shadow-none">
						<CardContent className="flex items-center justify-between gap-4 p-4">
							<div className="flex min-w-0 items-center gap-3">
								<span className="rounded-md bg-muted p-2"><Server className="size-4" /></span>
								<div className="min-w-0">
									<p className="font-medium">Web Gateway</p>
									<p className="truncate text-xs text-muted-foreground">{diagnostics.web?.host ?? "—"}:{diagnostics.web?.port ?? "—"} · PID {diagnostics.gateway?.pid ?? "—"}</p>
								</div>
							</div>
							<div className="flex items-center gap-2">
								<StatusBadge status={diagnostics.gateway} />
								<Button variant="outline" size="sm" disabled={activeAction !== undefined} onClick={() => void runServiceAction("gateway")}>
									<RotateCw className={cn("size-3.5", activeAction === "gateway" && "animate-spin")} />
									重启
								</Button>
							</div>
						</CardContent>
					</Card>
					<Card className="shadow-none">
						<CardContent className="flex items-center justify-between gap-4 p-4">
							<div className="flex min-w-0 items-center gap-3">
								<span className="rounded-md bg-muted p-2"><Activity className="size-4" /></span>
								<div className="min-w-0">
									<p className="font-medium">Web Runtime</p>
									<p className="truncate text-xs text-muted-foreground">PID {diagnostics.runtime?.pid ?? "—"} · {diagnostics.runtime?.manager ?? "—"}</p>
								</div>
							</div>
							<div className="flex items-center gap-2">
								<StatusBadge status={diagnostics.runtime} />
								<Button variant="outline" size="sm" disabled={activeAction !== undefined} onClick={() => void runServiceAction("runtime")}>
									<RotateCw className={cn("size-3.5", activeAction === "runtime" && "animate-spin")} />
									重启
								</Button>
							</div>
						</CardContent>
					</Card>
				</div>
			</SettingSection>

			<SettingSection title="主机信息">
				<div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
					<StatText label="Host IP" value={ipAddresses} />
					<StatText label="Web 服务端口" value={diagnostics.web?.port ? String(diagnostics.web.port) : "—"} />
					<StatText label="LYStar Code 版本" value={diagnostics.product?.version ?? "—"} />
					<StatText label="平台 / 架构" value={`${diagnostics.host?.platform ?? "—"} / ${diagnostics.host?.arch ?? "—"}`} />
				</div>
			</SettingSection>

			<SettingSection title="实时资源">
				<div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
					<MetricCard icon={<Cpu className="size-4" />} label="CPU 使用率" value={diagnostics.cpu?.usagePercent === undefined ? "采样中" : `${diagnostics.cpu.usagePercent.toFixed(1)}%`} detail={`${diagnostics.cpu?.cores ?? "—"} 核 · 负载 ${diagnostics.cpu?.loadAverage?.[0]?.toFixed(2) ?? "—"}`} />
					<MetricCard icon={<Activity className="size-4" />} label="系统运行内存" value={formatBytes(diagnostics.memory?.usedBytes)} detail={`${diagnostics.memory?.usedPercent?.toFixed(1) ?? "—"}% / ${formatBytes(diagnostics.memory?.totalBytes)}`} />
					<MetricCard icon={<Server className="size-4" />} label="LYStar 相关进程" value={formatBytes(diagnostics.processMemory?.totalRssBytes)} detail={processMemoryDetail} />
					<MetricCard icon={<HardDrive className="size-4" />} label="磁盘使用" value={formatBytes(diagnostics.disk?.usedBytes)} detail={`${diagnostics.disk?.usedPercent?.toFixed(1) ?? "—"}% / ${formatBytes(diagnostics.disk?.totalBytes)}`} />
				</div>
				<ResourceChart history={history} />
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
				{checks.length ? (
					<div className="grid gap-1">
						{checks.map((check, index) => {
							const ok = check.status === "ok" || check.status === "pass";
							return (
								<div className="flex items-start gap-2 rounded-md px-3 py-2 text-sm" key={check.id ?? index}>
									<span className={cn("mt-1.5 size-2 shrink-0 rounded-full", ok ? "bg-emerald-500" : "bg-amber-500")} />
									<span>{check.message ?? "检查完成"}</span>
								</div>
							);
						})}
					</div>
				) : (
					<Card>
						<CardContent className="py-6 text-center text-sm text-muted-foreground">等待诊断数据</CardContent>
					</Card>
				)}
			</SettingSection>
		</div>
	);
}
