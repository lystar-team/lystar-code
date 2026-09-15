import { ArrowRight, LockKeyhole, LoaderCircle } from "lucide-react";
import type { ProductBranding } from "../../types";
import type { FormEvent } from "react";
import { useState } from "react";
import { BrandLogo } from "../brand-logo";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../ui/card";
import { Input } from "../ui/input";

export function TokenGate({
	branding,
	loading,
	error,
	onSubmit,
}: {
	branding: ProductBranding;
	loading: boolean;
	error?: string;
	onSubmit: (password: string) => Promise<void>;
}) {
	const [password, setPassword] = useState("");
	const submit = async (event: FormEvent) => {
		event.preventDefault();
		if (!password.trim() || loading) return;
		await onSubmit(password);
	};

	return (
		<main className="grid min-h-dvh place-items-center bg-background p-6 text-foreground">
			<Card className="w-full max-w-md border-border/80 shadow-xl">
				<CardHeader className="gap-6">
					<div className="flex items-center gap-3">
						<BrandLogo logo={branding.logo} className="size-10 rounded-lg object-contain" alt={branding.name} />
						<div>
							<CardTitle>{branding.name}</CardTitle>
							<CardDescription>浏览器工作台</CardDescription>
						</div>
					</div>
					<div>
						<h1 className="text-2xl font-semibold tracking-tight">随时连接，随地开工</h1>
						<p className="mt-2 text-sm leading-6 text-muted-foreground">浏览器用于控制和查看运行状态。</p>
					</div>
				</CardHeader>
				<CardContent>
					<form className="grid gap-4" onSubmit={submit}>
						<div className="grid gap-2">
							<label className="text-sm font-medium" htmlFor="web-password">
								密码
							</label>
							<div className="relative">
								<LockKeyhole className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
								<Input
									id="web-password"
									type="password"
									className="pl-9 font-mono"
									value={password}
									onChange={(event) => setPassword(event.target.value)}
									placeholder="输入 ~/.pi/agent/web-config.json 中的连接密码"
									autoComplete="off"
								/>
							</div>
						</div>
						{error ? (
							<Alert variant="destructive">
								<AlertTitle>连接失败</AlertTitle>
								<AlertDescription>{error}</AlertDescription>
							</Alert>
						) : null}
						<Button className="w-full" type="submit" disabled={loading || !password.trim()}>
							{loading ? <LoaderCircle className="size-4 animate-spin" /> : <ArrowRight className="size-4" />}
							{loading ? "正在连接" : "进入工作台"}
						</Button>
					</form>
				</CardContent>
			</Card>
		</main>
	);
}
