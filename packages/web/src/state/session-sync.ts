import type { WebLease, WebOperation, WebSessionSnapshot } from "../types.ts";

export function bootstrapLeaseForSession(
	sessionId: string | undefined,
	current: WebLease | undefined,
	leases: readonly { sessionId: string; lease: WebLease }[],
): WebLease | undefined {
	if (!sessionId) return current;
	return leases.find((entry) => entry.sessionId === sessionId)?.lease ?? current;
}

export function needsTranscriptRefreshForCommit(
	current: { pageLoaded: boolean; revision?: number; runtimeGeneration?: string },
	incoming: { transcriptGeneration: string; fromRevision: number },
): boolean {
	return (
		!current.pageLoaded ||
		current.revision === undefined ||
		current.runtimeGeneration !== incoming.transcriptGeneration ||
		incoming.fromRevision > current.revision
	);
}

export function isOlderSessionSnapshot(current: WebSessionSnapshot | undefined, incoming: WebSessionSnapshot): boolean {
	return current?.id === incoming.id && incoming.revision < current.revision;
}

export function isSameSessionSnapshot(current: WebSessionSnapshot | undefined, incoming: WebSessionSnapshot): boolean {
	if (!current || current.id !== incoming.id) return false;
	const currentModel = current.model;
	const incomingModel = incoming.model;
	return (
		current.name === incoming.name &&
		current.createdAt === incoming.createdAt &&
		current.updatedAt === incoming.updatedAt &&
		current.phase === incoming.phase &&
		current.activity === incoming.activity &&
		currentModel?.provider === incomingModel?.provider &&
		currentModel?.id === incomingModel?.id &&
		current.thinkingLevel === incoming.thinkingLevel &&
		current.attached === incoming.attached &&
		current.writeAccess === incoming.writeAccess &&
		current.leafId === incoming.leafId &&
		current.queuedSteerCount === incoming.queuedSteerCount &&
		current.queuedFollowUpCount === incoming.queuedFollowUpCount &&
		JSON.stringify(current.queuedSteerMessages ?? []) === JSON.stringify(incoming.queuedSteerMessages ?? []) &&
		JSON.stringify(current.queuedFollowUpMessages ?? []) === JSON.stringify(incoming.queuedFollowUpMessages ?? []) &&
		current.contextTokens === incoming.contextTokens &&
		current.contextWindow === incoming.contextWindow &&
		current.transcriptGeneration === incoming.transcriptGeneration &&
		current.transcriptRevision === incoming.transcriptRevision &&
		current.toolActivityEpoch === incoming.toolActivityEpoch &&
		current.toolActivityRevision === incoming.toolActivityRevision &&
		JSON.stringify(current.toolActivities ?? []) === JSON.stringify(incoming.toolActivities ?? []) &&
		JSON.stringify(current.activeStep) === JSON.stringify(incoming.activeStep)
	);
}

export function runtimeHistoryChanged(
	current: WebSessionSnapshot | undefined,
	incoming: WebSessionSnapshot,
): boolean {
	// Runtime generation 与历史文件 generation 的格式不同，只能与同来源的快照比较。
	return current !== undefined && current.id === incoming.id &&
		current.transcriptGeneration !== incoming.transcriptGeneration;
}

export function isSameTranscriptHistory(
	current: { generation?: string; leafId?: string | null },
	incoming: { transcriptGeneration: string; leafId: string | null },
): boolean {
	return (
		(current.generation === undefined || current.generation === incoming.transcriptGeneration) &&
		(current.leafId === undefined || current.leafId === incoming.leafId)
	);
}

export function mergeOperationSnapshots(current: readonly WebOperation[], incoming: readonly WebOperation[]): WebOperation[] {
	const operations = new Map(incoming.map((operation) => [operation.operationId, operation]));
	for (const operation of current) {
		const replacement = operations.get(operation.operationId);
		if (!replacement || operation.updatedAt > replacement.updatedAt) operations.set(operation.operationId, operation);
	}
	return [...operations.values()].sort((left, right) => right.updatedAt - left.updatedAt).slice(0, 200);
}

export function replaceSessionOperationSnapshots(
	current: readonly WebOperation[],
	sessionId: string,
	incoming: readonly WebOperation[],
): WebOperation[] {
	const operations = new Map(
		current.filter((operation) => operation.sessionId !== sessionId).map((operation) => [operation.operationId, operation]),
	);
	for (const operation of incoming) {
		if (operation.sessionId === sessionId) operations.set(operation.operationId, operation);
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
