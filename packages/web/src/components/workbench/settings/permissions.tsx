import { CheckCircle2, CircleAlert, LoaderCircle, RefreshCw, Settings, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { webApi } from "../../../adapters/host-protocol/api";
import type { SystemPermissionStatus, SystemPermissionsResponse } from "../../../types";
import { Alert, AlertDescription, AlertTitle } from "../../ui/alert";
import { Badge } from "../../ui/badge";
import { Button } from "../../ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../ui/dialog";
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
	const [keychainGuideOpen, setKeychainGuideOpen] = useState(false);
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
		if (permission === "keychain") {
			setKeychainGuideOpen(true);
			return;
		}
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
							后台不会打开或等待密码窗口。Git 钥匙串授权在 Mac 本机终端集中完成；缺少授权时任务会立即停止并提示。
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
												) : permission.id === "keychain" ? (
													<code className="mt-2 block w-fit rounded bg-muted px-2 py-1 text-xs">lc web permissions setup</code>
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
								{permission.id === "keychain"
									? "查看授权方法"
									: granted
										? "重新授权"
										: "开始授权"}
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
			<Dialog open={keychainGuideOpen} onOpenChange={setKeychainGuideOpen}>
				<DialogContent className="max-w-lg">
					<DialogHeader>
						<DialogTitle>Git 钥匙串需要在 Mac 本机授权</DialogTitle>
						<DialogDescription>
							Web 不会在后台触发登录密码窗口。请到运行 LYStar Code Web 的 Mac 本机终端完成授权。
						</DialogDescription>
					</DialogHeader>
					<div className="grid gap-3 text-sm leading-6 text-muted-foreground">
						<p>执行下面的命令。终端会隐藏输入一次当前 macOS 登录钥匙串密码，并批量授权已登记的 Git HTTPS 凭据。</p>
						<code className="w-fit rounded bg-muted px-2 py-1 text-xs text-foreground">lc web permissions setup</code>
						<p>完成后回到这里点击“重新检测”，再重试 Git 操作。</p>
					</div>
					<DialogFooter>
						<Button variant="outline" onClick={() => setKeychainGuideOpen(false)}>
							关闭
						</Button>
						<Button
							onClick={() => {
								setKeychainGuideOpen(false);
								void refresh();
							}}
						>
							重新检测
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</div>
	);
}
