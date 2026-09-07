export function shouldJoinToolBatch(previousToolName: string | undefined, toolName: string): boolean {
	return previousToolName === "bash" && toolName === "bash";
}

export function shouldJoinLiveToolBatch(
	previousToolName: string | undefined,
	nextToolName: string,
	previousTurnId: number | undefined,
	currentTurnId: number,
): boolean {
	return previousTurnId === currentTurnId && shouldJoinToolBatch(previousToolName, nextToolName);
}
