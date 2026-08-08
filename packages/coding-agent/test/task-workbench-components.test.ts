import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Container, setKeybindings } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { ChangesSelectorComponent } from "../src/modes/interactive/components/changes-selector.ts";
import {
	formatTurnSummary,
	resolveTurnOutcome,
	TurnSummaryComponent,
} from "../src/modes/interactive/components/turn-summary.ts";
import { WorkspaceActivityBar } from "../src/modes/interactive/components/workspace-activity-bar.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { uiGlyphs } from "../src/modes/interactive/ui-glyphs.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

describe("task workbench components", () => {
	beforeAll(() => {
		initTheme("dark");
		setKeybindings(KeybindingsManager.create());
	});

	it("hides the activity row while idle and reports real tool progress", () => {
		const requestRender = vi.fn();
		const bar = new WorkspaceActivityBar(requestRender);
		expect(bar.render(80)).toEqual([]);

		bar.setState({
			phase: "runningTool",
			action: "edit",
			subject: "src/index.ts",
			startedAt: Date.now() - 65_000,
			completedTools: 2,
			knownTools: 5,
			queueCount: 1,
			runningTools: 1,
		});
		const line = stripAnsi(bar.render(80)[0] ?? "");
		expect(line).toContain("edit src/index.ts");
		expect(line).toContain("已完成 2/5");
		expect(line).toContain("队列 1");
		expect(line).toContain("1m5s");
		bar.dispose();
		expect(bar.render(80)).toEqual([]);
	});

	it("formats all final turn outcomes from facts", () => {
		const base = {
			startedAt: 0,
			endedAt: 134_000,
			outcome: "completed" as const,
			toolErrors: 1,
			totalTools: 6,
			successfulTools: 5,
			failedTools: 1,
			cancelledTools: 0,
			commandCount: 2,
			successfulCommands: 1,
			files: [
				{ path: "a.ts", additions: 4, deletions: 1 },
				{ path: "b.ts", additions: 2, deletions: 0 },
			],
			tools: [],
			retried: false,
			compacted: false,
			cancelled: false,
		};
		expect(formatTurnSummary(base)).toBe("完成 · 修改 2 个文件 · +6/-1 · 命令 1/2 · 2m14s");
		expect(formatTurnSummary({ ...base, outcome: "failed" })).toBe(
			"执行失败 · 5 个操作成功 · 1 个操作未完成 · 修改 2 个文件 · +6/-1 · 命令 1/2 · 2m14s",
		);
		expect(formatTurnSummary({ ...base, outcome: "incomplete" })).toBe(
			"未完成 · 修改 2 个文件 · +6/-1 · 命令 1/2 · 2m14s",
		);
		expect(formatTurnSummary({ ...base, outcome: "cancelled", successfulTools: 3 })).toBe(
			"已取消 · 完成 3/6 个操作 · 修改 2 个文件 · +6/-1 · 命令 1/2 · 2m14s",
		);
	});

	it("derives final outcomes from settlement facts instead of historical tool errors", () => {
		expect(resolveTurnOutcome({ cancelled: false, stopReason: "stop", hasUnfinishedTools: false })).toBe("completed");
		expect(resolveTurnOutcome({ cancelled: false, stopReason: "error", hasUnfinishedTools: false })).toBe("failed");
		expect(resolveTurnOutcome({ cancelled: false, stopReason: "toolUse", hasUnfinishedTools: true })).toBe(
			"incomplete",
		);
		expect(resolveTurnOutcome({ cancelled: true, stopReason: "stop", hasUnfinishedTools: false })).toBe("cancelled");
	});

	it("keeps a completed summary successful while exposing recovered tool errors when expanded", () => {
		const summary = new TurnSummaryComponent({
			startedAt: 0,
			endedAt: 10_000,
			outcome: "completed",
			toolErrors: 1,
			totalTools: 2,
			successfulTools: 1,
			failedTools: 1,
			cancelledTools: 0,
			commandCount: 1,
			successfulCommands: 0,
			files: [{ path: "src/index.ts", additions: 3, deletions: 1 }],
			tools: [{ name: "bash", subject: "npm test", status: "error", error: "Command exited with code 1" }],
			retried: true,
			compacted: false,
			cancelled: false,
		});
		const collapsed = stripAnsi(summary.render(80).join("\n"));
		expect(collapsed).toContain(`${uiGlyphs.success} 完成`);
		expect(collapsed).not.toContain("Command exited with code 1");
		summary.setExpanded(true);
		const expanded = stripAnsi(summary.render(80).join("\n"));
		expect(expanded).toContain("过程中有 1 次 Tool 调用失败，Agent 已继续处理");
		expect(expanded).toContain("src/index.ts");
		expect(expanded).toContain("bash npm test：Command exited with code 1");
		expect(expanded).toContain("发生过重试");
	});

	it("switches changes scope and loads only the selected workspace diff", async () => {
		const requestRender = vi.fn();
		const loadWorkspaceDiff = vi.fn(async (path: string) => `diff --git a/${path} b/${path}\n-old\n+new`);
		const selector = new ChangesSelectorComponent({
			data: {
				turnFiles: [{ path: "turn.ts", additions: 1, deletions: 0, diff: "+ 1 new" }],
				workspaceFiles: [
					{ path: "old.ts", status: " M", additions: 1, deletions: 1 },
					{ path: "other.ts", status: "??" },
				],
				gitAvailable: true,
				loadWorkspaceDiff,
			},
			getHeight: () => 24,
			requestRender,
			onCancel: vi.fn(),
		});

		expect(stripAnsi(selector.render(80).join("\n"))).toContain("turn.ts");
		selector.handleInput("\t");
		await vi.waitFor(() => expect(loadWorkspaceDiff).toHaveBeenCalledWith("old.ts"));
		await vi.waitFor(() => expect(stripAnsi(selector.render(80).join("\n"))).toContain("+new"));
		selector.handleInput("\x1b[B");
		await vi.waitFor(() => expect(loadWorkspaceDiff).toHaveBeenCalledWith("other.ts"));
		expect(loadWorkspaceDiff).toHaveBeenCalledTimes(2);
	});

	it("shows an empty workspace without a false Diff loading state", () => {
		const selector = new ChangesSelectorComponent({
			data: {
				turnFiles: [],
				workspaceFiles: [],
				gitAvailable: true,
				loadWorkspaceDiff: vi.fn(),
			},
			getHeight: () => 24,
			requestRender: vi.fn(),
			onCancel: vi.fn(),
		});

		const rendered = stripAnsi(selector.render(80).join("\n"));
		expect(rendered).toContain("工作区没有未提交变更");
		expect(rendered).toContain("没有可审阅的文件");
		expect(rendered).not.toContain("正在读取 Diff");
	});

	it("uses the session name, then the first user line, as the task title", () => {
		const getWorkspaceTaskTitle = (
			InteractiveMode.prototype as unknown as {
				getWorkspaceTaskTitle(this: unknown): string;
			}
		).getWorkspaceTaskTitle;
		const context = Object.assign(Object.create(InteractiveMode.prototype), {
			runtimeHost: {
				session: {
					sessionManager: { getSessionName: () => undefined },
					messages: [{ role: "user", content: "修复登录流程\n并补测试", timestamp: 1 }],
				},
			},
		});
		expect(getWorkspaceTaskTitle.call(context)).toBe("修复登录流程");
		context.runtimeHost.session.sessionManager.getSessionName = () => "登录修复";
		expect(getWorkspaceTaskTitle.call(context)).toBe("登录修复");
	});

	it("keeps startup changelog to one line in fullscreen", () => {
		const chatContainer = new Container();
		const context = Object.assign(Object.create(InteractiveMode.prototype), {
			startupNoticesShown: false,
			changelogMarkdown: "## 0.84.1\n\n- 第一项\n- 第二项",
			version: "0.84.1-lystar.1",
			chatContainer,
			workspace: { isFullscreen: () => true },
			runtimeHost: { session: { settingsManager: { getCollapseChangelog: () => false } } },
		});
		const showStartupNoticesIfNeeded = (
			InteractiveMode.prototype as unknown as {
				showStartupNoticesIfNeeded(this: typeof context): void;
			}
		).showStartupNoticesIfNeeded;
		showStartupNoticesIfNeeded.call(context);
		expect(chatContainer.children).toHaveLength(1);
		expect(stripAnsi(chatContainer.render(80).join("\n"))).toContain("使用 /changelog 查看完整更新记录");
	});

	it("reads workspace changes separately from turn files", () => {
		const cwd = mkdtempSync(join(tmpdir(), "lystar-changes-"));
		try {
			spawnSync("git", ["init", "-q"], { cwd });
			writeFileSync(join(cwd, "tracked.txt"), "before\n");
			spawnSync("git", ["add", "tracked.txt"], { cwd });
			spawnSync(
				"git",
				["-c", "user.name=LYStar Test", "-c", "user.email=test@example.com", "commit", "-qm", "init"],
				{ cwd },
			);
			writeFileSync(join(cwd, "tracked.txt"), "after\n");
			writeFileSync(join(cwd, "untracked.txt"), "new\n");
			const context = Object.assign(Object.create(InteractiveMode.prototype), {
				runtimeHost: { session: { sessionManager: { getCwd: () => cwd } } },
			});
			const getWorkspaceChanges = (
				InteractiveMode.prototype as unknown as {
					getWorkspaceChanges(this: typeof context): {
						gitAvailable: boolean;
						files: Array<{ path: string; status: string; additions?: number; deletions?: number }>;
					};
				}
			).getWorkspaceChanges;
			const result = getWorkspaceChanges.call(context);
			expect(result.gitAvailable).toBe(true);
			expect(result.files).toEqual([
				{ path: "tracked.txt", status: " M", additions: 1, deletions: 1 },
				{ path: "untracked.txt", status: "??" },
			]);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("settles one collector once and merges repeated edits to the same file", () => {
		const chatContainer = new Container();
		const activityBar = { setState: vi.fn() };
		const ui = { requestRender: vi.fn() };
		const turnActivity = {
			startedAt: 0,
			phase: "waiting",
			tools: new Map([
				[
					"one",
					{
						id: "one",
						name: "edit",
						args: {},
						status: "success",
						filePath: "src/index.ts",
						additions: 2,
						deletions: 1,
					},
				],
				[
					"two",
					{
						id: "two",
						name: "edit",
						args: {},
						status: "success",
						filePath: "src/index.ts",
						additions: 3,
						deletions: 0,
					},
				],
			]),
			toolOrder: ["one", "two"],
			queueCount: 0,
			retried: false,
			compacted: false,
			cancelled: false,
		};
		const context = Object.assign(Object.create(InteractiveMode.prototype), {
			turnActivity,
			lastTurnFiles: [],
			chatContainer,
			activityBar,
			ui,
		});
		const finishTurnActivity = (
			InteractiveMode.prototype as unknown as {
				finishTurnActivity(this: typeof context): void;
			}
		).finishTurnActivity;

		finishTurnActivity.call(context);
		expect(context.lastTurnFiles).toEqual([{ path: "src/index.ts", additions: 5, deletions: 1 }]);
		expect(chatContainer.children.filter((child) => child instanceof TurnSummaryComponent)).toHaveLength(1);
		finishTurnActivity.call(context);
		expect(chatContainer.children.filter((child) => child instanceof TurnSummaryComponent)).toHaveLength(1);
	});
});
