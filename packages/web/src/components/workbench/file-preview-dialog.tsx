import { FileTypeIcon } from "./files-panel";
import { CodeBlockCopyButton, CodeBlockDownloadButton } from "../ai-elements/code-block";
import { CodeBlockView } from "./transcript";
import { LoaderCircle, X } from "lucide-react";
import type { WorkbenchState } from "../../state/use-workbench";
import { Button } from "../ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../ui/dialog";
import type { WorkbenchActions } from "./types";

export function FilePreviewDialog({ state, actions }: { state: WorkbenchState; actions: WorkbenchActions }) {
	const open = Boolean(state.fileLoading || state.fileContent);
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
							<DialogDescription>{state.fileLoading ? "正在读取文件…" : "图片预览"}</DialogDescription>
						) : null}
					</div>
					<div className="flex shrink-0 items-center gap-1">
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
	const extension = path.split(".").at(-1)?.toLowerCase();
	return extension === "ts" || extension === "tsx"
		? "typescript"
		: extension === "js" || extension === "jsx"
			? "javascript"
			: extension === "json"
				? "json"
				: extension === "css"
					? "css"
					: extension === "md"
						? "markdown"
						: extension === "sh"
							? "bash"
							: "text";
}
