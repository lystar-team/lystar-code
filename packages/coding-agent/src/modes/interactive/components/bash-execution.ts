/**
 * Component for displaying direct shell command execution.
 */

import { Box, Container, Text, type TUI } from "@earendil-works/pi-tui";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	type TruncationResult,
	truncateTail,
} from "../../../core/tools/truncate.ts";
import { stripAnsi } from "../../../utils/ansi.ts";
import { theme } from "../theme/theme.ts";
import { formatToolSummary, getToolSummary } from "./tool-summary.ts";

export class BashExecutionComponent extends Container {
	private command: string;
	private outputLines: string[] = [];
	private status: "running" | "complete" | "cancelled" | "error" = "running";
	private exitCode: number | undefined;
	private truncationResult?: TruncationResult;
	private fullOutputPath?: string;
	private expanded = false;
	private contentBox: Box;

	constructor(command: string, _ui: TUI, _excludeFromContext = false) {
		super();
		this.command = command;
		this.contentBox = new Box(1, 0, (text: string) => text);
		this.addChild(this.contentBox);
		this.updateDisplay();
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
		this.updateDisplay();
	}

	isExpanded(): boolean {
		return this.expanded;
	}

	override invalidate(): void {
		super.invalidate();
		this.updateDisplay();
	}

	appendOutput(chunk: string): boolean {
		const clean = stripAnsi(chunk).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
		const newLines = clean.split("\n");
		if (this.outputLines.length > 0 && newLines.length > 0) {
			this.outputLines[this.outputLines.length - 1] += newLines[0];
			this.outputLines.push(...newLines.slice(1));
		} else {
			this.outputLines.push(...newLines);
		}

		if (this.expanded) this.updateDisplay();
		return this.expanded;
	}

	setComplete(
		exitCode: number | undefined,
		cancelled: boolean,
		truncationResult?: TruncationResult,
		fullOutputPath?: string,
	): void {
		this.exitCode = exitCode;
		this.status = cancelled
			? "cancelled"
			: exitCode !== 0 && exitCode !== undefined && exitCode !== null
				? "error"
				: "complete";
		this.truncationResult = truncationResult;
		this.fullOutputPath = fullOutputPath;
		this.updateDisplay();
	}

	private updateDisplay(): void {
		const isPartial = this.status === "running";
		const isError = this.status === "error";
		const successLabel = this.status === "cancelled" ? "已取消" : "已运行";
		const summary = getToolSummary(undefined);
		summary.setText(
			formatToolSummary({
				icon: "$",
				subject: this.command,
				expanded: this.expanded,
				isPartial,
				isError,
				labels: { running: "正在运行", success: successLabel, error: "运行失败" },
				detail: isError ? `退出码 ${this.exitCode}` : undefined,
			}),
		);

		this.contentBox.setBgFn(
			isPartial
				? (text) => theme.bg("toolPendingBg", text)
				: isError
					? (text) => theme.bg("toolErrorBg", text)
					: (text) => theme.bg("toolSuccessBg", text),
		);
		this.contentBox.clear();
		this.contentBox.addChild(summary);

		const fullOutput = this.outputLines.join("\n");
		const contextTruncation = truncateTail(fullOutput, {
			maxLines: DEFAULT_MAX_LINES,
			maxBytes: DEFAULT_MAX_BYTES,
		});
		const availableLines = contextTruncation.content ? contextTruncation.content.split("\n") : [];
		if (this.expanded && availableLines.length > 0) {
			this.contentBox.addChild(
				new Text(`\n${availableLines.map((line) => theme.fg("toolOutput", line)).join("\n")}`, 0, 0),
			);
		} else if (isError) {
			const firstErrorLine = availableLines.find((line) => line.trim());
			if (firstErrorLine) {
				const errorSummary = getToolSummary(undefined);
				errorSummary.setText(theme.fg("error", firstErrorLine));
				this.contentBox.addChild(errorSummary);
			}
		}

		if (this.expanded) {
			const wasTruncated = this.truncationResult?.truncated || contextTruncation.truncated;
			if (wasTruncated && this.fullOutputPath) {
				this.contentBox.addChild(
					new Text(`\n${theme.fg("warning", `输出已截断，完整内容：${this.fullOutputPath}`)}`, 0, 0),
				);
			}
		}
	}

	getOutput(): string {
		return this.outputLines.join("\n");
	}

	getCommand(): string {
		return this.command;
	}
}
