import { LoaderCircle, RefreshCw, Save } from "lucide-react";
import { useEffect, useState } from "react";
import type { WorkbenchState } from "../../../state/use-workbench";
import { Alert, AlertDescription, AlertTitle } from "../../ui/alert";
import { Button } from "../../ui/button";
import { MonacoMarkdownEditor } from "./monaco-markdown-editor";
import type { WorkbenchActions } from "../types";

export function GlobalInstructionsSettings({ state, actions }: { state: WorkbenchState; actions: WorkbenchActions }) {
	const file = state.hostInstructions.find((candidate) => candidate.fileName === "AGENTS.md");
	const [content, setContent] = useState("");

	useEffect(() => {
		setContent(file?.content ?? "");
	}, [state.hostInstructions]);

	const dirty = content !== (file?.content ?? "");
	const save = () => {
		if (!dirty || state.hostInstructionsLoading || state.hostInstructionSaving) return;
		void actions.saveHostInstruction(content, file?.contentHash);
	};

	return (
		<div className="grid min-w-0 gap-3">
			{state.hostInstructionsLoading ? (
				<div className="flex h-[clamp(320px,calc(100dvh-23rem),680px)] items-center justify-center gap-2 rounded-lg border border-border/70 text-sm text-muted-foreground md:h-[clamp(360px,calc(100dvh-19rem),800px)]" role="status">
					<LoaderCircle className="size-4 animate-spin" />正在读取 AGENTS.md
				</div>
			) : (
				<MonacoMarkdownEditor
					disabled={state.hostInstructionSaving}
					onChange={setContent}
					onSave={save}
					theme={state.theme}
					value={content}
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
		</div>
	);
}
