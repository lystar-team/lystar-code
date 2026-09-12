import { Copy, Download, LoaderCircle, Save, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { isAbsoluteResourcePath } from "../../lib/resource-path.ts";
import { cn } from "../../lib/utils.ts";
import type { WorkbenchState } from "../../state/use-workbench.ts";
import type { FileResponse } from "../../types.ts";
import { CodeBlockCopyButton, CodeBlockDownloadButton } from "../ai-elements/code-block.tsx";
import { MessageResponse } from "../ai-elements/message.tsx";
import { ResourceImage, ResourceImageViewer, type ResourceImageItem } from "../ai-elements/resource-preview.tsx";
import { Button } from "../ui/button.tsx";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../ui/dialog.tsx";
import { FileTypeIcon } from "./files-panel.tsx";
import { languageForPath, monacoLanguageForPath } from "./file-language.ts";
import {
	MonacoFileEditor,
	type MonacoFileEditorHandle,
	type MonacoFileEditorState,
} from "./monaco-file-editor.tsx";
import { OfficeFilePreview, downloadBinaryFile, officeFormatForPath } from "./office-file-preview.tsx";
import { preloadMonacoLanguage } from "./monaco-runtime.ts";
import { CodeBlockView } from "./transcript.tsx";
import type { WorkbenchActions } from "./types.ts";

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

const INITIAL_EDITOR_STATE: MonacoFileEditorState = {
	ready: false,
	dirty: false,
	saving: false,
	conflict: false,
};

type MarkdownView = "preview" | "edit";

export function FilePreviewDialog({ state, actions }: { state: WorkbenchState; actions: WorkbenchActions }) {
	const autoDownloadKeyRef = useRef<string>();
	const editorRef = useRef<MonacoFileEditorHandle>(null);
	const [editorState, setEditorState] = useState<MonacoFileEditorState>(INITIAL_EDITOR_STATE);
	const [imagePreviewOpen, setImagePreviewOpen] = useState(false);
	const [markdownView, setMarkdownView] = useState<MarkdownView>("preview");
	const [markdownPreviewContent, setMarkdownPreviewContent] = useState("");
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
	const textFile =
		state.fileContent?.kind === "text" && state.fileContent.content !== undefined && !state.fileContent.truncated
			? (state.fileContent as FileResponse & { kind: "text"; content: string })
			: undefined;
	const markdownFile = textFile && languageForPath(textFile.path) === "markdown" ? textFile : undefined;
	const textActive = Boolean(textFile && textFile.path === state.filePath && !state.fileLoading);
	const textEditable = Boolean(
		textActive &&
			textFile?.contentHash &&
			state.currentProjectId &&
			state.filePath &&
			!isAbsoluteResourcePath(state.filePath) &&
			(!state.sessionId || (!state.readOnly && state.lease)),
	);
	const dark =
		state.theme === "dark" ||
		(state.theme === "system" && typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches);
	const filename = state.fileContent?.path.split(/[\\/]/u).at(-1) || "code.txt";

	const downloadBinary = useCallback(() => {
		if (binaryPath && binaryData) downloadBinaryFile(binaryPath, binaryData, binaryMimeType || "application/octet-stream");
	}, [binaryData, binaryMimeType, binaryPath]);

	const closePreview = useCallback(() => {
		if (editorRef.current?.hasUnsavedChanges() && !window.confirm("当前文件有未保存更改，仍要关闭吗？")) return;
		actions.closeFilePreview();
	}, [actions]);

	const handleMarkdownViewChange = useCallback(
		(value: MarkdownView) => {
			if (value === "preview") setMarkdownPreviewContent(editorRef.current?.getValue() ?? textFile?.content ?? "");
			setMarkdownView(value);
		},
		[textFile?.content],
	);

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

	useEffect(() => {
		if (!state.filePath) return;
		preloadMonacoLanguage(monacoLanguageForPath(state.filePath));
	}, [state.filePath]);

	useEffect(() => {
		setEditorState(INITIAL_EDITOR_STATE);
		setMarkdownView("preview");
		setMarkdownPreviewContent(textFile?.content ?? "");
	}, [textFile?.path]);

	return (
		<>
			<Dialog
				open={open}
				onOpenChange={(nextOpen) => {
					if (!nextOpen) closePreview();
				}}
			>
				<DialogContent
					showCloseButton={false}
					className="z-[70] flex h-[min(88vh,900px)] w-[min(94vw,1200px)] max-w-none flex-col gap-0 overflow-hidden p-0 sm:max-w-[min(94vw,1200px)] max-sm:left-0 max-sm:top-0 max-sm:h-dvh max-sm:w-screen max-sm:max-w-none max-sm:translate-x-0 max-sm:translate-y-0 max-sm:rounded-none max-sm:border-0"
				>
					<DialogHeader className="flex-row flex-wrap items-center justify-between gap-3 border-b border-border/60 px-4 py-3 text-left sm:px-5 sm:py-4 max-sm:gap-x-2 max-sm:gap-y-1">
						<div className="order-1 min-w-0 flex-1 sm:order-none">
							<DialogTitle className="flex min-w-0 items-center gap-2 text-sm">
								<FileTypeIcon path={state.filePath ?? ""} />
								<span className="min-w-0 truncate font-mono">{state.filePath || "文件预览"}</span>
							</DialogTitle>
							<DialogDescription>
								{state.fileLoading && !state.fileContent
									? "正在读取文件…"
									: state.fileError && !state.fileContent
										? "文件加载失败，错误信息保留在预览窗口内"
										: textFile
											? editorState.conflict
												? "磁盘版本已变化，本地内容已保留，可重新加载磁盘版本"
												: editorState.saving
													? "正在保存"
													: editorState.dirty
														? "有未保存更改"
														: textEditable
															? "可编辑文本文件"
															: "只读文本文件"
											: state.fileContent?.kind === "image"
												? state.fileContent.truncated
													? `文件共 ${formatBytes(state.fileContent.byteLength)}，已停止加载完整内容`
													: "图片预览"
												: binaryFile
													? binaryFormat
														? "浏览器端 Office 预览"
														: "当前格式不支持在线预览，已开始下载"
													: "文件预览"}
							</DialogDescription>
						</div>
						{markdownFile ? (
							<div
								className="order-3 flex h-8 w-full shrink-0 items-stretch sm:order-none sm:w-auto"
								role="tablist"
								aria-label="Markdown 文件视图"
							>
								<button
									type="button"
									id="markdown-preview-tab"
									role="tab"
									aria-controls="markdown-preview-panel"
									aria-selected={markdownView === "preview"}
									className={cn(
										"relative min-w-0 flex-1 px-3 text-sm text-muted-foreground hover:text-foreground sm:flex-none",
										markdownView === "preview" &&
											"text-foreground after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:bg-foreground",
									)}
									onClick={() => handleMarkdownViewChange("preview")}
								>
									预览
								</button>
								<button
									type="button"
									id="markdown-edit-tab"
									role="tab"
									aria-controls="markdown-edit-panel"
									aria-selected={markdownView === "edit"}
									className={cn(
										"relative min-w-0 flex-1 px-3 text-sm text-muted-foreground hover:text-foreground sm:flex-none",
										markdownView === "edit" &&
											"text-foreground after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:bg-foreground",
									)}
									onClick={() => handleMarkdownViewChange("edit")}
								>
									编辑
								</button>
							</div>
						) : null}
						<div className="order-2 flex shrink-0 items-center gap-1 sm:order-none">
							{binaryFile?.data && !binaryFile.truncated ? (
								<Button size="icon" variant="ghost" onClick={downloadBinary} aria-label="下载原文件">
									<Download className="size-4" />
								</Button>
							) : null}
							{textFile ? (
								<>
									<Button
										size="icon"
										variant="ghost"
										onClick={() => editorRef.current?.download(filename)}
										aria-label="下载文件"
										disabled={!editorState.ready || !textActive}
									>
										<Download className="size-4" />
									</Button>
									<Button
										size="icon"
										variant="ghost"
										onClick={() => void editorRef.current?.copy().catch((error) => actions.showToast(error.message))}
										aria-label="复制文件内容"
										disabled={!editorState.ready || !textActive}
									>
										<Copy className="size-4" />
									</Button>
									{textEditable ? (
										<Button
											size="icon"
											variant={editorState.dirty ? "default" : "ghost"}
											onClick={() => void editorRef.current?.save().catch((error) => actions.showToast(error.message))}
											aria-label="保存文件"
											disabled={!editorState.ready || !editorState.dirty || editorState.saving}
										>
											{editorState.saving ? <LoaderCircle className="size-4 animate-spin" /> : <Save className="size-4" />}
										</Button>
									) : null}
								</>
							) : state.fileContent?.kind === "text" && state.fileContent.content !== undefined ? (
								<>
									<CodeBlockDownloadButton
										code={state.fileContent.content}
										aria-label="下载文件"
										filename={filename}
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
					<div className="relative min-h-0 flex-1 overflow-auto bg-background p-3 sm:p-4">
						{state.fileLoading && !state.fileContent ? (
							<div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
								<LoaderCircle className="size-4 animate-spin" />
								正在读取文件
							</div>
						) : state.fileError && !state.fileContent ? (
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
						) : textFile ? (
							<>
								{markdownFile && markdownView === "preview" ? (
									<MessageResponse
										id="markdown-preview-panel"
										role="tabpanel"
										aria-labelledby="markdown-preview-tab"
										className="markdown-file-preview sd-prose !h-auto mx-auto min-h-full w-full max-w-4xl px-1 py-2 sm:px-4 sm:py-4"
										mode="static"
										parseIncompleteMarkdown
										linkSafety={{ enabled: true }}
										controls={{ code: { copy: true, download: true }, table: { copy: true, download: true } }}
										onOpenPath={(path) => void actions.openResource(path)}
										projectId={state.currentProjectId}
									>
										{markdownPreviewContent}
									</MessageResponse>
								) : null}
								<div
									id={markdownFile ? "markdown-edit-panel" : undefined}
									role={markdownFile ? "tabpanel" : undefined}
									aria-labelledby={markdownFile ? "markdown-edit-tab" : undefined}
									className={cn(
										"h-full min-h-0",
										markdownFile && markdownView === "preview" && "hidden",
									)}
								>
									<MonacoFileEditor
										ref={editorRef}
										dark={dark}
										editable={textEditable}
										file={textFile}
										modelKey={`${state.currentProjectId ?? "external"}:${textFile.path}`}
										onContentChange={markdownFile ? setMarkdownPreviewContent : undefined}
										onSave={(content, expectedHash) => actions.saveFile(textFile.path, content, expectedHash)}
										onStateChange={setEditorState}
									/>
								</div>
							</>
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
						{state.fileLoading && state.fileContent ? (
							<div className="absolute inset-0 flex items-center justify-center gap-2 bg-background/70 text-sm text-muted-foreground backdrop-blur-[1px]">
								<LoaderCircle className="size-4 animate-spin" />
								正在切换文件
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
