export function shouldJoinToolBatch(previousToolName: string | undefined, toolName: string): boolean {
	return (
		(previousToolName === "bash" && toolName === "bash") ||
		(previousToolName === "web_search" && toolName === "web_search")
	);
}

export function shouldJoinLiveToolBatch(
	previousToolName: string | undefined,
	nextToolName: string,
	previousTurnId: number | undefined,
	currentTurnId: number,
): boolean {
	return previousTurnId === currentTurnId && shouldJoinToolBatch(previousToolName, nextToolName);
}
