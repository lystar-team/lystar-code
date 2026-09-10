import { useCallback, useEffect, useRef, useState } from "react";
import { Download, LoaderCircle, X } from "lucide-react";
import { FileTypeIcon } from "./files-panel";
import { CodeBlockCopyButton, CodeBlockDownloadButton } from "../ai-elements/code-block";
import { CodeBlockView } from "./transcript";
import { ResourceImage, ResourceImageViewer, type ResourceImageItem } from "../ai-elements/resource-preview";
import { OfficeFilePreview, downloadBinaryFile, officeFormatForPath } from "./office-file-preview";
import type { WorkbenchState } from "../../state/use-workbench";
import { Button } from "../ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../ui/dialog";
import type { WorkbenchActions } from "./types";

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

export function FilePreviewDialog({ state, actions }: { state: WorkbenchState; actions: WorkbenchActions }) {
	const autoDownloadKeyRef = useRef<string>();
	const [imagePreviewOpen, setImagePreviewOpen] = useState(false);
	const open = Boolean(state.fileLoading || state.fileContent || state.fileError);
	const imageFile = state.fileContent?.kind === "image" ? state.fileContent : undefined;
	const imagePreviewSource = imageFile?.data ? `data:${imageFile.mimeType};base64,${imageFile.data}` : undefined;
	const imagePreviewItem: ResourceImageItem | undefined = imageFile && imagePreviewSource
		? { id: imageFile.path, src: imagePreviewSource, alt: imageFile.path }
		: undefined;
	const binaryFile = state.fileContent?.kind === "binary" ? state.fileContent : undefined;
	const binaryFormat = binaryFile && !binaryFile.truncated ? officeFormatForPath(binaryFile.path) : undefined;
	const binaryPath = binaryFile?.path;
	const binaryData = binaryFile?.data;
	const binaryMimeType = binaryFile?.mimeType;
	const downloadBinary = useCallback(() => {
		if (binaryPath && binaryData) downloadBinaryFile(binaryPath, binaryData, binaryMimeType || "application/octet-stream");
	}, [binaryData, binaryMimeType, binaryPath]);

	useEffect(() => {
		if (!binaryFile || binaryFile.truncated || binaryFormat || !binaryData) return;
		const key = `${binaryFile.path}:${binaryFile.byteLength}`;
		if (autoDownloadKeyRef.current === key) return;
		autoDownloadKeyRef.current = key;
		downloadBinary();
	}, [binaryData, binaryFile, binaryFormat, downloadBinary]);

	useEffect(() => {
		if (!open) setImagePreviewOpen(false);
	}, [open]);

	return (
		<>
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
				<DialogHeader className="flex-row items-center justify-between gap-3 border-b border-border/60 px-5 py-4 text-left">
					<div className="min-w-0 flex-1">
						<DialogTitle className="flex min-w-0 items-center gap-2 text-sm">
							<FileTypeIcon path={state.filePath ?? ""} />
							<span className="min-w-0 truncate font-mono">{state.filePath || "文件预览"}</span>
						</DialogTitle>
						{state.fileLoading || state.fileContent?.kind === "image" || state.fileError ? (
							<DialogDescription>
								{state.fileLoading
									? "正在读取文件…"
									: state.fileError
										? "文件加载失败，错误信息保留在预览窗口内"
										: state.fileContent?.truncated
											? `文件共 ${formatBytes(state.fileContent.byteLength)}，已停止加载完整内容`
											: "图片预览"}
							</DialogDescription>
						) : binaryFile ? (
							<DialogDescription>
								{binaryFormat ? "浏览器端 Office 预览" : "当前格式不支持在线预览，已开始下载"}
							</DialogDescription>
						) : null}
					</div>
					<div className="flex shrink-0 items-center gap-1">
						{binaryFile?.data && !binaryFile.truncated ? (
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
					) : state.fileError ? (
						<div className="flex h-full min-h-48 items-center justify-center p-4">
							<div className="w-full max-w-xl rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm" role="alert">
								<p className="font-medium text-destructive">无法预览该文件</p>
								<p className="mt-2 break-words text-muted-foreground">{state.fileError}</p>
								{state.filePath ? (
									<Button className="mt-4" size="sm" variant="outline" onClick={() => void actions.openResource(state.filePath!)}>
										重新读取
									</Button>
								) : null}
							</div>
						</div>
					) : state.fileContent?.truncated && state.fileContent.kind !== "text" ? (
						<div className="flex h-full min-h-48 items-center justify-center p-4 text-center text-sm text-muted-foreground">
							<div className="max-w-lg rounded-xl border border-border bg-muted/20 p-5">
								<p className="font-medium text-foreground">文件过大，未加载完整二进制内容</p>
								<p className="mt-2">
									文件大小为 {formatBytes(state.fileContent.byteLength)}。浏览器预览已限制为
									{formatBytes(state.fileContent.previewByteLength ?? 0)}，避免文件拖垮聊天页面。
								</p>
							</div>
						</div>
					) : state.fileContent?.kind === "image" && state.fileContent.data ? (
						<div className="flex h-full items-center justify-center rounded-xl bg-muted/20 p-4">
							<ResourceImage
								src={imagePreviewSource}
								alt={imageFile?.path ?? "图片"}
								className="h-full w-full"
								buttonClassName="h-full w-full cursor-zoom-in border-0 bg-transparent hover:border-transparent"
								imageClassName="max-h-full max-w-full"
								onPreview={() => setImagePreviewOpen(true)}
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
						<div className="space-y-3">
							{state.fileContent.truncated ? (
								<div className="rounded-lg border border-border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
									文件共 {formatBytes(state.fileContent.byteLength)}，仅显示前
									{formatBytes(state.fileContent.previewByteLength ?? 0)}。
								</div>
							) : null}
							<CodeBlockView
								code={state.fileContent.content ?? ""}
								language={languageForPath(state.fileContent.path)}
								embedded
								wrap
								showActions={false}
							/>
						</div>
					) : null}
				</div>
			</DialogContent>
		</Dialog>
		<ResourceImageViewer
			items={imagePreviewItem ? [imagePreviewItem] : []}
			open={imagePreviewOpen}
			onOpenChange={setImagePreviewOpen}
		/>
		</>
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
