import type { AgentStep } from "@lystar/code-web-protocol";

export type AgentStepIndex = Readonly<Record<string, AgentStep>>;

function terminal(status: AgentStep["status"]): boolean {
	return status !== "running";
}

function mergeStep(current: AgentStep | undefined, incoming: AgentStep): AgentStep {
	if (!current) return incoming;
	const currentEndedAt = current.endedAt ?? current.startedAt;
	const incomingEndedAt = incoming.endedAt ?? incoming.startedAt;
	const preferred =
		terminal(current.status) && !terminal(incoming.status)
			? current
			: incomingEndedAt >= currentEndedAt
				? incoming
				: current;
	return {
		...preferred,
		toolCallIds: [...new Set([...current.toolCallIds, ...incoming.toolCallIds])],
		messageEntryIds: [
			...new Set([...(current.messageEntryIds ?? []), ...(incoming.messageEntryIds ?? [])]),
		],
	};
}

export function mergeAgentStepIndex(
	current: AgentStepIndex | undefined,
	incoming: readonly AgentStep[] | undefined,
): Record<string, AgentStep> {
	const next: Record<string, AgentStep> = { ...(current ?? {}) };
	for (const step of incoming ?? []) next[step.id] = mergeStep(next[step.id], step);
	return next;
}

export function agentStepsFromIndex(index: AgentStepIndex | undefined): AgentStep[] {
	return Object.values(index ?? {}).sort((left, right) => left.startedAt - right.startedAt || left.id.localeCompare(right.id));
}

export function agentStepIndexChanged(
	current: AgentStepIndex | undefined,
	incoming: readonly AgentStep[] | undefined,
): boolean {
	for (const step of incoming ?? []) {
		const previous = current?.[step.id];
		if (!previous) return true;
		const previousMessageEntryIds = previous.messageEntryIds ?? [];
		const incomingMessageEntryIds = step.messageEntryIds ?? [];
		if (
			previous.title !== step.title ||
			previous.status !== step.status ||
			previous.endedAt !== step.endedAt ||
			previous.summary !== step.summary ||
			previous.toolCallIds.length !== step.toolCallIds.length ||
			previousMessageEntryIds.length !== incomingMessageEntryIds.length ||
			previous.toolCallIds.some((id, index) => id !== step.toolCallIds[index]) ||
			previousMessageEntryIds.some((id, index) => id !== incomingMessageEntryIds[index])
		)
			return true;
	}
	return false;
}
