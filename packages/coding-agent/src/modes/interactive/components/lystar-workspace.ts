import type { Component } from "@earendil-works/pi-tui";
import { type Container, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { t } from "../../../locales/zh-CN.ts";
import { theme } from "../theme/theme.ts";

interface RenderedComponentRange {
	component: Component;
	start: number;
	end: number;
}

export interface WorkspaceHeaderState {
	path: string;
	session?: string;
	context: string;
}

export class WorkspaceHeader implements Component {
	private readonly version: string;
	private readonly getState: () => WorkspaceHeaderState;

	constructor(version: string, getState: () => WorkspaceHeaderState) {
		this.version = version;
		this.getState = getState;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const state = this.getState();
		const brand = theme.bold(theme.fg("accent", "LYStar Agent")) + theme.fg("dim", ` v${this.version}`);
		const context = theme.fg("muted", state.context);
		const brandWidth = visibleWidth(brand);
		const contextWidth = visibleWidth(context);
		const firstLine =
			brandWidth + contextWidth + 2 <= width
				? `${brand}${" ".repeat(width - brandWidth - contextWidth)}${context}`
				: truncateToWidth(`${brand}  ${context}`, width, "");
		const location = state.session ? `${state.path}  ·  ${state.session}` : state.path;
		const secondLine = truncateToWidth(theme.fg("dim", location), width, theme.fg("dim", "..."));
		return [firstLine, secondLine, theme.fg("border", "─".repeat(Math.max(0, width)))];
	}
}

export interface WorkspaceOptions {
	getHeight: () => number;
	header: Container;
	scrollContainers: Container[];
	bottomContainers: Container[];
	fullscreen: boolean;
}

export class LystarWorkspace implements Component {
	private readonly options: WorkspaceOptions;
	private following = true;
	private scrollTop = 0;
	private viewportScreenTop = 0;
	private viewportHeight = 0;
	private contentRanges: RenderedComponentRange[] = [];
	private indicatorRow = -1;

	constructor(options: WorkspaceOptions) {
		this.options = options;
	}

	invalidate(): void {
		this.options.header.invalidate();
		for (const component of this.options.scrollContainers) component.invalidate();
		for (const component of this.options.bottomContainers) component.invalidate();
	}

	isFullscreen(): boolean {
		return this.options.fullscreen;
	}

	isFollowing(): boolean {
		return this.following;
	}

	scrollBy(lines: number): void {
		if (!this.options.fullscreen || lines === 0) return;
		const maxScrollTop = this.getMaxScrollTop();
		this.scrollTop = Math.max(0, Math.min(maxScrollTop, this.scrollTop + lines));
		this.following = this.scrollTop >= maxScrollTop;
	}

	pageUp(): void {
		this.scrollBy(-Math.max(1, this.viewportHeight - 2));
	}

	pageDown(): void {
		this.scrollBy(Math.max(1, this.viewportHeight - 2));
	}

	scrollToTop(): void {
		if (!this.options.fullscreen) return;
		this.scrollTop = 0;
		this.following = false;
	}

	scrollToBottom(): void {
		if (!this.options.fullscreen) return;
		this.following = true;
		this.scrollTop = this.getMaxScrollTop();
	}

	getComponentAtScreenRow(row: number): Component | undefined {
		if (
			!this.options.fullscreen ||
			row < this.viewportScreenTop ||
			row >= this.viewportScreenTop + this.viewportHeight
		) {
			return undefined;
		}
		if (row === this.indicatorRow) return undefined;
		const contentRow = this.scrollTop + row - this.viewportScreenTop;
		return this.contentRanges.find((range) => contentRow >= range.start && contentRow < range.end)?.component;
	}

	isNewContentIndicatorRow(row: number): boolean {
		return row === this.indicatorRow;
	}

	render(width: number): string[] {
		const headerLines = this.options.header.render(width);
		const { lines: contentLines, ranges } = this.renderScrollContent(width);
		const bottomLines = this.options.bottomContainers.flatMap((component) => component.render(width));
		this.contentRanges = ranges;

		if (!this.options.fullscreen) {
			this.viewportScreenTop = headerLines.length;
			this.viewportHeight = contentLines.length;
			this.scrollTop = 0;
			this.indicatorRow = -1;
			return [...headerLines, ...contentLines, ...bottomLines];
		}

		const height = Math.max(1, this.options.getHeight());
		const maxHeaderHeight = Math.min(4, Math.max(0, height - 1));
		const visibleHeader = headerLines.slice(0, maxHeaderHeight);
		const maxBottomHeight = Math.max(0, height - visibleHeader.length - 1);
		const visibleBottom = bottomLines.slice(0, maxBottomHeight);
		this.viewportHeight = Math.max(1, height - visibleHeader.length - visibleBottom.length);
		this.viewportScreenTop = visibleHeader.length;

		const maxScrollTop = Math.max(0, contentLines.length - this.viewportHeight);
		if (this.following) {
			this.scrollTop = maxScrollTop;
		} else {
			this.scrollTop = Math.max(0, Math.min(this.scrollTop, maxScrollTop));
			if (this.scrollTop >= maxScrollTop) this.following = true;
		}

		const viewport = contentLines.slice(this.scrollTop, this.scrollTop + this.viewportHeight);
		while (viewport.length < this.viewportHeight) viewport.push("");
		this.indicatorRow = -1;
		if (!this.following && this.scrollTop < maxScrollTop && viewport.length > 0) {
			const remaining = maxScrollTop - this.scrollTop;
			viewport[viewport.length - 1] = truncateToWidth(
				theme.fg("accent", t("workspace.moreLines", { count: remaining })),
				width,
				"",
			);
			this.indicatorRow = this.viewportScreenTop + viewport.length - 1;
		}

		return [...visibleHeader, ...viewport, ...visibleBottom];
	}

	private getMaxScrollTop(): number {
		const contentHeight = this.contentRanges.reduce((height, range) => Math.max(height, range.end), 0);
		return Math.max(0, contentHeight - this.viewportHeight);
	}

	private renderScrollContent(width: number): { lines: string[]; ranges: RenderedComponentRange[] } {
		const lines: string[] = [];
		const ranges: RenderedComponentRange[] = [];
		for (const container of this.options.scrollContainers) {
			for (const component of container.children) {
				const start = lines.length;
				lines.push(...component.render(width));
				if (lines.length > start) ranges.push({ component, start, end: lines.length });
			}
		}
		return { lines, ranges };
	}
}
