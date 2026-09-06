import { ArrowRight, LockKeyhole, LoaderCircle, ShieldCheck } from "lucide-react";
import type { FormEvent } from "react";
import { useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../ui/card";
import { Input } from "../ui/input";

export function TokenGate({
	loading,
	error,
	onSubmit,
}: {
	loading: boolean;
	error?: string;
	onSubmit: (token: string) => Promise<void>;
}) {
	const [token, setToken] = useState("");
	const submit = async (event: FormEvent) => {
		event.preventDefault();
		if (!token.trim() || loading) return;
		await onSubmit(token);
	};

	return (
		<main className="grid min-h-dvh place-items-center bg-background p-6 text-foreground">
			<Card className="w-full max-w-md border-border/80 shadow-xl">
				<CardHeader className="gap-6">
					<div className="flex items-center gap-3">
						<img className="size-10 rounded-lg object-contain" src="/brand/lystar-mark.png" alt="LYStar" />
						<div>
							<CardTitle>LYStar Code</CardTitle>
							<CardDescription>浏览器工作台</CardDescription>
						</div>
					</div>
					<div>
						<Badge variant="secondary">私有控制台</Badge>
						<h1 className="mt-4 text-2xl font-semibold tracking-tight">连接你的本机 Agent</h1>
						<p className="mt-2 text-sm leading-6 text-muted-foreground">浏览器用于控制和查看运行状态。</p>
					</div>
				</CardHeader>
				<CardContent>
					<form className="grid gap-4" onSubmit={submit}>
						<div className="grid gap-2">
							<label className="text-sm font-medium" htmlFor="web-token">
								Web Token
							</label>
							<div className="relative">
								<LockKeyhole className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
								<Input
									id="web-token"
									type="password"
									className="pl-9 font-mono"
									value={token}
									onChange={(event) => setToken(event.target.value)}
									placeholder="输入 ~/.pi/agent/web/token"
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
						<Button className="w-full" type="submit" disabled={loading || !token.trim()}>
							{loading ? <LoaderCircle className="size-4 animate-spin" /> : <ArrowRight className="size-4" />}
							{loading ? "正在连接" : "进入工作台"}
						</Button>
						<p className="flex items-center gap-2 text-xs text-muted-foreground">
							<ShieldCheck className="size-4 text-emerald-600" />
							Token 只保存在当前浏览器
						</p>
					</form>
				</CardContent>
			</Card>
		</main>
	);
}
