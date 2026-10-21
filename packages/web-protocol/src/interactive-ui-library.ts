import { createLibrary, createParser, defineComponent, markReactive, type StateField } from "@openuidev/lang-core";
import { z } from "zod/v4";

const number = z.number();
markReactive(number);

// Schema、参数顺序和说明同时供模型、服务端校验及 Web 组件使用。
export const interactiveUiDefinitions = {
	Stack: {
		name: "Stack",
		props: z.object({ children: z.array(z.unknown()) }),
		description: "按阅读顺序排列内容，作为根组件。",
	},
	Text: { name: "Text", props: z.object({ text: z.string() }), description: "显示说明、计算假设和单位。" },
	StatusSummary: {
		name: "StatusSummary",
		props: z.object({}),
		description: "汇总快照 rows 中的检查状态，仅用于检查结果。",
	},
	ResultsTable: {
		name: "ResultsTable",
		props: z.object({}),
		description: "显示快照 rows 中的检查结果，支持状态筛选与勾选。",
	},
	DataTable: {
		name: "DataTable",
		props: z.object({ tableId: z.string() }),
		description: "显示快照 tables 中指定 id 的数据表，支持搜索和勾选；适合方案比较及数据分析。",
	},
	Continue: {
		name: "Continue",
		props: z.object({ label: z.string() }),
		description: "把当前参数、筛选和选中数据带回原会话继续讨论。",
	},
	NumberInput: {
		name: "NumberInput",
		props: z.object({ value: number as unknown as z.ZodType<StateField<number>>, label: z.string() }),
		description: "修改 $变量的数值；变量须有初始值。",
	},
	Value: {
		name: "Value",
		props: z.object({ label: z.string(), value: z.union([z.number(), z.string()]) }),
		description: "显示表达式计算的结果，label 中写明单位。",
	},
};

export const interactiveUiSchemaLibrary = createLibrary({
	root: "Stack",
	components: Object.values(interactiveUiDefinitions).map((definition) =>
		defineComponent<z.ZodObject, null>({ ...definition, component: null }),
	),
});

export function interactiveUiGenerationPrompt(): string {
	return interactiveUiSchemaLibrary.prompt({
		toolCalls: false,
		bindings: true,
		builtinFunctions: true,
		preamble:
			"为 LYStar 当前会话生成交互回答。只生成 OpenUI Lang，由 present_ui 发布；不要生成 HTML、React 或 Markdown 代码围栏。",
		additionalRules: [
			"普通问答使用文字。需要比较、筛选、选择或修改参数观察结果时使用交互内容。",
			"先用已有工具取得事实，再组织界面；明确区分实测、用户数据和示例假设。不要把模型推断写成实测。",
			"DataTable 的 tableId 必须对应 present_ui.tables 中的 id。检查专属组件只配合 rows 使用。",
			"数值计算在浏览器执行，说明公式、单位和假设；不要在交互程序中调用外部工具。",
			"放置 Continue 按钮，让用户能把当前参数和选择带回会话。发布后用简短正文说明关键结论。",
		],
		examples: [
			'root = Stack([NumberInput($n, "并发数"), Value("每分钟理论处理量（项）", $n * 60), Text("假设每项耗时 1 秒，不计排队和限流。"), Continue("讨论当前参数")])\n$n = 2',
		],
	});
}

export function validateInteractiveUiProgram(program: string, tableIds: readonly string[] = []): void {
	const parsed = createParser(interactiveUiSchemaLibrary.toJSONSchema(), "Stack").parse(program);
	const problems = parsed.meta.errors.map((error) => error.message);
	if (!parsed.root || parsed.root.typeName !== "Stack") problems.push("根节点必须是 Stack");
	if (parsed.meta.incomplete) problems.push("程序不完整");
	if (parsed.meta.unresolved.length) problems.push(`引用未定义：${parsed.meta.unresolved.join("、")}`);
	const inspect = (value: unknown): void => {
		if (Array.isArray(value)) {
			for (const child of value) inspect(child);
			return;
		}
		if (!value || typeof value !== "object") return;
		const node = value as Record<string, unknown>;
		if (node.k === "StateRef" && typeof node.n === "string" && parsed.stateDeclarations[node.n] == null)
			problems.push(`请为状态变量 ${node.n} 设置初始值`);
		if (node.type === "element" && node.typeName === "DataTable") {
			const props = node.props as Record<string, unknown>;
			if (typeof props.tableId !== "string" || !tableIds.includes(props.tableId))
				problems.push(`DataTable 引用了不存在的数据表：${String(props.tableId)}`);
		}
		if (node.type === "element" && node.typeName === "NumberInput") {
			const props = node.props as Record<string, unknown>;
			const ref = props.value as { k?: string; n?: string } | null;
			if (
				!ref ||
				ref.k !== "StateRef" ||
				!ref.n ||
				typeof parsed.stateDeclarations[ref.n] !== "number" ||
				!Number.isFinite(parsed.stateDeclarations[ref.n])
			)
				problems.push("NumberInput 必须绑定有数值初始值的 $变量");
		}
		for (const child of Object.values(node)) inspect(child);
	};
	inspect(parsed.root);
	if (parsed.queryStatements.length || parsed.mutationStatements.length)
		problems.push("当前宿主不支持 Query 或 Mutation，请通过原会话工具取得数据");
	if (problems.length) throw new Error(`交互程序校验失败，请按 get_ui_spec 返回的规格修正：\n${problems.join("\n")}`);
}
