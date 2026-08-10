import { join, resolve } from "node:path";
import { Text, type TUI } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { beforeAll, describe, expect, test } from "vitest";
import { getReadmePath } from "../src/config.ts";
import type { ToolDefinition } from "../src/core/extensions/types.ts";
import { type BashOperations, createBashToolDefinition } from "../src/core/tools/bash.ts";
import { createReadTool, createReadToolDefinition } from "../src/core/tools/read.ts";
import { createWriteToolDefinition } from "../src/core/tools/write.ts";
import { createApplyPatchToolDefinition } from "../src/extensions/apply-patch/index.ts";
import { SubagentResultComponent } from "../src/modes/interactive/components/subagent-run.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

function createBaseToolDefinition(name = "custom_tool"): ToolDefinition {
	return {
		name,
		label: name,
		description: "custom tool",
		parameters: Type.Any(),
		execute: async () => ({
			content: [{ type: "text", text: "ok" }],
			details: {},
		}),
	};
}

function createFakeTui(): TUI {
	return {
		requestRender: () => {},
	} as unknown as TUI;
}

describe("ToolExecutionComponent parity", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	test("stacks custom call and result renderers like the old implementation", () => {
		const toolDefinition: ToolDefinition = {
			...createBaseToolDefinition(),
			renderCall: () => new Text("custom call", 0, 0),
			renderResult: () => new Text("custom result", 0, 0),
		};

		const component = new ToolExecutionComponent(
			"custom_tool",
			"tool-1",
			{},
			{},
			toolDefinition,
			createFakeTui(),
			process.cwd(),
		);
		expect(stripAnsi(component.render(120).join("\n"))).toContain("custom call");

		component.updateResult(
			{
				content: [{ type: "text", text: "done" }],
				details: {},
				isError: false,
			},
			false,
		);

		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("custom call");
		expect(rendered).toContain("custom result");
	});

	test("maps Subagent title rows to one stable agentId", () => {
		const toolDefinition: ToolDefinition = {
			...createBaseToolDefinition("subagent"),
			renderCall: () => new Text("subagent parallel", 0, 0),
			renderResult: (result, _options, _theme, context) => {
				const details = result.details as never;
				const rendered =
					context.lastComponent instanceof SubagentResultComponent
						? context.lastComponent
						: new SubagentResultComponent(details);
				rendered.setDetails(details);
				return rendered;
			},
		};
		const component = new ToolExecutionComponent(
			"subagent",
			"subagent-call",
			{ tasks: [{ agent: "reader" }, { agent: "worker" }] },
			{},
			toolDefinition,
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({
			content: [{ type: "text", text: "done" }],
			details: {
				runId: "run-1",
				mode: "parallel",
				agentScope: "user",
				results: [
					{
						runId: "run-1",
						agent: "reader",
						agentSource: "builtin",
						agentId: "agent-1",
						task: "first task",
						state: "succeeded",
					},
					{
						runId: "run-1",
						agent: "worker",
						agentSource: "builtin",
						agentId: "agent-2",
						task: "second task",
						state: "running",
					},
				],
			},
			isError: false,
		});
		component.render(100);

		expect(component.getAgentTargetAtRow(0)).toBeUndefined();
		expect(component.getAgentTargetAtRow(1)).toMatchObject({ runId: "run-1", agentId: "agent-1" });
		expect(component.getAgentTargetAtRow(2)).toMatchObject({ runId: "run-1", agentId: "agent-2" });
	});

	test("shows apply_patch files and counts by default, then full diffs when expanded", () => {
		const component = new ToolExecutionComponent(
			"apply_patch",
			"apply-patch-call",
			{ input: "*** Begin Patch\n*** End Patch" },
			{},
			createApplyPatchToolDefinition(),
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({
			content: [{ type: "text", text: "Applied patch to 3 file(s)." }],
			details: {
				files: [
					{ path: "docs/new.md", operation: "add", additions: 1, deletions: 0, diff: "+ 1 created" },
					{
						path: "src/index.ts",
						operation: "update",
						additions: 1,
						deletions: 1,
						diff: "- 1 before\n+ 1 after",
					},
					{ path: "src/old.ts", operation: "delete", additions: 0, deletions: 1, diff: "- 1 removed" },
				],
			},
			isError: false,
		});

		const collapsed = stripAnsi(component.render(100).join("\n"));
		expect(collapsed).toContain("已应用补丁 3 个文件 +2 -2");
		expect(collapsed).toContain("docs/new.md  +1 -0");
		expect(collapsed).toContain("src/index.ts  +1 -1");
		expect(collapsed).toContain("src/old.ts  +0 -1");
		expect(collapsed).not.toContain("before");

		component.setExpanded(true);
		const expanded = stripAnsi(component.render(100).join("\n"));
		expect(expanded).toContain("before");
		expect(expanded).toContain("after");
		expect(expanded).toContain("removed");
	});

	test("renders apply_patch failures and legacy file details", () => {
		const tool = createApplyPatchToolDefinition();
		const legacy = new ToolExecutionComponent("apply_patch", "legacy", {}, {}, tool, createFakeTui(), process.cwd());
		legacy.updateResult({
			content: [{ type: "text", text: "Applied patch to 1 file(s)." }],
			details: { files: [{ path: "legacy.ts", additions: 2, deletions: 1, diff: "- 1 old\n+ 1 new" }] },
			isError: false,
		});
		expect(stripAnsi(legacy.render(80).join("\n"))).toContain("legacy.ts  +2 -1");

		const failed = new ToolExecutionComponent("apply_patch", "failed", {}, {}, tool, createFakeTui(), process.cwd());
		failed.updateResult({
			content: [{ type: "text", text: "Could not find the expected text in src/index.ts" }],
			isError: true,
		});
		const rendered = stripAnsi(failed.render(80).join("\n"));
		expect(rendered).toContain("应用补丁失败");
		expect(rendered).toContain("Could not find the expected text");
		expect(rendered).not.toContain("已应用补丁");
	});

	test("self-rendered empty tool rows take no layout space", () => {
		const toolDefinition: ToolDefinition = {
			...createBaseToolDefinition(),
			renderShell: "self",
			renderCall: () => new Text("", 0, 0),
			renderResult: () => new Text("", 0, 0),
		};

		const component = new ToolExecutionComponent(
			"custom_tool",
			"tool-empty-self-render",
			{},
			{},
			toolDefinition,
			createFakeTui(),
			process.cwd(),
		);
		expect(component.render(120)).toEqual([]);
		expect(component.getCardClickActionAtRow(0)?.type).toBe("toggle");
		expect(component.getCardClickActionAtRow(1)?.type).toBe("toggle");
		expect(component.getCardClickActionAtRow(-1)).toBeUndefined();

		component.updateResult(
			{
				content: [],
				details: {},
				isError: false,
			},
			false,
		);

		expect(component.render(120)).toEqual([]);
	});

	test("uses built-in rendering for built-in overrides without custom renderers", () => {
		const overrideDefinition: ToolDefinition = {
			...createBaseToolDefinition("edit"),
		};

		const component = new ToolExecutionComponent(
			"edit",
			"tool-2",
			{ path: "README.md", oldText: "before", newText: "after" },
			{},
			overrideDefinition,
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [], details: { diff: "+1 after", firstChangedLine: 1 }, isError: false });
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("已编辑");
		expect(rendered).toContain("README.md");
		expect(rendered).not.toContain(":1");
	});

	test("preserves legacy file_path rendering compatibility for built-in tools", () => {
		const component = new ToolExecutionComponent(
			"read",
			"tool-3",
			{ file_path: "README.md" },
			{},
			undefined,
			createFakeTui(),
			process.cwd(),
		);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("正在读取");
		expect(rendered).toContain("README.md");
	});

	test("bash execute emits an initial empty partial update before output arrives", async () => {
		const updates: Array<{ content: Array<{ type: string; text?: string }>; details?: unknown }> = [];
		const operations: BashOperations = {
			exec: async () => {
				await new Promise((resolve) => setTimeout(resolve, 10));
				return { exitCode: 0 };
			},
		};
		const tool = createBashToolDefinition(process.cwd(), { operations, exposeSessionEnvironment: false });
		const promise = tool.execute(
			"tool-bash-1",
			{ command: "sleep 10" },
			undefined,
			(update) => updates.push(update as { content: Array<{ type: string; text?: string }>; details?: unknown }),
			{} as never,
		);
		expect(updates).toEqual([{ content: [], details: undefined }]);
		await promise;
	});

	test("bash renderer does not duplicate final full output truncation details", async () => {
		const operations: BashOperations = {
			exec: async (_command, _cwd, { onData }) => {
				for (let i = 1; i <= 4000; i++) {
					onData(Buffer.from(`line-${String(i).padStart(4, "0")}\n`));
				}
				return { exitCode: 0 };
			},
		};
		const tool = createBashToolDefinition(process.cwd(), { operations, exposeSessionEnvironment: false });
		const result = await tool.execute(
			"tool-bash-1b",
			{ command: "generate output" },
			undefined,
			undefined,
			{} as never,
		);
		const component = new ToolExecutionComponent(
			"bash",
			"tool-bash-1b",
			{ command: "generate output" },
			{},
			tool,
			createFakeTui(),
			process.cwd(),
		);
		component.setExpanded(true);
		component.updateResult({ ...result, isError: false }, false);

		const rendered = stripAnsi(component.render(200).join("\n"));
		expect(rendered.match(/Full output:/g)?.length ?? 0).toBe(1);
		expect(rendered).toMatch(/line-4000[^\n]*\n[^\S\n]*\n \[Full output:/);
		expect(rendered).not.toMatch(/line-4000[^\n]*\n[^\S\n]*\n[^\S\n]*\n \[Full output:/);
		expect(rendered).toContain("Truncated: showing 2000 of 4000 lines");
		expect(rendered).not.toContain("[Showing lines 2001-4000 of 4000. Full output:");
	});

	test("skips collapsed built-in partial-result redraws", () => {
		const component = new ToolExecutionComponent(
			"bash",
			"tool-bash-streaming-collapsed",
			{ command: "generate output" },
			{},
			createBashToolDefinition(process.cwd(), { exposeSessionEnvironment: false }),
			createFakeTui(),
			process.cwd(),
		);

		expect(
			component.updateResult({ content: [{ type: "text", text: "streamed chunk" }], isError: false }, true),
		).toBe(false);
		expect(stripAnsi(component.render(80).join("\n"))).not.toContain("streamed chunk");
	});

	test("collapses successful bash output to one event row", () => {
		const component = new ToolExecutionComponent(
			"bash",
			"tool-bash-compact",
			{ command: "generate output" },
			{},
			createBashToolDefinition(process.cwd(), { exposeSessionEnvironment: false }),
			createFakeTui(),
			process.cwd(),
		);
		component.markExecutionStarted();
		component.updateResult(
			{
				content: [
					{ type: "text", text: Array.from({ length: 100 }, (_, index) => `line-${index + 1}`).join("\n") },
				],
				isError: false,
			},
			false,
		);

		const collapsedLines = component.render(80);
		const collapsed = stripAnsi(collapsedLines.join("\n"));
		expect(collapsedLines).toHaveLength(1);
		expect(collapsed).toContain("$ 已运行");
		expect(collapsed).not.toContain("▣");
		expect(collapsed).not.toContain("line-100");
		expect(component.getCardClickActionAtRow(0)?.type).toBe("toggle");
		expect(component.getCardClickActionAtRow(99)?.type).toBe("toggle");
		expect(component.render(80).join("\n")).toContain(theme.getBgAnsi("toolSuccessBg"));

		component.setExpanded(true);
		expect(stripAnsi(component.render(80).join("\n"))).toContain("line-100");
	});

	test("does not duplicate built-in headers when passed the active built-in definition", () => {
		const component = new ToolExecutionComponent(
			"read",
			"tool-4",
			{ path: "README.md" },
			{},
			createReadToolDefinition(process.cwd()),
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: "hello" }], details: undefined, isError: false }, false);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered.match(/已读取/g)?.length ?? 0).toBe(1);
	});

	test("inherits missing built-in result renderer slot from the built-in tool", () => {
		const overrideDefinition: ToolDefinition = {
			...createBaseToolDefinition("read"),
			renderCall: () => new Text("override call", 0, 0),
		};

		const component = new ToolExecutionComponent(
			"read",
			"tool-4b",
			{ path: "notes.txt" },
			{},
			overrideDefinition,
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: "hello" }], details: undefined, isError: false }, false);
		component.setExpanded(true);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("override call");
		expect(rendered).toContain("hello");
	});

	test("inherits missing built-in call renderer slot from the built-in tool", () => {
		const overrideDefinition: ToolDefinition = {
			...createBaseToolDefinition("read"),
			renderResult: () => new Text("override result", 0, 0),
		};

		const component = new ToolExecutionComponent(
			"read",
			"tool-4c",
			{ path: "README.md" },
			{},
			overrideDefinition,
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: "hello" }], details: undefined, isError: false }, false);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("已读取");
		expect(rendered).toContain("README.md");
		expect(rendered).toContain("override result");
	});

	test("uses custom renderers for built-in overrides that reuse built-in definition parameters", () => {
		const builtInDefinition = createReadToolDefinition(process.cwd());
		const component = new ToolExecutionComponent(
			"read",
			"tool-4d",
			{ path: "README.md" },
			{},
			{
				...builtInDefinition,
				renderCall: () => new Text("override call", 0, 0),
				renderResult: () => new Text("override result", 0, 0),
			},
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: "hello" }], details: undefined, isError: false }, false);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("override call");
		expect(rendered).toContain("override result");
		expect(rendered).not.toContain("read README.md");
	});

	test("uses custom renderers for built-in overrides that reuse wrapped built-in tool parameters", () => {
		const builtInTool = createReadTool(process.cwd());
		const component = new ToolExecutionComponent(
			"read",
			"tool-4e",
			{ path: "README.md" },
			{},
			{
				...createBaseToolDefinition("read"),
				parameters: builtInTool.parameters,
				renderCall: () => new Text("wrapped override call", 0, 0),
				renderResult: () => new Text("wrapped override result", 0, 0),
			},
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: "hello" }], details: undefined, isError: false }, false);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("wrapped override call");
		expect(rendered).toContain("wrapped override result");
	});

	test("shares renderer state across custom call and result slots", () => {
		type RenderState = { token?: string };
		const toolDefinition: ToolDefinition<any, unknown, RenderState> = {
			...createBaseToolDefinition(),
			renderCall: (_args, _theme, context) => {
				context.state.token ??= "shared-token";
				return new Text(`custom call ${context.state.token}`, 0, 0);
			},
			renderResult: (_result, _options, _theme, context) => {
				return new Text(`custom result ${context.state.token}`, 0, 0);
			},
		};

		const component = new ToolExecutionComponent(
			"custom_tool",
			"tool-5",
			{},
			{},
			toolDefinition,
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: "done" }], details: {}, isError: false }, false);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("custom call shared-token");
		expect(rendered).toContain("custom result shared-token");
	});

	test("exposes args in render result context", () => {
		const toolDefinition: ToolDefinition = {
			...createBaseToolDefinition(),
			renderCall: () => new Text("call", 0, 0),
			renderResult: (_result, _options, _theme, context) =>
				new Text(`arg:${String((context.args as { foo: string }).foo)}`, 0, 0),
		};

		const component = new ToolExecutionComponent(
			"custom_tool",
			"tool-5b",
			{ foo: "bar" },
			{},
			toolDefinition,
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: "done" }], details: {}, isError: false }, false);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("arg:bar");
	});

	test("falls back when custom renderers are absent", () => {
		const toolDefinition: ToolDefinition = {
			...createBaseToolDefinition(),
		};

		const component = new ToolExecutionComponent(
			"custom_tool",
			"tool-6",
			{ foo: "bar" },
			{},
			toolDefinition,
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: "done" }], details: {}, isError: false }, false);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("custom_tool");
		expect(rendered).not.toContain("done");

		component.setExpanded(true);
		expect(stripAnsi(component.render(120).join("\n"))).toContain("done");
	});

	test("collapses write contents until expanded", () => {
		const component = new ToolExecutionComponent(
			"write",
			"tool-7",
			{ path: "README.md", content: "one\ntwo\n" },
			{},
			createWriteToolDefinition(process.cwd()),
			createFakeTui(),
			process.cwd(),
		);
		const collapsed = stripAnsi(component.render(120).join("\n"));
		expect(collapsed).toContain("正在写入");
		expect(collapsed).toContain("+2");
		expect(collapsed).not.toContain("one");
		expect(collapsed).not.toContain("two");

		component.setExpanded(true);
		const expanded = stripAnsi(component.render(120).join("\n"));
		expect(expanded).toContain("one");
		expect(expanded).toContain("two");
		expect(expanded).not.toContain("two\n\n");
	});

	test("shows created-file details in the collapsed write summary", () => {
		const component = new ToolExecutionComponent(
			"write",
			"tool-write-created",
			{ path: "new-file.ts", content: "one\ntwo\n" },
			{},
			createWriteToolDefinition(process.cwd()),
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({
			content: [{ type: "text", text: "done" }],
			details: { operation: "created", additions: 2, deletions: 0 },
			isError: false,
		});

		const rendered = stripAnsi(component.render(80).join("\n"));
		expect(rendered).toContain("已创建");
		expect(rendered).toContain("new-file.ts");
		expect(rendered).toContain("+2");
		expect(rendered).not.toContain("done");
	});

	test("trims trailing blank display lines from read results", () => {
		const component = new ToolExecutionComponent(
			"read",
			"tool-8",
			{ path: "notes.txt" },
			{},
			createReadToolDefinition(process.cwd()),
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult(
			{ content: [{ type: "text", text: "one\ntwo\n" }], details: undefined, isError: false },
			false,
		);
		component.setExpanded(true);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("one");
		expect(rendered).toContain("two");
		expect(rendered).not.toContain("two\n\n");
	});

	test("does not syntax-highlight read errors based on the requested file path", () => {
		const component = new ToolExecutionComponent(
			"read",
			"tool-read-error-highlighting",
			{ path: "config.exs", offset: 120, limit: 130 },
			{},
			createReadToolDefinition(process.cwd()),
			createFakeTui(),
			process.cwd(),
		);
		const error = "Offset 120 is beyond end of file (96 lines total)";
		component.updateResult({ content: [{ type: "text", text: error }], details: undefined, isError: true }, false);

		const rendered = component.render(120).join("\n");
		expect(stripAnsi(rendered)).toContain(error);
		expect(rendered).toContain(theme.fg("toolOutput", error));
	});

	test("collapses ordinary read results until expanded", () => {
		const component = new ToolExecutionComponent(
			"read",
			"tool-ordinary-read-collapsed",
			{ path: "notes.txt" },
			{},
			createReadToolDefinition(process.cwd()),
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult(
			{ content: [{ type: "text", text: "hidden content" }], details: undefined, isError: false },
			false,
		);

		const collapsed = stripAnsi(component.render(120).join("\n"));
		expect(collapsed).toContain("已读取");
		expect(collapsed).toContain("notes.txt");
		expect(collapsed).not.toContain("hidden content");

		component.setExpanded(true);
		const expanded = stripAnsi(component.render(120).join("\n"));
		expect(expanded).toContain("hidden content");
	});

	for (const scenario of [
		{
			title: "SKILL.md",
			path: join(process.cwd(), "attio", "SKILL.md"),
			content: "---\nname: attio\ndescription: CRM helper\n---\n\n# Hidden skill instructions",
			compact: "[skill] attio",
			hidden: "Hidden skill instructions",
			absent: "read skill attio",
		},
		{
			title: "AGENTS.md",
			path: join(process.cwd(), ".pi", "AGENTS.md"),
			content: "Hidden resource instructions",
			compact: ".pi/AGENTS.md",
			hidden: "Hidden resource instructions",
			absent: undefined,
		},
		{
			title: "AGENTS.override.md",
			path: join(process.cwd(), ".pi", "AGENTS.override.md"),
			content: "Hidden override instructions",
			compact: ".pi/AGENTS.override.md",
			hidden: "Hidden override instructions",
			absent: undefined,
		},
		{
			title: "outside AGENTS.md",
			path: resolve(process.cwd(), "..", "AGENTS.md"),
			content: "Hidden outside resource instructions",
			compact: resolve(process.cwd(), "..", "AGENTS.md").replace(/\\/g, "/"),
			hidden: "Hidden outside resource instructions",
			absent: undefined,
		},
		{
			title: "Pi documentation",
			path: getReadmePath(),
			content: "Hidden docs content",
			compact: "README.md",
			hidden: "Hidden docs content",
			absent: undefined,
		},
	] as const) {
		test(`renders ${scenario.title} read results compactly until expanded`, () => {
			const component = new ToolExecutionComponent(
				"read",
				`tool-compact-${scenario.title}`,
				{ path: scenario.path },
				{},
				createReadToolDefinition(process.cwd()),
				createFakeTui(),
				process.cwd(),
			);
			component.updateResult(
				{ content: [{ type: "text", text: scenario.content }], details: undefined, isError: false },
				false,
			);

			const collapsed = stripAnsi(component.render(120).join("\n"));
			expect(collapsed).toContain(scenario.compact);
			expect(collapsed).not.toContain(scenario.hidden);
			if (scenario.absent) {
				expect(collapsed).not.toContain(scenario.absent);
			}

			component.setExpanded(true);
			const expanded = stripAnsi(component.render(120).join("\n"));
			expect(expanded).toContain(scenario.hidden);
		});
	}

	for (const scenario of [
		{ title: "SKILL.md", path: join(process.cwd(), "attio", "SKILL.md"), compact: "[skill] attio:120-329" },
		{ title: "Pi documentation", path: getReadmePath(), compact: "README.md:120-329" },
	] as const) {
		test(`shows the read line range in compact ${scenario.title} reads before the expand hint`, () => {
			const component = new ToolExecutionComponent(
				"read",
				`tool-compact-range-${scenario.title}`,
				{ path: scenario.path, offset: 120, limit: 210 },
				{},
				createReadToolDefinition(process.cwd()),
				createFakeTui(),
				process.cwd(),
			);

			const collapsed = stripAnsi(component.render(120).join("\n"));
			expect(collapsed).toContain(scenario.compact);
		});
	}
});
