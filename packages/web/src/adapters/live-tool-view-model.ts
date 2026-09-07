import type { ToolBatchTool } from "../components/ai-elements/tool-batch.tsx";
import type { LiveTool } from "../state/use-workbench.ts";

export function toLiveToolViewModel(tool: LiveTool): ToolBatchTool {
	return {
		id: tool.id,
		name: tool.name,
		summary: tool.summary,
		state:
			tool.state === "success"
				? "output-available"
				: tool.state === "error"
					? "output-error"
					: tool.state === "cancelled"
						? "output-cancelled"
						: tool.state === "interrupted"
							? "output-interrupted"
							: tool.state === "preparing" || tool.state === "queued"
								? "input-queued"
								: "input-available",
		detail: tool.result,
		inputPreview: tool.inputPreview,
		diff: tool.diff,
	};
}
