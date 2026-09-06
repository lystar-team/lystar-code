import { LoaderCircle, RefreshCw, Save } from "lucide-react";
import { useEffect, useState } from "react";
import type { WorkbenchState } from "../../../state/use-workbench";
import { Alert, AlertDescription, AlertTitle } from "../../ui/alert";
import { Badge } from "../../ui/badge";
import { Button } from "../../ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../ui/card";
import { Textarea } from "../../ui/textarea";
import { SettingSection } from "./shared";
import type { WorkbenchActions } from "../types";

export function GlobalInstructionsSettings({ state, actions }: { state: WorkbenchState; actions: WorkbenchActions }) {
	const file = state.hostInstructions.find((candidate) => candidate.fileName === "AGENTS.md");
	const [content, setContent] = useState("");

	useEffect(() => {
		setContent(file?.content ?? "");
	}, [state.hostInstructions]);

	const dirty = content !== (file?.content ?? "");
	const save = () => void actions.saveHostInstruction(content, file?.contentHash);

	return (
		<div className="grid gap-6">
			<SettingSection title="全局提示词">
				<Card className="shadow-none">
					<CardHeader className="gap-2">
						<div className="flex items-center justify-between gap-3">
							<div className="min-w-0">
								<CardTitle className="text-base">AGENTS.md</CardTitle>
								<CardDescription>为所有项目的任务提供说明和上下文。</CardDescription>
							</div>
							<Badge variant={file?.active ? "secondary" : "outline"}>{file?.active ? "生效中" : "未创建"}</Badge>
						</div>
					</CardHeader>
					<CardContent className="grid gap-3">
						{state.hostInstructionsLoading ? (
							<div className="flex min-h-72 items-center justify-center gap-2 text-sm text-muted-foreground" role="status">
								<LoaderCircle className="size-4 animate-spin" />正在读取 AGENTS.md
							</div>
						) : (
							<Textarea
								aria-label="全局 AGENTS.md 内容"
								className="min-h-72 resize-y font-mono text-sm leading-6"
								value={content}
								disabled={state.hostInstructionSaving}
								spellCheck={false}
								onChange={(event) => setContent(event.target.value)}
								placeholder="添加全局说明…"
							/>
						)}
						{state.hostInstructionsError ? (
							<Alert variant="destructive">
								<AlertTitle>操作失败</AlertTitle>
								<AlertDescription>{state.hostInstructionsError}</AlertDescription>
							</Alert>
						) : null}
						<div className="flex flex-wrap items-center justify-end gap-2">
							<Button variant="outline" onClick={() => void actions.refreshHostInstructions()} disabled={state.hostInstructionsLoading || state.hostInstructionSaving}>
								<RefreshCw className="size-4" />重新加载
							</Button>
							<Button onClick={save} disabled={!dirty || state.hostInstructionsLoading || state.hostInstructionSaving}>
								{state.hostInstructionSaving ? <LoaderCircle className="size-4 animate-spin" /> : <Save className="size-4" />}
								{state.hostInstructionSaving ? "正在保存" : file?.exists ? "保存" : "创建"}
							</Button>
						</div>
					</CardContent>
				</Card>
			</SettingSection>
		</div>
	);
}
