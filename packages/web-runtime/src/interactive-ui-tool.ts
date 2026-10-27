import { defineTool } from "@earendil-works/pi-coding-agent/core";
import {
	InteractiveUiRowSchema,
	InteractiveUiTableSchema,
	serializeInteractiveUiSnapshot,
} from "@lystar/code-web-protocol";
import {
	interactiveUiGenerationPrompt,
	validateInteractiveUiProgram,
} from "@lystar/code-web-protocol/interactive-ui-library";
import { Type } from "typebox";

export function createInteractiveUiPresentationTools() {
	return [
		defineTool({
			name: "get_ui_spec",
			label: "读取交互组件规格",
			description:
				"读取当前 Web 会话的交互组件规格、OpenUI Lang 语法和示例。用户需要搜索筛选、勾选后继续处理，或调整数值观察结果时，主动读取规格并调用 present_ui，无须用户点名工具。规格与实际 Web 组件同源。",
			parameters: Type.Object({}),
			async execute() {
				return { content: [{ type: "text", text: interactiveUiGenerationPrompt() }], details: null };
			},
		}),
		defineTool({
			name: "present_ui",
			label: "展示交互内容",
			description:
				"在当前 Web 会话直接展示可操作的回答。用户需要搜索筛选数据、勾选方案后继续处理，或调整参数观察计算结果时主动使用，无须先询问是否需要交互界面。先调用 get_ui_spec 读取实际组件规格，再生成并发布交互内容。简单问答和无需操作的静态比较使用文字或表格。",
			promptSnippet: "主动展示可搜索、勾选和改参的回答，让用户直接操作并继续对话",
			promptGuidelines: [
				"根据用户当前任务选择回答形式：需要搜索筛选、勾选后继续处理，或调整数值观察结果时，主动先调用 get_ui_spec，再调用 present_ui；用户明确要求交互展示时也使用此流程。无需用户点名工具，不先询问是否需要交互界面。",
				"简单问答、单一结论和无需操作的静态比较使用文字或表格。交互控件必须支持当前任务中的实际操作，不为装饰增加按钮或输入框。",
				"交互内容直接服务用户任务，不向用户解释工具名称、组件规格或生成步骤。发布后正文只说明关键结论或操作，不重复完整表格和全部数据。",
			],
			parameters: Type.Object({
				title: Type.String({ minLength: 1 }),
				program: Type.String({ minLength: 1, description: "完整 OpenUI Lang 程序，根组件为 Stack" }),
				source: Type.String({ minLength: 1, description: "数据来源或推演假设；事实来自已有工具或用户输入" }),
				tables: Type.Optional(Type.Array(InteractiveUiTableSchema)),
				rows: Type.Optional(Type.Array(InteractiveUiRowSchema, { description: "仅检查结果需要此字段" })),
			}),
			async execute(_id, params, signal) {
				signal?.throwIfAborted();
				validateInteractiveUiProgram(
					params.program,
					params.tables?.map((table) => table.id),
				);
				const snapshot = {
					kind: "lystar.interactive-ui" as const,
					version: 1 as const,
					revision: 1,
					title: params.title,
					program: params.program,
					rows: params.rows ?? [],
					tables: params.tables ?? [],
					source: { kind: "agent" as const, label: params.source },
					updatedAt: new Date().toISOString(),
				};
				return { content: [{ type: "text", text: serializeInteractiveUiSnapshot(snapshot) }], details: snapshot };
			},
		}),
	];
}
