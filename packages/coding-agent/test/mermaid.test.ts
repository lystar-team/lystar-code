import { describe, expect, it, vi } from "vitest";

const { renderSpy } = vi.hoisted(() => ({ renderSpy: vi.fn() }));

vi.mock("grok-mermaid", async (importOriginal) => {
	const actual = await importOriginal<typeof import("grok-mermaid")>();
	renderSpy.mockImplementation(actual.render);
	return { ...actual, render: renderSpy };
});

import type { MarkdownTransformContext } from "../src/core/extensions/types.ts";
import type { MermaidRenderingMode } from "../src/core/settings-manager.ts";
import { createMermaidMarkdownTransformer } from "../src/modes/interactive/components/mermaid.ts";
import type { Theme } from "../src/modes/interactive/theme/theme.ts";

interface TransformOptions {
	maxWidth?: number;
	isStreaming?: boolean;
	messageType?: MarkdownTransformContext["messageType"];
	mode?: MermaidRenderingMode;
	theme?: Theme;
}

function transformMermaid(markdown: string, options: TransformOptions = {}): string {
	const transformer = createMermaidMarkdownTransformer({
		getMode: () => options.mode ?? "streaming",
		theme: options.theme,
	});
	return transformer(markdown, {
		availableWidth: options.maxWidth ?? 100,
		isStreaming: options.isStreaming ?? false,
		messageType: options.messageType ?? "assistant",
	});
}

describe("Mermaid rendering", () => {
	it("replaces Mermaid code blocks with Unicode diagrams", () => {
		const markdown = "Before\n\n```mermaid\nflowchart LR\n  A[Start] --> B[Done]\n```\nAfter";
		const rendered = transformMermaid(markdown);

		expect(rendered).toContain("Before");
		expect(rendered).toContain("┌───────┐");
		expect(rendered).toContain("│ Start ├───▶│ Done │");
		expect(rendered).toContain("└───────┘    └──────┘`\nAfter");
		expect(rendered).not.toContain("```mermaid");
		expect(rendered).toContain("After");
	});

	it("keeps source for unsupported diagrams and reports oversized diagrams after streaming", () => {
		const unsupported = '```mermaid\npie\n  title Pets\n  "Dogs" : 4\n```';
		const oversized = "```mermaid\nflowchart LR\n  A[One] --> B[Two] --> C[Three] --> D[Four] --> E[Five]\n```";

		expect(transformMermaid(unsupported)).toBe(unsupported);
		expect(transformMermaid(oversized, { maxWidth: 40, isStreaming: true })).toBe(oversized);

		const fallback = transformMermaid(oversized, { maxWidth: 40 });
		expect(fallback).toContain(oversized);
		expect(fallback).toContain("diagram exceeds current terminal width");
	});

	it("uses width-specific source fallback and caches repeated failures", () => {
		const markdown = "```mermaid\nflowchart LR\n  A[One] --> B[Two] --> C[Three] --> D[Four] --> E[Five]\n```";
		const transformer = createMermaidMarkdownTransformer({ getMode: () => "streaming" });
		renderSpy.mockClear();
		const context = (availableWidth: number): MarkdownTransformContext => ({
			availableWidth,
			isStreaming: false,
			messageType: "assistant",
		});

		expect(transformer(markdown, context(40))).toContain("diagram exceeds current terminal width");
		expect(transformer(markdown, context(40))).toContain("diagram exceeds current terminal width");
		expect(renderSpy).toHaveBeenCalledTimes(1);

		expect(transformer(markdown, context(60))).not.toContain("```mermaid");
		expect(renderSpy).toHaveBeenCalledTimes(2);
	});

	it("renders diagrams consistently through 40, 60, 80, and 120 column resizes", () => {
		const markdown = "```mermaid\nflowchart LR\n  A[One] --> B[Two] --> C[Three] --> D[Four] --> E[Five]\n```";
		const transformer = createMermaidMarkdownTransformer({ getMode: () => "streaming" });

		for (const width of [40, 60, 80, 120]) {
			const rendered = transformer(markdown, {
				availableWidth: width,
				isStreaming: false,
				messageType: "assistant",
			});
			if (width === 40) {
				expect(rendered).toContain(markdown);
				expect(rendered).toContain("diagram exceeds current terminal width");
			} else {
				expect(rendered).not.toContain("```mermaid");
				expect(rendered).toContain("┌─────┐");
			}
		}
	});

	it("maps semantic spans through the Pi theme", () => {
		const theme = {
			fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
			bold: (text: string) => `<bold>${text}</bold>`,
		} as Theme;
		const rendered = transformMermaid("```mermaid\nflowchart LR\n  A --> B\n```", { theme });

		expect(rendered).toContain("<borderMuted>");
		expect(rendered).toContain("<accent>");
	});

	it("renders incomplete Mermaid blocks during streaming", () => {
		const partialMarkdown = "```mermaid\nflowchart LR\n  A --> B";

		expect(transformMermaid(partialMarkdown, { isStreaming: true })).toContain("───▶");
	});

	it("falls back to the code block with a warning after streaming", () => {
		const markdown = "```mermaid\nflowchart LR\n  A[Foo]:::highlight --> B[Bar]\n```";
		const final = transformMermaid(markdown);
		const followedByText = transformMermaid(`${markdown}\nFollowing text`);
		const streaming = transformMermaid(markdown, { isStreaming: true });

		expect(final).toContain(markdown);
		expect(final).toContain("```\n`Mermaid diagram not rendered");
		expect(final).toContain('dropped, expected a link: ":::highlight --> B[Bar]"');
		expect(final).not.toContain("more)");
		expect(followedByText).toContain("  \nFollowing text");
		expect(streaming).not.toContain("Mermaid diagram not rendered");
		expect(streaming).not.toContain("```mermaid");
		expect(streaming).toContain("│ Foo │");
	});

	it("summarizes additional partial-render warnings", () => {
		const markdown = "```mermaid\nflowchart LR\n  A[Foo]:::highlight --> B[Bar]\n  C[Baz]:::other --> D[Qux]\n```";
		const rendered = transformMermaid(markdown);

		expect(rendered).toContain(markdown);
		expect(rendered).toContain('dropped, expected a link: ":::highlight --> B[Bar]"');
		expect(rendered).toContain("(+1 more)");
		expect(rendered).not.toContain('dropped, expected a link: ":::other --> D[Qux]"');
	});

	it("respects rendering modes and skips thinking blocks", () => {
		const markdown = "```mermaid\nflowchart LR\n  A --> B\n```";

		expect(transformMermaid(markdown, { mode: "off" })).toBe(markdown);
		expect(transformMermaid(markdown, { mode: "final", isStreaming: true })).toBe(markdown);
		expect(transformMermaid(markdown, { mode: "final" })).not.toContain("```mermaid");
		expect(transformMermaid(markdown, { messageType: "assistant-thinking" })).toBe(markdown);
	});
});
