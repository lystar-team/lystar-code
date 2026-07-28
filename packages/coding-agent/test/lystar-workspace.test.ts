import { Container, Text, visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
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

	it("keeps the editor visible before autocomplete items at minimal height", () => {
		const editor = textContainer(
			"────────────────",
			"  $",
			"────────────────",
			"skill-1",
			"skill-2",
			"skill-3",
			"(1/3)",
		);
		const composer = new WorkspaceComposer({ editor, getInfo: () => "model", fullscreen: true });
		const shortcuts = textContainer("shortcuts");
		const workspace = new LystarWorkspace({
			getHeight: () => 8,
			header: textContainer("header"),
			scrollContainers: [textContainer("latest message")],
			bottomContainers: [composer, shortcuts],
			fixedBottomContainers: [composer, shortcuts],
			fullscreen: true,
		});

		const rendered = workspace.render(40).map(stripAnsi);
		expect(rendered).toHaveLength(8);
		expect(rendered.join("\n")).toContain("│❯ $");
		expect(rendered.join("\n")).toContain("skill-1");
		expect(rendered.at(-1)?.trim()).toBe("shortcuts");
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

	it("reuses versioned history blocks until their content changes", () => {
		const history = {
			version: 0,
			render: vi.fn(() => Array.from({ length: 40 }, (_, index) => `history-${index}`)),
			invalidate: () => {},
			getRenderVersion() {
				return this.version;
			},
		};
		const chat = new Container();
		chat.addChild(history);
		const workspace = new LystarWorkspace({
			getHeight: () => 8,
			header: textContainer("header"),
			scrollContainers: [chat],
			bottomContainers: [textContainer("editor")],
			fullscreen: true,
		});

		workspace.render(60);
		workspace.pageUp();
		workspace.render(60);
		expect(history.render).toHaveBeenCalledOnce();

		history.version++;
		workspace.render(60);
		expect(history.render).toHaveBeenCalledTimes(2);
	});

	it("reuses 500 history blocks and redraws only the changed block", () => {
		let renderCount = 0;
		const histories = Array.from({ length: 500 }, (_, index) => ({
			version: 0,
			render: () => {
				renderCount++;
				return [`message-${index}`];
			},
			invalidate: () => {},
			getRenderVersion() {
				return this.version;
			},
		}));
		const chat = new Container();
		for (const history of histories) chat.addChild(history);
		const workspace = new LystarWorkspace({
			getHeight: () => 24,
			header: textContainer("header"),
			scrollContainers: [chat],
			bottomContainers: [textContainer("editor")],
			fullscreen: true,
		});

		workspace.render(80);
		workspace.render(80);
		expect(renderCount).toBe(500);

		histories[250]!.version++;
		workspace.render(80);
		expect(renderCount).toBe(501);
	});

	it("prioritizes the active status over widgets when bottom space is limited", () => {
		const status = textContainer("正在执行");
		const widget = textContainer("widget-1", "widget-2", "widget-3");
		const footer = textContainer("累计 输入 12K");
		const composer = textContainer("╭────╮", "│❯   │", "╰────╯");
		const shortcuts = textContainer("Esc 取消");
		const workspace = new LystarWorkspace({
			getHeight: () => 8,
			header: textContainer("header"),
			scrollContainers: [textContainer("latest message")],
			bottomContainers: [status, widget, composer, footer, shortcuts],
			fixedBottomContainers: [composer, shortcuts],
			optionalBottomPriority: [status, footer, widget],
			fullscreen: true,
		});

		const rendered = workspace.render(60).map(stripAnsi).join("\n");

		expect(rendered).toContain("正在执行");
		expect(rendered).toContain("累计 输入 12K");
		expect(rendered).not.toContain("widget-");
	});

	it("scales the wheel step with the session viewport", () => {
		let height = 8;
		const workspace = new LystarWorkspace({
			getHeight: () => height,
			header: textContainer("header"),
			scrollContainers: [textContainer(...Array.from({ length: 100 }, (_, index) => `line-${index}`))],
			bottomContainers: [textContainer("editor")],
			fullscreen: true,
		});

		height = 3;
		workspace.render(80);
		expect(workspace.getWheelScrollStep()).toBe(2);

		height = 8;
		workspace.render(80);
		expect(workspace.getWheelScrollStep()).toBe(2);

		height = 24;
		workspace.render(80);
		expect(workspace.getWheelScrollStep()).toBe(4);

		height = 60;
		workspace.render(80);
		expect(workspace.getWheelScrollStep()).toBe(8);
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

	it("uses structured editor sections without parsing border glyphs", () => {
		const composer = new WorkspaceComposer({
			editor: textContainer("legacy editor output"),
			getEditorRender: () => ({ body: ["  结构化输入"], autocomplete: ["候选一"] }),
			getInfo: () => "项目已信任 · test-model",
			fullscreen: true,
		});

		const lines = composer.render(40).map(stripAnsi);

		expect(lines.join("\n")).toContain("│❯ 结构化输入");
		expect(lines.join("\n")).toContain("候选一");
		expect(lines.join("\n")).not.toContain("legacy editor output");
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
