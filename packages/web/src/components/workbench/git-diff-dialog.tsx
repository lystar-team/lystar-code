import * as monaco from "monaco-editor/editor/editor.api.js";
import editorWorker from "monaco-editor/editor/editor.worker.js?worker";
import cssWorker from "monaco-editor/language/css/css.worker.js?worker";
import htmlWorker from "monaco-editor/language/html/html.worker.js?worker";
import jsonWorker from "monaco-editor/language/json/json.worker.js?worker";
import tsWorker from "monaco-editor/language/typescript/ts.worker.js?worker";
import "monaco-editor/language/css/monaco.contribution.js";
import "monaco-editor/language/html/monaco.contribution.js";
import "monaco-editor/language/json/monaco.contribution.js";
import "monaco-editor/language/typescript/monaco.contribution.js";
import { GitCompare, LoaderCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { languageForPath } from "./file-preview-dialog";
import { CodeBlockView } from "./transcript";
import type { WorkbenchState } from "../../state/use-workbench";
import { Badge } from "../ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../ui/dialog";
import type { WorkbenchActions } from "./types";

interface MonacoEnvironment {
	getWorker: (moduleId: string, label: string) => Worker;
}

const globalScope = globalThis as typeof globalThis & { MonacoEnvironment?: MonacoEnvironment };
globalScope.MonacoEnvironment = {
	getWorker(_moduleId, label) {
		switch (label) {
			case "json":
				return new jsonWorker();
			case "css":
			case "scss":
			case "less":
				return new cssWorker();
			case "html":
			case "handlebars":
			case "razor":
				return new htmlWorker();
			case "typescript":
			case "javascript":
				return new tsWorker();
			default:
				return new editorWorker();
		}
	},
};

let sharedDiffEditor: monaco.editor.IStandaloneDiffEditor | undefined;
let sharedOriginalModel: monaco.editor.ITextModel | undefined;
let sharedModifiedModel: monaco.editor.ITextModel | undefined;
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

	useEffect(() => {
		const container = containerRef.current;
		if (!container) return;
		let disposed = false;
		setDiffReady(false);
		disposeSharedDiffEditor();
		const language = languageForPath(path);
		const modelId = ++modelSequence;
		const originalModel = monaco.editor.createModel(
			original,
			language,
			monaco.Uri.parse(`inmemory://lystar-git-diff/${modelId}/original/${encodeURIComponent(path)}`),
		);
		const modifiedModel = monaco.editor.createModel(
			modified,
			language,
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
		monaco.editor.setTheme(dark ? "vs-dark" : "vs");
		sharedDiffEditor = editor;
		sharedOriginalModel = originalModel;
		sharedModifiedModel = modifiedModel;

		return () => {
			disposed = true;
			diffListener.dispose();
			if (sharedDiffEditor === editor) disposeSharedDiffEditor();
			else {
				editor.setModel(null);
				editor.dispose();
				originalModel.dispose();
				modifiedModel.dispose();
			}
		};
	}, [modified, original, path]);

	useEffect(() => {
		monaco.editor.setTheme(dark ? "vs-dark" : "vs");
	}, [dark]);

	return (
		<div className="relative h-full min-h-0 w-full overflow-hidden rounded-lg border border-border/60">
			<div ref={containerRef} className={`h-full min-h-0 w-full overflow-hidden ${diffReady ? "opacity-100" : "opacity-0"}`} />
			{!diffReady ? (
				<div className="absolute inset-0 flex items-center justify-center gap-2 text-sm text-muted-foreground">
					<LoaderCircle className="size-4 animate-spin" />
					正在计算文件差异
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
						<span className="min-w-0 truncate font-mono">{diff?.path || "工作区差异"}</span>
						{diff ? <Badge variant="outline">{diff.staged ? "暂存区" : "工作区"}</Badge> : null}
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
