import { useCallback, useEffect, useRef } from "react";
import { Download, LoaderCircle, X } from "lucide-react";
import { FileTypeIcon } from "./files-panel";
import { CodeBlockCopyButton, CodeBlockDownloadButton } from "../ai-elements/code-block";
import { CodeBlockView } from "./transcript";
import { OfficeFilePreview, downloadBinaryFile, officeFormatForPath } from "./office-file-preview";
import type { WorkbenchState } from "../../state/use-workbench";
import { Button } from "../ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../ui/dialog";
import type { WorkbenchActions } from "./types";

export function FilePreviewDialog({ state, actions }: { state: WorkbenchState; actions: WorkbenchActions }) {
	const autoDownloadKeyRef = useRef<string>();
	const open = Boolean(state.fileLoading || state.fileContent);
	const binaryFile = state.fileContent?.kind === "binary" ? state.fileContent : undefined;
	const binaryFormat = binaryFile ? officeFormatForPath(binaryFile.path) : undefined;
	const binaryPath = binaryFile?.path;
	const binaryData = binaryFile?.data;
	const binaryMimeType = binaryFile?.mimeType;
	const downloadBinary = useCallback(() => {
		if (binaryPath && binaryData) downloadBinaryFile(binaryPath, binaryData, binaryMimeType || "application/octet-stream");
	}, [binaryData, binaryMimeType, binaryPath]);

	useEffect(() => {
		if (!binaryFile || binaryFormat || !binaryData) return;
		const key = `${binaryFile.path}:${binaryFile.byteLength}`;
		if (autoDownloadKeyRef.current === key) return;
		autoDownloadKeyRef.current = key;
		downloadBinary();
	}, [binaryData, binaryFile, binaryFormat, downloadBinary]);

	return (
		<Dialog
			open={open}
			onOpenChange={(nextOpen) => {
				if (!nextOpen) actions.closeFilePreview();
			}}
		>
			<DialogContent
				showCloseButton={false}
				className="flex h-[min(88vh,900px)] w-[min(94vw,1200px)] max-w-none flex-col gap-0 overflow-hidden p-0 sm:max-w-[min(94vw,1200px)]"
			>
				<DialogHeader className="flex-row items-start justify-between gap-3 border-b border-border/60 px-5 py-4 text-left">
					<div className="min-w-0 flex-1">
						<DialogTitle className="flex min-w-0 items-center gap-2 text-sm">
							<FileTypeIcon path={state.filePath ?? ""} />
							<span className="min-w-0 truncate font-mono">{state.filePath || "文件预览"}</span>
						</DialogTitle>
						{state.fileLoading || state.fileContent?.kind === "image" ? (
							<DialogDescription>
								{state.fileLoading
									? "正在读取文件…"
									: state.fileContent?.kind === "image"
										? "图片预览"
										: null}
							</DialogDescription>
						) : binaryFile ? (
							<DialogDescription>
								{binaryFormat ? "浏览器端 Office 预览" : "当前格式不支持在线预览，已开始下载"}
							</DialogDescription>
						) : null}
					</div>
					<div className="flex shrink-0 items-center gap-1">
						{binaryFile?.data ? (
							<Button size="icon" variant="ghost" onClick={downloadBinary} aria-label="下载原文件">
								<Download className="size-4" />
							</Button>
						) : null}
						{state.fileContent?.kind === "text" && state.fileContent.content !== undefined ? (
							<>
								<CodeBlockDownloadButton
									code={state.fileContent.content}
									aria-label="下载文件"
									filename={state.fileContent.path.split(/[\\/]/u).at(-1) || "code.txt"}
								/>
								<CodeBlockCopyButton code={state.fileContent.content} aria-label="复制文件内容" />
							</>
						) : null}
						<DialogClose asChild>
							<Button size="icon" variant="ghost" aria-label="关闭文件预览">
								<X className="size-4" />
							</Button>
						</DialogClose>
					</div>
				</DialogHeader>
				<div className="min-h-0 flex-1 overflow-auto bg-background p-4 sm:p-6">
					{state.fileLoading ? (
						<div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
							<LoaderCircle className="size-4 animate-spin" />
							正在读取文件
						</div>
					) : state.fileContent?.kind === "image" && state.fileContent.data ? (
						<div className="flex h-full items-center justify-center overflow-auto rounded-xl bg-muted/20 p-4">
							<img
								className="max-h-full max-w-full object-contain"
								src={`data:${state.fileContent.mimeType};base64,${state.fileContent.data}`}
								alt={state.fileContent.path}
							/>
						</div>
					) : binaryFile?.data && binaryFormat ? (
						<OfficeFilePreview
							path={binaryFile.path}
							data={binaryFile.data}
							className="h-full"
							onFallbackDownload={downloadBinary}
						/>
					) : binaryFile ? (
						<div className="flex h-full min-h-48 flex-col items-center justify-center gap-3 text-center text-sm">
							<p>当前格式不支持在线预览</p>
							<Button variant="outline" onClick={downloadBinary} disabled={!binaryFile.data}>
								<Download className="size-4" />
								下载原文件
							</Button>
						</div>
					) : state.fileContent ? (
						<CodeBlockView
							code={state.fileContent.content ?? ""}
							language={languageForPath(state.fileContent.path)}
							embedded
							wrap
							showActions={false}
						/>
					) : null}
				</div>
			</DialogContent>
		</Dialog>
	);
}

export function languageForPath(path: string): string {
	const fileName = path.split(/[?#]/u)[0]?.split(/[\\/]/u).filter(Boolean).at(-1)?.toLowerCase() ?? "";
	if (fileName === "dockerfile") return "docker";
	if (fileName === "makefile") return "make";
	const extension = fileName.includes(".") ? fileName.slice(fileName.lastIndexOf(".") + 1) : "";
	const languages: Record<string, string> = {
		bash: "shellscript",
		bat: "bat",
		c: "c",
		cc: "cpp",
		cpp: "cpp",
		cs: "csharp",
		css: "css",
		cxx: "cpp",
		dart: "dart",
		go: "go",
		gql: "graphql",
		graphql: "graphql",
		h: "c",
		hcl: "hcl",
		hpp: "cpp",
		htm: "html",
		html: "html",
		ini: "ini",
		java: "java",
		js: "javascript",
		json: "json",
		jsonc: "json",
		jsx: "jsx",
		kt: "kotlin",
		kts: "kotlin",
		less: "less",
		md: "markdown",
		markdown: "markdown",
		mdx: "mdx",
		mjs: "javascript",
		mts: "typescript",
		php: "php",
		pl: "perl",
		ps1: "powershell",
		py: "python",
		rb: "ruby",
		rs: "rust",
		sass: "scss",
		scss: "scss",
		sh: "shellscript",
		sql: "sql",
		swift: "swift",
		ts: "typescript",
		tsx: "tsx",
		toml: "toml",
		vue: "vue",
		xml: "xml",
		yaml: "yaml",
		yml: "yaml",
		zsh: "shellscript",
	};
	return languages[extension] ?? "text";
}
