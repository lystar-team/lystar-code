import { CheckCircle2, Download, LoaderCircle, RotateCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { webApi } from "../../adapters/host-protocol/api";
import type { ProductUpdateCheckResponse, ProductUpdateStatusResponse } from "../../types";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../ui/dialog";
import { Progress } from "../ui/progress";

const UPDATE_POLL_MS = 1_200;

function versionLabel(version: string | undefined): string {
	if (!version || version === "unknown") return "版本未知";
	return version.startsWith("v") ? version : `v${version}`;
}

export function ProductUpdateControl() {
	const [snapshot, setSnapshot] = useState<ProductUpdateStatusResponse>();
	const [check, setCheck] = useState<ProductUpdateCheckResponse>();
	const [checking, setChecking] = useState(true);
	const [dialogOpen, setDialogOpen] = useState(false);
	const [starting, setStarting] = useState(false);
	const [checkError, setCheckError] = useState<string>();
	const [updateError, setUpdateError] = useState<string>();
	const job = snapshot?.job;
	const currentVersion = snapshot?.currentVersion ?? check?.currentVersion;
	const targetVersion = job?.targetVersion ?? check?.latestVersion ?? undefined;
	const updateAvailable = check?.status === "available" && check.installEnabled && Boolean(check.latestVersion);
	const busy = starting || job?.status === "running";

	const load = useCallback(async () => {
		setChecking(true);
		try {
			const status = await webApi.productUpdateStatus();
			setSnapshot(status);
			if (status.job?.status === "running") {
				setDialogOpen(true);
				return;
			}
			const result = await webApi.checkProductUpdate();
			setCheck(result);
			setSnapshot({
				currentVersion: result.currentVersion,
				...(result.job?.status === "running" ? { job: result.job } : {}),
			});
		} catch {
			// 后台版本检查失败不打断工作台，保留已读取到的版本信息。
		} finally {
			setChecking(false);
		}
	}, []);

	useEffect(() => {
		void load();
	}, [load]);

	useEffect(() => {
		if (job?.status !== "running") return;
		let active = true;
		const poll = async () => {
			try {
				const result = await webApi.productUpdateStatus();
				if (!active) return;
				setSnapshot(result);
				if (result.job?.status === "failed") setUpdateError(result.job.message);
			} catch {
				// Gateway 更新期间会短暂离线，保留进度并继续等待新服务。
			}
		};
		const timer = window.setInterval(() => void poll(), UPDATE_POLL_MS);
		void poll();
		return () => {
			active = false;
			window.clearInterval(timer);
		};
	}, [job?.id, job?.status]);

	useEffect(() => {
		if (!dialogOpen || job?.status !== "completed") return;
		const timer = window.setTimeout(() => window.location.reload(), 1_200);
		return () => window.clearTimeout(timer);
	}, [dialogOpen, job?.status]);

	const checkNow = async () => {
		setChecking(true);
		setCheck(undefined);
		setCheckError(undefined);
		setUpdateError(undefined);
		try {
			const result = await webApi.checkProductUpdate();
			setCheck(result);
			setSnapshot({
				currentVersion: result.currentVersion,
				...(result.job?.status === "running" ? { job: result.job } : {}),
			});
			setDialogOpen(true);
		} catch (value) {
			setCheckError(value instanceof Error ? value.message : String(value));
			setDialogOpen(true);
		} finally {
			setChecking(false);
		}
	};

	const startUpdate = async () => {
		if (!check?.latestVersion || !updateAvailable) return;
		setStarting(true);
		setUpdateError(undefined);
		try {
			const result = await webApi.startProductUpdate(check.latestVersion);
			setSnapshot(result);
		} catch (value) {
			setUpdateError(value instanceof Error ? value.message : String(value));
		} finally {
			setStarting(false);
		}
	};

	const openConfirmation = () => {
		setCheckError(undefined);
		setUpdateError(undefined);
		setSnapshot((current) =>
			current?.job?.status === "running" ? current : current ? { currentVersion: current.currentVersion } : current,
		);
		setDialogOpen(true);
	};

	let dialogTitle = "更新 LYStar Code";
	let dialogDescription = `将 ${versionLabel(currentVersion)} 更新到 ${versionLabel(targetVersion)}。更新期间 Web 服务会重启，页面会自动恢复。`;
	if (job?.status === "completed") dialogTitle = "更新完成";
	else if (job?.status === "failed" || updateError) dialogTitle = "更新没有完成";
	else if (busy) dialogTitle = "正在更新 LYStar Code";
	else if (checkError) dialogTitle = "无法检查更新";
	else if (check?.status === "current") dialogTitle = "已是最新版本";
	else if (!updateAvailable) dialogTitle = "暂时无法检查更新";
	if (busy || job) dialogDescription = `${versionLabel(currentVersion)} → ${versionLabel(targetVersion)}`;
	else if (checkError) dialogDescription = checkError;
	else if (check?.status === "current") dialogDescription = `当前版本是 ${versionLabel(currentVersion)}，没有可用更新。`;
	else if (!updateAvailable)
		dialogDescription = check?.note ?? check?.installBlockedReason ?? "当前无法获取新版本信息，请稍后重试。";

	return (
		<>
			{updateAvailable ? (
				<Button
					className="h-8 min-w-0 max-w-[10rem] shrink px-2 text-[10px]"
					variant="outline"
					onClick={openConfirmation}
					title={`更新到 ${versionLabel(check.latestVersion ?? undefined)}`}
				>
					<Download className="size-3.5 shrink-0" aria-hidden="true" />
					<span className="truncate text-[10px]">更新 {versionLabel(check.latestVersion ?? undefined)}</span>
				</Button>
			) : (
				<Button
					className="h-8 min-w-0 max-w-[9rem] shrink px-2 text-[10px] text-muted-foreground"
					variant="ghost"
					onClick={() => void checkNow()}
					title="检查更新"
				>
					<RotateCw className={`size-3 shrink-0 ${checking ? "animate-spin" : ""}`} aria-hidden="true" />
					<span className="truncate text-[10px]">{versionLabel(currentVersion)}</span>
				</Button>
			)}

			<Dialog
				open={dialogOpen}
				onOpenChange={(open) => {
					if (!open && busy) return;
					setDialogOpen(open);
				}}
			>
				<DialogContent className="max-w-md" showCloseButton={!busy}>
					<DialogHeader>
						<DialogTitle>{dialogTitle}</DialogTitle>
						<DialogDescription>{dialogDescription}</DialogDescription>
					</DialogHeader>

					{busy || job || updateError ? (
						<div className="grid gap-3" role="status" aria-live="polite">
							<div className="flex items-center gap-3 rounded-lg border border-border/70 bg-muted/30 p-3">
								{job?.status === "completed" ? (
									<CheckCircle2 className="size-5 shrink-0 text-emerald-600" aria-hidden="true" />
								) : job?.status === "failed" || updateError ? (
									<RotateCw className="size-5 shrink-0 text-destructive" aria-hidden="true" />
								) : (
									<LoaderCircle className="size-5 shrink-0 animate-spin text-primary" aria-hidden="true" />
								)}
								<div className="min-w-0">
									<p className="text-sm font-medium">
										{updateError ?? job?.message ?? "正在启动更新"}
									</p>
									<p className="mt-1 text-xs text-muted-foreground">
										{job?.status === "completed" ? "页面即将刷新" : "请保持页面打开"}
									</p>
								</div>
							</div>
							<Progress
								value={starting ? 6 : (job?.progress ?? 0)}
								aria-label={`更新进度 ${starting ? 6 : (job?.progress ?? 0)}%`}
							/>
						</div>
					) : updateAvailable && check?.note ? (
						<div className="max-h-40 overflow-y-auto whitespace-pre-wrap rounded-lg border border-border/70 bg-muted/30 p-3 text-sm leading-6 text-muted-foreground">
							{check.note}
						</div>
					) : null}

					{!busy && job?.status !== "completed" ? (
						<DialogFooter>
							<Button variant="outline" onClick={() => setDialogOpen(false)}>
								{updateAvailable ? "取消" : "关闭"}
							</Button>
							{updateAvailable ? (
								<Button onClick={() => void startUpdate()} disabled={!check?.latestVersion}>
									{job?.status === "failed" || updateError ? (
										<RotateCw className="size-4" />
									) : (
										<Download className="size-4" />
									)}
									{job?.status === "failed" || updateError ? "重试更新" : "开始更新"}
								</Button>
							) : null}
						</DialogFooter>
					) : null}
				</DialogContent>
			</Dialog>
		</>
	);
}
