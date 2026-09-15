"use client";

import {
	ChevronLeftIcon,
	ChevronRightIcon,
	CopyIcon,
	DownloadIcon,
	ImageIcon,
	LoaderCircleIcon,
	MinusIcon,
	PlusIcon,
	XIcon,
	ZoomInIcon,
} from "lucide-react";
import { useEffect, useRef, useState, type PointerEvent, type TouchEvent, type WheelEvent } from "react";
import { cn } from "@/lib/utils";
import { isAbsoluteResourcePath } from "@/lib/resource-path";
import { webApi } from "../../adapters/host-protocol/api.ts";
import type { FileResponse } from "../../types.ts";
import { Dialog, DialogContent, DialogTitle } from "../ui/dialog";
import { Button } from "../ui/button";

export interface ResourceImageGenerationMetadata {
	model?: string;
	prompt?: string;
}

export interface ResourceImageItem {
	id: string;
	src?: string;
	path?: string;
	pathLabel?: string;
	projectId?: string;
	sessionId?: string;
	contentRef?: string;
	mimeType?: string;
	alt?: string;
	generation?: ResourceImageGenerationMetadata;
}

export interface ResourceImageProps {
	src?: string;
	path?: string;
	pathLabel?: string;
	projectId?: string;
	sessionId?: string;
	contentRef?: string;
	alt?: string;
	generation?: ResourceImageGenerationMetadata;
	className?: string;
	imageClassName?: string;
	buttonClassName?: string;
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

const MAX_RESOURCE_IMAGE_CACHE_BYTES = 12 * 1024 * 1024;

type ResourceImageCacheEntry = {
	promise: Promise<string | undefined>;
	bytes: number;
};

const resourceImageCache = new Map<string, ResourceImageCacheEntry>();
let resourceImageCacheBytes = 0;

function resourceImageCacheKey(item: ResourceImageItem): string | undefined {
	return item.sessionId && item.contentRef ? `${item.sessionId}\u0000${item.contentRef}` : undefined;
}

function removeResourceImageCacheEntry(key: string): void {
	const entry = resourceImageCache.get(key);
	if (!entry) return;
	resourceImageCache.delete(key);
	resourceImageCacheBytes -= entry.bytes;
}

function trimResourceImageCache(): void {
	while (resourceImageCacheBytes > MAX_RESOURCE_IMAGE_CACHE_BYTES) {
		const oldest = resourceImageCache.keys().next().value;
		if (typeof oldest !== "string") break;
		removeResourceImageCacheEntry(oldest);
	}
}

function requestResourceImage(item: ResourceImageItem): Promise<string | undefined> {
	if (item.src) return Promise.resolve(item.src);
	if (item.path) {
		const request = item.projectId && !isAbsoluteResourcePath(item.path)
			? webApi.projectFile(item.projectId, item.path)
			: webApi.externalFile(item.path);
		return request.then(imageDataUrl);
	}
	if (item.sessionId && item.contentRef) {
		return webApi.readImageContent(item.sessionId, item.contentRef).then((result) => {
			if (!result.data) return undefined;
			return `data:${result.mimeType};base64,${result.data}`;
		});
	}
	return Promise.resolve(undefined);
}

function loadResourceImage(item: ResourceImageItem): Promise<string | undefined> {
	const key = resourceImageCacheKey(item);
	if (!key) return requestResourceImage(item);
	const cached = resourceImageCache.get(key);
	if (cached) {
		resourceImageCache.delete(key);
		resourceImageCache.set(key, cached);
		return cached.promise;
	}
	const entry: ResourceImageCacheEntry = { promise: Promise.resolve(undefined), bytes: 0 };
	entry.promise = requestResourceImage(item).then(
		(source) => {
			if (resourceImageCache.get(key) === entry && source) {
				entry.bytes = source.length * 2;
				resourceImageCacheBytes += entry.bytes;
				trimResourceImageCache();
			}
			return source;
		},
		(error: unknown) => {
			if (resourceImageCache.get(key) === entry) removeResourceImageCacheEntry(key);
			throw error;
		},
	);
	resourceImageCache.set(key, entry);
	return entry.promise;
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
	}, [item.contentRef, item.path, item.projectId, item.sessionId, item.src]);

	return { source, loading, failed };
}

function resourceFileName(item: ResourceImageItem, index: number): string {
	const candidate = item.pathLabel ?? item.path ?? item.alt ?? `image-${index + 1}`;
	const name = candidate.split(/[\\/]/u).filter(Boolean).at(-1) || `image-${index + 1}`;
	return name.includes(".") ? name : `${name}.png`;
}

function touchDistance(touches: { length: number; [index: number]: { clientX: number; clientY: number } }): number | undefined {
	if (touches.length < 2) return undefined;
	const first = touches[0];
	const second = touches[1];
	return Math.hypot(second.clientX - first.clientX, second.clientY - first.clientY);
}

export function ResourceImageViewer({ items, open, initialIndex = 0, onOpenChange }: ResourceImageViewerProps) {
	const [index, setIndex] = useState(initialIndex);
	const [zoom, setZoom] = useState(1);
	const [pan, setPan] = useState({ x: 0, y: 0 });
	const [dragging, setDragging] = useState(false);
	const [source, setSource] = useState<string | undefined>();
	const [loading, setLoading] = useState(false);
	const [failed, setFailed] = useState(false);
	const [copiedPrompt, setCopiedPrompt] = useState(false);
	const pinchStartDistanceRef = useRef<number>();
	const pinchStartZoomRef = useRef(1);
	const dragStartRef = useRef<{ x: number; y: number }>();
	const dragOriginRef = useRef({ x: 0, y: 0 });
	const dragPointerIdRef = useRef<number>();
	const current = items[index];

	useEffect(() => {
		if (!open || !items.length) return;
		setIndex(Math.min(Math.max(initialIndex, 0), items.length - 1));
		setZoom(1);
		setPan({ x: 0, y: 0 });
		setDragging(false);
	}, [initialIndex, items.length, open]);

	useEffect(() => {
		if (!open || !current) return;
		let cancelled = false;
		setSource(current.src);
		setFailed(false);
		setCopiedPrompt(false);
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
	}, [current?.contentRef, current?.path, current?.projectId, current?.sessionId, current?.src, open]);

	useEffect(() => {
		if (!open || items.length < 2) return;
		const handleKeyDown = (event: KeyboardEvent) => {
			if (event.key === "ArrowLeft") {
				event.preventDefault();
				setIndex((value) => (value - 1 + items.length) % items.length);
				setZoom(1);
				setPan({ x: 0, y: 0 });
			} else if (event.key === "ArrowRight") {
				event.preventDefault();
				setIndex((value) => (value + 1) % items.length);
				setZoom(1);
				setPan({ x: 0, y: 0 });
			}
		};
		window.addEventListener("keydown", handleKeyDown);
		return () => window.removeEventListener("keydown", handleKeyDown);
	}, [items.length, open]);

	if (!current) return null;

	const applyZoom = (value: number) => {
		const nextZoom = Math.min(3, Math.max(0.5, value));
		setZoom(nextZoom);
		if (nextZoom <= 1) setPan({ x: 0, y: 0 });
	};
	const changeZoom = (delta: number) => applyZoom(zoom + delta);
	const move = (delta: number) => {
		setIndex((value) => (value + delta + items.length) % items.length);
		setZoom(1);
		setPan({ x: 0, y: 0 });
	};
	const handleWheel = (event: WheelEvent<HTMLDivElement>) => {
		event.preventDefault();
		changeZoom(event.deltaY < 0 ? 0.1 : -0.1);
	};
	const handleTouchStart = (event: TouchEvent<HTMLDivElement>) => {
		const distance = touchDistance(event.touches);
		if (distance === undefined) return;
		event.preventDefault();
		pinchStartDistanceRef.current = distance;
		pinchStartZoomRef.current = zoom;
	};
	const handleTouchMove = (event: TouchEvent<HTMLDivElement>) => {
		const startDistance = pinchStartDistanceRef.current;
		const distance = touchDistance(event.touches);
		if (startDistance === undefined || distance === undefined) return;
		event.preventDefault();
		const nextZoom = pinchStartZoomRef.current * (distance / startDistance);
		applyZoom(nextZoom);
	};
	const handleTouchEnd = (event: TouchEvent<HTMLDivElement>) => {
		if (event.touches.length < 2) pinchStartDistanceRef.current = undefined;
	};
	const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
		if (
			event.pointerType !== "mouse" ||
			event.button !== 0 ||
			!source ||
			zoom <= 1 ||
			!(event.target instanceof HTMLImageElement)
		) {
			return;
		}
		event.preventDefault();
		dragPointerIdRef.current = event.pointerId;
		dragStartRef.current = { x: event.clientX, y: event.clientY };
		dragOriginRef.current = pan;
		setDragging(true);
		event.currentTarget.setPointerCapture(event.pointerId);
	};
	const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
		if (dragPointerIdRef.current !== event.pointerId || !dragStartRef.current) return;
		event.preventDefault();
		setPan({
			x: dragOriginRef.current.x + event.clientX - dragStartRef.current.x,
			y: dragOriginRef.current.y + event.clientY - dragStartRef.current.y,
		});
	};
	const handlePointerEnd = (event: PointerEvent<HTMLDivElement>) => {
		if (dragPointerIdRef.current !== event.pointerId) return;
		if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
		dragPointerIdRef.current = undefined;
		dragStartRef.current = undefined;
		setDragging(false);
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
	const copyPrompt = async () => {
		const prompt = current.generation?.prompt;
		if (!prompt || !navigator.clipboard?.writeText) return;
		await navigator.clipboard.writeText(prompt);
		setCopiedPrompt(true);
	};

	if (current.generation) {
		return (
			<Dialog open={open} onOpenChange={onOpenChange}>
				<DialogContent
					showCloseButton={false}
					overlayClassName="z-[100] bg-black/35"
					className="fixed inset-0 z-[100] flex h-dvh w-screen max-w-none translate-x-0 translate-y-0 flex-col gap-0 overflow-hidden rounded-none border-0 bg-background p-0 text-foreground shadow-none sm:max-w-none"
				>
					<header className="flex h-14 shrink-0 items-center gap-3 border-b border-border px-4">
						<DialogTitle className="min-w-0 flex-1 truncate text-sm font-medium">
							{resourceFileName(current, index)}
						</DialogTitle>
						<Button
							className="h-8 gap-1.5 px-2.5"
							disabled={!source}
							onClick={download}
							size="sm"
							type="button"
							variant="outline"
						>
							<DownloadIcon className="size-4" />
							下载
						</Button>
						<Button
							aria-label="关闭图片预览"
							className="size-8"
							onClick={() => onOpenChange(false)}
							size="icon-sm"
							type="button"
							variant="ghost"
						>
							<XIcon className="size-5" />
						</Button>
					</header>

					<div className="grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)_minmax(12rem,42vh)] lg:grid-cols-[minmax(0,1fr)_22rem] lg:grid-rows-1">
						<div
							className={cn(
								"relative flex min-h-0 touch-none items-center justify-center overflow-hidden bg-muted/30 p-6 cursor-grab",
								dragging && "cursor-grabbing",
							)}
							onWheel={handleWheel}
							onTouchStart={handleTouchStart}
							onTouchMove={handleTouchMove}
							onTouchEnd={handleTouchEnd}
							onTouchCancel={handleTouchEnd}
							onPointerDown={handlePointerDown}
							onPointerMove={handlePointerMove}
							onPointerUp={handlePointerEnd}
							onPointerCancel={handlePointerEnd}
						>
							{items.length > 1 ? (
								<Button
									aria-label="上一张图片"
									className="absolute left-4 z-10 rounded-full bg-background/90 shadow-sm"
									onClick={() => move(-1)}
									size="icon"
									type="button"
									variant="outline"
								>
									<ChevronLeftIcon className="size-5" />
								</Button>
							) : null}
							{source ? (
								<img
									className={cn(
										"max-h-full max-w-full select-none object-contain",
										!dragging && "transition-transform duration-100 ease-out",
									)}
									src={source}
									alt={current.alt ?? "图片"}
									draggable={false}
									style={{ transform: `translate3d(${pan.x}px, ${pan.y}px, 0) scale(${zoom})` }}
								/>
							) : loading ? (
								<LoaderCircleIcon className="size-8 animate-spin text-muted-foreground" />
							) : (
								<span className="text-sm text-muted-foreground">
									{failed ? "图片暂时无法预览" : "没有图片内容"}
								</span>
							)}
							{items.length > 1 ? (
								<Button
									aria-label="下一张图片"
									className="absolute right-4 z-10 rounded-full bg-background/90 shadow-sm"
									onClick={() => move(1)}
									size="icon"
									type="button"
									variant="outline"
								>
									<ChevronRightIcon className="size-5" />
								</Button>
							) : null}
							<div className="absolute inset-x-0 bottom-5 flex justify-center px-4">
								<div className="flex items-center gap-1 rounded-lg border border-border bg-background p-1 shadow-sm">
									<Button aria-label="缩小图片" onClick={() => changeZoom(-0.1)} size="icon-sm" type="button" variant="ghost">
										<MinusIcon className="size-4" />
									</Button>
									<span className="min-w-12 px-1 text-center text-xs tabular-nums text-muted-foreground">
										{Math.round(zoom * 100)}%
									</span>
									<Button aria-label="放大图片" onClick={() => changeZoom(0.1)} size="icon-sm" type="button" variant="ghost">
										<PlusIcon className="size-4" />
									</Button>
								</div>
							</div>
						</div>

						<aside className="min-h-0 overflow-y-auto border-t border-border bg-background p-6 lg:border-t-0 lg:border-l">
							<div className="flex items-center gap-2">
								<ImageIcon className="size-5" />
								<h2 className="text-base font-medium">图片详情</h2>
							</div>
							{current.generation.model ? (
								<div className="mt-6 grid gap-2">
									<div className="text-xs text-muted-foreground">生成模型</div>
									<div className="break-all font-mono text-[13px] leading-5">{current.generation.model}</div>
								</div>
							) : null}
							{current.generation.prompt ? (
								<div className="mt-6 border-t border-border pt-6">
									<div className="flex items-center justify-between gap-3">
										<div className="text-xs text-muted-foreground">提示词</div>
										<Button
											className="h-8 gap-1.5 px-2 text-muted-foreground"
											onClick={() => void copyPrompt()}
											size="sm"
											type="button"
											variant="ghost"
										>
											<CopyIcon className="size-4" />
											{copiedPrompt ? "已复制" : "复制"}
										</Button>
									</div>
									<p className="mt-3 whitespace-pre-wrap break-words text-sm leading-6">{current.generation.prompt}</p>
								</div>
							) : null}
						</aside>
					</div>
				</DialogContent>
			</Dialog>
		);
	}

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent
				showCloseButton={false}
				overlayClassName="z-[100] bg-black/80"
				className="fixed inset-0 z-[100] flex h-dvh w-screen max-w-none translate-x-0 translate-y-0 flex-col gap-0 overflow-hidden rounded-none border-0 bg-black p-0 text-white shadow-none sm:max-w-none"
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

				<div
					className={cn(
						"relative flex min-h-0 flex-1 touch-none items-center justify-center overflow-hidden px-16 py-16 cursor-grab sm:px-24",
						dragging && "cursor-grabbing",
					)}
					onWheel={handleWheel}
					onTouchStart={handleTouchStart}
					onTouchMove={handleTouchMove}
					onTouchEnd={handleTouchEnd}
					onTouchCancel={handleTouchEnd}
					onPointerDown={handlePointerDown}
					onPointerMove={handlePointerMove}
					onPointerUp={handlePointerEnd}
					onPointerCancel={handlePointerEnd}
				>
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
							className={cn(
								"max-h-[calc(100dvh-8rem)] max-w-[calc(100vw-8rem)] select-none object-contain",
								!dragging && "transition-transform duration-100 ease-out",
							)}
							src={source}
							alt={current.alt ?? "图片"}
							draggable={false}
							style={{ transform: `translate3d(${pan.x}px, ${pan.y}px, 0) scale(${zoom})` }}
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
	projectId,
	sessionId,
	contentRef,
	alt = "图片",
	generation,
	className,
	imageClassName,
	buttonClassName,
	onOpenPath,
	onPreview,
}: ResourceImageProps) {
	const item: ResourceImageItem = {
		id: contentRef ?? path ?? src ?? alt,
		src,
		path,
		pathLabel,
		projectId,
		sessionId,
		contentRef,
		alt,
		generation,
	};
	const { source, loading, failed } = useResourceImageSource(item);
	const [open, setOpen] = useState(false);
	const displayPath = pathLabel ?? path;

	return (
		<>
			<div className={cn("grid min-w-0 gap-1.5", className)}>
				<button
					className={cn("group relative flex min-h-24 w-fit max-w-full items-center justify-center overflow-hidden rounded-xl border border-border bg-muted/30 text-left transition-colors hover:border-primary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", buttonClassName)}
					disabled={!source}
					onClick={() => (onPreview ? onPreview() : setOpen(true))}
					type="button"
					aria-label={`放大${alt}`}
				>
					{source ? (
						<img className={cn("max-h-72 max-w-full object-contain", imageClassName)} src={source} alt={alt} />
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
						projectId={item.projectId}
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
