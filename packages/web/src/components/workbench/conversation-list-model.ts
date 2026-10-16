import type { ToolActivityKind, ToolBatchTool } from "../ai-elements/tool-batch";
import type { AgentStepRenderItem, ConversationRenderItem, TranscriptToolStackRenderItem } from "./conversation-render-model";

export const DEFAULT_TRANSCRIPT_GAP = 12;
export type ConversationToolActivity = TranscriptToolStackRenderItem & { activityKind: ToolActivityKind };
export type ConversationGroupEntry = AgentStepRenderItem | Extract<ConversationRenderItem, { kind: "work-process" }> | ConversationToolActivity;
export type ConversationListContent = ConversationRenderItem | { kind: "tool-activity-row"; key: string; tool: ToolBatchTool };
export type ConversationListRow = {
	key: string;
	kind: "content" | "header" | "space";
	entry?: ConversationListContent;
	height: number;
	stepChild: boolean;
};
export type ConversationListNode = {
	key: string;
	start: number;
	end: number;
	entry?: ConversationGroupEntry;
	open?: boolean;
	children?: ConversationListNode[];
};
export type ConversationListModel = { rows: ConversationListRow[]; nodes: ConversationListNode[] };

type ProjectionOptions = {
	expandedAgentSteps: ReadonlyMap<string, boolean>;
	expandedWorkProcesses: ReadonlyMap<string, boolean>;
	expandedThinking: ReadonlyMap<string, boolean>;
	expandedToolBatches: ReadonlyMap<string, boolean>;
	retainedGroups: ReadonlySet<string>;
	toolActivityPresentation: (entry: TranscriptToolStackRenderItem) => { kind?: ToolActivityKind; repeatedFileReads: boolean };
	toolPresentation: (key: string, tools: readonly ToolBatchTool[]) => "rows" | "group";
	gap: (previous: ConversationRenderItem, current: ConversationRenderItem) => number;
};

/** 分组关系保留在树中；展开内容以稳定身份成为独立测量行。 */
export function buildConversationListModel(items: readonly ConversationRenderItem[], options: ProjectionOptions): ConversationListModel {
	const rows: ConversationListRow[] = [];
	const space = (key: string, height: number): ConversationListNode[] => {
		if (height <= 0) return [];
		const index = rows.length;
		rows.push({ key, kind: "space", height, stepChild: false });
		return [{ key, start: index, end: index }];
	};
	const content = (entry: ConversationListContent, stepChild: boolean): ConversationListNode => {
		const index = rows.length;
		const height = entry.kind === "message" ? 80 : entry.kind === "result-boundary" ? 1 : 32;
		rows.push({ key: entry.key, kind: "content", entry, height: height + (stepChild && entry.kind === "message" ? 16 : 0), stepChild });
		return { key: entry.key, start: index, end: index };
	};
	const project = (entries: readonly ConversationRenderItem[], context: "root" | "step" | "process"): ConversationListNode[] => {
		const nodes: ConversationListNode[] = [];
		for (let index = 0; index < entries.length; index++) {
			const entry = entries[index]!;
			if (index > 0 && context !== "step") nodes.push(...space(
				"gap:" + entries[index - 1]!.key + ":" + entry.key,
				options.gap(entries[index - 1]!, entry),
			));
			const start = rows.length;
			if (entry.kind === "agent-step" || entry.kind === "work-process") {
				const open = entry.kind === "agent-step"
					? options.expandedAgentSteps.get(entry.key) ?? (entry.step.status === "running" || entry.items.some((item) => item.kind === "thinking" && options.expandedThinking.get(item.key)))
					: options.expandedWorkProcesses.get(entry.key) ?? entry.items.some((item) => item.kind === "thinking" ? options.expandedThinking.get(item.key) : item.kind === "agent-step" && item.items.some((child) => child.kind === "thinking" && options.expandedThinking.get(child.key)));
				rows.push({ key: entry.key, kind: "header", entry, height: 28, stepChild: false });
				const children = open || options.retainedGroups.has(entry.key) ? [
					...space(entry.key + ":padding", entry.kind === "agent-step" ? 4 : 8),
					...project(entry.items, entry.kind === "agent-step" ? "step" : "process"),
				] : [];
				nodes.push({ key: entry.key, start, end: rows.length - 1, entry, open, children });
			} else if (entry.kind === "tool-stack") {
				const tools = entry.batches.flatMap((batch) => batch.tools);
				const presentation = options.toolPresentation(entry.key, tools);
				const activity = options.toolActivityPresentation(entry);
				const activityKind = presentation === "group" ? activity.kind : undefined;
				if (activityKind) {
					const group = { ...entry, activityKind };
					const open = options.expandedToolBatches.get(entry.key) ?? tools.some((tool) => tool.state === "input-available" || tool.state === "input-queued");
					rows.push({ key: entry.key, kind: "header", entry, height: 28, stepChild: false });
					const children = open || options.retainedGroups.has(entry.key) ? [
						...space(entry.key + ":padding", 6),
						...tools.map((tool) => content({ kind: "tool-activity-row", key: "tool:" + tool.id, tool }, false)),
					] : [];
					nodes.push({ key: entry.key, start, end: rows.length - 1, entry: group, open, children });
				} else if (presentation === "rows" || activity.repeatedFileReads) {
					for (const tool of tools) nodes.push(content({
						...entry, key: "tool:" + tool.id,
						batches: [{ kind: "tool-batch", key: "tool:" + tool.id, tools: [tool], stepId: entry.stepId }],
					}, context === "step"));
				} else nodes.push(content(entry, context === "step"));
			} else nodes.push(content(entry, context === "step"));
		}
		return nodes;
	};
	return { rows, nodes: project(items, "root") };
}
