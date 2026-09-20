"use client";

// 引入自 beUI Image Generation（https://beui.dev/components/agents/image-generation），保留其媒体框、
// 点阵占位画布、状态行与重试按钮。与 beUI 原版的差异：状态文案改为中文；resolution 不再给默认值，
// 没有真实分辨率时不显示角标；媒体改由调用方按需传入。

import { Check, CircleAlert, RotateCcw } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import type { CSSProperties, ReactNode } from "react";
import { memo, useEffect, useRef } from "react";
import { EASE_IN_OUT, EASE_OUT, SPRING_PRESS } from "@/lib/ease";
import { useHoverCapable } from "@/lib/hooks/use-hover-capable";
import { cn } from "@/lib/utils";

export type ImageGenerationStatus = "queued" | "generating" | "refining" | "complete" | "error";

export interface ImageGenerationProps {
	/** 已生成的媒体内容：img、canvas、video 或自定义预览。 */
	children?: ReactNode;
	status?: ImageGenerationStatus;
	/** 无障碍描述，缺省时由状态文案和提示词组合。 */
	label?: string;
	prompt?: string;
	/** 有真实分辨率时才传，否则不显示角标。 */
	resolution?: string;
	/** 媒体就绪前预留的画布比例。 */
	aspectRatio?: CSSProperties["aspectRatio"];
	size?: "compact" | "fluid";
	/** 悬停时点阵是否跟随精细指针。 */
	interactive?: boolean;
	statusText?: string;
	showStatus?: boolean;
	onRetry?: () => void;
	/** 点击媒体区域（例如打开大图）。媒体本身在 role="img" 内，指针操作走这里，键盘入口由调用方另行提供。 */
	onMediaClick?: () => void;
	className?: string;
	mediaClassName?: string;
	statusClassName?: string;
}

const STATUS_TEXT: Record<ImageGenerationStatus, string> = {
	queued: "等待生成",
	generating: "正在生成图片",
	refining: "正在细化细节",
	complete: "图片已生成",
	error: "生成失败",
};

const MEDIA_STATE: Record<ImageGenerationStatus, { filter: string; opacity: number; scale: number }> = {
	queued: { filter: "blur(4px) saturate(0.75)", opacity: 0, scale: 1.02 },
	generating: { filter: "blur(3px) saturate(0.85)", opacity: 0, scale: 1.015 },
	refining: { filter: "blur(1.5px) saturate(0.95)", opacity: 0.62, scale: 1.005 },
	complete: { filter: "blur(0px) saturate(1)", opacity: 1, scale: 1 },
	error: { filter: "blur(2px) saturate(0.5)", opacity: 0.28, scale: 1 },
};

const OVERLAY_OPACITY: Record<ImageGenerationStatus, number> = {
	queued: 1,
	generating: 1,
	refining: 0.48,
	complete: 0,
	error: 0,
};

const DOT_GAP = 10;
const TWO_PI = Math.PI * 2;

function DitherMark({ status, reduce }: { status: ImageGenerationStatus; reduce: boolean }) {
	if (status === "complete") {
		return <Check aria-hidden="true" className="size-3.5" />;
	}

	if (status === "error") {
		return <CircleAlert aria-hidden="true" className="size-3.5" />;
	}

	return (
		<motion.span
			aria-hidden="true"
			animate={reduce ? undefined : { rotate: 360 }}
			transition={{ duration: 2.4, ease: EASE_IN_OUT, repeat: Number.POSITIVE_INFINITY }}
			className="grid size-3.5 grid-cols-2 place-items-center gap-0.5"
		>
			<span className="size-1 rounded-[1px] bg-current" />
			<span className="size-1 rounded-[1px] bg-current opacity-55" />
			<span className="size-1 rounded-[1px] bg-current opacity-55" />
			<span className="size-1 rounded-[1px] bg-current" />
		</motion.span>
	);
}

// 生成中的点阵占位：网格点按到光标的距离被推开并变大，没有指针时按正弦轨迹自行游走。
const DitherField = memo(function DitherField({
	interactive,
	reduce,
	status,
}: {
	interactive: boolean;
	reduce: boolean;
	status: ImageGenerationStatus;
}) {
	const canHover = useHoverCapable();
	const canvasRef = useRef<HTMLCanvasElement>(null);

	useEffect(() => {
		const canvas = canvasRef.current;
		const context = canvas?.getContext("2d");
		if (!canvas || !context) return;

		let frame = 0;
		let width = 0;
		let height = 0;
		let dotColor = "currentColor";
		const dots: Array<{ x: number; y: number }> = [];
		const pointer = { x: 0, y: 0, targetX: 0, targetY: 0, inside: false };
		const pointerEnabled = interactive && canHover && !reduce;

		const resize = () => {
			const rect = canvas.getBoundingClientRect();
			width = rect.width || canvas.clientWidth || 208;
			height = rect.height || canvas.clientHeight || 208;
			const dpr = Math.min(window.devicePixelRatio || 1, 2);

			canvas.width = Math.round(width * dpr);
			canvas.height = Math.round(height * dpr);
			context.setTransform(dpr, 0, 0, dpr, 0, 0);
			dotColor = window.getComputedStyle(canvas).color;
			pointer.x = width / 2;
			pointer.y = height / 2;
			pointer.targetX = pointer.x;
			pointer.targetY = pointer.y;

			dots.length = 0;
			const columns = Math.ceil(width / DOT_GAP) + 1;
			const rows = Math.ceil(height / DOT_GAP) + 1;
			const offsetX = (width - (columns - 1) * DOT_GAP) / 2;
			const offsetY = (height - (rows - 1) * DOT_GAP) / 2;
			for (let row = 0; row < rows; row += 1) {
				for (let column = 0; column < columns; column += 1) {
					dots.push({ x: offsetX + column * DOT_GAP, y: offsetY + row * DOT_GAP });
				}
			}
		};

		const draw = (time: number) => {
			context.clearRect(0, 0, width, height);

			if (!pointer.inside) {
				pointer.targetX = width / 2 + (reduce ? 0 : Math.sin(time / 1700) * width * 0.12);
				pointer.targetY = height / 2 + (reduce ? 0 : Math.cos(time / 2100) * height * 0.1);
			}

			const follow = reduce ? 1 : pointer.inside ? 0.16 : 0.045;
			pointer.x += (pointer.targetX - pointer.x) * follow;
			pointer.y += (pointer.targetY - pointer.y) * follow;

			const radius = Math.min(width, height) * 0.38;

			context.fillStyle = dotColor;

			for (const dot of dots) {
				const deltaX = dot.x - pointer.x;
				const deltaY = dot.y - pointer.y;
				const distance = Math.hypot(deltaX, deltaY);
				const proximity = Math.max(0, 1 - distance / radius);
				const influence = proximity * proximity * (3 - 2 * proximity);
				const displacement = influence * influence * 9;
				const directionX = distance > 0 ? deltaX / distance : 0;
				const directionY = distance > 0 ? deltaY / distance : 0;
				const x = dot.x + directionX * displacement;
				const y = dot.y + directionY * displacement;
				const dotRadius = 0.65 + influence * 0.85;

				context.globalAlpha = 0.17 + influence * 0.72;
				context.beginPath();
				context.arc(x, y, dotRadius, 0, TWO_PI);
				context.fill();
			}

			context.globalAlpha = 1;
			if (!reduce) frame = window.requestAnimationFrame(draw);
		};

		const handlePointerMove = (event: PointerEvent) => {
			if (!pointerEnabled) return;
			const rect = canvas.getBoundingClientRect();
			pointer.inside = true;
			pointer.targetX = event.clientX - rect.left;
			pointer.targetY = event.clientY - rect.top;
		};

		const handlePointerLeave = () => {
			pointer.inside = false;
		};

		const resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(resize);

		resize();
		resizeObserver?.observe(canvas);
		canvas.addEventListener("pointermove", handlePointerMove, { passive: true });
		canvas.addEventListener("pointerleave", handlePointerLeave);
		draw(0);

		return () => {
			if (frame) window.cancelAnimationFrame(frame);
			resizeObserver?.disconnect();
			canvas.removeEventListener("pointermove", handlePointerMove);
			canvas.removeEventListener("pointerleave", handlePointerLeave);
		};
	}, [canHover, interactive, reduce]);

	return (
		<motion.div
			aria-hidden="true"
			initial={false}
			animate={{ opacity: OVERLAY_OPACITY[status] }}
			transition={{ duration: reduce ? 0 : 0.4, ease: EASE_OUT }}
			className="absolute inset-0 overflow-hidden bg-muted"
		>
			<canvas ref={canvasRef} className="absolute inset-0 size-full text-foreground" />
		</motion.div>
	);
});

export const ImageGeneration = memo(function ImageGeneration({
	children,
	status = "generating",
	label,
	prompt,
	resolution,
	aspectRatio = "1 / 1",
	size = "compact",
	interactive = true,
	statusText,
	showStatus = true,
	onRetry,
	onMediaClick,
	className,
	mediaClassName,
	statusClassName,
}: ImageGenerationProps) {
	const reduce = useReducedMotion() ?? false;
	const active = status === "queued" || status === "generating" || status === "refining";
	const mediaState = MEDIA_STATE[status];
	const resolvedStatusText = statusText ?? STATUS_TEXT[status];
	const resolvedLabel = label ?? (prompt ? `${resolvedStatusText}：${prompt}` : resolvedStatusText);

	return (
		<div data-slot="image-generation" data-state={status} aria-busy={active} className={cn("w-full", className)}>
			<div className={cn("w-full", size === "compact" && "mx-auto max-w-52")}>
				<div
					role="img"
					aria-label={resolvedLabel}
					style={{ aspectRatio }}
					className="relative isolate w-full overflow-hidden rounded-xl bg-muted"
				>
					<motion.div
						aria-hidden={children ? undefined : true}
						initial={false}
						animate={
							reduce
								? { opacity: mediaState.opacity }
								: { filter: mediaState.filter, opacity: mediaState.opacity, scale: mediaState.scale }
						}
						transition={reduce ? { duration: 0 } : { duration: 0.4, ease: EASE_OUT }}
						onClick={onMediaClick}
						className={cn(
							"absolute inset-0 [&>*]:size-full [&>*]:object-cover [&_img]:size-full [&_img]:object-cover",
							onMediaClick && "cursor-zoom-in",
							mediaClassName,
						)}
					>
						{children}
					</motion.div>

					<AnimatePresence initial={false}>
						{active ? (
							<motion.div
								key="dither-field"
								initial={{ opacity: 0 }}
								animate={{ opacity: 1 }}
								exit={{ opacity: 0 }}
								transition={{ duration: reduce ? 0 : 0.25, ease: EASE_OUT }}
								className="absolute inset-0"
							>
								<DitherField interactive={interactive} reduce={reduce} status={status} />
							</motion.div>
						) : null}
					</AnimatePresence>

					{resolution ? (
						<span className="absolute top-2 right-2 z-10 rounded-full bg-background/75 px-2 py-0.5 font-mono text-[10px] tabular-nums text-muted-foreground">
							{resolution}
						</span>
					) : null}
				</div>

				{showStatus || prompt ? (
					<div className="mt-3 text-left">
						{showStatus ? (
							<div
								aria-live="polite"
								className={cn(
									"flex min-h-5 items-center gap-2 text-sm font-medium text-foreground",
									status === "error" && "text-destructive",
									statusClassName,
								)}
							>
								<DitherMark status={status} reduce={reduce} />
								<AnimatePresence mode="popLayout" initial={false}>
									<motion.span
										key={resolvedStatusText}
										initial={reduce ? false : { opacity: 0, y: 4 }}
										animate={{ opacity: 1, y: 0 }}
										exit={reduce ? undefined : { opacity: 0, y: -4 }}
										transition={{ duration: reduce ? 0 : 0.15, ease: EASE_OUT }}
									>
										{resolvedStatusText}
									</motion.span>
								</AnimatePresence>
							</div>
						) : null}
						{prompt ? <p className="mt-0.5 truncate text-xs text-muted-foreground">“{prompt}”</p> : null}
					</div>
				) : null}

				{status === "error" && onRetry ? (
					<motion.button
						type="button"
						onClick={onRetry}
						whileTap={reduce ? undefined : { scale: 0.96 }}
						transition={SPRING_PRESS}
						className="mt-3 inline-flex min-h-10 items-center gap-2 rounded-full px-3 text-sm font-medium text-foreground outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
					>
						<RotateCcw aria-hidden="true" className="size-4" />
						重新生成
					</motion.button>
				) : null}
			</div>
		</div>
	);
});
