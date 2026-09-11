import { LoaderCircle, RefreshCw, Save, ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";
import type { WorkbenchState } from "../../../state/use-workbench";
import { Alert, AlertDescription, AlertTitle } from "../../ui/alert";
import { Badge } from "../../ui/badge";
import { Button } from "../../ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../ui/card";
import { Input } from "../../ui/input";
import { SettingSection } from "./shared";
import type { WorkbenchActions } from "../types";

export function SecuritySettings({ state, actions }: { state: WorkbenchState; actions: WorkbenchActions }) {
	const settings = state.securitySettings;
	const [host, setHost] = useState("");
	const [allowedHosts, setAllowedHosts] = useState("");
	const [port, setPort] = useState("");
	const [runtimePort, setRuntimePort] = useState("");
	const [password, setPassword] = useState("");

	useEffect(() => {
		if (!settings) return;
		setHost(settings.host);
		setAllowedHosts(settings.allowedHosts.join(","));
		setPort(String(settings.port));
		setRuntimePort(String(settings.runtimePort));
		setPassword("");
	}, [settings]);

	const portNumber = Number(port);
	const runtimePortNumber = Number(runtimePort);
	const portValid = Number.isInteger(portNumber) && portNumber >= 1 && portNumber <= 65535;
	const runtimePortValid = Number.isInteger(runtimePortNumber) && runtimePortNumber >= 1 && runtimePortNumber <= 65535;
	const allowedHostValues = allowedHosts
		.split(",")
		.map((value) => value.trim())
		.filter(Boolean);
	const allowedHostsValid = allowedHostValues.length > 0;
	const passwordValid = !password || password.trim().length >= 8;
	const dirty = Boolean(
		settings &&
		(host !== settings.host ||
			allowedHosts !== settings.allowedHosts.join(",") ||
			port !== String(settings.port) ||
			runtimePort !== String(settings.runtimePort) ||
			password.trim()),
	);
	const canSave = Boolean(
		settings &&
		(host.trim() || !settings.editable.host) &&
		(allowedHostsValid || !settings.editable.allowedHosts) &&
		(port || !settings.editable.port) &&
		(runtimePort || !settings.editable.runtimePort) &&
		portValid &&
		runtimePortValid &&
		passwordValid &&
		(!settings.editable.host || host.trim() !== "") &&
		(!settings.editable.port || portNumber > 0) &&
		(!settings.editable.runtimePort || runtimePortNumber > 0) &&
		dirty,
	);

	const save = () => {
		if (!settings || !canSave) return;
		void actions.saveSecuritySettings({
			host: settings.editable.host ? host.trim() : settings.host,
			allowedHosts: settings.editable.allowedHosts ? allowedHostValues : settings.allowedHosts,
			port: settings.editable.port ? portNumber : settings.port,
			runtimePort: settings.editable.runtimePort ? runtimePortNumber : settings.runtimePort,
			...(password.trim() ? { password: password.trim() } : {}),
		});
	};

	return (
		<div className="grid min-w-0 gap-6">
			<SettingSection title="网络访问">
				<Card className="min-w-0 shadow-none">
					<CardHeader className="gap-2">
						<div className="flex flex-wrap items-start justify-between gap-3">
							<div className="min-w-0">
								<CardTitle className="text-base">Gateway 访问配置</CardTitle>
								<CardDescription>
									保存到 web-config.json 后按新配置重启 Gateway，Web Runtime 与运行中的会话保持运行。
								</CardDescription>
							</div>
							<Badge variant={settings?.passwordConfigured ? "secondary" : "outline"}>
								{settings?.passwordConfigured ? "密码已设置" : "未设置密码"}
							</Badge>
						</div>
					</CardHeader>
					<CardContent className="grid gap-5">
						{state.securitySettingsLoading && !settings ? (
							<div className="flex min-h-28 items-center justify-center gap-2 text-sm text-muted-foreground" role="status">
								<LoaderCircle className="size-4 animate-spin" />正在读取访问配置
							</div>
						) : (
							<>
								<div className="grid gap-4 sm:grid-cols-2">
									<div className="grid gap-2">
										<div className="flex items-center justify-between gap-2">
											<label className="text-sm font-medium" htmlFor="gateway-host">
												监听 IP
											</label>
											{settings && !settings.editable.host ? <span className="text-xs text-muted-foreground">启动参数管理</span> : null}
										</div>
										<Input
											id="gateway-host"
											value={host}
											onChange={(event) => setHost(event.target.value)}
											placeholder="例如 0.0.0.0"
											disabled={!settings?.editable.host || state.securitySettingsSaving}
											autoComplete="off"
										/>
										<p className="text-xs leading-5 text-muted-foreground">填写 Gateway 监听的 IPv4 或 IPv6 地址。</p>
									</div>
									<div className="grid gap-2">
										<div className="flex items-center justify-between gap-2">
											<label className="text-sm font-medium" htmlFor="gateway-allowed-hosts">
												白名单 IP
											</label>
											{settings && !settings.editable.allowedHosts ? <span className="text-xs text-muted-foreground">启动参数管理</span> : null}
										</div>
										<Input
											id="gateway-allowed-hosts"
											value={allowedHosts}
											onChange={(event) => setAllowedHosts(event.target.value)}
											placeholder="* 或 127.0.0.1,192.168.1.20"
											aria-invalid={Boolean(allowedHosts) && !allowedHostsValid}
											disabled={!settings?.editable.allowedHosts || state.securitySettingsSaving}
											autoComplete="off"
										/>
										<p className="text-xs leading-5 text-muted-foreground">填入 * 表示不限制来源，多个地址使用英文逗号分隔。</p>
									</div>
								</div>

								<div className="grid gap-4 sm:grid-cols-2">
									<div className="grid gap-2">
										<div className="flex items-center justify-between gap-2">
											<label className="text-sm font-medium" htmlFor="gateway-port">
												Web 监听端口
											</label>
											{settings && !settings.editable.port ? <span className="text-xs text-muted-foreground">启动参数管理</span> : null}
										</div>
										<Input
											id="gateway-port"
											type="number"
											inputMode="numeric"
											min={1}
											max={65535}
											value={port}
											onChange={(event) => setPort(event.target.value)}
											aria-invalid={Boolean(port) && !portValid}
											disabled={!settings?.editable.port || state.securitySettingsSaving}
										/>
										<p className="text-xs leading-5 text-muted-foreground">浏览器访问 Web UI 使用此端口，范围为 1 到 65535。</p>
									</div>
									<div className="grid gap-2">
										<div className="flex items-center justify-between gap-2">
											<label className="text-sm font-medium" htmlFor="runtime-port">
												Runtime 端口
											</label>
											{settings && !settings.editable.runtimePort ? <span className="text-xs text-muted-foreground">启动参数管理</span> : null}
										</div>
										<Input
											id="runtime-port"
											type="number"
											inputMode="numeric"
											min={1}
											max={65535}
											value={runtimePort}
											onChange={(event) => setRuntimePort(event.target.value)}
											aria-invalid={Boolean(runtimePort) && !runtimePortValid}
											disabled={!settings?.editable.runtimePort || state.securitySettingsSaving}
										/>
										<p className="text-xs leading-5 text-muted-foreground">Gateway 连接的本机 Runtime 端口，范围为 1 到 65535。</p>
									</div>
								</div>

								<div className="grid gap-2">
									<div className="flex items-center justify-between gap-2">
										<label className="text-sm font-medium" htmlFor="gateway-password">
											访问密码
										</label>
										{settings && !settings.editable.password ? <span className="text-xs text-muted-foreground">启动参数管理</span> : null}
									</div>
									<Input
										id="gateway-password"
										type="password"
										value={password}
										onChange={(event) => setPassword(event.target.value)}
										aria-invalid={Boolean(password) && !passwordValid}
										placeholder="留空表示保持当前密码"
										disabled={!settings?.editable.password || state.securitySettingsSaving}
										autoComplete="new-password"
									/>
									<p className="text-xs leading-5 text-muted-foreground">密码也是进入 Web 工作台时输入的 Web 密码，至少 8 个字符。</p>
								</div>

								<Alert>
									<ShieldCheck className="size-4" />
									<AlertTitle>Runtime 不会停止</AlertTitle>
									<AlertDescription>
										保存会让当前 Web 连接短暂断开。同一地址会按新配置重连；Web 或 Runtime 端口变化后，请使用新地址或新配置打开页面。正在执行的会话由独立 Runtime 继续运行。
									</AlertDescription>
								</Alert>
							</>
						)}

						{state.securitySettingsError ? (
							<Alert variant="destructive">
								<AlertTitle>访问配置读取或保存失败</AlertTitle>
								<AlertDescription>{state.securitySettingsError}</AlertDescription>
							</Alert>
						) : null}

						<div className="flex flex-wrap items-center justify-end gap-2">
							<Button
								variant="outline"
								onClick={() => void actions.refreshSecuritySettings()}
								disabled={state.securitySettingsLoading || state.securitySettingsSaving}
							>
								<RefreshCw className="size-4" />重新加载
							</Button>
							<Button
								onClick={save}
								disabled={!canSave || state.securitySettingsLoading || state.securitySettingsSaving}
							>
								{state.securitySettingsSaving ? <LoaderCircle className="size-4 animate-spin" /> : <Save className="size-4" />}
								{state.securitySettingsSaving ? "正在保存" : "保存设置"}
							</Button>
						</div>
					</CardContent>
				</Card>
			</SettingSection>
		</div>
	);
}
