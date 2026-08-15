import type { Component } from "./tui.ts";

export interface HeadlessFrame {
	lines: string[];
	cursor?: { row: number; column: number };
	hitRegions: [];
}

export interface HeadlessComponentAdapter {
	input(data: string): HeadlessFrame;
	resize(width: number, height: number): HeadlessFrame;
	requestRender(): HeadlessFrame;
	invalidate(): HeadlessFrame;
	dispose(): void;
}

/**
 * 兼容桥只投影 Component 输出；终端、焦点和 alternate screen 仍由外层前端负责。
 */
export function createHeadlessComponentAdapter(
	component: Component & { dispose?(): void },
	options: { width: number; height: number; onInvalidate?: () => void },
): HeadlessComponentAdapter {
	let width = options.width;
	let height = options.height;
	let disposed = false;
	const render = (): HeadlessFrame => ({
		lines: disposed ? [] : component.render(width).slice(0, Math.max(0, height)),
		hitRegions: [],
	});
	return {
		input(data) {
			if (!disposed) component.handleInput?.(data);
			return render();
		},
		resize(nextWidth, nextHeight) {
			width = nextWidth;
			height = nextHeight;
			return render();
		},
		requestRender() {
			options.onInvalidate?.();
			return render();
		},
		invalidate() {
			if (!disposed) component.invalidate();
			options.onInvalidate?.();
			return render();
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			component.dispose?.();
		},
	};
}
