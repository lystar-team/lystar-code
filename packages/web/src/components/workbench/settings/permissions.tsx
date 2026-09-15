import { CheckCircle2, CircleAlert, LoaderCircle, RefreshCw, Settings, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { webApi } from "../../../adapters/host-protocol/api";
import type { SystemPermissionStatus, SystemPermissionsResponse } from "../../../types";
import { Alert, AlertDescription, AlertTitle } from "../../ui/alert";
import { Badge } from "../../ui/badge";
import { Button } from "../../ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../ui/card";
import { SettingSection } from "./shared";

function badgeVariant(state: SystemPermissionStatus["state"]): "default" | "secondary" | "outline" | "destructive" {
	if (state === "granted") return "secondary";
	if (state === "required") return "destructive";
	return "outline";
}

function stateLabel(state: SystemPermissionStatus["state"]): string {
	if (state === "granted") return "已授权";
	if (state === "required") return "需要授权";
	if (state === "unsupported") return "不支持";
	return "无法检测";
}

export function SystemPermissionsSettings() {
	const [status, setStatus] = useState<SystemPermissionsResponse>();
	const [loading, setLoading] = useState(true);
	const [requesting, setRequesting] = useState<SystemPermissionStatus["id"]>();
	const [error, setError] = useState<string>();

	const refresh = useCallback(async () => {
		setLoading(true);
		setError(undefined);
		try {
			setStatus(await webApi.systemPermissions());
		} catch (value) {
			setError(value instanceof Error ? value.message : String(value));
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	const request = async (permission: "keychain" | "accessibility" | "automation" | "screen-recording") => {
		setRequesting(permission);
		setError(undefined);
		try {
			setStatus(await webApi.requestSystemPermission(permission));
		} catch (value) {
			setError(value instanceof Error ? value.message : String(value));
		} finally {
			setRequesting(undefined);
		}
	};

	if (!loading && status && !status.supported) return null;

	return (
		<div className="grid min-w-0 gap-6">
			<SettingSection title="macOS 系统授权">
				<Card className="min-w-0 shadow-none">
					<CardHeader className="gap-2">
						<CardTitle className="text-base">Web 后台权限</CardTitle>
						<CardDescription>
							完成一次授权后，后台任务会使用静默管理员通道；缺少权限时任务会直接报错，不再等待系统弹窗。
						</CardDescription>
					</CardHeader>
					<CardContent className="grid gap-4">
						{loading && !status ? (
							<div className="flex min-h-28 items-center justify-center gap-2 text-sm text-muted-foreground" role="status">
								<LoaderCircle className="size-4 animate-spin" />正在读取系统授权
							</div>
						) : (
							status?.permissions.map((permission) => {
								const granted = permission.state === "granted";
								return (
									<div
										className="flex flex-col gap-3 rounded-xl border border-border/70 p-4 sm:flex-row sm:items-center sm:justify-between"
										key={permission.id}
									>
										<div className="flex min-w-0 items-start gap-3">
											{granted ? (
												<CheckCircle2 className="mt-0.5 size-5 shrink-0 text-emerald-600" aria-hidden="true" />
											) : permission.state === "required" ? (
												<CircleAlert className="mt-0.5 size-5 shrink-0 text-amber-600" aria-hidden="true" />
											) : (
												<Settings className="mt-0.5 size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
											)}
											<div className="min-w-0">
												<div className="flex flex-wrap items-center gap-2">
													<p className="text-sm font-medium">{permission.name}</p>
													<Badge variant={badgeVariant(permission.state)}>{stateLabel(permission.state)}</Badge>
												</div>
												<p className="mt-1 text-sm leading-6 text-muted-foreground">{permission.message}</p>
												{permission.id === "administrator" && !granted ? (
													<code className="mt-2 block w-fit rounded bg-muted px-2 py-1 text-xs">lc web service install</code>
												) : null}
											</div>
										</div>
						{permission.canRequest ? (
							<Button
								variant="outline"
								disabled={Boolean(requesting)}
								onClick={() =>
									void request(permission.id as "keychain" | "accessibility" | "automation" | "screen-recording")
								}
							>
								{requesting === permission.id ? <LoaderCircle className="size-4 animate-spin" /> : <ShieldCheck className="size-4" />}
								{granted ? "重新授权" : "开始授权"}
							</Button>
						) : null}
									</div>
								);
							})
						)}

						{error ? (
							<Alert variant="destructive">
								<AlertTitle>系统授权操作失败</AlertTitle>
								<AlertDescription>{error}</AlertDescription>
							</Alert>
						) : null}

						<div className="flex justify-end">
							<Button variant="outline" disabled={loading || Boolean(requesting)} onClick={() => void refresh()}>
								<RefreshCw className={`size-4 ${loading ? "animate-spin" : ""}`} />重新检测
							</Button>
						</div>
					</CardContent>
				</Card>
			</SettingSection>
		</div>
	);
}
