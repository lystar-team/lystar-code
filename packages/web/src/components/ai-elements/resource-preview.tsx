"use client";

import {
	ChevronLeftIcon,
	ChevronRightIcon,
	DownloadIcon,
	LoaderCircleIcon,
	MinusIcon,
	PlusIcon,
	XIcon,
	ZoomInIcon,
} from "lucide-react";
import { useEffect, useState, type WheelEvent } from "react";
import { cn } from "@/lib/utils";
import { webApi } from "../../adapters/host-protocol/api.ts";
import type { FileResponse } from "../../types.ts";
import { Dialog, DialogContent, DialogTitle } from "../ui/dialog";

export interface ResourceImageItem {
	id: string;
	src?: string;
	path?: string;
	pathLabel?: string;
	sessionId?: string;
	contentRef?: string;
	mimeType?: string;
	alt?: string;
}

export interface ResourceImageProps {
	src?: string;
	path?: string;
	pathLabel?: string;
	sessionId?: string;
	contentRef?: string;
	alt?: string;
	className?: string;
	onOpenPath?: (path: string) => void;
	onPreview?: () => void;
}

interface ResourceImageViewerProps {
	items: readonly ResourceImageItem[];
	open: boolean;
	initialIndex?: number;
	onOpenChange: (open: boolean) => void;
}

function imageDataUrl(result: FileResponse): string | undefined {
	if (result.kind !== "image" || !result.data) return undefined;
	return `data:${result.mimeType};base64,${result.data}`;
}

function loadResourceImage(item: ResourceImageItem): Promise<string | undefined> {
	if (item.src) return Promise.resolve(item.src);
	if (item.path) return webApi.externalFile(item.path).then(imageDataUrl);
	if (item.sessionId && item.contentRef) {
		return webApi.readImageContent(item.sessionId, item.contentRef).then((result) => {
			if (!result.data) return undefined;
			return `data:${result.mimeType};base64,${result.data}`;
		});
	}
	return Promise.resolve(undefined);
}

function useResourceImageSource(item: ResourceImageItem) {
	const [source, setSource] = useState(item.src);
	const [loading, setLoading] = useState(!item.src && Boolean(item.path || (item.sessionId && item.contentRef)));
	const [failed, setFailed] = useState(false);

	useEffect(() => {
		let cancelled = false;
		setSource(item.src);
		setFailed(false);
		if (item.src || (!item.path && !(item.sessionId && item.contentRef))) {
			setLoading(false);
			return;
		}
		setLoading(true);
		void loadResourceImage(item)
			.then((result) => {
				if (!cancelled) setSource(result);
			})
			.catch(() => {
				if (!cancelled) setFailed(true);
			})
			.finally(() => {
				if (!cancelled) setLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [item.contentRef, item.path, item.sessionId, item.src]);

	return { source, loading, failed };
}

function resourceFileName(item: ResourceImageItem, index: number): string {
	const candidate = item.pathLabel ?? item.path ?? item.alt ?? `image-${index + 1}`;
	const name = candidate.split(/[\\/]/u).filter(Boolean).at(-1) || `image-${index + 1}`;
	return name.includes(".") ? name : `${name}.png`;
}

function ResourceImageViewer({ items, open, initialIndex = 0, onOpenChange }: ResourceImageViewerProps) {
	const [index, setIndex] = useState(initialIndex);
	const [zoom, setZoom] = useState(1);
	const [source, setSource] = useState<string | undefined>();
	const [loading, setLoading] = useState(false);
	const [failed, setFailed] = useState(false);
	const current = items[index];

	useEffect(() => {
		if (!open || !items.length) return;
		setIndex(Math.min(Math.max(initialIndex, 0), items.length - 1));
		setZoom(1);
	}, [initialIndex, items.length, open]);

	useEffect(() => {
		if (!open || !current) return;
		let cancelled = false;
		setSource(current.src);
		setFailed(false);
		if (current.src || (!current.path && !(current.sessionId && current.contentRef))) {
			setLoading(false);
			return;
		}
		setLoading(true);
		void loadResourceImage(current)
			.then((result) => {
				if (!cancelled) setSource(result);
			})
			.catch(() => {
				if (!cancelled) setFailed(true);
			})
			.finally(() => {
				if (!cancelled) setLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [current?.contentRef, current?.path, current?.sessionId, current?.src, open]);

	useEffect(() => {
		if (!open || items.length < 2) return;
		const handleKeyDown = (event: KeyboardEvent) => {
			if (event.key === "ArrowLeft") {
				event.preventDefault();
				setIndex((value) => (value - 1 + items.length) % items.length);
				setZoom(1);
			} else if (event.key === "ArrowRight") {
				event.preventDefault();
				setIndex((value) => (value + 1) % items.length);
				setZoom(1);
			}
		};
		window.addEventListener("keydown", handleKeyDown);
		return () => window.removeEventListener("keydown", handleKeyDown);
	}, [items.length, open]);

	if (!current) return null;

	const changeZoom = (delta: number) => setZoom((value) => Math.min(3, Math.max(0.5, value + delta)));
	const move = (delta: number) => {
		setIndex((value) => (value + delta + items.length) % items.length);
		setZoom(1);
	};
	const handleWheel = (event: WheelEvent<HTMLDivElement>) => {
		event.preventDefault();
		changeZoom(event.deltaY < 0 ? 0.1 : -0.1);
	};
	const download = () => {
		if (!source) return;
		const link = document.createElement("a");
		link.href = source;
		link.download = resourceFileName(current, index);
		link.rel = "noreferrer";
		document.body.appendChild(link);
		link.click();
		link.remove();
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent
				showCloseButton={false}
				className="fixed inset-0 z-50 flex h-dvh w-screen max-w-none translate-x-0 translate-y-0 flex-col gap-0 overflow-hidden rounded-none border-0 bg-black p-0 text-white shadow-none sm:max-w-none"
			>
				<DialogTitle className="sr-only">{current.alt ?? "图片预览"}</DialogTitle>
				<div className="absolute top-4 right-4 z-20 flex items-center gap-1 rounded-xl border border-white/10 bg-white/10 p-1 shadow-2xl backdrop-blur-md">
					<button
						className="flex size-9 items-center justify-center rounded-lg text-white/75 transition-colors hover:bg-white/15 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70 disabled:pointer-events-none disabled:opacity-40"
						type="button"
						disabled={!source}
						onClick={download}
						aria-label="下载图片"
					>
						<DownloadIcon className="size-4" />
					</button>
					<button
						className="flex size-9 items-center justify-center rounded-lg text-white/75 transition-colors hover:bg-white/15 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
						type="button"
						onClick={() => onOpenChange(false)}
						aria-label="关闭图片预览"
					>
						<XIcon className="size-5" />
					</button>
				</div>

				<div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden px-16 py-16 sm:px-24" onWheel={handleWheel}>
					{items.length > 1 ? (
						<button
							className="absolute left-4 z-10 flex size-11 items-center justify-center rounded-full border border-white/10 bg-white/10 text-white/80 shadow-xl backdrop-blur-md transition-colors hover:bg-white/20 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70 sm:left-8"
							type="button"
							onClick={() => move(-1)}
							aria-label="上一张图片"
						>
							<ChevronLeftIcon className="size-6" />
						</button>
					) : null}
					{source ? (
						<img
							className="max-h-[calc(100dvh-8rem)] max-w-[calc(100vw-8rem)] select-none object-contain transition-transform duration-100 ease-out"
							src={source}
							alt={current.alt ?? "图片"}
							draggable={false}
							style={{ transform: `scale(${zoom})` }}
						/>
					) : loading ? (
						<LoaderCircleIcon className="size-8 animate-spin text-white/60" />
					) : (
						<span className="text-sm text-white/60">{failed ? "图片暂时无法预览" : "没有图片内容"}</span>
					)}
					{items.length > 1 ? (
						<button
							className="absolute right-4 z-10 flex size-11 items-center justify-center rounded-full border border-white/10 bg-white/10 text-white/80 shadow-xl backdrop-blur-md transition-colors hover:bg-white/20 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70 sm:right-8"
							type="button"
							onClick={() => move(1)}
							aria-label="下一张图片"
						>
							<ChevronRightIcon className="size-6" />
						</button>
					) : null}
				</div>

				<div className="absolute inset-x-0 bottom-5 z-20 flex justify-center px-4">
					<div className="flex items-center gap-1 rounded-xl border border-white/10 bg-white/10 p-1 shadow-2xl backdrop-blur-md">
						<button
							className="flex size-8 items-center justify-center rounded-lg text-white/75 transition-colors hover:bg-white/15 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
							type="button"
							onClick={() => changeZoom(-0.1)}
							aria-label="缩小图片"
						>
							<MinusIcon className="size-4" />
						</button>
						<span className="min-w-12 px-1 text-center text-xs tabular-nums text-white/75">{Math.round(zoom * 100)}%</span>
						<button
							className="flex size-8 items-center justify-center rounded-lg text-white/75 transition-colors hover:bg-white/15 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
							type="button"
							onClick={() => changeZoom(0.1)}
							aria-label="放大图片"
						>
							<PlusIcon className="size-4" />
						</button>
					</div>
				</div>
			</DialogContent>
		</Dialog>
	);
}

export function ResourceImage({
	src,
	path,
	pathLabel,
	sessionId,
	contentRef,
	alt = "图片",
	className,
	onOpenPath,
	onPreview,
}: ResourceImageProps) {
	const item: ResourceImageItem = {
		id: contentRef ?? path ?? src ?? alt,
		src,
		path,
		pathLabel,
		sessionId,
		contentRef,
		alt,
	};
	const { source, loading, failed } = useResourceImageSource(item);
	const [open, setOpen] = useState(false);
	const displayPath = pathLabel ?? path;

	return (
		<>
			<div className={cn("grid min-w-0 gap-1.5", className)}>
				<button
					className="group relative flex min-h-24 w-fit max-w-full items-center justify-center overflow-hidden rounded-xl border border-border bg-muted/30 text-left transition-colors hover:border-primary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
					disabled={!source}
					onClick={() => (onPreview ? onPreview() : setOpen(true))}
					type="button"
					aria-label={`放大${alt}`}
				>
					{source ? (
						<img className="max-h-72 max-w-full object-contain" src={source} alt={alt} />
					) : loading ? (
						<LoaderCircleIcon className="m-8 size-5 animate-spin text-muted-foreground" />
					) : (
						<span className="px-4 py-6 text-sm text-muted-foreground">
							{failed ? "图片暂时无法预览" : "没有图片内容"}
						</span>
					)}
					{source ? (
						<span className="pointer-events-none absolute right-2 bottom-2 rounded-full bg-background/85 p-1.5 opacity-0 shadow-sm transition-opacity group-hover:opacity-100">
							<ZoomInIcon className="size-4 text-foreground" />
						</span>
					) : null}
				</button>
				{displayPath ? (
					onOpenPath ? (
						<button
							className="max-w-full truncate text-left font-mono text-xs text-primary underline decoration-primary/40 underline-offset-2 hover:decoration-primary"
							onClick={() => onOpenPath(displayPath)}
							type="button"
						>
							{displayPath}
						</button>
					) : (
						<span className="max-w-full truncate font-mono text-xs text-muted-foreground">{displayPath}</span>
					)
				) : null}
			</div>
			{onPreview ? null : (
				<ResourceImageViewer items={[item]} open={open} onOpenChange={setOpen} />
			)}
		</>
	);
}

export function ResourceImageGallery({
	items,
	itemClassName,
	onOpenPath,
}: {
	items: readonly ResourceImageItem[];
	itemClassName?: string;
	onOpenPath?: (path: string) => void;
}) {
	const [openIndex, setOpenIndex] = useState<number>();
	if (!items.length) return null;

	return (
		<>
			<div className="flex min-w-0 flex-wrap items-start gap-2">
				{items.map((item, index) => (
					<ResourceImage
						key={item.id}
						src={item.src}
						path={item.path}
						pathLabel={item.pathLabel}
						sessionId={item.sessionId}
						contentRef={item.contentRef}
						alt={item.alt}
						className={itemClassName}
						onOpenPath={onOpenPath}
						onPreview={() => setOpenIndex(index)}
					/>
				))}
			</div>
			<ResourceImageViewer
				items={items}
				open={openIndex !== undefined}
				initialIndex={openIndex ?? 0}
				onOpenChange={(open) => {
					if (!open) setOpenIndex(undefined);
				}}
			/>
		</>
	);
}
