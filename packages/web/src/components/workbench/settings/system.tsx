import { Image, RotateCcw, Save, Upload } from "lucide-react";
import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import type { WorkbenchState } from "../../../state/use-workbench";
import { BrandLogo } from "../../brand-logo";
import { Alert, AlertDescription, AlertTitle } from "../../ui/alert";
import { Button } from "../../ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../ui/card";
import { Input } from "../../ui/input";
import { SettingSection } from "./shared";
import type { WorkbenchActions } from "../types";

const MAX_LOGO_BYTES = 1024 * 1024;
const LOGO_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export function SystemSettings({ state, actions }: { state: WorkbenchState; actions: WorkbenchActions }) {
	const [name, setName] = useState(state.branding.name);
	const [logo, setLogo] = useState(state.branding.logo);

	useEffect(() => {
		setName(state.branding.name);
		setLogo(state.branding.logo);
	}, [state.branding]);

	const dirty = name.trim() !== state.branding.name || logo !== state.branding.logo;
	const selectLogo = (file: File | undefined) => {
		if (!file) return;
		if (!LOGO_TYPES.has(file.type)) {
			actions.showToast("Logo 只支持 PNG、JPEG、GIF 或 WebP 图片");
			return;
		}
		if (file.size > MAX_LOGO_BYTES) {
			actions.showToast("Logo 图片不能超过 1 MB");
			return;
		}
		const reader = new FileReader();
		reader.addEventListener("load", () => {
			if (typeof reader.result === "string") setLogo(reader.result);
			else actions.showToast("Logo 图片读取失败");
		});
		reader.addEventListener("error", () => actions.showToast("Logo 图片读取失败"));
		reader.readAsDataURL(file);
	};
	const save = async (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		if (!name.trim() || state.brandingSaving) return;
		await actions.saveBranding({ name: name.trim(), logo: logo ?? null });
	};

	return (
		<div className="grid min-w-0 gap-5">
			<SettingSection title="品牌">
				<Card className="min-w-0 shadow-none">
					<CardHeader className="gap-2">
						<CardTitle className="text-base">系统名称和 Logo</CardTitle>
						<CardDescription>修改后会同步到登录页、加载页和工作台，并写入 ~/.pi/agent/lystar.json。</CardDescription>
					</CardHeader>
					<CardContent>
						<form className="grid min-w-0 gap-5" onSubmit={save}>
							<div className="grid gap-2">
								<label className="text-sm font-medium" htmlFor="system-name">
									系统名称
								</label>
								<Input
									id="system-name"
									value={name}
									maxLength={64}
									onChange={(event) => setName(event.target.value)}
									placeholder="例如：LYStar Code"
								/>
								<p className="text-xs leading-5 text-muted-foreground">最多 64 个字符。</p>
							</div>
							<div className="grid min-w-0 gap-3 rounded-xl border border-dashed border-border/80 p-4">
								<div className="flex min-w-0 items-center gap-3">
									<div className="grid size-16 shrink-0 place-items-center rounded-xl bg-muted/60 p-2">
										<BrandLogo logo={logo} className="size-full rounded-lg object-contain" alt="" />
									</div>
									<div className="min-w-0">
										<p className="flex items-center gap-2 text-sm font-medium">
											<Image className="size-4" />
											Logo
										</p>
										<p className="mt-1 text-xs leading-5 text-muted-foreground">
											支持 PNG、JPEG、GIF 和 WebP，单个文件不超过 1 MB。
										</p>
									</div>
								</div>
								<div className="flex flex-wrap gap-2">
									<Button type="button" variant="outline" asChild>
										<label htmlFor="system-logo" className="cursor-pointer">
											<Upload className="size-4" />
											选择图片
										</label>
									</Button>
									<input
										id="system-logo"
										type="file"
										accept="image/png,image/jpeg,image/gif,image/webp"
										className="sr-only"
										onChange={(event) => {
											selectLogo(event.target.files?.[0]);
											event.currentTarget.value = "";
										}}
									/>
									<Button type="button" variant="ghost" onClick={() => setLogo(undefined)} disabled={!logo}>
										<RotateCcw className="size-4" />
										恢复默认
									</Button>
								</div>
							</div>
							{state.brandingError ? (
								<Alert variant="destructive">
									<AlertTitle>系统设置保存失败</AlertTitle>
									<AlertDescription>{state.brandingError}</AlertDescription>
								</Alert>
							) : null}
							<div className="flex flex-wrap justify-end gap-2">
								<Button type="submit" disabled={!dirty || !name.trim() || state.brandingSaving}>
									<Save className="size-4" />
									{state.brandingSaving ? "保存中" : "保存系统设置"}
								</Button>
							</div>
						</form>
					</CardContent>
				</Card>
			</SettingSection>
		</div>
	);
}
