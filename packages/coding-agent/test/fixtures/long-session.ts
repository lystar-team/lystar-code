export type LongSessionEntry = Record<string, unknown>;

export interface LongSessionFixture {
	entries: LongSessionEntry[];
	activeLeafId: string;
	siblingLeafId: string;
	compactionId: string;
	toolResultIds: string[];
}

function message(id: string, parentId: string | null, content: string): LongSessionEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: "2026-08-23T00:00:00Z",
		message: { role: "user", content, timestamp: 1 },
	};
}

function assistantToolCall(id: string, parentId: string, toolCallId: string): LongSessionEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: "2026-08-23T00:00:00Z",
		message: {
			role: "assistant",
			content: [{ type: "toolCall", id: toolCallId, name: "read", arguments: { path: "src/index.ts" } }],
			stopReason: "toolUse",
			timestamp: 1,
		},
	};
}

function toolResult(id: string, parentId: string, toolCallId: string): LongSessionEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: "2026-08-23T00:00:00Z",
		message: {
			role: "toolResult",
			toolCallId,
			toolName: "read",
			content: [{ type: "text", text: "ok" }],
			isError: false,
			timestamp: 1,
		},
	};
}

export function createLongSessionFixture(messageCount = 5000): LongSessionFixture {
	const entries: LongSessionEntry[] = [
		{
			type: "session",
			version: 3,
			id: "long-session",
			timestamp: "2026-08-23T00:00:00Z",
			cwd: "/tmp/lystar-long-session",
		},
	];
	let parentId: string | null = null;
	const toolResultIds: string[] = [];
	const compactionId = "active-compaction";

	for (let index = 0; index < messageCount; index++) {
		const messageId = `active-${index}`;
		entries.push(message(messageId, parentId, `active message ${index}`));
		parentId = messageId;

		if (index % 250 === 0) {
			const toolCallId = `tool-call-${index}`;
			const assistantId = `active-tool-assistant-${index}`;
			const resultId = `active-tool-result-${index}`;
			entries.push(assistantToolCall(assistantId, parentId, toolCallId));
			entries.push(toolResult(resultId, assistantId, toolCallId));
			parentId = resultId;
			toolResultIds.push(resultId);
		}

		if (index === Math.floor(messageCount / 2)) {
			entries.push({
				type: "compaction",
				id: compactionId,
				parentId,
				timestamp: "2026-08-23T00:00:00Z",
				summary: "long session compaction",
				firstKeptEntryId: "active-0",
				tokensBefore: 250000,
			});
			parentId = compactionId;
		}
	}

	const siblingId = "sibling-branch";
	const siblingLeafId = "sibling-leaf";
	entries.push(message(siblingId, "active-12", "sibling branch must not appear"));
	entries.push(message(siblingLeafId, siblingId, "sibling leaf must not appear"));

	return {
		entries,
		activeLeafId: parentId!,
		siblingLeafId,
		compactionId,
		toolResultIds,
	};
}
