import type * as Monaco from "monaco-editor/editor/editor.api.js";
import { GitCompare, LoaderCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { monacoLanguageForPath } from "./file-language";
import { ensureMonacoLanguage, loadMonacoRuntime, setMonacoTheme } from "./monaco-runtime";
import { CodeBlockView } from "./transcript";
import type { WorkbenchState } from "../../state/use-workbench";
import { Badge } from "../ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../ui/dialog";
import type { WorkbenchActions } from "./types";

let sharedDiffEditor: Monaco.editor.IStandaloneDiffEditor | undefined;
let sharedOriginalModel: Monaco.editor.ITextModel | undefined;
let sharedModifiedModel: Monaco.editor.ITextModel | undefined;
let modelSequence = 0;

function disposeSharedDiffEditor(): void {
	sharedDiffEditor?.setModel(null);
	sharedDiffEditor?.dispose();
	sharedOriginalModel?.dispose();
	sharedModifiedModel?.dispose();
	sharedDiffEditor = undefined;
	sharedOriginalModel = undefined;
	sharedModifiedModel = undefined;
}

function MonacoDiffViewer({
	path,
	original,
	modified,
	dark,
}: {
	path: string;
	original: string;
	modified: string;
	dark: boolean;
}) {
	const containerRef = useRef<HTMLDivElement>(null);
	const [diffReady, setDiffReady] = useState(false);
	const [languageReady, setLanguageReady] = useState(false);

	useEffect(() => {
		const container = containerRef.current;
		if (!container) return;
		let disposed = false;
		setDiffReady(false);
		setLanguageReady(false);
		disposeSharedDiffEditor();
		const language = monacoLanguageForPath(path);
		const modelId = ++modelSequence;

		void (async () => {
			const monaco = await loadMonacoRuntime();
			const resolvedLanguage = await ensureMonacoLanguage(monaco, language);
			if (disposed) return;
			const originalModel = monaco.editor.createModel(
				original,
				resolvedLanguage,
				monaco.Uri.parse(`inmemory://lystar-git-diff/${modelId}/original/${encodeURIComponent(path)}`),
			);
			const modifiedModel = monaco.editor.createModel(
				modified,
				resolvedLanguage,
				monaco.Uri.parse(`inmemory://lystar-git-diff/${modelId}/modified/${encodeURIComponent(path)}`),
			);
			const editor = monaco.editor.createDiffEditor(container, {
				automaticLayout: true,
				diffAlgorithm: "legacy",
				enableSplitViewResizing: true,
				fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
				fontSize: 13,
				ignoreTrimWhitespace: false,
				maxComputationTime: 2000,
				minimap: { enabled: false },
				originalEditable: false,
				renderGutterMenu: false,
				renderIndicators: true,
				renderMarginRevertIcon: false,
				renderOverviewRuler: true,
				renderSideBySide: true,
				scrollBeyondLastLine: false,
				useInlineViewWhenSpaceIsLimited: false,
				wordWrap: "off",
			});
			const diffListener = editor.onDidUpdateDiff(() => {
				if (!disposed) setDiffReady(true);
			});
			editor.setModel({ original: originalModel, modified: modifiedModel });
			setMonacoTheme(monaco, dark);
			setLanguageReady(true);
			sharedDiffEditor = editor;
			sharedOriginalModel = originalModel;
			sharedModifiedModel = modifiedModel;

			if (disposed) {
				diffListener.dispose();
				editor.setModel(null);
				editor.dispose();
				originalModel.dispose();
				modifiedModel.dispose();
			}
		})();

		return () => {
			disposed = true;
			disposeSharedDiffEditor();
		};
	}, [dark, modified, original, path]);


	return (
		<div className="relative h-full min-h-0 w-full overflow-hidden rounded-lg border border-border/60">
			<div ref={containerRef} className={`h-full min-h-0 w-full overflow-hidden ${diffReady && languageReady ? "opacity-100" : "opacity-0"}`} />
			{!(diffReady && languageReady) ? (
				<div className="absolute inset-0 flex items-center justify-center gap-2 text-sm text-muted-foreground">
					<LoaderCircle className="size-4 animate-spin" />
					{languageReady ? "正在计算文件差异" : "正在加载代码高亮"}
				</div>
			) : null}
		</div>
	);
}

export function GitDiffDialog({ state, actions }: { state: WorkbenchState; actions: WorkbenchActions }) {
	const diff = state.gitDiff;
	const open = state.gitDiffLoading || Boolean(diff);
	const dark =
		state.theme === "dark" ||
		(state.theme === "system" && typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches);
	const hasEditorContent = Boolean(diff && diff.original !== undefined && diff.modified !== undefined && !diff.contentTruncated);

	return (
		<Dialog
			open={open}
			onOpenChange={(nextOpen) => {
				if (!nextOpen) actions.closeGitDiff();
			}}
		>
			<DialogContent className="flex h-[min(88vh,900px)] w-[min(96vw,1400px)] max-w-none flex-col gap-0 overflow-hidden p-0 sm:max-w-[min(96vw,1400px)]">
				<DialogHeader className="shrink-0 border-b border-border/60 px-5 py-4 text-left">
					<DialogTitle className="flex min-w-0 items-center gap-2 pr-8 text-sm">
						<GitCompare className="size-4 shrink-0 text-muted-foreground" />
						<span className="min-w-0 truncate font-mono">
							{diff?.repositoryPath ? `${diff.repositoryPath}/` : ""}
							{diff?.path || "工作区差异"}
						</span>
						{diff ? (
							<Badge variant="outline">
								{diff.revision ? `提交 ${diff.revision.slice(0, 7)}` : diff.staged ? "暂存区" : "工作区"}
							</Badge>
						) : null}
					</DialogTitle>
					<DialogDescription>
						{state.gitDiffLoading
							? "正在读取文件差异…"
							: diff?.contentTruncated
								? "文件过大或不是文本文件，已切换为受限 Diff 文本展示。"
								: diff
									? `新增 ${diff.additions} 行，删除 ${diff.deletions} 行`
									: "文件差异"}
					</DialogDescription>
				</DialogHeader>
				<div className="min-h-0 flex-1 overflow-hidden bg-muted/20 p-3 sm:p-4">
					{state.gitDiffLoading ? (
						<div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
							<LoaderCircle className="size-4 animate-spin" />
							正在读取文件差异
						</div>
					) : diff && hasEditorContent ? (
						<MonacoDiffViewer
							path={diff.path ?? "workspace.diff"}
							original={diff.original ?? ""}
							modified={diff.modified ?? ""}
							dark={dark}
						/>
					) : diff ? (
						<div className="h-full overflow-auto rounded-lg border border-border/60 bg-background p-3 sm:p-4">
							<CodeBlockView code={diff.diff || "没有差异"} language="diff" embedded wrap />
						</div>
					) : null}
				</div>
			</DialogContent>
		</Dialog>
	);
}
