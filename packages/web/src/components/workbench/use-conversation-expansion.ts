import { useCallback, useRef, useState } from "react";
import type { ToolBatchTool } from "../ai-elements/tool-batch";

type ToolStackPresentation = "rows" | "group";

function isToolComplete(tool: ToolBatchTool): boolean {
	return (
		tool.state === "output-available" ||
		tool.state === "output-error" ||
		tool.state === "output-cancelled" ||
		tool.state === "output-interrupted"
	);
}

export function initialToolStackPresentation(tools: readonly ToolBatchTool[]): ToolStackPresentation {
	const groupableActivity =
		tools.length > 1 &&
		(tools.every((tool) => tool.name === "read" && !tool.images?.length) ||
			tools.every((tool) => tool.name === "bash" && !tool.images?.length) ||
			tools.every((tool) => tool.name === "edit" || tool.name === "write" || tool.name === "apply_patch"));
	return groupableActivity && tools.every(isToolComplete) ? "group" : "rows";
}

export function useConversationExpansion() {
	const [expandedWorkProcesses, setExpandedWorkProcesses] = useState<ReadonlyMap<string, boolean>>(() => new Map());
	const [expandedAgentSteps, setExpandedAgentSteps] = useState<ReadonlyMap<string, boolean>>(() => new Map());
	const expandedToolBatches = useRef(new Map<string, boolean>()).current;
	const expandedToolRows = useRef(new Map<string, boolean>()).current;
	const toolStackPresentationsRef = useRef(new Map<string, ToolStackPresentation>());
	const resetExpandedState = useCallback(() => {
		setExpandedWorkProcesses(new Map());
		setExpandedAgentSteps(new Map());
		expandedToolBatches.clear();
		expandedToolRows.clear();
		toolStackPresentationsRef.current.clear();
	}, [expandedToolBatches, expandedToolRows]);
	const updateExpandedWorkProcess = useCallback((key: string, open: boolean) => {
		setExpandedWorkProcesses((current) => {
			if ((current.get(key) ?? false) === open) return current;
			const next = new Map(current);
			if (open) next.set(key, true);
			else next.delete(key);
			return next;
		});
	}, []);
	const updateExpandedAgentStep = useCallback((key: string, open: boolean) => {
		setExpandedAgentSteps((current) => {
			if (current.get(key) === open) return current;
			const next = new Map(current);
			next.set(key, open);
			return next;
		});
	}, []);
	const updateExpandedToolBatch = useCallback((key: string, open: boolean) => {
		if (open) expandedToolBatches.set(key, true);
		else expandedToolBatches.delete(key);
	}, [expandedToolBatches]);
	const updateExpandedToolRow = useCallback((toolId: string, open: boolean) => {
		if (open) expandedToolRows.set(toolId, true);
		else expandedToolRows.delete(toolId);
	}, [expandedToolRows]);
	const getToolStackPresentation = useCallback((key: string, tools: readonly ToolBatchTool[]) => {
		let presentation = toolStackPresentationsRef.current.get(key);
		if (!presentation) {
			presentation = initialToolStackPresentation(tools);
			toolStackPresentationsRef.current.set(key, presentation);
		}
		return presentation;
	}, []);

	return {
		expandedWorkProcesses,
		expandedAgentSteps,
		expandedToolBatches,
		expandedToolRows,
		getToolStackPresentation,
		resetExpandedState,
		updateExpandedWorkProcess,
		updateExpandedAgentStep,
		updateExpandedToolBatch,
		updateExpandedToolRow,
	};
}
