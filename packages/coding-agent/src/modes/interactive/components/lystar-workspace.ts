import type { Component } from "@earendil-works/pi-tui";
import { type Container, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { t } from "../../../locales/zh-CN.ts";
import { stripAnsi } from "../../../utils/ansi.ts";
import { theme } from "../theme/theme.ts";
import { uiGlyphs } from "../ui-glyphs.ts";

export interface WorkspaceComponentHit {
	component: Component;
	row: number;
}

interface RenderedComponentRange {
	component: Component;
	start: number;
	end: number;
}

interface RenderedComponentBlock extends RenderedComponentRange {
	index: number;
	lines: string[];
}

interface RenderVersionedComponent extends Component {
	getRenderVersion(): number;
}

function isRenderVersioned(component: Component): component is RenderVersionedComponent {
	return "getRenderVersion" in component && typeof component.getRenderVersion === "function";
}

export interface WorkspaceHeaderState {
	path: string;
	session?: string;
	context: string;
}

export class WorkspaceHeader implements Component {
	private readonly getState: () => WorkspaceHeaderState;

	constructor(getState: () => WorkspaceHeaderState) {
		this.getState = getState;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const state = this.getState();
		const location = state.session ? `${state.path}  ·  ${state.session}` : state.path;
		const left = theme.fg("dim", location);
		const right = theme.fg("text", state.context);
		const rightWidth = visibleWidth(right);
		if (rightWidth >= width) {
			return [truncateToWidth(right, width, theme.fg("dim", "..."))];
		}

		const leftMaxWidth = Math.max(0, width - rightWidth - 2);
		const visibleLeft = truncateToWidth(left, leftMaxWidth, theme.fg("dim", "..."));
		const gap = " ".repeat(Math.max(0, width - visibleWidth(visibleLeft) - rightWidth));
		return [`${visibleLeft}${gap}${right}`];
	}
}

export interface WorkspaceComposerOptions {
	editor: Container;
	structuredEditor?: Component & {
		renderWorkspace(width: number): { body: string[]; autocomplete: string[] };
	};
	getInfo: () => string;
	fullscreen: boolean;
}

export class WorkspaceComposer implements Component {
	private readonly options: WorkspaceComposerOptions;

	constructor(options: WorkspaceComposerOptions) {
		this.options = options;
	}

	invalidate(): void {
		this.options.editor.invalidate();
	}

	render(width: number): string[] {
		const editorWidth = this.options.fullscreen ? Math.max(1, width - 2) : width;
		if (!this.options.fullscreen || width < 4) return this.options.editor.render(editorWidth);
		const structuredEditor = this.options.structuredEditor;
		const structured =
			structuredEditor && this.options.editor.children.includes(structuredEditor)
				? structuredEditor.renderWorkspace(editorWidth)
				: undefined;
		const lines = structured ? [] : this.options.editor.render(editorWidth);
		if (!structured && lines.length === 0) return lines;

		const innerWidth = width - 2;
		const bottomBorder = structured
			? -1
			: lines.findIndex((line, index) => index > 0 && stripAnsi(line).startsWith("─"));
		const body = structured?.body ?? (bottomBorder > 0 ? lines.slice(1, bottomBorder) : lines);
		const autocomplete = structured?.autocomplete ?? (bottomBorder > 0 ? lines.slice(bottomBorder + 1) : []);
		const border = (text: string) => theme.fg("borderMuted", text);
		const visibleBody = body.length > 0 ? body : [""];
		const arrowRow = Math.floor(visibleBody.length / 2);
		const framedBody = visibleBody.map((line, index) => {
			let content = truncateToWidth(line, innerWidth, "", true);
			if (index === arrowRow && content.startsWith("  ")) {
				content = theme.fg("accent", `${uiGlyphs.prompt} `) + content.slice(2);
			}
			return `${border("│")}${content}${border("│")}`;
		});

		const info = truncateToWidth(this.options.getInfo().trim(), Math.max(0, innerWidth - 4), "…");
		const infoLabel = info ? ` ${info} ` : "";
		const dividerWidth = Math.max(0, innerWidth - visibleWidth(infoLabel));
		const bottom = `${border(`╰${"─".repeat(dividerWidth)}`)}${theme.fg("dim", infoLabel)}${border("╯")}`;
		const framed = [`${border("╭")}${border("─".repeat(innerWidth))}${border("╮")}`, ...framedBody, bottom];
		for (const line of autocomplete) {
			framed.push(` ${truncateToWidth(line, innerWidth, "", true)} `);
		}
		return framed;
	}
}

export interface WorkspaceOptions {
	getHeight: () => number;
	header: Container;
	scrollContainers: Container[];
	bottomContainers: Component[];
	fixedBottomContainers?: Component[];
	optionalBottomPriority?: Component[];
	fullscreen: boolean;
	horizontalPadding?: number;
}

export class LystarWorkspace implements Component {
	private readonly options: WorkspaceOptions;
	private following = true;
	private scrollTop = 0;
	private viewportScreenTop = 0;
	private viewportHeight = 0;
	private contentRanges: RenderedComponentRange[] = [];
	private blockCache = new Map<Component, { width: number; version: number; lines: string[] }>();
	private componentInvalidationGeneration = new WeakMap<Component, number>();
	private invalidationGeneration = 0;
	private scrollComponents: Component[] = [];
	private scrollContainerSnapshots: Array<{
		children: Component[];
		length: number;
		first: Component | undefined;
		last: Component | undefined;
	}> = [];
	private historyStartIndex = 0;
	private historyEndIndex = 0;
	private jumpToTop = false;
	private hasNewerHistory = false;
	private indicatorRow = -1;

	constructor(options: WorkspaceOptions) {
		this.options = options;
	}

	invalidate(): void {
		this.options.header.invalidate();
		for (const component of this.options.bottomContainers) component.invalidate();
		// 历史组件进入窗口时再按代刷新，避免主题切换同步重建完整会话。
		this.invalidationGeneration++;
		this.blockCache = new Map();
	}

	isFullscreen(): boolean {
		return this.options.fullscreen;
	}

	isFollowing(): boolean {
		return this.following;
	}

	resetScrollback(): void {
		this.following = true;
		this.scrollTop = 0;
		this.viewportScreenTop = 0;
		this.viewportHeight = 0;
		this.contentRanges = [];
		this.scrollComponents = [];
		this.scrollContainerSnapshots = [];
		this.historyStartIndex = 0;
		this.historyEndIndex = 0;
		this.jumpToTop = false;
		this.hasNewerHistory = false;
		this.indicatorRow = -1;
		this.blockCache = new Map();
		this.componentInvalidationGeneration = new WeakMap();
	}

	getWheelScrollStep(): number {
		return Math.max(2, Math.min(8, Math.round(this.viewportHeight * 0.2)));
	}

	scrollBy(lines: number): void {
		if (!this.options.fullscreen || lines === 0) return;
		const maxScrollTop = this.getMaxScrollTop();
		this.scrollTop = Math.max(0, Math.min(maxScrollTop, this.scrollTop + lines));
		this.following = !this.hasNewerHistory && this.scrollTop >= maxScrollTop;
	}

	pageUp(): void {
		this.scrollBy(-Math.max(1, this.viewportHeight - 2));
	}

	pageDown(): void {
		this.scrollBy(Math.max(1, this.viewportHeight - 2));
	}

	scrollToTop(): void {
		if (!this.options.fullscreen) return;
		this.jumpToTop = true;
		this.scrollTop = 0;
		this.following = false;
	}

	scrollToBottom(): void {
		if (!this.options.fullscreen) return;
		this.jumpToTop = false;
		this.following = true;
		this.scrollTop = this.getMaxScrollTop();
	}

	getComponentAtScreenRow(row: number): Component | undefined {
		return this.getComponentHitAtScreenRow(row)?.component;
	}

	getComponentHitAtScreenRow(row: number): WorkspaceComponentHit | undefined {
		if (
			!this.options.fullscreen ||
			row < this.viewportScreenTop ||
			row >= this.viewportScreenTop + this.viewportHeight
		) {
			return undefined;
		}
		if (row === this.indicatorRow) return undefined;
		const contentRow = this.scrollTop + row - this.viewportScreenTop;
		const range = this.contentRanges.find((item) => contentRow >= item.start && contentRow < item.end);
		return range ? { component: range.component, row: contentRow - range.start } : undefined;
	}

	isNewContentIndicatorRow(row: number): boolean {
		return row === this.indicatorRow;
	}

	render(width: number): string[] {
		const horizontalPadding = this.options.fullscreen
			? Math.min(this.options.horizontalPadding ?? 2, Math.max(0, Math.floor((width - 1) / 2)))
			: 0;
		const renderWidth = Math.max(1, width - horizontalPadding * 2);
		const headerLines = this.options.header.render(renderWidth);
		const bottomSections = this.options.bottomContainers.map((component) => ({
			component,
			lines: component.render(renderWidth),
		}));
		const bottomLines = bottomSections.flatMap((section) => section.lines);

		if (!this.options.fullscreen) {
			const { blocks: contentBlocks, ranges } = this.renderScrollContent(renderWidth);
			const contentLines = contentBlocks.flatMap((block) => block.lines);
			this.contentRanges = ranges;
			this.viewportScreenTop = headerLines.length;
			this.viewportHeight = contentLines.length;
			this.scrollTop = 0;
			this.indicatorRow = -1;
			return [...headerLines, ...contentLines, ...bottomLines];
		}

		const height = Math.max(1, this.options.getHeight());
		const maxHeaderHeight = Math.min(3, Math.max(0, height - 1));
		const visibleHeader = headerLines.slice(0, maxHeaderHeight);
		const maxBottomHeight = Math.max(0, height - visibleHeader.length - 1);
		// 先预留输入框和快捷栏，状态与 Extension Widget 只使用剩余空间。
		const fixedComponents = new Set(this.options.fixedBottomContainers ?? []);
		const fixedHeight = bottomSections.reduce(
			(total, section) => total + (fixedComponents.has(section.component) ? section.lines.length : 0),
			0,
		);
		let visibleBottom: string[];
		if (maxBottomHeight === 0) {
			visibleBottom = [];
		} else if (fixedHeight >= maxBottomHeight) {
			let fixedBudget = maxBottomHeight;
			const fixedLineCounts = new Map<Component, number>();
			for (let index = bottomSections.length - 1; index >= 0; index--) {
				const section = bottomSections[index];
				if (!fixedComponents.has(section.component)) continue;
				const lineCount = Math.min(fixedBudget, section.lines.length);
				fixedLineCounts.set(section.component, lineCount);
				fixedBudget -= lineCount;
			}
			visibleBottom = bottomSections.flatMap((section) => {
				if (!fixedComponents.has(section.component)) return [];
				const lineCount = fixedLineCounts.get(section.component) ?? 0;
				if (lineCount === 0) return [];
				return section.component instanceof WorkspaceComposer
					? section.lines.slice(0, lineCount)
					: section.lines.slice(-lineCount);
			});
		} else {
			let optionalBudget = maxBottomHeight - fixedHeight;
			const optionalLineCounts = new Map<Component, number>();
			const optionalSections = new Map(
				bottomSections
					.filter((section) => !fixedComponents.has(section.component))
					.map((section) => [section.component, section]),
			);
			const allocationOrder: Component[] = [];
			for (const component of [
				...(this.options.optionalBottomPriority ?? []),
				...bottomSections.map((section) => section.component).reverse(),
			]) {
				if (!optionalSections.has(component) || allocationOrder.includes(component)) continue;
				allocationOrder.push(component);
			}
			for (const component of allocationOrder) {
				const section = optionalSections.get(component);
				if (!section) continue;
				const lineCount = Math.min(optionalBudget, section.lines.length);
				optionalLineCounts.set(component, lineCount);
				optionalBudget -= lineCount;
			}
			visibleBottom = bottomSections.flatMap((section) => {
				if (fixedComponents.has(section.component)) return section.lines;
				const visibleLineCount = Math.min(section.lines.length, optionalLineCounts.get(section.component) ?? 0);
				return visibleLineCount > 0 ? section.lines.slice(-visibleLineCount) : [];
			});
		}
		this.viewportHeight = Math.max(1, height - visibleHeader.length - visibleBottom.length);
		this.viewportScreenTop = visibleHeader.length;

		const {
			blocks: contentBlocks,
			ranges,
			height: contentHeight,
		} = this.renderScrollContent(renderWidth, this.viewportHeight);
		this.contentRanges = ranges;
		const maxScrollTop = Math.max(0, contentHeight - this.viewportHeight);
		if (this.following) {
			this.scrollTop = maxScrollTop;
		} else {
			this.scrollTop = Math.max(0, Math.min(this.scrollTop, maxScrollTop));
			if (!this.hasNewerHistory && this.scrollTop >= maxScrollTop) this.following = true;
		}

		const viewport = this.renderViewport(contentBlocks, this.scrollTop, this.viewportHeight);
		while (viewport.length < this.viewportHeight) viewport.push("");
		this.indicatorRow = -1;
		if (!this.following && this.scrollTop < maxScrollTop && viewport.length > 0) {
			const remaining = maxScrollTop - this.scrollTop;
			viewport[viewport.length - 1] = truncateToWidth(
				theme.fg("accent", t("workspace.moreLines", { count: remaining })),
				renderWidth,
				"",
			);
			this.indicatorRow = this.viewportScreenTop + viewport.length - 1;
		}

		const padding = " ".repeat(horizontalPadding);
		return [...visibleHeader, ...viewport, ...visibleBottom].map(
			(line) => `${padding}${truncateToWidth(line, renderWidth, "", true)}${padding}`,
		);
	}

	private getMaxScrollTop(): number {
		const contentHeight = this.contentRanges.reduce((height, range) => Math.max(height, range.end), 0);
		return Math.max(0, contentHeight - this.viewportHeight);
	}

	private getScrollComponents(): Component[] {
		const changed = this.options.scrollContainers.some((container, index) => {
			const snapshot = this.scrollContainerSnapshots[index];
			return (
				!snapshot ||
				snapshot.children !== container.children ||
				snapshot.length !== container.children.length ||
				snapshot.first !== container.children[0] ||
				snapshot.last !== container.children.at(-1)
			);
		});
		if (!changed && this.scrollContainerSnapshots.length === this.options.scrollContainers.length) {
			return this.scrollComponents;
		}

		this.scrollComponents = this.options.scrollContainers.flatMap((container) => container.children);
		this.scrollContainerSnapshots = this.options.scrollContainers.map((container) => ({
			children: container.children,
			length: container.children.length,
			first: container.children[0],
			last: container.children.at(-1),
		}));
		return this.scrollComponents;
	}

	private renderScrollContent(
		width: number,
		viewportHeight?: number,
	): {
		blocks: RenderedComponentBlock[];
		ranges: RenderedComponentRange[];
		height: number;
	} {
		const components = this.getScrollComponents();
		const renderedThisPass = new Map<Component, string[]>();
		const renderComponent = (component: Component): string[] => {
			const rendered = renderedThisPass.get(component);
			if (rendered) return rendered;

			if ((this.componentInvalidationGeneration.get(component) ?? 0) < this.invalidationGeneration) {
				component.invalidate();
				this.componentInvalidationGeneration.set(component, this.invalidationGeneration);
			}

			let lines: string[];
			if (isRenderVersioned(component)) {
				const version = component.getRenderVersion();
				const cached = this.blockCache.get(component);
				if (cached && cached.width === width && cached.version === version) {
					lines = cached.lines;
				} else {
					lines = component.render(width);
					this.blockCache.set(component, { width, version, lines });
				}
			} else {
				lines = component.render(width);
			}
			renderedThisPass.set(component, lines);
			return lines;
		};
		const buildBlocks = (start: number, end: number) => {
			const blocks: RenderedComponentBlock[] = [];
			let height = 0;
			for (let index = start; index < end; index++) {
				const component = components[index]!;
				const lines = renderComponent(component);
				if (lines.length === 0) continue;
				const block = { component, index, start: height, end: height + lines.length, lines };
				blocks.push(block);
				height = block.end;
			}
			return { blocks, height };
		};

		if (viewportHeight === undefined) {
			const { blocks, height } = buildBlocks(0, components.length);
			return { blocks, ranges: blocks, height };
		}
		if (components.length === 0) {
			this.historyStartIndex = 0;
			this.historyEndIndex = 0;
			this.hasNewerHistory = false;
			return { blocks: [], ranges: [], height: 0 };
		}

		const bufferHeight = viewportHeight * 2;
		let start: number;
		let end: number;
		let jumpedToTop = false;
		if (
			this.following ||
			this.historyEndIndex <= this.historyStartIndex ||
			this.historyEndIndex > components.length
		) {
			end = components.length;
			start = end;
			let tailHeight = 0;
			while (start > 0 && tailHeight < viewportHeight + bufferHeight) {
				start--;
				tailHeight += renderComponent(components[start]!).length;
			}
		} else if (this.jumpToTop) {
			start = 0;
			end = 0;
			let headHeight = 0;
			while (end < components.length && headHeight < viewportHeight + bufferHeight) {
				headHeight += renderComponent(components[end]!).length;
				end++;
			}
			this.scrollTop = 0;
			this.jumpToTop = false;
			jumpedToTop = true;
		} else {
			start = this.historyStartIndex;
			end = this.historyEndIndex;
			const current = buildBlocks(start, end);
			let expandedHeight = current.height;

			if (start > 0 && this.scrollTop <= bufferHeight) {
				let prependedHeight = 0;
				while (start > 0 && prependedHeight < bufferHeight) {
					start--;
					prependedHeight += renderComponent(components[start]!).length;
				}
				this.scrollTop += prependedHeight;
				expandedHeight += prependedHeight;
			}
			if (end < components.length && this.scrollTop + viewportHeight + bufferHeight >= expandedHeight) {
				let appendedHeight = 0;
				while (end < components.length && appendedHeight < bufferHeight) {
					appendedHeight += renderComponent(components[end]!).length;
					end++;
				}
			}
		}

		let { blocks, height } = buildBlocks(start, end);
		// 只保留视口前后缓冲区；裁掉上方块时同步重定位局部滚动坐标。
		if (!this.following && !jumpedToTop && blocks.length > 0) {
			const keepStart = Math.max(0, this.scrollTop - bufferHeight);
			const keepEnd = this.scrollTop + viewportHeight + bufferHeight;
			let first = 0;
			while (first < blocks.length - 1 && blocks[first]!.end <= keepStart) first++;
			let last = first + 1;
			while (last < blocks.length && blocks[last]!.start < keepEnd) last++;

			const removedHeight = blocks[first]!.start;
			blocks = blocks.slice(first, last).map((block) => ({
				...block,
				start: block.start - removedHeight,
				end: block.end - removedHeight,
			}));
			start = blocks[0]!.index;
			end = blocks.at(-1)!.index + 1;
			height = blocks.at(-1)!.end;
			this.scrollTop = Math.max(0, this.scrollTop - removedHeight);
		}

		this.historyStartIndex = start;
		this.historyEndIndex = end;
		this.hasNewerHistory = end < components.length;
		const retainedComponents = new Set(blocks.map((block) => block.component));
		for (const component of this.blockCache.keys()) {
			if (!retainedComponents.has(component)) this.blockCache.delete(component);
		}
		return { blocks, ranges: blocks, height };
	}

	private renderViewport(blocks: RenderedComponentBlock[], start: number, height: number): string[] {
		const end = start + height;
		const lines: string[] = [];
		for (const block of blocks) {
			if (block.end <= start) continue;
			if (block.start >= end) break;
			const from = Math.max(0, start - block.start);
			const to = Math.min(block.lines.length, end - block.start);
			lines.push(...block.lines.slice(from, to));
		}
		return lines;
	}
}
