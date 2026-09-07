import type { WebOperation, WebSessionSnapshot } from "../types.ts";

export function isOlderSessionSnapshot(current: WebSessionSnapshot | undefined, incoming: WebSessionSnapshot): boolean {
	return current?.id === incoming.id && incoming.revision < current.revision;
}

export function runtimeHistoryChanged(
	current: WebSessionSnapshot | undefined,
	incoming: WebSessionSnapshot,
): boolean {
	// Runtime generation 与历史文件 generation 的格式不同，只能与同来源的快照比较。
	return current !== undefined && current.id === incoming.id &&
		current.transcriptGeneration !== incoming.transcriptGeneration;
}

export function mergeOperationSnapshots(current: readonly WebOperation[], incoming: readonly WebOperation[]): WebOperation[] {
	const operations = new Map(incoming.map((operation) => [operation.operationId, operation]));
	for (const operation of current) {
		const replacement = operations.get(operation.operationId);
		if (!replacement || operation.updatedAt > replacement.updatedAt) operations.set(operation.operationId, operation);
	}
	return [...operations.values()].sort((left, right) => right.updatedAt - left.updatedAt).slice(0, 200);
}

export function isTranscriptResponseObsolete(
	requested: { generation?: string; leafId?: string | null },
	current: { generation?: string; leafId?: string | null },
	response: { transcriptGeneration: string; leafId: string | null },
): boolean {
	const generationChanged = requested.generation !== current.generation && current.generation !== undefined;
	const leafChanged = requested.leafId !== current.leafId && current.leafId !== undefined;
	return (generationChanged && response.transcriptGeneration !== current.generation) ||
		(leafChanged && response.leafId !== current.leafId);
}
