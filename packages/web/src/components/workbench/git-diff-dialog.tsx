import type * as Monaco from "monaco-editor/editor/editor.api.js";
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

async function loadMonacoRuntime() {
	const [monaco, editorWorkerModule] = await Promise.all([
		import("monaco-editor/editor/editor.api.js"),
		import("monaco-editor/editor/editor.worker.js?worker"),
	]);
	globalScope.MonacoEnvironment = {
		getWorker() {
			return new editorWorkerModule.default();
		},
	};
	return monaco;
}

const lazyLanguageLoaders: Record<string, () => Promise<unknown>> = {
	bat: () => import("monaco-editor/languages/definitions/bat/register.js"),
	c: () => import("monaco-editor/languages/definitions/cpp/register.js"),
	cpp: () => import("monaco-editor/languages/definitions/cpp/register.js"),
	csharp: () => import("monaco-editor/languages/definitions/csharp/register.js"),
	css: () => import("monaco-editor/languages/definitions/css/register.js"),
	dart: () => import("monaco-editor/languages/definitions/dart/register.js"),
	dockerfile: () => import("monaco-editor/languages/definitions/dockerfile/register.js"),
	go: () => import("monaco-editor/languages/definitions/go/register.js"),
	graphql: () => import("monaco-editor/languages/definitions/graphql/register.js"),
	hcl: () => import("monaco-editor/languages/definitions/hcl/register.js"),
	html: () => import("monaco-editor/languages/definitions/html/register.js"),
	ini: () => import("monaco-editor/languages/definitions/ini/register.js"),
	java: () => import("monaco-editor/languages/definitions/java/register.js"),
	javascript: () => import("monaco-editor/languages/definitions/javascript/register.js"),
	julia: () => import("monaco-editor/languages/definitions/julia/register.js"),
	kotlin: () => import("monaco-editor/languages/definitions/kotlin/register.js"),
	less: () => import("monaco-editor/languages/definitions/less/register.js"),
	markdown: () => import("monaco-editor/languages/definitions/markdown/register.js"),
	mdx: () => import("monaco-editor/languages/definitions/mdx/register.js"),
	objectivec: () => import("monaco-editor/languages/definitions/objective-c/register.js"),
	perl: () => import("monaco-editor/languages/definitions/perl/register.js"),
	php: () => import("monaco-editor/languages/definitions/php/register.js"),
	powershell: () => import("monaco-editor/languages/definitions/powershell/register.js"),
	python: () => import("monaco-editor/languages/definitions/python/register.js"),
	ruby: () => import("monaco-editor/languages/definitions/ruby/register.js"),
	rust: () => import("monaco-editor/languages/definitions/rust/register.js"),
	scala: () => import("monaco-editor/languages/definitions/scala/register.js"),
	scss: () => import("monaco-editor/languages/definitions/scss/register.js"),
	shell: () => import("monaco-editor/languages/definitions/shell/register.js"),
	solidity: () => import("monaco-editor/languages/definitions/solidity/register.js"),
	sql: () => import("monaco-editor/languages/definitions/sql/register.js"),
	swift: () => import("monaco-editor/languages/definitions/swift/register.js"),
	systemverilog: () => import("monaco-editor/languages/definitions/systemverilog/register.js"),
	typescript: () => import("monaco-editor/languages/definitions/typescript/register.js"),
	xml: () => import("monaco-editor/languages/definitions/xml/register.js"),
	yaml: () => import("monaco-editor/languages/definitions/yaml/register.js"),
};

const languageLoadPromises = new Map<string, Promise<string>>();

function monacoLanguageForPath(path: string): string {
	const language = languageForPath(path);
	switch (language) {
		case "c":
			return "cpp";
		case "docker":
			return "dockerfile";
		case "jsx":
			return "javascript";
		case "tsx":
			return "typescript";
		case "make":
		case "shellscript":
			return "shell";
		case "toml":
			return "ini";
		case "vue":
			return "html";
		default:
			return language;
	}
}

function ensureMonacoLanguage(monaco: typeof Monaco, language: string): Promise<string> {
	if (language === "text" || monaco.languages.getLanguages().some((entry) => entry.id === language)) {
		return Promise.resolve(language);
	}
	const loader = lazyLanguageLoaders[language];
	if (!loader) return Promise.resolve("text");
	const existing = languageLoadPromises.get(language);
	if (existing) return existing;
	const promise = loader().then(
		() => (monaco.languages.getLanguages().some((entry) => entry.id === language) ? language : "text"),
		() => "text",
	);
	languageLoadPromises.set(language, promise);
	return promise;
}

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
			monaco.editor.setTheme(dark ? "vs-dark" : "vs");
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
