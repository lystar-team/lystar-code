import type { AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, test } from "vitest";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.ts";
import { UserMessageComponent } from "../src/modes/interactive/components/user-message.ts";
import { getMarkdownTheme, initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

function createAssistantMessage(
	content: AssistantMessage["content"],
	overrides: Partial<Pick<AssistantMessage, "stopReason">> = {},
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "gpt-4o-mini",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: overrides.stopReason ?? "stop",
		timestamp: Date.now(),
	};
}

function createCodeBlock(lineCount: number, closed = true): string {
	const lines = Array.from({ length: lineCount }, (_, index) => `line-${String(index + 1).padStart(3, "0")}`);
	return ["```text", ...lines, ...(closed ? ["```"] : [])].join("\n");
}

describe("AssistantMessageComponent", () => {
	test("adds OSC 133 zone markers to assistant messages without tool calls", () => {
		initTheme("dark");

		const component = new AssistantMessageComponent(createAssistantMessage([{ type: "text", text: "hello" }]));
		const lines = component.render(40);

		expect(lines).not.toHaveLength(0);
		expect(lines[0]).toContain(OSC133_ZONE_START);
		expect(lines[lines.length - 1].startsWith(OSC133_ZONE_END + OSC133_ZONE_FINAL)).toBe(true);
	});

	test("does not add OSC 133 zone markers when assistant message contains tool calls", () => {
		initTheme("dark");

		const component = new AssistantMessageComponent(
			createAssistantMessage([
				{ type: "text", text: "calling tool" },
				{ type: "toolCall", id: "tool-1", name: "read", arguments: { path: "file.txt" } },
			]),
		);
		const rendered = component.render(60).join("\n");

		expect(rendered.includes(OSC133_ZONE_START)).toBe(false);
		expect(rendered.includes(OSC133_ZONE_END)).toBe(false);
		expect(rendered.includes(OSC133_ZONE_FINAL)).toBe(false);
	});

	test("hides configured markdown fences while keeping a code rail", () => {
		initTheme("dark");
		const component = new AssistantMessageComponent(
			createAssistantMessage([{ type: "text", text: "```text\nstatus line\n```" }]),
			false,
			{ ...getMarkdownTheme(), showCodeBlockFences: false },
		);

		const rendered = stripAnsi(component.render(80).join("\n"));

		expect(rendered).toContain("│ status line");
		expect(rendered).not.toContain("```text");
		expect(rendered).not.toContain("```");
	});

	test("shows thinking content by default", () => {
		initTheme("dark");

		const component = new AssistantMessageComponent(
			createAssistantMessage([{ type: "thinking", thinking: "检查输入和边界条件" }]),
		);
		const rendered = stripAnsi(component.render(80).join("\n"));

		expect(rendered).toContain("检查输入和边界条件");
		expect(rendered).not.toContain("◆ 思考过程");
	});

	test("renders web search status and cited links", () => {
		initTheme("dark");
		const component = new AssistantMessageComponent(
			createAssistantMessage([
				{
					type: "webSearchCall",
					id: "ws_1",
					status: "completed",
					action: {
						type: "search",
						query: "OpenAI web search",
						sources: [{ type: "url", url: "https://developers.openai.com/api/docs/guides/tools-web-search" }],
					},
				},
				{
					type: "text",
					text: "Use web search.",
					annotations: [
						{
							type: "url_citation",
							startIndex: 4,
							endIndex: 14,
							title: "OpenAI Web Search",
							url: "https://developers.openai.com/api/docs/guides/tools-web-search",
						},
					],
				},
			]),
		);

		const rendered = stripAnsi(component.render(100).join("\n"));
		expect(rendered).toContain("已搜索网页 · 1 个来源");
		expect(rendered).toContain("引用：");
		expect(rendered).toContain("OpenAI Web Search");
	});

	test("renders length stops with neutral truncation wording", () => {
		initTheme("dark");

		const component = new AssistantMessageComponent(
			createAssistantMessage([{ type: "thinking", thinking: "private reasoning" }], { stopReason: "length" }),
			true,
		);
		const rendered = component.render(80).join("\n");

		expect(rendered).toContain("◆ 思考过程");
		expect(rendered).toContain("回复在完成前已被截断。");
	});

	test("coalesces adjacent thinking blocks into one hidden thinking label", () => {
		initTheme("dark");

		const component = new AssistantMessageComponent(
			createAssistantMessage([
				{ type: "thinking", thinking: "first thought" },
				{ type: "thinking", thinking: "" },
				{ type: "thinking", thinking: "second thought" },
				{ type: "text", text: "answer" },
			]),
			true,
		);
		const rendered = stripAnsi(component.render(80).join("\n"));

		expect(rendered.match(/◆ 思考过程/g)).toHaveLength(1);
		expect(rendered).toContain("answer");
	});

	test("uses configured output padding for text and thinking", () => {
		initTheme("dark");

		const component = new AssistantMessageComponent(
			createAssistantMessage([
				{ type: "text", text: "hello" },
				{ type: "thinking", thinking: "reasoning" },
			]),
			false,
			undefined,
			"Thinking...",
			1,
		);
		const lines = component.render(80).map((line) => stripAnsi(line));

		expect(lines.some((line) => line.includes(" hello"))).toBe(true);
		expect(lines.some((line) => line.includes(" reasoning"))).toBe(true);

		component.setOutputPad(0);
		const updatedLines = component.render(80).map((line) => stripAnsi(line));
		expect(updatedLines.some((line) => line.startsWith("hello"))).toBe(true);
		expect(updatedLines.some((line) => line.startsWith("reasoning"))).toBe(true);
	});

	test("chains Markdown transformers in registration order", () => {
		initTheme("dark");
		const calls: string[] = [];
		const message = createAssistantMessage([{ type: "text", text: "The result is $x^2$." }]);
		const component = new AssistantMessageComponent(message, false, undefined, "Thinking...", 1, [
			(markdown, context) => {
				calls.push("formula");
				expect(context).toEqual({ messageType: "assistant", isStreaming: false, availableWidth: 78 });
				return markdown.replace("$x^2$", "x²");
			},
			(markdown) => {
				calls.push("suffix");
				return `${markdown} Done.`;
			},
		]);

		expect(stripAnsi(component.render(80).join("\n"))).toContain("The result is x². Done.");
		expect(calls).toEqual(["formula", "suffix"]);
	});

	test("identifies partial assistant Markdown as streaming", () => {
		initTheme("dark");
		const streamingStates: boolean[] = [];
		const message = createAssistantMessage([{ type: "text", text: "partial" }]);
		const component = new AssistantMessageComponent(undefined, false, undefined, "Thinking...", 1, [
			(markdown, context) => {
				streamingStates.push(context.isStreaming);
				return context.isStreaming ? markdown : `${markdown} transformed`;
			},
		]);

		component.updateContent(message, true);
		expect(stripAnsi(component.render(80).join("\n"))).not.toContain("transformed");

		component.updateContent(message, false);
		expect(stripAnsi(component.render(80).join("\n"))).toContain("partial transformed");
		expect(streamingStates).toEqual([true, false]);
	});

	test("reapplies Markdown transformers when available width changes", () => {
		initTheme("dark");
		const availableWidths: number[] = [];
		const component = new AssistantMessageComponent(
			createAssistantMessage([{ type: "text", text: "answer" }]),
			false,
			undefined,
			"Thinking...",
			1,
			[
				(markdown, context) => {
					availableWidths.push(context.availableWidth);
					return `${markdown} (${context.availableWidth})`;
				},
			],
		);

		expect(stripAnsi(component.render(80).join("\n"))).toContain("answer (78)");
		component.render(80);
		expect(stripAnsi(component.render(60).join("\n"))).toContain("answer (58)");
		expect(availableWidths).toEqual([78, 58]);
	});

	test("continues the Markdown transformer chain when a transformer throws", () => {
		initTheme("dark");
		const calls: string[] = [];
		const component = new AssistantMessageComponent(
			createAssistantMessage([{ type: "text", text: "still visible" }]),
			false,
			undefined,
			"Thinking...",
			1,
			[
				(markdown) => {
					calls.push("first");
					return markdown.replace("still", "remains");
				},
				() => {
					calls.push("throw");
					throw new Error("broken transformer");
				},
				(markdown) => {
					calls.push("last");
					return `${markdown} after error`;
				},
			],
		);

		expect(stripAnsi(component.render(80).join("\n"))).toContain("remains visible after error");
		expect(calls).toEqual(["first", "throw", "last"]);
	});

	test("transforms text and thinking Markdown without mutating the original message", () => {
		initTheme("dark");
		const message = createAssistantMessage([
			{ type: "text", text: "answer" },
			{ type: "thinking", thinking: "reasoning" },
		]);
		const component = new AssistantMessageComponent(message, false, undefined, "Thinking...", 1, [
			(markdown, { messageType }) => {
				return `${messageType}:${markdown}`;
			},
		]);

		const rendered = stripAnsi(component.render(80).join("\n"));
		expect(rendered).toContain("assistant:answer");
		expect(rendered).toContain("assistant-thinking:reasoning");
		expect(message.content).toEqual([
			{ type: "text", text: "answer" },
			{ type: "thinking", thinking: "reasoning" },
		]);
	});

	test("collapses completed code blocks over 200 lines and restores them on expansion", () => {
		initTheme("dark");
		const source = createCodeBlock(500);
		const message = createAssistantMessage([{ type: "text", text: source }]);
		const component = new AssistantMessageComponent(message);

		const collapsed = stripAnsi(component.render(80).join("\n"));
		expect(collapsed).toContain("line-001");
		expect(collapsed).toContain("line-020");
		expect(collapsed).toContain("... 已省略 460 行 ...");
		expect(collapsed).toContain("line-481");
		expect(collapsed).toContain("line-500");
		expect(collapsed).not.toContain("line-250");
		expect(message.content[0]).toEqual({ type: "text", text: source });

		component.setExpanded(true);
		const expanded = stripAnsi(component.render(80).join("\n"));
		expect(expanded).toContain("line-250");
		expect(expanded).not.toContain("已省略");

		component.setExpanded(false);
		const collapsedAgain = stripAnsi(component.render(80).join("\n"));
		expect(collapsedAgain).toContain("... 已省略 460 行 ...");
		expect(collapsedAgain).not.toContain("line-250");
	});

	test("collapses completed long Markdown and restores the exact source on expansion", () => {
		initTheme("dark");
		const source = `HEAD-${"a".repeat(9000)}-MIDDLE-${"b".repeat(9000)}-TAIL`;
		const message = createAssistantMessage([{ type: "text", text: source }]);
		const component = new AssistantMessageComponent(message);

		const collapsed = stripAnsi(component.render(80).join("\n"));
		expect(collapsed).toContain("HEAD-");
		expect(collapsed).toContain("-TAIL");
		expect(collapsed).toContain("已省略");
		expect(collapsed).not.toContain("-MIDDLE-");
		expect(message.content[0]).toEqual({ type: "text", text: source });

		component.setExpanded(true);
		const expanded = stripAnsi(component.render(80).join("\n"));
		expect(expanded).toContain("-MIDDLE-");
		expect(expanded).not.toContain("已省略");
	});

	test("keeps fenced blocks intact when collapsing surrounding long Markdown", () => {
		initTheme("dark");
		const source = `${"a".repeat(1900)}\n\`\`\`ts\nconst insideFence = "${"x".repeat(1000)}";\n\`\`\`\n${"b".repeat(15000)}-TAIL`;
		const component = new AssistantMessageComponent(createAssistantMessage([{ type: "text", text: source }]));

		const collapsed = stripAnsi(component.render(80).join("\n"));
		expect(collapsed).toContain("const insideFence");
		expect(collapsed).toContain("已省略");
		expect(collapsed).toContain("-TAIL");
	});

	test("does not react to expansion for short or incomplete streaming code blocks", () => {
		initTheme("dark");
		const shortComponent = new AssistantMessageComponent(
			createAssistantMessage([{ type: "text", text: createCodeBlock(200) }]),
		);
		const shortVersion = shortComponent.getRenderVersion();
		shortComponent.setExpanded(true);
		expect(shortComponent.getRenderVersion()).toBe(shortVersion);

		const streamingComponent = new AssistantMessageComponent();
		streamingComponent.updateContent(
			createAssistantMessage([{ type: "text", text: createCodeBlock(500, false) }]),
			true,
		);
		const streamingVersion = streamingComponent.getRenderVersion();
		const streaming = stripAnsi(streamingComponent.render(80).join("\n"));
		expect(streaming).toContain("line-250");
		expect(streaming).not.toContain("已省略");
		streamingComponent.setExpanded(true);
		expect(streamingComponent.getRenderVersion()).toBe(streamingVersion);
	});

	test("uses configured output padding for user messages", () => {
		initTheme("dark");

		const paddedComponent = new UserMessageComponent("hello", undefined, 1);
		const paddedLines = paddedComponent.render(40).map((line) => stripAnsi(line));
		expect(paddedLines.some((line) => line.startsWith("│  ❯ hello"))).toBe(true);

		const unpaddedComponent = new UserMessageComponent("hello", undefined, 0);
		const unpaddedLines = unpaddedComponent.render(40).map((line) => stripAnsi(line));
		expect(unpaddedLines.some((line) => line.startsWith("│ ❯ hello"))).toBe(true);
	});
});
