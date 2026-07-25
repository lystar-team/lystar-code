import { Container, Text } from "@earendil-works/pi-tui";
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
			fullscreen: true,
		});

		const rendered = workspace.render(40);
		expect(rendered).toHaveLength(8);
		expect(rendered.join("\n")).toContain("line-12");
		expect(rendered.slice(-2).map((line) => line.trimEnd())).toEqual(["  editor", "  footer"]);
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

	it("renders the Grok-style workspace header and composer", () => {
		const header = new WorkspaceHeader(() => ({ path: "~/project", session: "任务一", context: "9.5k / 128k" }));
		const editor = textContainer("────────────────", "  修复登录流程", "────────────────");
		const composer = new WorkspaceComposer({
			editor,
			getInfo: () => "claude-sonnet-4 (high)  ·  项目已信任",
			fullscreen: true,
		});

		const headerLines = header.render(60).map(stripAnsi);
		const composerLines = composer.render(60).map(stripAnsi);

		expect(headerLines).toHaveLength(1);
		expect(headerLines[0]).toContain("~/project  ·  任务一");
		expect(headerLines[0]).toContain("9.5k / 128k");
		expect(composerLines[0]).toMatch(/^╭─+╮$/);
		expect(composerLines[1]).toContain("│❯ 修复登录流程");
		expect(composerLines[2]).toContain("claude-sonnet-4 (high)  ·  项目已信任");
		expect(composerLines[2]).toMatch(/^╰─+ .* ╯$/);
	});
});
