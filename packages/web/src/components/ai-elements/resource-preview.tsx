"use client";

import { LoaderCircleIcon, ZoomInIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { webApi } from "../../adapters/host-protocol/api.ts";
import type { FileResponse } from "../../types.ts";
import { Dialog, DialogContent, DialogTitle } from "../ui/dialog";

export interface ResourceImageProps {
	src?: string;
	path?: string;
	pathLabel?: string;
	sessionId?: string;
	contentRef?: string;
	alt?: string;
	className?: string;
	onOpenPath?: (path: string) => void;
}

function imageDataUrl(result: FileResponse): string | undefined {
	if (result.kind !== "image" || !result.data) return undefined;
	return `data:${result.mimeType};base64,${result.data}`;
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
}: ResourceImageProps) {
	const [source, setSource] = useState(src);
	const [open, setOpen] = useState(false);
	const [loading, setLoading] = useState(!src && Boolean(path || (sessionId && contentRef)));
	const [failed, setFailed] = useState(false);
	const displayPath = pathLabel ?? path;

	useEffect(() => {
		let cancelled = false;
		setSource(src);
		setFailed(false);
		if (src || (!path && !(sessionId && contentRef))) {
			setLoading(false);
			return;
		}
		setLoading(true);
		const load = path
			? webApi.externalFile(path).then(imageDataUrl)
			: webApi
					.readImageContent(sessionId!, contentRef!)
					.then((result) => `data:${result.mimeType};base64,${result.data}`);
		void load
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
	}, [contentRef, path, sessionId, src]);

	return (
		<>
			<div className={cn("grid min-w-0 gap-1.5", className)}>
				<button
					className="group relative flex min-h-24 w-fit max-w-full items-center justify-center overflow-hidden rounded-xl border border-border bg-muted/30 text-left transition-colors hover:border-primary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
					disabled={!source}
					onClick={() => setOpen(true)}
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
			<Dialog open={open} onOpenChange={setOpen}>
				<DialogContent className="flex h-[min(92vh,900px)] w-[min(96vw,1400px)] max-w-none items-center justify-center border-0 bg-black/90 p-3 shadow-2xl">
					<DialogTitle className="sr-only">{alt}</DialogTitle>
					{source ? (
						<img className="max-h-[calc(92vh-2rem)] max-w-full object-contain" src={source} alt={alt} />
					) : null}
				</DialogContent>
			</Dialog>
		</>
	);
}
