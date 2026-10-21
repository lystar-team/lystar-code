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
				"生成交互回答前读取当前组件规格、OpenUI Lang 语法和示例；规格与实际 Web 组件同源。普通文字回答不需要调用。",
			parameters: Type.Object({}),
			async execute() {
				return { content: [{ type: "text", text: interactiveUiGenerationPrompt() }], details: null };
			},
		}),
		defineTool({
			name: "present_ui",
			label: "展示交互内容",
			description:
				"在当前 Web 会话发布交互回答。适用于方案比较、结果筛选和参数推演。先调用 get_ui_spec 读取实际组件规格。复用当前会话模型，不调用额外模型。",
			promptSnippet: "在当前会话展示可筛选、选择和改参的交互回答",
			promptGuidelines: [
				"需要比较、筛选、选择或改参观察结果时，先读取 get_ui_spec，再用 present_ui 发布；普通文字更直接时不要使用交互界面。",
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
