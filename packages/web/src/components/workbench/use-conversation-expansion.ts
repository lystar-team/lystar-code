import { useCallback, useRef, useState } from "react";
import type { ToolBatchTool } from "../ai-elements/tool-batch";

type ToolStackPresentation = "rows" | "group";
type ExpansionState = {
	expandedWorkProcesses: Map<string, boolean>;
	expandedAgentSteps: Map<string, boolean>;
	expandedThinking: Map<string, boolean>;
	expandedToolBatches: Map<string, boolean>;
	expandedToolRows: Map<string, boolean>;
	presentations: Map<string, ToolStackPresentation>;
};

export function initialToolStackPresentation(tools: readonly ToolBatchTool[]): ToolStackPresentation {
	const groupableActivity = tools.length > 1 &&
		(tools.every((tool) => tool.name === "read" && !tool.images?.length) ||
			tools.every((tool) => tool.name === "read" && Boolean(tool.images?.length)) ||
			tools.every((tool) => tool.name === "bash" && !tool.images?.length) ||
			tools.every((tool) => tool.name === "edit" || tool.name === "write" || tool.name === "apply_patch"));
	const completed = tools.every((tool) => ["output-available", "output-error", "output-cancelled", "output-interrupted"].includes(tool.state));
	return groupableActivity && completed ? "group" : "rows";
}

/** 展开选择按会话保存，与滚动锚点一起恢复原来的可见行结构。 */
export function useConversationExpansion(sessionKey: string) {
	const cache = useRef(new Map<string, ExpansionState>()).current;
	let state = cache.get(sessionKey);
	if (!state) {
		state = {
			expandedWorkProcesses: new Map(), expandedAgentSteps: new Map(), expandedThinking: new Map(),
			expandedToolBatches: new Map(), expandedToolRows: new Map(), presentations: new Map(),
		};
		cache.set(sessionKey, state);
	}
	cache.delete(sessionKey);
	cache.set(sessionKey, state);
	while (cache.size > 8) {
		const oldest = cache.keys().next().value;
		if (oldest === undefined) break;
		cache.delete(oldest);
	}
	const active = useRef(state);
	active.current = state;
	const [, refresh] = useState(0);
	const update = useCallback((field: Exclude<keyof ExpansionState, "presentations">, key: string, open: boolean) => {
		if (active.current[field].get(key) === open) return;
		const next = new Map(active.current[field]);
		next.set(key, open);
		active.current[field] = next;
		refresh((value) => value + 1);
	}, []);
	const updateExpandedWorkProcess = useCallback((key: string, open: boolean) => update("expandedWorkProcesses", key, open), [update]);
	const updateExpandedAgentStep = useCallback((key: string, open: boolean) => update("expandedAgentSteps", key, open), [update]);
	const updateExpandedThinking = useCallback((key: string, open: boolean) => update("expandedThinking", key, open), [update]);
	const updateExpandedToolBatch = useCallback((key: string, open: boolean) => update("expandedToolBatches", key, open), [update]);
	const updateExpandedToolRow = useCallback((key: string, open: boolean) => update("expandedToolRows", key, open), [update]);
	const getToolStackPresentation = useCallback((key: string, tools: readonly ToolBatchTool[]) => {
		let presentation = active.current.presentations.get(key);
		if (!presentation) {
			presentation = initialToolStackPresentation(tools);
			active.current.presentations.set(key, presentation);
		}
		return presentation;
	}, []);
	return {
		...state, getToolStackPresentation,
		updateExpandedWorkProcess, updateExpandedAgentStep, updateExpandedThinking,
		updateExpandedToolBatch, updateExpandedToolRow,
	};
}
