import { type Static, Type } from "typebox";
import { Compile } from "typebox/compile";

// 沿用工具输出传输；快照上限低于现有历史预览的 16,384 字符限制。
export const INTERACTIVE_UI_MAX_CHARS = 12 * 1024;
export const INTERACTIVE_UI_TOOL_NAMES = new Set(["present_ui", "inspect_project_ui"]);

export const InteractiveUiRowSchema = Type.Object(
	{
		id: Type.String({ minLength: 1 }),
		label: Type.String({ minLength: 1 }),
		state: Type.Union([
			Type.Literal("pending"),
			Type.Literal("running"),
			Type.Literal("passed"),
			Type.Literal("failed"),
		]),
		detail: Type.String(),
	},
	{ additionalProperties: false },
);
export type InteractiveUiRow = Static<typeof InteractiveUiRowSchema>;

export const InteractiveUiTableSchema = Type.Object(
	{
		id: Type.String({ minLength: 1 }),
		label: Type.String({ minLength: 1 }),
		columns: Type.Array(
			Type.Object(
				{ key: Type.String({ minLength: 1 }), label: Type.String({ minLength: 1 }) },
				{ additionalProperties: false },
			),
			{ minItems: 1 },
		),
		rows: Type.Array(
			Type.Object(
				{
					id: Type.String({ minLength: 1 }),
					cells: Type.Record(
						Type.String(),
						Type.Union([Type.String(), Type.Number(), Type.Boolean(), Type.Null()]),
					),
				},
				{ additionalProperties: false },
			),
		),
	},
	{ additionalProperties: false },
);
export type InteractiveUiTable = Static<typeof InteractiveUiTableSchema>;

export const InteractiveUiSnapshotSchema = Type.Object(
	{
		kind: Type.Literal("lystar.interactive-ui"),
		version: Type.Literal(1),
		title: Type.String({ minLength: 1 }),
		program: Type.String({ minLength: 1 }),
		revision: Type.Integer({ minimum: 1 }),
		updatedAt: Type.String({ minLength: 1 }),
		source: Type.Object(
			{
				kind: Type.Union([Type.Literal("tool"), Type.Literal("agent")]),
				label: Type.String({ minLength: 1 }),
			},
			{ additionalProperties: false },
		),
		rows: Type.Array(InteractiveUiRowSchema),
		tables: Type.Optional(Type.Array(InteractiveUiTableSchema)),
	},
	{ additionalProperties: false },
);
export type InteractiveUiSnapshot = Static<typeof InteractiveUiSnapshotSchema>;
const validator = Compile(InteractiveUiSnapshotSchema);

export function parseInteractiveUiSnapshot(text: string | undefined): InteractiveUiSnapshot | undefined {
	if (!text || text.length > INTERACTIVE_UI_MAX_CHARS) return undefined;
	try {
		const value: unknown = JSON.parse(text);
		if (!validator.Check(value)) return undefined;
		if (new Set(value.rows.map((row) => row.id)).size !== value.rows.length) return undefined;
		const tables = value.tables ?? [];
		if (new Set(tables.map((table) => table.id)).size !== tables.length) return undefined;
		for (const table of tables) {
			if (new Set(table.rows.map((row) => row.id)).size !== table.rows.length) return undefined;
			if (new Set(table.columns.map((column) => column.key)).size !== table.columns.length) return undefined;
			if (table.rows.some((row) => table.columns.some((column) => !(column.key in row.cells)))) return undefined;
		}
		if (!Number.isFinite(Date.parse(value.updatedAt))) return undefined;
		return value;
	} catch {
		return undefined;
	}
}

export function serializeInteractiveUiSnapshot(snapshot: InteractiveUiSnapshot): string {
	const text = JSON.stringify(snapshot);
	if (!parseInteractiveUiSnapshot(text)) {
		throw new Error("交互快照无效或超过 12,288 字符；请检查数据、时间、唯一标识，或减少本次展示内容");
	}
	return text;
}
