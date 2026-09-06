export function shouldJoinToolBatch(previousToolName: string | undefined, toolName: string): boolean {
	return previousToolName === "bash" && toolName === "bash";
}
