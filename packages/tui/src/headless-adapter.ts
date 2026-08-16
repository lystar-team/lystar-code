import { performance } from "node:perf_hooks";
import type { Component, Focusable, OverlayHandle, OverlayOptions, TUI } from "./tui.ts";
import { CURSOR_MARKER } from "./tui.ts";
import { visibleWidth } from "./utils.ts";

const MAX_FRAME_LINES = 500;
const MAX_FRAME_BYTES = 512 * 1024;
const FRAME_INTERVAL_MS = 1000 / 60;

export interface HeadlessTerminalOwnershipViolation {
	type: "terminal_ownership_violation";
	componentId: string;
	operation: string;
}

export interface HeadlessFrame {
	componentId: string;
	revision: number;
	width: number;
	height: number;
	lines: string[];
	cursor?: { row: number; column: number };
	hitRegions: Array<{ kind: "component"; row: number; column: number; width: number }>;
	desiredSize?: { width?: number; height?: number };
}

export interface HeadlessComponentAdapter {
	input(data: string): HeadlessFrame;
	resize(width: number, height: number): HeadlessFrame;
	requestRender(): HeadlessFrame;
	invalidate(): HeadlessFrame;
	renderNow(): HeadlessFrame;
	render(): HeadlessFrame;
	dispose(): void;
}

export interface HeadlessTuiFacadeOptions {
	componentId: string;
	width: number;
	height: number;
	onRequestRender: () => void;
	onTerminalOwnershipViolation?: (violation: HeadlessTerminalOwnershipViolation) => void;
}

function clampDimension(value: number): number {
	return Number.isFinite(value) ? Math.max(0, Math.min(10_000, Math.floor(value))) : 0;
}

export function sanitizeHeadlessFrameLine(value: string, limit = 4096): string {
	let output = "";
	let index = 0;
	while (index < value.length && output.length < limit) {
		const character = value[index]!;
		if (character !== "\x1b") {
			if (character >= " " && character !== "\x7f") output += character;
			index++;
			continue;
		}
		const next = value[index + 1];
		if (next === "[") {
			const end = value.slice(index + 2).search(/[@-~]/);
			if (end >= 0) {
				const finish = index + 2 + end;
				const sequence = value.slice(index, finish + 1);
				if (value[finish] === "m" && /^\x1b\[[0-9;?]*m$/.test(sequence)) output += sequence;
				index = finish + 1;
				continue;
			}
		}
		if (next === "]") {
			const bell = value.indexOf("\x07", index + 2);
			const st = value.indexOf("\x1b\\", index + 2);
			const end = bell >= 0 && (st < 0 || bell < st) ? bell : st;
			if (end >= 0) {
				const content = value.slice(index + 2, end);
				if (
					content === "8;;" ||
					/^8;;(?:https:\/\/|http:\/\/|mailto:|file:\/\/)[^\s\x00-\x1f\x7f-\x9f]+$/.test(content)
				) {
					output += `\x1b]${content}\x1b\\`;
				}
				index = end + (end === st ? 2 : 1);
				continue;
			}
		}
		index++;
	}
	return output;
}

function ownershipError(options: HeadlessTuiFacadeOptions, operation: string): never {
	options.onTerminalOwnershipViolation?.({
		type: "terminal_ownership_violation",
		componentId: options.componentId,
		operation,
	});
	throw Object.assign(new Error(`Component ${options.componentId} attempted terminal operation: ${operation}`), {
		code: "terminal_ownership_violation",
	});
}

/**
 * 给 Extension Component 的最小 TUI 外观。它绝不取得 stdin/stdout、raw mode 或 alternate-screen 所有权。
 */
export function createHeadlessTuiFacade(options: HeadlessTuiFacadeOptions): TUI {
	let width = clampDimension(options.width);
	let height = clampDimension(options.height);
	let focused: Component | null = null;
	let hardwareCursor = true;
	let overlayHidden = false;
	const terminal = new Proxy(
		{},
		{
			get(_target, property) {
				if (property === "columns") return width;
				if (property === "rows") return height;
				if (property === "write" || property === "start" || property === "stop" || property === "setRawMode") {
					return () => ownershipError(options, String(property));
				}
				if (typeof property === "string") return () => ownershipError(options, property);
				return undefined;
			},
		},
	);
	const facade = {
		mode: "fullscreen" as const,
		children: [] as Component[],
		terminal,
		fullRedraws: 0,
		addChild(component: Component) {
			this.children.push(component);
		},
		removeChild(component: Component) {
			const index = this.children.indexOf(component);
			if (index >= 0) this.children.splice(index, 1);
		},
		clear() {
			this.children.length = 0;
		},
		getShowHardwareCursor: () => hardwareCursor,
		setShowHardwareCursor(enabled: boolean) {
			hardwareCursor = enabled;
			options.onRequestRender();
		},
		getClearOnShrink: () => false,
		setClearOnShrink: () => {},
		reduceMotion: true,
		setReduceMotion: () => {},
		setFocus(component: Component | null) {
			if (focused && "focused" in focused) (focused as Component & Focusable).focused = false;
			focused = component;
			if (focused && "focused" in focused) (focused as Component & Focusable).focused = true;
			options.onRequestRender();
		},
		showOverlay(_component: Component, _overlayOptions?: OverlayOptions): OverlayHandle {
			return {
				hide: () => {
					overlayHidden = true;
					options.onRequestRender();
				},
				setHidden: (hidden: boolean) => {
					overlayHidden = hidden;
					options.onRequestRender();
				},
				isHidden: () => overlayHidden,
				focus: () => options.onRequestRender(),
				unfocus: () => options.onRequestRender(),
				isFocused: () => focused !== null && !overlayHidden,
			};
		},
		hideOverlay: () => {
			overlayHidden = true;
			options.onRequestRender();
		},
		hasOverlay: () => !overlayHidden,
		isOverlayFocused: () => focused !== null && !overlayHidden,
		start: () => ownershipError(options, "start"),
		stop: () => ownershipError(options, "stop"),
		renderNow: () => options.onRequestRender(),
		requestRender: () => options.onRequestRender(),
		addInputListener: () => () => {},
		removeInputListener: () => {},
		onTerminalColorSchemeChange: () => () => {},
		setTerminalColorSchemeNotifications: () => ownershipError(options, "setTerminalColorSchemeNotifications"),
		queryTerminalClipboard: async () => ownershipError(options, "queryTerminalClipboard"),
		queryTerminalBackgroundColor: async () => ownershipError(options, "queryTerminalBackgroundColor"),
		queryTerminalColorScheme: async () => ownershipError(options, "queryTerminalColorScheme"),
		invalidate: () => options.onRequestRender(),
		render: () => [],
	};
	Object.defineProperties(facade, {
		__setHeadlessSize: {
			value: (nextWidth: number, nextHeight: number) => {
				width = clampDimension(nextWidth);
				height = clampDimension(nextHeight);
			},
		},
	});
	return facade as unknown as TUI;
}

/**
 * 只投影 Component 输出。请求渲染按 60fps 合并，frame 内容和大小在桥接边界严格限制。
 */
export function createHeadlessComponentAdapter(
	component: Component & { dispose?(): void },
	options: {
		componentId?: string;
		generation?: number;
		width: number;
		height: number;
		onInvalidate?: () => void;
		onFrame?: (frame: HeadlessFrame) => void;
	},
): HeadlessComponentAdapter {
	const componentId = options.componentId ?? "headless-component";
	let width = clampDimension(options.width);
	let height = clampDimension(options.height);
	let revision = 0;
	let disposed = false;
	let scheduled = false;
	let invalidationScheduled = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let lastFrameAt = 0;
	let lastFrame: HeadlessFrame = { componentId, revision, width, height, lines: [], hitRegions: [] };
	const renderNow = (): HeadlessFrame => {
		if (disposed) return { componentId, revision, width, height, lines: [], hitRegions: [] };
		if (timer) clearTimeout(timer);
		timer = undefined;
		scheduled = false;
		const cursorMarkerLength = CURSOR_MARKER.length;
		let cursor: HeadlessFrame["cursor"];
		let bytes = 0;
		const lines: string[] = [];
		for (const line of component.render(width)) {
			if (lines.length >= Math.min(height, MAX_FRAME_LINES)) break;
			const marker = line.indexOf(CURSOR_MARKER);
			const visible = sanitizeHeadlessFrameLine(
				marker === -1 ? line : line.slice(0, marker) + line.slice(marker + cursorMarkerLength),
				MAX_FRAME_BYTES,
			);
			const nextBytes = bytes + Buffer.byteLength(visible);
			if (nextBytes > MAX_FRAME_BYTES) break;
			if (marker !== -1 && !cursor) cursor = { row: lines.length, column: visibleWidth(line.slice(0, marker)) };
			bytes = nextBytes;
			lines.push(visible);
		}
		lastFrameAt = performance.now();
		lastFrame = {
			componentId,
			revision: ++revision,
			width,
			height,
			lines,
			...(cursor === undefined ? {} : { cursor }),
			hitRegions: lines.map((line, row) => ({ kind: "component", row, column: 0, width: visibleWidth(line) })),
			...(typeof (component as { width?: unknown }).width === "number"
				? { desiredSize: { width: clampDimension((component as unknown as { width: number }).width) } }
				: {}),
		};
		return lastFrame;
	};
	const schedule = () => {
		if (disposed || scheduled) return;
		if (!invalidationScheduled) {
			invalidationScheduled = true;
			queueMicrotask(() => {
				invalidationScheduled = false;
				if (!disposed) options.onInvalidate?.();
			});
		}
		scheduled = true;
		const delay = Math.max(0, FRAME_INTERVAL_MS - (performance.now() - lastFrameAt));
		timer = setTimeout(() => {
			timer = undefined;
			scheduled = false;
			if (!disposed) options.onFrame?.(renderNow());
		}, delay);
		timer.unref?.();
	};
	return {
		input(data) {
			if (!disposed) component.handleInput?.(data);
			return renderNow();
		},
		resize(nextWidth, nextHeight) {
			width = clampDimension(nextWidth);
			height = clampDimension(nextHeight);
			return renderNow();
		},
		requestRender() {
			if (disposed) return { componentId, revision, width, height, lines: [], hitRegions: [] };
			schedule();
			return lastFrame;
		},
		invalidate() {
			if (disposed) return { componentId, revision, width, height, lines: [], hitRegions: [] };
			component.invalidate();
			schedule();
			return lastFrame;
		},
		render: renderNow,
		renderNow,
		dispose() {
			if (disposed) return;
			disposed = true;
			if (timer) clearTimeout(timer);
			timer = undefined;
			component.dispose?.();
		},
	};
}
