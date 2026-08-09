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
		const composer = new WorkspaceComposer({ editor, getInfo: () => ({ primary: "model" }), fullscreen: true });
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

	it("resets the virtual history window when the session changes", () => {
		const chat = textContainer(...Array.from({ length: 100 }, (_, index) => `old-${index}`));
		const workspace = new LystarWorkspace({
			getHeight: () => 12,
			header: textContainer("header"),
			scrollContainers: [chat],
			bottomContainers: [textContainer("editor")],
			fullscreen: true,
		});

		workspace.render(60);
		workspace.pageUp();
		expect(workspace.isFollowing()).toBe(false);

		chat.clear();
		chat.addChild(new Text("new-session-tail", 0, 0));
		workspace.resetScrollback();
		const rendered = workspace.render(60).map(stripAnsi).join("\n");

		expect(workspace.isFollowing()).toBe(true);
		expect(rendered).toContain("new-session-tail");
		expect(rendered).not.toContain("old-");
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

	it("materializes only the visible history window and loads older blocks on demand", () => {
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
		const initialRenderCount = renderCount;
		expect(initialRenderCount).toBeGreaterThan(0);
		expect(initialRenderCount).toBeLessThan(100);
		expect(workspace.render(80).join("\n")).toContain("message-499");
		expect(renderCount).toBe(initialRenderCount);

		histories[499]!.version++;
		workspace.render(80);
		expect(renderCount).toBe(initialRenderCount + 1);

		workspace.pageUp();
		workspace.render(80);
		workspace.pageUp();
		workspace.render(80);
		expect(renderCount).toBeGreaterThan(initialRenderCount + 1);
		expect(renderCount).toBeLessThan(500);

		const beforeTop = renderCount;
		workspace.scrollToTop();
		expect(workspace.render(80).join("\n")).toContain("message-0");
		expect(renderCount - beforeTop).toBeLessThan(100);
		expect(renderCount).toBeLessThan(500);
	});

	it("keeps rendering work bounded after navigating deep history", () => {
		let versionReads = 0;
		const chat = new Container();
		for (let index = 0; index < 5000; index++) {
			const component = {
				render: () => [`message-${index}`],
				invalidate: () => {},
				getRenderVersion: () => {
					versionReads++;
					return 0;
				},
			};
			chat.addChild(component);
		}
		const workspace = new LystarWorkspace({
			getHeight: () => 24,
			header: textContainer("header"),
			scrollContainers: [chat],
			bottomContainers: [textContainer("editor")],
			fullscreen: true,
		});

		workspace.render(80);
		workspace.scrollToTop();
		const top = workspace.render(80).join("\n");
		expect(top).toContain("message-0");
		expect(versionReads).toBeLessThan(200);

		for (let index = 0; index < 100; index++) {
			workspace.pageDown();
			workspace.render(80);
		}
		versionReads = 0;
		workspace.render(80);
		expect(versionReads).toBeLessThan(200);

		for (let index = 0; index < 400; index++) {
			workspace.pageDown();
			workspace.render(80);
		}
		expect(workspace.isFollowing()).toBe(true);
		expect(workspace.render(80).join("\n")).toContain("message-4999");
	});

	it("invalidates off-screen history lazily", () => {
		const invalidations = Array.from({ length: 1000 }, () => vi.fn());
		const chat = new Container();
		for (let index = 0; index < invalidations.length; index++) {
			const component = {
				render: () => [`message-${index}`],
				invalidate: invalidations[index]!,
				getRenderVersion: () => 0,
			};
			chat.addChild(component);
		}
		const workspace = new LystarWorkspace({
			getHeight: () => 24,
			header: textContainer("header"),
			scrollContainers: [chat],
			bottomContainers: [textContainer("editor")],
			fullscreen: true,
		});

		workspace.render(80);
		workspace.invalidate();
		workspace.render(80);

		expect(invalidations[0]).not.toHaveBeenCalled();
		expect(invalidations.at(-1)).toHaveBeenCalledOnce();
		expect(invalidations.reduce((total, invalidate) => total + invalidate.mock.calls.length, 0)).toBeLessThan(100);
	});

	it("releases rendered blocks outside the history window", () => {
		const renderCounts = Array.from({ length: 500 }, () => 0);
		const chat = new Container();
		for (let index = 0; index < renderCounts.length; index++) {
			const component = {
				render: () => {
					renderCounts[index]++;
					return [`message-${index}`];
				},
				invalidate: () => {},
				getRenderVersion: () => 0,
			};
			chat.addChild(component);
		}
		const workspace = new LystarWorkspace({
			getHeight: () => 24,
			header: textContainer("header"),
			scrollContainers: [chat],
			bottomContainers: [textContainer("editor")],
			fullscreen: true,
		});

		workspace.render(80);
		workspace.scrollToTop();
		workspace.render(80);
		workspace.scrollToBottom();
		workspace.render(80);
		workspace.scrollToTop();
		workspace.render(80);

		expect(renderCounts[0]).toBe(2);
		expect(renderCounts.at(-1)).toBe(2);
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

	it("uses one-line wheel scrolling at every viewport height", () => {
		let height = 3;
		const workspace = new LystarWorkspace({
			getHeight: () => height,
			header: textContainer("header"),
			scrollContainers: [textContainer(...Array.from({ length: 100 }, (_, index) => `line-${index}`))],
			bottomContainers: [textContainer("editor")],
			fullscreen: true,
		});

		for (height of [3, 8, 24, 60]) {
			workspace.render(80);
			expect(workspace.getWheelScrollStep()).toBe(1);
		}
	});

	it("renders and hides the fullscreen scrollbar", () => {
		const workspace = new LystarWorkspace({
			getHeight: () => 8,
			header: textContainer("header"),
			scrollContainers: [textContainer(...Array.from({ length: 30 }, (_, index) => `line-${index}`))],
			bottomContainers: [textContainer("editor")],
			fullscreen: true,
			scrollbar: "always",
		});

		expect(stripAnsi(workspace.render(40).join("\n"))).toContain("┃");
		workspace.setScrollbar("hidden");
		expect(stripAnsi(workspace.render(40).join("\n"))).not.toMatch(/[│┃]/);
	});

	it("moves one line per wheel step through a long history", () => {
		const workspace = new LystarWorkspace({
			getHeight: () => 24,
			header: textContainer("header"),
			scrollContainers: [textContainer(...Array.from({ length: 500 }, (_, index) => `line-${index}`))],
			bottomContainers: [textContainer("editor")],
			fullscreen: true,
			scrollbar: "hidden",
		});
		const topLine = () => stripAnsi(workspace.render(80)[1] ?? "").trim();

		workspace.render(80);
		workspace.scrollToTop();
		expect(topLine()).toBe("line-0");
		for (let index = 1; index <= 80; index++) {
			workspace.scrollBy(workspace.getWheelScrollStep());
			expect(topLine()).toBe(`line-${index}`);
		}
		for (let index = 79; index >= 0; index--) {
			workspace.scrollBy(-workspace.getWheelScrollStep());
			expect(topLine()).toBe(`line-${index}`);
		}
	});

	it("keeps context usage visible when the header is narrow", () => {
		const header = new WorkspaceHeader(() => ({
			product: "LYStar Agent",
			path: "~/very/long/project/path/that/needs/truncation",
			branch: "main",
			context: "上下文 64.2%  ·  82K/128K",
		}));

		const line = stripAnsi(header.render(40)[0]);

		expect(line).toContain("上下文 64.2%  ·  82K/128K");
		expect(visibleWidth(line)).toBeLessThanOrEqual(40);
	});

	it("prioritizes task text at medium and narrow widths", () => {
		const header = new WorkspaceHeader(() => ({
			product: "LYStar Agent",
			path: "~/project",
			branch: "main",
			task: "修复登录流程",
			context: "上下文 7.4%  ·  9.5K/128K",
			compactContext: "上下文 7.4%",
		}));

		const medium = stripAnsi(header.render(80)[0]);
		const narrow = stripAnsi(header.render(48)[0]);

		expect(medium).not.toContain("LYStar Agent");
		expect(medium).toContain("修复登录流程");
		expect(medium).toContain("上下文 7.4%");
		expect(narrow).toContain("修复登录流程");
		expect(narrow).toContain("上下文 7.4%");
		expect(visibleWidth(medium)).toBeLessThanOrEqual(80);
		expect(visibleWidth(narrow)).toBeLessThanOrEqual(48);
	});

	it("keeps the active top status ahead of secondary header rows at minimal height", () => {
		const workspace = new LystarWorkspace({
			getHeight: () => 5,
			header: textContainer("header-1", "header-2", "header-3"),
			topStatus: textContainer("正在执行 edit src/index.ts"),
			scrollContainers: [textContainer("latest message")],
			bottomContainers: [textContainer("editor")],
			fixedBottomContainers: [textContainer("unused")],
			fullscreen: true,
		});

		const rendered = workspace.render(60).map(stripAnsi).join("\n");
		expect(rendered).toContain("正在执行 edit src/index.ts");
		expect(rendered).not.toContain("header-3");
		expect(workspace.render(60)).toHaveLength(5);
	});

	it("renders the product workspace header and structured composer status", () => {
		const header = new WorkspaceHeader(() => ({
			product: "LYStar Agent",
			path: "~/project",
			branch: "main",
			session: "任务一",
			context: "上下文 7.4%  ·  9.5K/128K",
		}));
		const editor = textContainer("────────────────", "  修复登录流程", "────────────────");
		const composer = new WorkspaceComposer({
			editor,
			brand: "LYStar Agent",
			getInfo: () => ({
				primary: "upstream/claude-sonnet-4 · 思考强度：高(high)",
				secondary: "项目已信任",
			}),
			fullscreen: true,
		});

		const headerLines = header.render(120).map(stripAnsi);
		const composerLines = composer.render(80).map(stripAnsi);

		expect(headerLines).toHaveLength(1);
		expect(headerLines[0]).toContain("LYStar Agent  ·  ~/project  ·  main  ·  任务一");
		expect(headerLines[0]).toContain("上下文 7.4%  ·  9.5K/128K");
		expect(composerLines[0]).toMatch(/^╭─+ LYStar Agent ─╮$/);
		expect(composerLines[1]).toContain("│❯ 修复登录流程");
		expect(composerLines[2]).toContain("upstream/claude-sonnet-4");
		expect(composerLines[2]).toContain("思考强度：高(high)");
		expect(composerLines[2]).toContain("项目已信任");
		expect(composerLines[2]).toMatch(/^╰─+ .* ─+ .* ─╯$/);
	});

	it("keeps the LYStar brand in the composer border without changing its width", () => {
		const composer = new WorkspaceComposer({
			editor: textContainer("────────────────", "  ", "────────────────"),
			brand: "LYStar Agent",
			getInfo: () => ({ primary: "model" }),
			fullscreen: true,
		});

		for (const width of [40, 80, 160]) {
			const top = stripAnsi(composer.render(width)[0]);
			expect(top).toContain("LYStar Agent");
			expect(visibleWidth(top)).toBe(width);
		}

		const tinyTop = stripAnsi(composer.render(16)[0]);
		expect(tinyTop).not.toContain("LYStar Agent");
		expect(visibleWidth(tinyTop)).toBe(16);
	});

	it("uses structured editor sections only while that editor is active", () => {
		const editor = new Container();
		const structuredEditor = {
			render: () => ["legacy editor output"],
			invalidate: () => {},
			renderWorkspace: () => ({ body: ["  结构化输入"], autocomplete: ["候选一"] }),
		};
		editor.addChild(structuredEditor);
		const composer = new WorkspaceComposer({
			editor,
			structuredEditor,
			getInfo: () => ({ primary: "test-model", secondary: "项目已信任" }),
			fullscreen: true,
		});

		const lines = composer.render(40).map(stripAnsi);

		expect(lines.join("\n")).toContain("│❯ 结构化输入");
		expect(lines.join("\n")).toContain("候选一");
		expect(lines.join("\n")).not.toContain("legacy editor output");

		editor.clear();
		editor.addChild(new Text("继续会话（当前目录）", 0, 0));
		const selectorLines = composer.render(40).map(stripAnsi);
		expect(selectorLines.join("\n")).toContain("继续会话（当前目录）");
		expect(selectorLines.join("\n")).not.toContain("结构化输入");
	});

	it("centers the prompt arrow beside multiline input", () => {
		const editor = textContainer("────────────────", "  第一行", "  第二行", "  第三行", "────────────────");
		const composer = new WorkspaceComposer({ editor, getInfo: () => ({ primary: "" }), fullscreen: true });

		const lines = composer.render(40).map(stripAnsi);

		expect(lines[1]).toContain("│  第一行");
		expect(lines[2]).toContain("│❯ 第二行");
		expect(lines[3]).toContain("│  第三行");
	});
});
