import { z } from "zod/v4";
import type { InteractiveUiSnapshot } from "@lystar/code-web-protocol";

export const interactiveUiViewSchema = z.object({
	filter: z.enum(["all", "failed", "passed"]),
	selected: z.array(z.string()),
	renderer: z.record(z.string(), z.unknown()),
	searches: z.record(z.string(), z.string()).default({}),
	tableSelections: z.record(z.string(), z.array(z.string())).default({}),
});
export type InteractiveUiViewState = z.infer<typeof interactiveUiViewSchema>;
export function emptyInteractiveUiView(): InteractiveUiViewState {
	return { filter: "all", selected: [], renderer: {}, searches: {}, tableSelections: {} };
}
export function interactiveUiStorageKey(sessionId: string, toolId: string): string {
	return "lystar:interactive-ui:v1:" + encodeURIComponent(sessionId) + ":" + encodeURIComponent(toolId);
}
export function restoreInteractiveUiView(key: string, program: string): InteractiveUiViewState {
	const raw = localStorage.getItem(key);
	if (!raw) return emptyInteractiveUiView();
	const stored = z.object({ program: z.string(), view: interactiveUiViewSchema }).parse(JSON.parse(raw));
	return stored.program === program ? stored.view : emptyInteractiveUiView();
}
export function clearInteractiveUiSession(sessionId: string): void {
	const prefix = "lystar:interactive-ui:v1:" + encodeURIComponent(sessionId) + ":";
	const keys = Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index));
	for (const key of keys) if (key?.startsWith(prefix)) localStorage.removeItem(key);
}
export function interactiveUiDiscussion(
	snapshot: InteractiveUiSnapshot,
	toolId: string,
	view: InteractiveUiViewState,
): string {
	return (
		"请继续分析「" +
		snapshot.title +
		"」中的当前参数与选择。\n" +
		JSON.stringify(
			{
				toolCallId: toolId,
				source: snapshot.source,
				revision: snapshot.revision,
				updatedAt: snapshot.updatedAt,
				program: snapshot.program,
				parameters: view.renderer,
				filter: view.filter,
				selected: snapshot.rows.filter((row) => view.selected.includes(row.id)),
				tables: (snapshot.tables ?? []).map((table) => ({
					id: table.id,
					label: table.label,
					columns: table.columns,
					search: view.searches[table.id] ?? "",
					selected: table.rows.filter((row) => view.tableSelections[table.id]?.includes(row.id)),
				})),
			},
			null,
			2,
		)
	);
}
