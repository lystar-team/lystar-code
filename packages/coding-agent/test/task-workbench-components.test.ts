import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Container, setKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { createApplyPatchToolDefinition } from "../src/extensions/apply-patch/index.ts";
import { BranchSummaryMessageComponent } from "../src/modes/interactive/components/branch-summary-message.ts";
import { ChangesSelectorComponent } from "../src/modes/interactive/components/changes-selector.ts";
import { CompactionSummaryMessageComponent } from "../src/modes/interactive/components/compaction-summary-message.ts";
import { SkillInvocationMessageComponent } from "../src/modes/interactive/components/skill-invocation-message.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import {
	formatTurnSummary,
	resolveTurnOutcome,
	TurnSummaryComponent,
} from "../src/modes/interactive/components/turn-summary.ts";
import { WorkspaceActivityBar } from "../src/modes/interactive/components/workspace-activity-bar.ts";
import { getLatestThinkingActivityText, InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
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

	it("hides waiting activity and keeps the latest thinking tail visible", () => {
		const bar = new WorkspaceActivityBar(() => undefined);
		bar.setState({
			phase: "waiting",
			startedAt: Date.now(),
			completedTools: 0,
			knownTools: 0,
			queueCount: 0,
		});
		expect(bar.render(80)).toEqual([]);

		bar.setState({
			phase: "thinking",
			thinking: "正在检查前面的上下文并准备最后结论",
			startedAt: Date.now(),
			completedTools: 0,
			knownTools: 0,
			queueCount: 0,
		});
		const line = stripAnsi(bar.render(24)[0] ?? "");
		expect(line).toContain("最后结论");
		expect(line).not.toContain("正在检查");
		expect(visibleWidth(bar.render(24)[0] ?? "")).toBeLessThanOrEqual(24);
		bar.dispose();
	});

	it("renders inline Markdown in live thinking without exposing source markers", () => {
		const bar = new WorkspaceActivityBar(() => undefined);
		bar.setState({
			phase: "thinking",
			thinking: "正在检查 **类型定义** 和 `apply_patch`",
			startedAt: Date.now(),
			completedTools: 0,
			knownTools: 0,
			queueCount: 0,
		});

		const raw = bar.render(80)[0] ?? "";
		const line = stripAnsi(raw);
		expect(line).toContain("正在检查 类型定义 和 apply_patch");
		expect(line).not.toContain("**");
		expect(line).not.toContain("`");
		expect(raw).toContain(theme.fg("mdCode", "apply_patch"));

		bar.setState({
			phase: "thinking",
			thinking: "**正在分析",
			startedAt: Date.now(),
			completedTools: 0,
			knownTools: 0,
			queueCount: 0,
		});
		expect(stripAnsi(bar.render(80)[0] ?? "")).toContain("**正在分析");
		bar.dispose();
	});

	it("extracts the last non-empty thinking line for live activity", () => {
		expect(
			getLatestThinkingActivityText({
				content: [
					{ type: "thinking", thinking: "第一行\n\n  第二行  " },
					{ type: "text", text: "answer" },
				],
			} as never),
		).toBe("第二行");
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
		expect(formatTurnSummary(base)).toBe("完成 · 修改 2 个文件 · +6 -1 · 命令 1/2 · 2m14s");
		expect(formatTurnSummary({ ...base, outcome: "failed" })).toBe(
			"执行失败 · 5 个操作成功 · 1 个操作未完成 · 修改 2 个文件 · +6 -1 · 命令 1/2 · 2m14s",
		);
		expect(formatTurnSummary({ ...base, outcome: "incomplete" })).toBe(
			"未完成 · 修改 2 个文件 · +6 -1 · 命令 1/2 · 2m14s",
		);
		expect(formatTurnSummary({ ...base, outcome: "cancelled", successfulTools: 3 })).toBe(
			"已取消 · 完成 3/6 个操作 · 修改 2 个文件 · +6 -1 · 命令 1/2 · 2m14s",
		);
	});

	it("keeps turn summaries on one line without repeating the expand shortcut", () => {
		const summary = new TurnSummaryComponent({
			startedAt: 0,
			endedAt: 335_000,
			outcome: "completed",
			toolErrors: 1,
			totalTools: 15,
			successfulTools: 14,
			failedTools: 1,
			cancelledTools: 0,
			commandCount: 15,
			successfulCommands: 14,
			files: [{ path: "src/index.ts", additions: 437, deletions: 0 }],
			tools: [],
			retried: false,
			compacted: false,
			cancelled: false,
		});

		for (const width of [40, 60, 80, 120]) {
			const lines = summary.render(width).map(stripAnsi);
			expect(lines).toHaveLength(2);
			expect(visibleWidth(lines[0])).toBeLessThanOrEqual(width);
			expect(lines[0]).toContain(uiGlyphs.collapsed);
			expect(lines[1]).toContain("─");
			expect(lines[0]).not.toContain("Ctrl+O");
			expect(lines[0]).not.toContain("展开");
		}
	});

	it("keeps the global expand hint out of collapsed message cards", () => {
		const cards = [
			new SkillInvocationMessageComponent({
				name: "shuorenhua",
				location: "/tmp/SKILL.md",
				content: "instructions",
				userMessage: undefined,
			}),
			new BranchSummaryMessageComponent({
				role: "branchSummary",
				summary: "summary",
				fromId: "entry-1",
				timestamp: 1,
			}),
			new CompactionSummaryMessageComponent({
				role: "compactionSummary",
				summary: "summary",
				tokensBefore: 120_000,
				timestamp: 1,
			}),
		];

		for (const card of cards) {
			const lines = card.render(80).map(stripAnsi);
			const rendered = lines.join("\n");
			expect(rendered).not.toContain("Ctrl+O");
			expect(rendered).not.toContain("展开）");
			expect(lines.filter((line) => line.trim())).toHaveLength(2);
			expect(lines[0]).toContain(uiGlyphs.collapsed);
			expect(lines[1]).toContain("─");
		}
	});

	it("keeps flat card output stable across repeated renders at the same width", () => {
		const cards = [
			new TurnSummaryComponent({
				startedAt: 0,
				endedAt: 1000,
				outcome: "completed",
				totalTools: 1,
				successfulTools: 1,
				failedTools: 0,
				cancelledTools: 0,
				commandCount: 1,
				successfulCommands: 1,
				files: [],
				tools: [],
				retried: false,
				compacted: false,
				cancelled: false,
			}),
			new CompactionSummaryMessageComponent({
				role: "compactionSummary",
				summary: "summary",
				tokensBefore: 120_000,
				timestamp: 1,
			}),
			new BranchSummaryMessageComponent({
				role: "branchSummary",
				summary: "summary",
				fromId: "entry-1",
				timestamp: 1,
			}),
			new SkillInvocationMessageComponent({
				name: "shuorenhua",
				location: "/tmp/SKILL.md",
				content: "instructions",
				userMessage: undefined,
			}),
		];

		for (const card of cards) {
			const first = [...card.render(80)];
			for (let index = 0; index < 20; index++) {
				expect([...card.render(80)]).toEqual(first);
			}
			expect(first.map(stripAnsi).filter((line) => line.includes("─"))).toHaveLength(1);
		}
	});

	it("uses the localized apply_patch action in the activity bar", () => {
		const activityBar = { setState: vi.fn() };
		const context = Object.assign(Object.create(InteractiveMode.prototype), {
			turnActivity: {
				startedAt: 0,
				phase: "waiting",
				action: undefined,
				tools: new Map(),
				toolOrder: [],
				queueCount: 0,
				retried: false,
				compacted: false,
				cancelled: false,
			},
			activityBar,
		});
		const prototype = InteractiveMode.prototype as unknown as {
			ensureTrackedTool(this: typeof context, id: string, name: string, args: unknown): { status: string };
			updateActivityBar(this: typeof context, phase?: string): void;
		};
		const tool = prototype.ensureTrackedTool.call(context, "patch-1", "apply_patch", { input: "patch" });
		tool.status = "running";
		prototype.updateActivityBar.call(context, "runningTool");

		expect(activityBar.setState).toHaveBeenLastCalledWith(
			expect.objectContaining({ action: "正在应用补丁", runningTools: 1 }),
		);
	});

	it("routes thinking text to the activity bar only in activity mode", () => {
		const activityBar = { setState: vi.fn() };
		const context = Object.assign(Object.create(InteractiveMode.prototype), {
			thinkingDisplayMode: "activity",
			turnActivity: {
				startedAt: 0,
				phase: "thinking",
				thinking: "最新思考内容",
				tools: new Map(),
				toolOrder: [],
				queueCount: 0,
				retried: false,
				compacted: false,
				cancelled: false,
			},
			activityBar,
		});
		const updateActivityBar = (
			InteractiveMode.prototype as unknown as {
				updateActivityBar(this: typeof context, phase?: string): void;
			}
		).updateActivityBar;

		updateActivityBar.call(context, "thinking");
		expect(activityBar.setState).toHaveBeenLastCalledWith(expect.objectContaining({ thinking: "最新思考内容" }));

		context.thinkingDisplayMode = "transcript";
		updateActivityBar.call(context, "thinking");
		expect(activityBar.setState).toHaveBeenLastCalledWith(expect.objectContaining({ thinking: undefined }));
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

	it("shows runtime activity and leaves the idle header to the current path", () => {
		const getWorkspaceStatusLabel = (
			InteractiveMode.prototype as unknown as {
				getWorkspaceStatusLabel(this: unknown): string | undefined;
			}
		).getWorkspaceStatusLabel;
		const context = Object.assign(Object.create(InteractiveMode.prototype), {
			runtimeHost: {
				session: { isCompacting: false, isBashRunning: false, isStreaming: false },
			},
			turnActivity: undefined,
		});
		expect(getWorkspaceStatusLabel.call(context)).toBeUndefined();
		context.turnActivity = { phase: "runningTool" };
		expect(getWorkspaceStatusLabel.call(context)).toBe("执行中");
		context.turnActivity = undefined;
		context.runtimeHost.session.isStreaming = true;
		expect(getWorkspaceStatusLabel.call(context)).toBe("思考中");
	});

	it("updates the hovered interactive card from pointer movement", () => {
		let hovered = false;
		const card = {
			render: () => ["card"],
			invalidate: () => {},
			isExpanded: () => false,
			setExpanded: () => {},
			setHovered: (value: boolean) => {
				hovered = value;
			},
		};
		const requestRender = vi.fn();
		const workspace = {
			isFullscreen: () => true,
			getComponentHitAtScreenRow: () => ({ component: card, row: 0 }),
		};
		const context = Object.assign(Object.create(InteractiveMode.prototype), {
			workspace,
			renderer: { hasOverlay: () => false },
			ui: { requestRender },
			hoveredCard: undefined,
		});
		const handleWorkspaceInput = (
			InteractiveMode.prototype as unknown as {
				handleWorkspaceInput(this: typeof context, data: string): { consume: true } | undefined;
			}
		).handleWorkspaceInput;

		expect(handleWorkspaceInput.call(context, "\x1b[<35;3;2M")).toBeUndefined();
		expect(hovered).toBe(true);
		expect(requestRender).toHaveBeenCalledOnce();

		workspace.getComponentHitAtScreenRow = () => undefined as never;
		handleWorkspaceInput.call(context, "\x1b[<35;3;3M");
		expect(hovered).toBe(false);
		expect(requestRender).toHaveBeenCalledTimes(2);
	});

	it("forces a full redraw after a mouse card toggle changes layout height", () => {
		let expanded = false;
		const child = {
			render: () => ["card"],
			invalidate: () => {},
			isExpanded: () => expanded,
			setExpanded: (value: boolean) => {
				expanded = value;
			},
		};
		const invalidate = vi.fn();
		const card = {
			render: () => ["card"],
			invalidate,
			isExpanded: () => false,
			setExpanded: () => {},
			getCardClickActionAtRow: () => ({ type: "toggle" as const, component: child }),
		};
		const requestRender = vi.fn();
		const rememberCardExpansion = vi.fn();
		const context = Object.assign(Object.create(InteractiveMode.prototype), {
			workspace: {
				isFullscreen: () => true,
				isNewContentIndicatorRow: () => false,
				getComponentHitAtScreenRow: () => ({ component: card, row: 0 }),
			},
			renderer: { hasOverlay: () => false },
			ui: { requestRender },
			pendingCardClick: undefined,
			hoveredCard: undefined,
			rememberCardExpansion,
			openSubagentSession: vi.fn(),
		});
		const handleWorkspaceInput = (
			InteractiveMode.prototype as unknown as {
				handleWorkspaceInput(this: typeof context, data: string): { consume: true } | undefined;
			}
		).handleWorkspaceInput;

		handleWorkspaceInput.call(context, "\x1b[<0;3;2M");
		handleWorkspaceInput.call(context, "\x1b[<0;3;2m");

		expect(expanded).toBe(true);
		expect(rememberCardExpansion).toHaveBeenCalledWith(child);
		expect(invalidate).toHaveBeenCalledOnce();
		expect(requestRender).toHaveBeenLastCalledWith(true);
	});

	it("collapses an apply_patch file from its Diff body in the main workspace", () => {
		const tool = new ToolExecutionComponent(
			"apply_patch",
			"main-apply-patch",
			{ input: "*** Begin Patch\n*** End Patch" },
			{},
			createApplyPatchToolDefinition(),
			{ requestRender: () => {} } as never,
			process.cwd(),
		);
		tool.updateResult({
			content: [{ type: "text", text: "Applied patch to 1 file(s)." }],
			details: {
				files: [
					{
						path: "src/index.ts",
						operation: "update",
						additions: 1,
						deletions: 1,
						diff: "- 1 before\n+ 1 after",
					},
				],
			},
			isError: false,
		});
		tool.setExpanded(true);
		const fileRow = tool
			.render(80)
			.map(stripAnsi)
			.findIndex((line) => line.includes("src/index.ts"));
		const fileAction = tool.getCardClickActionAtRow(fileRow);
		if (fileAction?.type !== "toggle") throw new Error("expected apply_patch file toggle");
		fileAction.component.setExpanded(true);
		const detailRow = tool
			.render(80)
			.map(stripAnsi)
			.findIndex((line) => line.includes("before"));
		const invalidate = vi.spyOn(tool, "invalidate");
		const requestRender = vi.fn();
		const rememberCardExpansion = vi.fn();
		const context = Object.assign(Object.create(InteractiveMode.prototype), {
			workspace: {
				isFullscreen: () => true,
				isNewContentIndicatorRow: () => false,
				getComponentHitAtScreenRow: () => ({ component: tool, row: detailRow }),
			},
			renderer: { hasOverlay: () => false },
			ui: { requestRender },
			pendingCardClick: undefined,
			hoveredCard: undefined,
			rememberCardExpansion,
			openSubagentSession: vi.fn(),
		});
		const handleWorkspaceInput = (
			InteractiveMode.prototype as unknown as {
				handleWorkspaceInput(this: typeof context, data: string): { consume: true } | undefined;
			}
		).handleWorkspaceInput;

		handleWorkspaceInput.call(context, "\x1b[<0;3;2M");
		handleWorkspaceInput.call(context, "\x1b[<0;3;2m");

		expect(tool.isExpanded()).toBe(true);
		expect(stripAnsi(tool.render(80).join("\n"))).not.toContain("before");
		expect(stripAnsi(tool.render(80).join("\n"))).toContain("src/index.ts");
		expect(rememberCardExpansion).toHaveBeenCalledWith(fileAction.component);
		expect(invalidate).toHaveBeenCalledOnce();
		expect(requestRender).toHaveBeenLastCalledWith(true);
	});

	it("restores stable card expansion within the same session", () => {
		const sessionManager = { getSessionId: () => "session-1" };
		const context = Object.assign(Object.create(InteractiveMode.prototype), {
			runtimeHost: { session: { sessionManager } },
			cardExpansionSessionId: undefined,
			cardExpansion: new Map<string, boolean>(),
		});
		const prototype = InteractiveMode.prototype as unknown as {
			rememberCardExpansion(this: typeof context, card: TurnSummaryComponent): void;
			restoreCardExpansion(this: typeof context, cards: TurnSummaryComponent[]): void;
		};
		const data = {
			startedAt: 123,
			endedAt: 456,
			totalTools: 0,
			successfulTools: 0,
			failedTools: 0,
			cancelledTools: 0,
			commandCount: 0,
			successfulCommands: 0,
			files: [],
			tools: [],
			retried: false,
			compacted: false,
			cancelled: false,
		};
		const original = new TurnSummaryComponent(data);
		original.setExpanded(true);
		prototype.rememberCardExpansion.call(context, original);

		const rebuilt = new TurnSummaryComponent(data);
		prototype.restoreCardExpansion.call(context, [rebuilt]);
		expect(rebuilt.isExpanded()).toBe(true);

		sessionManager.getSessionId = () => "session-2";
		const otherSession = new TurnSummaryComponent(data);
		prototype.restoreCardExpansion.call(context, [otherSession]);
		expect(otherSession.isExpanded()).toBe(false);
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
		expect(ui.requestRender).toHaveBeenCalledWith(true);
		finishTurnActivity.call(context);
		expect(chatContainer.children.filter((child) => child instanceof TurnSummaryComponent)).toHaveLength(1);
	});
});
