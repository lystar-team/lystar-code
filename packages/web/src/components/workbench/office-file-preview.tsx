import { LoaderCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { cn } from "../../lib/utils";

export type OfficeFileFormat = "docx" | "xlsx" | "pptx";

interface OfficeFilePreviewProps {
	path: string;
	data: string;
	className?: string;
	onFallbackDownload?: () => void;
}

function fileName(path: string): string {
	return path.split(/[\\/]/u).at(-1) || "文件";
}

export function officeFormatForPath(path: string): OfficeFileFormat | undefined {
	const extension = path.split(".").at(-1)?.toLowerCase();
	return extension === "docx" || extension === "xlsx" || extension === "pptx" ? extension : undefined;
}

function base64ToArrayBuffer(value: string): ArrayBuffer {
	const binary = atob(value);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
	return bytes.buffer;
}

function isZipContainer(source: ArrayBuffer): boolean {
	const bytes = new Uint8Array(source);
	if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) return false;
	return (
		(bytes[2] === 0x03 && bytes[3] === 0x04) ||
		(bytes[2] === 0x05 && bytes[3] === 0x06) ||
		(bytes[2] === 0x07 && bytes[3] === 0x08)
	);
}

export function downloadBinaryFile(path: string, data: string, mimeType: string): void {
	const url = URL.createObjectURL(new Blob([base64ToArrayBuffer(data)], { type: mimeType }));
	const link = document.createElement("a");
	link.href = url;
	link.download = fileName(path);
	link.click();
	window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function workerMode(): "main" | "worker" {
	return typeof Worker !== "undefined" && typeof OffscreenCanvas !== "undefined" ? "worker" : "main";
}

export function OfficeFilePreview({ path, data, className, onFallbackDownload }: OfficeFilePreviewProps) {
	const format = officeFormatForPath(path);
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const containerRef = useRef<HTMLDivElement>(null);
	const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
	const [error, setError] = useState<string>();

	useEffect(() => {
		let disposed = false;
		let viewer: { destroy: () => void } | undefined;
		let resizeObserver: ResizeObserver | undefined;
		let resizeFrame: number | undefined;
		let fallbackTriggered = false;
		let viewerFailed = false;
		const source = base64ToArrayBuffer(data);
		setStatus("loading");
		setError(undefined);

		const observeViewerSize = (target: Element | null) => {
			if (!target || typeof ResizeObserver === "undefined") return;
			resizeObserver = new ResizeObserver(() => {
				if (resizeFrame !== undefined) window.cancelAnimationFrame(resizeFrame);
				resizeFrame = window.requestAnimationFrame(() => window.dispatchEvent(new Event("resize")));
			});
			resizeObserver.observe(target);
			window.dispatchEvent(new Event("resize"));
		};

		const triggerFallback = () => {
			if (fallbackTriggered) return;
			fallbackTriggered = true;
			onFallbackDownload?.();
		};
		const handleViewerError = (viewerError: Error) => {
			if (disposed) return;
			viewerFailed = true;
			setStatus("error");
			setError(viewerError.message);
			triggerFallback();
		};

		const load = async () => {
			if (!format) throw new Error("当前文件格式不支持在线预览");
			if (!isZipContainer(source)) throw new Error("文件不是有效的 Office 文档");
			const mode = workerMode();
			switch (format) {
				case "docx": {
					const { DocxViewer } = await import("@silurus/ooxml/docx");
					if (disposed) return;
					if (!canvasRef.current) throw new Error("预览画布尚未准备完成");
					const nextViewer = new DocxViewer(canvasRef.current, {
						mode,
						enableTextSelection: true,
						onError: handleViewerError,
					});
					viewer = nextViewer;
					observeViewerSize(canvasRef.current.parentElement);
					await nextViewer.load(source);
					break;
				}
				case "xlsx": {
					const { XlsxViewer } = await import("@silurus/ooxml/xlsx");
					if (disposed) return;
					if (!containerRef.current) throw new Error("预览容器尚未准备完成");
					const nextViewer = new XlsxViewer(containerRef.current, {
						mode,
						showScrollbars: true,
						onError: handleViewerError,
					});
					viewer = nextViewer;
					observeViewerSize(containerRef.current);
					await nextViewer.load(source);
					break;
				}
				case "pptx": {
					const { PptxViewer } = await import("@silurus/ooxml/pptx");
					if (disposed) return;
					if (!canvasRef.current) throw new Error("预览画布尚未准备完成");
					const nextViewer = new PptxViewer(canvasRef.current, {
						mode,
						enableTextSelection: true,
						onError: handleViewerError,
					});
					viewer = nextViewer;
					observeViewerSize(canvasRef.current.parentElement);
					await nextViewer.load(source);
					await nextViewer.fitPage();
					break;
				}
			}
			if (!disposed && !viewerFailed) setStatus("ready");
		};

		void load().catch((reason: unknown) => {
			if (disposed) return;
			setStatus("error");
			setError(reason instanceof Error ? reason.message : "文件预览失败");
			triggerFallback();
		});

		return () => {
			disposed = true;
			resizeObserver?.disconnect();
			if (resizeFrame !== undefined) window.cancelAnimationFrame(resizeFrame);
			viewer?.destroy();
			if (containerRef.current) containerRef.current.replaceChildren();
		};
	}, [data, format, onFallbackDownload]);

	if (!format) return null;

	return (
		<div
			className={cn("relative min-h-full w-full overflow-auto rounded-lg border border-border/60 bg-muted/10", className)}
			aria-busy={status === "loading"}
		>
			{status === "loading" ? (
				<div className="absolute inset-0 z-10 flex items-center justify-center gap-2 bg-background/70 text-sm text-muted-foreground backdrop-blur-[1px]">
					<LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
					正在加载 {fileName(path)}
				</div>
			) : null}
			{status === "error" ? (
				<div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 p-6 text-center text-sm">
					<p className="text-foreground">文件暂时无法预览</p>
					<p className="max-w-md text-xs text-muted-foreground">{error || "浏览器端解析失败，请下载原文件查看。"}</p>
				</div>
			) : null}
			{format === "xlsx" ? (
				<div ref={containerRef} className="h-full min-h-[min(72vh,720px)] w-full" />
			) : (
				<div className="flex min-h-[min(72vh,720px)] min-w-full items-start justify-center p-4 sm:p-6">
					<canvas ref={canvasRef} className="h-auto max-w-full shadow-sm" aria-label={`${fileName(path)}预览`} />
				</div>
			)}
		</div>
	);
}
