import {
	Box,
	type Component,
	Container,
	getCapabilities,
	Image,
	Spacer,
	Text,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import type { ToolDefinition, ToolRenderContext } from "../../../core/extensions/types.ts";
import { createAllToolDefinitions, type ToolName } from "../../../core/tools/index.ts";
import { getTextOutput as getRenderedTextOutput } from "../../../core/tools/render-utils.ts";
import { convertToPng } from "../../../utils/image-convert.ts";
import { theme } from "../theme/theme.ts";
import { uiGlyphs } from "../ui-glyphs.ts";
import {
	type InteractiveCard,
	type InteractiveCardAction,
	isInteractiveCard,
	resolveInteractiveCardAction,
} from "./interactive-card.ts";
import { keyHint } from "./keybinding-hints.ts";
import type { SubagentRunTarget } from "./subagent-run.ts";
import { renderCardHover } from "./tool-card-layout.ts";
import { formatToolSummary } from "./tool-summary.ts";

const FALLBACK_PREVIEW_LINES = 10;

export interface ToolExecutionOptions {
	showImages?: boolean;
	imageWidthCells?: number;
}

export type ToolExecutionStatus = "pending" | "running" | "success" | "error" | "cancelled";

export type ToolExecutionAgentTarget = SubagentRunTarget;

export class ToolExecutionComponent extends Container {
	private contentBox: Box;
	private contentText: Text;
	private selfRenderContainer: Container;
	private callRendererComponent?: Component;
	private resultRendererComponent?: Component;
	private rendererState: any = {};
	private imageComponents: Image[] = [];
	private imageSpacers: Spacer[] = [];
	private toolName: string;
	private toolCallId: string;
	private args: any;
	private argsRevision = 0;
	private expanded = false;
	private hovered = false;
	private showImages: boolean;
	private imageWidthCells: number;
	private isPartial = true;
	private toolDefinition?: ToolDefinition<any, any>;
	private builtInToolDefinition?: ToolDefinition<any, any>;
	private ui: TUI;
	private cwd: string;
	private executionStarted = false;
	private argsComplete = false;
	private result?: {
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		isError: boolean;
		details?: any;
	};
	private convertedImages: Map<number, { data: string; mimeType: string }> = new Map();
	private hideComponent = false;
	private cancelled = false;
	private renderVersion = 0;
	private lastRenderedWidth = 0;
	private lastRenderedLineCount = 0;

	constructor(
		toolName: string,
		toolCallId: string,
		args: any,
		options: ToolExecutionOptions = {},
		toolDefinition: ToolDefinition<any, any> | undefined,
		ui: TUI,
		cwd: string,
	) {
		super();
		this.toolName = toolName;
		this.toolCallId = toolCallId;
		this.args = args;
		this.toolDefinition = toolDefinition;
		this.builtInToolDefinition = createAllToolDefinitions(cwd)[toolName as ToolName];
		this.showImages = options.showImages ?? true;
		this.imageWidthCells = options.imageWidthCells ?? 60;
		this.ui = ui;
		this.cwd = cwd;

		// Always create all shell variants. contentBox is used for default renderer-based composition.
		// selfRenderContainer is used when the tool renders its own framing.
		// contentText is reserved for generic fallback rendering when no tool definition exists.
		this.contentBox = new Box(1, 0);
		this.contentText = new Text("", 1, 0);
		this.selfRenderContainer = new Container();

		if (this.hasRendererDefinition()) {
			this.addChild(this.getRenderShell() === "self" ? this.selfRenderContainer : this.contentBox);
		} else {
			this.addChild(this.contentText);
		}

		this.updateDisplay();
	}

	private getCallRenderer(): ToolDefinition<any, any>["renderCall"] | undefined {
		if (!this.builtInToolDefinition) {
			return this.toolDefinition?.renderCall;
		}
		if (!this.toolDefinition) {
			return this.builtInToolDefinition.renderCall;
		}
		return this.toolDefinition.renderCall ?? this.builtInToolDefinition.renderCall;
	}

	private getResultRenderer(): ToolDefinition<any, any>["renderResult"] | undefined {
		if (!this.builtInToolDefinition) {
			return this.toolDefinition?.renderResult;
		}
		if (!this.toolDefinition) {
			return this.builtInToolDefinition.renderResult;
		}
		return this.toolDefinition.renderResult ?? this.builtInToolDefinition.renderResult;
	}

	private hasRendererDefinition(): boolean {
		return this.builtInToolDefinition !== undefined || this.toolDefinition !== undefined;
	}

	private getRenderShell(): "default" | "self" {
		if (!this.builtInToolDefinition) {
			return this.toolDefinition?.renderShell ?? "default";
		}
		if (!this.toolDefinition) {
			return this.builtInToolDefinition.renderShell ?? "default";
		}
		return this.toolDefinition.renderShell ?? this.builtInToolDefinition.renderShell ?? "default";
	}

	private getRenderContext(lastComponent: Component | undefined): ToolRenderContext {
		return {
			args: this.args,
			argsRevision: this.argsRevision,
			toolCallId: this.toolCallId,
			invalidate: () => {
				this.invalidate();
				this.ui.requestRender();
			},
			lastComponent,
			state: this.rendererState,
			cwd: this.cwd,
			executionStarted: this.executionStarted,
			argsComplete: this.argsComplete,
			isPartial: this.isPartial,
			expanded: this.expanded,
			showImages: this.showImages,
			isError: this.result?.isError ?? false,
			resultDetails: this.result?.details,
		};
	}

	private createCallFallback(): Component {
		const args = this.args && typeof this.args === "object" && !Array.isArray(this.args) ? this.args : undefined;
		const path =
			args && typeof args.path === "string"
				? args.path
				: args && typeof args.file_path === "string"
					? args.file_path
					: undefined;
		const fallback =
			this.toolName === "write"
				? {
						icon: uiGlyphs.write,
						subject: path ?? this.toolName,
						labels: { running: "正在写入", success: "已写入", error: "写入失败" },
					}
				: this.toolName === "edit"
					? {
							icon: uiGlyphs.edit,
							subject: path ?? this.toolName,
							labels: { running: "正在编辑", success: "已编辑", error: "编辑失败" },
						}
					: this.toolName === "apply_patch"
						? {
								icon: uiGlyphs.patch,
								subject: this.toolName,
								labels: { running: "正在应用补丁", success: "已应用补丁", error: "应用补丁失败" },
							}
						: {
								icon: uiGlyphs.tool,
								subject: this.toolName,
								labels: { running: "正在执行", success: "已执行", error: "执行失败" },
							};
		return new Text(
			formatToolSummary({
				icon: fallback.icon,
				subject: fallback.subject,
				isPartial: this.isPartial,
				isError: this.result?.isError ?? false,
				labels: fallback.labels,
			}),
			0,
			0,
		);
	}

	private createResultFallback(): Component | undefined {
		const output = this.getTextOutput();
		if (!output) {
			return undefined;
		}
		const lines = output.split("\n");
		const displayLines = this.expanded ? lines : lines.slice(0, FALLBACK_PREVIEW_LINES);
		const remaining = lines.length - displayLines.length;
		let text = displayLines.map((line) => theme.fg("toolOutput", line)).join("\n");
		if (remaining > 0) {
			text += `${theme.fg("muted", `\n...（还有 ${remaining} 行，`)} ${keyHint("app.tools.expand", "展开")}${theme.fg("muted", "）")}`;
		}
		return new Text(text, 0, 0);
	}

	private createCollapsedErrorPreview(): Component | undefined {
		const output = this.getTextOutput();
		const firstLine = output.split("\n").find((line) => line.trim());
		return firstLine ? new Text(theme.fg("error", firstLine.trim()), 0, 0) : undefined;
	}

	updateArgs(args: any): void {
		this.args = args;
		this.argsRevision++;
		this.updateDisplay();
	}

	markExecutionStarted(): void {
		this.executionStarted = true;
		this.updateDisplay();
	}

	setArgsComplete(): void {
		this.argsComplete = true;
		this.updateDisplay();
	}

	updateResult(
		result: {
			content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
			details?: any;
			isError: boolean;
		},
		isPartial = false,
	): boolean {
		this.cancelled = false;
		this.result = result;
		this.isPartial = isPartial;
		const visibleChanged = !isPartial || this.expanded || !this.builtInToolDefinition;
		if (visibleChanged) this.updateDisplay();
		this.maybeConvertImagesForKitty();
		return visibleChanged;
	}

	markCancelled(message: string): void {
		this.updateResult({ content: [{ type: "text", text: message }], isError: true });
		this.cancelled = true;
		this.renderVersion++;
	}

	private maybeConvertImagesForKitty(): void {
		const caps = getCapabilities();
		if (caps.images !== "kitty") return;
		if (!this.result) return;

		const imageBlocks = this.result.content.filter((c) => c.type === "image");
		for (let i = 0; i < imageBlocks.length; i++) {
			const img = imageBlocks[i];
			if (!img.data || !img.mimeType) continue;
			if (img.mimeType === "image/png") continue;
			if (this.convertedImages.has(i)) continue;

			const index = i;
			convertToPng(img.data, img.mimeType).then((converted) => {
				if (converted) {
					this.convertedImages.set(index, converted);
					this.updateDisplay();
					this.ui.requestRender();
				}
			});
		}
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
		this.updateDisplay();
	}

	setHovered(hovered: boolean): void {
		if (this.hovered === hovered) return;
		this.hovered = hovered;
		this.renderVersion++;
	}

	isExpanded(): boolean {
		return this.expanded;
	}

	getCardStateKey(): string {
		return `tool:${this.toolCallId}`;
	}

	getToolName(): string {
		return this.toolName;
	}

	getCardClickActionAtRow(row: number): InteractiveCardAction | undefined {
		if (row < 0 || row >= this.lastRenderedLineCount) return undefined;
		if (this.lastRenderedWidth > 0) {
			const callLineCount = this.callRendererComponent?.render(this.lastRenderedWidth).length ?? 0;
			if (row >= callLineCount && isInteractiveCard(this.resultRendererComponent)) {
				const action = resolveInteractiveCardAction(this.resultRendererComponent, row - callLineCount);
				if (action) return action;
			}
		}
		return { type: "toggle", component: this };
	}

	getChildCards(): readonly InteractiveCard[] {
		return [this.callRendererComponent, this.resultRendererComponent].filter(isInteractiveCard);
	}

	getAgentTargetAtRow(row: number): ToolExecutionAgentTarget | undefined {
		if (this.toolName !== "subagent" || row < 0 || this.lastRenderedWidth <= 0) return undefined;
		const callLines = this.callRendererComponent?.render(this.lastRenderedWidth) ?? [];
		if (row < callLines.length) return undefined;
		const resultRow = row - callLines.length;
		const result = this.resultRendererComponent as
			| (Component & { getAgentTargetAtRow?: (row: number) => SubagentRunTarget | undefined })
			| undefined;
		return result?.getAgentTargetAtRow?.(resultRow);
	}

	getRenderVersion(): number {
		const nestedVersion = [this.callRendererComponent, this.resultRendererComponent].reduce(
			(version, component) => version + (isInteractiveCard(component) ? (component.getRenderVersion?.() ?? 0) : 0),
			0,
		);
		return this.renderVersion + nestedVersion;
	}

	getExecutionStatus(): ToolExecutionStatus {
		if (this.cancelled) return "cancelled";
		if (this.result) return this.result.isError ? "error" : this.isPartial ? "running" : "success";
		return this.executionStarted ? "running" : "pending";
	}

	setShowImages(show: boolean): void {
		this.showImages = show;
		this.updateDisplay();
	}

	setImageWidthCells(width: number): void {
		this.imageWidthCells = Math.max(1, Math.floor(width));
		this.updateDisplay();
	}

	override invalidate(): void {
		super.invalidate();
		this.updateDisplay();
	}

	override render(width: number): string[] {
		this.lastRenderedWidth = width;
		if (this.hideComponent) {
			this.lastRenderedLineCount = 0;
			return [];
		}

		if (this.hasRendererDefinition() && this.getRenderShell() === "self") {
			const contentLines = this.selfRenderContainer.render(width);
			if (contentLines.length === 0 && this.imageComponents.length === 0) {
				this.lastRenderedLineCount = 0;
				return [];
			}

			const lines: string[] = contentLines.length > 0 ? [...contentLines] : [];
			for (let i = 0; i < this.imageComponents.length; i++) {
				const spacer = this.imageSpacers[i];
				if (spacer) {
					lines.push(...spacer.render(width));
				}
				const imageComponent = this.imageComponents[i];
				if (imageComponent) {
					lines.push(...imageComponent.render(width));
				}
			}
			const rendered = renderCardHover(this.renderExpansionIndicator(lines, width), width, this.hovered);
			this.lastRenderedLineCount = rendered.length;
			return rendered;
		}

		const rendered = renderCardHover(this.renderExpansionIndicator(super.render(width), width), width, this.hovered);
		this.lastRenderedLineCount = rendered.length;
		return rendered;
	}

	private renderExpansionIndicator(lines: string[], width: number): string[] {
		if (lines.length === 0 || width <= 0) return lines;
		const indicator = theme.fg("dim", this.expanded ? uiGlyphs.expanded : uiGlyphs.collapsed);
		const indicatorWidth = visibleWidth(indicator);
		if (indicatorWidth >= width) return [truncateToWidth(indicator, width, ""), ...lines.slice(1)];
		const left = truncateToWidth(lines[0] ?? "", Math.max(1, width - indicatorWidth - 1), "…");
		const gap = " ".repeat(Math.max(1, width - visibleWidth(left) - indicatorWidth));
		return [`${left}${gap}${indicator}`, ...lines.slice(1)];
	}

	private updateDisplay(): void {
		this.renderVersion++;

		let hasContent = false;
		this.hideComponent = false;
		if (this.hasRendererDefinition()) {
			const renderContainer = this.getRenderShell() === "self" ? this.selfRenderContainer : this.contentBox;
			renderContainer.clear();

			const callRenderer = this.getCallRenderer();
			if (!callRenderer) {
				renderContainer.addChild(this.createCallFallback());
				hasContent = true;
			} else {
				try {
					const component = callRenderer(this.args, theme, this.getRenderContext(this.callRendererComponent));
					this.callRendererComponent = component;
					renderContainer.addChild(component);
					hasContent = true;
				} catch {
					this.callRendererComponent = undefined;
					renderContainer.addChild(this.createCallFallback());
					hasContent = true;
				}
			}

			if (this.result) {
				const collapsedError =
					this.result.isError && !this.expanded ? this.createCollapsedErrorPreview() : undefined;
				if (collapsedError) {
					renderContainer.addChild(collapsedError);
					hasContent = true;
				} else {
					const resultRenderer = this.getResultRenderer();
					if (!resultRenderer) {
						const component = this.createResultFallback();
						if (component) {
							renderContainer.addChild(component);
							hasContent = true;
						}
					} else {
						try {
							const component = resultRenderer(
								{ content: this.result.content as any, details: this.result.details },
								{ expanded: this.expanded, isPartial: this.isPartial },
								theme,
								this.getRenderContext(this.resultRendererComponent),
							);
							this.resultRendererComponent = component;
							renderContainer.addChild(component);
							hasContent = true;
						} catch {
							this.resultRendererComponent = undefined;
							const component = this.createResultFallback();
							if (component) {
								renderContainer.addChild(component);
								hasContent = true;
							}
						}
					}
				}
			}
		} else {
			this.contentText.setText(this.formatToolExecution());
			hasContent = true;
		}

		for (const img of this.imageComponents) {
			this.removeChild(img);
		}
		this.imageComponents = [];
		for (const spacer of this.imageSpacers) {
			this.removeChild(spacer);
		}
		this.imageSpacers = [];

		if (this.result) {
			const imageBlocks = this.result.content.filter((c) => c.type === "image");
			const caps = getCapabilities();
			for (let i = 0; i < imageBlocks.length; i++) {
				const img = imageBlocks[i];
				if (caps.images && this.showImages && this.expanded && img.data && img.mimeType) {
					const converted = this.convertedImages.get(i);
					const imageData = converted?.data ?? img.data;
					const imageMimeType = converted?.mimeType ?? img.mimeType;
					if (caps.images === "kitty" && imageMimeType !== "image/png") continue;

					const spacer = new Spacer(1);
					this.addChild(spacer);
					this.imageSpacers.push(spacer);
					const imageComponent = new Image(
						imageData,
						imageMimeType,
						{ fallbackColor: (s: string) => theme.fg("toolOutput", s) },
						{ maxWidthCells: this.imageWidthCells },
					);
					this.imageComponents.push(imageComponent);
					this.addChild(imageComponent);
				}
			}
		}

		if (this.hasRendererDefinition() && !hasContent && this.imageComponents.length === 0) {
			this.hideComponent = true;
		}
	}

	private getTextOutput(): string {
		return getRenderedTextOutput(this.result, this.showImages);
	}

	private formatToolExecution(): string {
		let text = formatToolSummary({
			icon: uiGlyphs.tool,
			subject: this.toolName,
			isPartial: this.isPartial,
			isError: this.result?.isError ?? false,
			labels: { running: "正在执行", success: "已执行", error: "执行失败" },
		});
		if (!this.expanded) {
			const output = this.getTextOutput();
			return output
				? `${text}\n${theme.fg("error", output.split("\n").find((line) => line.trim()) ?? output)}`
				: text;
		}
		const content = JSON.stringify(this.args, null, 2);
		if (content) {
			text += `\n\n${content}`;
		}
		const output = this.getTextOutput();
		if (output) {
			text += `\n${output}`;
		}
		return text;
	}
}
