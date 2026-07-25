import { Container, Text, visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it } from "vitest";
import {
	LystarWorkspace,
	WorkspaceComposer,
	WorkspaceHeader,
} from "../src/modes/interactive/components/lystar-workspace.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

function textContainer(...lines: string[]): Container {
	const container = new Container();
	for (const line of lines) container.addChild(new Text(line, 0, 0));
	return container;
}

describe("LYStar workspace", () => {
	beforeAll(() => initTheme("dark"));

	it("keeps a stable terminal height and follows the newest content", () => {
		const header = textContainer("header");
		const chat = textContainer(...Array.from({ length: 12 }, (_, index) => `line-${index + 1}`));
		const bottom = textContainer("editor", "footer");
		const workspace = new LystarWorkspace({
			getHeight: () => 8,
			header,
			scrollContainers: [chat],
			bottomContainers: [bottom],
			fixedBottomContainers: [bottom],
			fullscreen: true,
		});

		const rendered = workspace.render(40);
		expect(rendered).toHaveLength(8);
		expect(rendered.join("\n")).toContain("line-12");
		expect(rendered.slice(-2).map((line) => line.trimEnd())).toEqual(["  editor", "  footer"]);
	});

	it("keeps the composer and shortcuts when optional bottom content overflows", () => {
		const optional = textContainer(...Array.from({ length: 10 }, (_, index) => `status-${index + 1}`));
		const composer = textContainer("╭────╮", "│❯   │", "╰────╯");
		const shortcuts = textContainer("Shift+Tab:思考强度  │  Esc:取消");
		const workspace = new LystarWorkspace({
			getHeight: () => 8,
			header: textContainer("header"),
			scrollContainers: [textContainer("latest message")],
			bottomContainers: [optional, composer, shortcuts],
			fixedBottomContainers: [composer, shortcuts],
			fullscreen: true,
		});

		const rendered = workspace.render(60).map(stripAnsi);

		expect(rendered).toHaveLength(8);
		expect(rendered.slice(-4).map((line) => line.trim())).toEqual([
			"╭────╮",
			"│❯   │",
			"╰────╯",
			"Shift+Tab:思考强度  │  Esc:取消",
		]);
	});

	it("keeps the one-line usage footer when one optional row fits", () => {
		const footer = textContainer("输入 267M · 输出 572K · 命中 99.5%");
		const composer = textContainer("╭────╮", "│❯   │", "╰────╯");
		const shortcuts = textContainer("Shift+Tab:思考强度  │  Esc:取消");
		const workspace = new LystarWorkspace({
			getHeight: () => 7,
			header: textContainer("~/project  上下文 81.8%"),
			scrollContainers: [textContainer("latest message")],
			bottomContainers: [composer, footer, shortcuts],
			fixedBottomContainers: [composer, shortcuts],
			fullscreen: true,
		});

		const rendered = workspace.render(60).map(stripAnsi);

		expect(rendered.join("\n")).toContain("输入 267M · 输出 572K · 命中 99.5%");
		expect(rendered.slice(-5).map((line) => line.trim())).toEqual([
			"╭────╮",
			"│❯   │",
			"╰────╯",
			"输入 267M · 输出 572K · 命中 99.5%",
			"Shift+Tab:思考强度  │  Esc:取消",
		]);
	});

	it("preserves the user's position while new content arrives", () => {
		const chat = textContainer(...Array.from({ length: 20 }, (_, index) => `line-${index + 1}`));
		const workspace = new LystarWorkspace({
			getHeight: () => 7,
			header: textContainer("header"),
			scrollContainers: [chat],
			bottomContainers: [textContainer("editor")],
			fullscreen: true,
		});

		workspace.render(60);
		workspace.pageUp();
		const before = workspace.render(60);
		chat.addChild(new Text("line-21", 0, 0));
		const after = workspace.render(60);

		expect(workspace.isFollowing()).toBe(false);
		expect(after[1]).toBe(before[1]);
		expect(after.join("\n")).toContain("下方还有");
		workspace.scrollToBottom();
		expect(workspace.render(60).join("\n")).toContain("line-21");
	});

	it("reports the row inside a clicked scroll component", () => {
		const execution = { render: () => ["summary", "detail-1", "detail-2"], invalidate: () => {} };
		const chat = new Container();
		chat.addChild(execution);
		const workspace = new LystarWorkspace({
			getHeight: () => 8,
			header: textContainer("header"),
			scrollContainers: [chat],
			bottomContainers: [textContainer("editor")],
			fullscreen: true,
		});

		workspace.render(40);

		expect(workspace.getComponentHitAtScreenRow(1)).toEqual({ component: execution, row: 0 });
		expect(workspace.getComponentHitAtScreenRow(2)).toEqual({ component: execution, row: 1 });
	});

	it("keeps context usage visible when the header is narrow", () => {
		const header = new WorkspaceHeader(() => ({
			path: "~/very/long/project/path/that/needs/truncation",
			context: "上下文 64.2%  ·  82K/128K",
		}));

		const line = stripAnsi(header.render(40)[0]);

		expect(line).toContain("上下文 64.2%  ·  82K/128K");
		expect(visibleWidth(line)).toBeLessThanOrEqual(40);
	});

	it("renders the Grok-style workspace header and composer", () => {
		const header = new WorkspaceHeader(() => ({
			path: "~/project",
			session: "任务一",
			context: "上下文 7.4%  ·  9.5K/128K",
		}));
		const editor = textContainer("────────────────", "  修复登录流程", "────────────────");
		const composer = new WorkspaceComposer({
			editor,
			getInfo: () => "(upstream) claude-sonnet-4 · 思考强度：高(high) · 项目已信任",
			fullscreen: true,
		});

		const headerLines = header.render(60).map(stripAnsi);
		const composerLines = composer.render(60).map(stripAnsi);

		expect(headerLines).toHaveLength(1);
		expect(headerLines[0]).toContain("~/project  ·  任务一");
		expect(headerLines[0]).toContain("上下文 7.4%  ·  9.5K/128K");
		expect(composerLines[0]).toMatch(/^╭─+╮$/);
		expect(composerLines[1]).toContain("│❯ 修复登录流程");
		expect(composerLines[2]).toContain("(upstream) claude-sonnet-4");
		expect(composerLines[2]).toContain("思考强度：高(high)");
		expect(composerLines[2]).toMatch(/^╰─+ .* ╯$/);
	});

	it("centers the prompt arrow beside multiline input", () => {
		const editor = textContainer("────────────────", "  第一行", "  第二行", "  第三行", "────────────────");
		const composer = new WorkspaceComposer({ editor, getInfo: () => "", fullscreen: true });

		const lines = composer.render(40).map(stripAnsi);

		expect(lines[1]).toContain("│  第一行");
		expect(lines[2]).toContain("│❯ 第二行");
		expect(lines[3]).toContain("│  第三行");
	});
});
