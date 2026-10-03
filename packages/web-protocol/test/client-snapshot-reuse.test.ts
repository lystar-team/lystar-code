import { describe, expect, it } from "vitest";
import { type ByteTransport, type RuntimeClientSnapshot, RuntimeProtocolClient } from "../src/client.ts";
import { encodeServerMessage } from "../src/framing.ts";
import type { ServerEvent } from "../src/schemas.ts";

class EventTransport implements ByteTransport {
	private readonly bytesListeners = new Set<(bytes: Uint8Array) => void>();
	private readonly closeListeners = new Set<(error?: Error) => void>();

	async send(_bytes: Uint8Array): Promise<void> {}

	async close(): Promise<void> {
		for (const listener of this.closeListeners) listener();
	}

	onBytes(listener: (bytes: Uint8Array) => void): () => void {
		this.bytesListeners.add(listener);
		return () => this.bytesListeners.delete(listener);
	}

	onClose(listener: (error?: Error) => void): () => void {
		this.closeListeners.add(listener);
		return () => this.closeListeners.delete(listener);
	}

	emit(event: ServerEvent): void {
		const bytes = encodeServerMessage({ type: "event", event });
		for (const listener of this.bytesListeners) listener(bytes);
	}
}

function sessionSnapshot(revision: number): ServerEvent {
	return {
		type: "session_snapshot",
		snapshot: {
			id: "session",
			path: "/session",
			cwd: "/workspace",
			createdAt: 1,
			updatedAt: revision,
			phase: "idle",
			activity: "idle",
			thinkingLevel: "off",
			attached: true,
			writeAccess: "owned",
			revision,
			leafId: null,
			queuedSteerCount: 0,
			queuedFollowUpCount: 0,
			transcriptGeneration: "generation",
			transcriptRevision: 0,
		},
	};
}

function operationUpdated(updatedAt: number, status: "running" | "completed"): ServerEvent {
	return {
		type: "operation_updated",
		operation: {
			operationId: "operation",
			clientInstanceId: "client",
			clientRequestId: "request",
			sessionPath: "/session",
			type: "prompt",
			status,
			acceptedAt: 1,
			updatedAt,
			payloadHash: "hash",
		},
	};
}

function transcriptCommitted(fromRevision: number, toRevision: number): ServerEvent {
	return {
		type: "transcript_committed",
		sessionPath: "/session",
		transcriptGeneration: "generation",
		fromRevision,
		toRevision,
		items: [],
	};
}

describe("RuntimeProtocolClient snapshot Map reuse", () => {
	it("keeps progress notifications and listener snapshot order while reusing all Maps", async () => {
		const transport = new EventTransport();
		const client = new RuntimeProtocolClient(transport, "progress-snapshot");
		await client.connect();
		const before = client.getSnapshot();
		const order: string[] = [];
		let eventSnapshot: RuntimeClientSnapshot | undefined;
		let firstSubscriberSnapshot: RuntimeClientSnapshot | undefined;

		client.onEvent(() => {
			order.push("event-first");
			eventSnapshot = client.getSnapshot();
		});
		client.onEvent(() => order.push("event-second"));
		client.subscribe(() => {
			order.push("subscriber-first");
			firstSubscriberSnapshot = client.getSnapshot();
		});
		client.subscribe(() => order.push("subscriber-second"));

		transport.emit({
			type: "session_progress",
			sessionPath: "/session",
			progress: { type: "assistant_delta", text: "progress", stepId: "step" },
		});

		const after = client.getSnapshot();
		expect(order).toEqual(["event-first", "event-second", "subscriber-first", "subscriber-second"]);
		expect(eventSnapshot).toBe(before);
		expect(firstSubscriberSnapshot).toBe(after);
		expect(after).not.toBe(before);
		expect(after.sessions).toBe(before.sessions);
		expect(after.operations).toBe(before.operations);
		expect(after.transcripts).toBe(before.transcripts);
		await client.close();
	});

	it("copies only changed Maps and preserves every published historical snapshot", async () => {
		const transport = new EventTransport();
		const client = new RuntimeProtocolClient(transport, "history-snapshot");
		await client.connect();
		const initial = client.getSnapshot();
		let eventSnapshot: RuntimeClientSnapshot | undefined;
		let subscriberSnapshot: RuntimeClientSnapshot | undefined;
		client.onEvent((event) => {
			if (event.type === "session_snapshot") eventSnapshot = client.getSnapshot();
		});
		client.subscribe(() => {
			subscriberSnapshot = client.getSnapshot();
		});

		transport.emit(sessionSnapshot(1));
		const sessionOne = client.getSnapshot();
		expect(eventSnapshot).toBe(initial);
		expect(eventSnapshot?.sessions.size).toBe(0);
		expect(subscriberSnapshot).toBe(sessionOne);
		expect(sessionOne.sessions).not.toBe(initial.sessions);
		expect(sessionOne.operations).toBe(initial.operations);
		expect(sessionOne.transcripts).toBe(initial.transcripts);
		expect(initial.sessions.size).toBe(0);

		transport.emit(sessionSnapshot(2));
		const sessionTwo = client.getSnapshot();
		expect(sessionOne.sessions.get("/session")?.revision).toBe(1);
		expect(sessionTwo.sessions.get("/session")?.revision).toBe(2);
		expect(sessionTwo.operations).toBe(sessionOne.operations);
		expect(sessionTwo.transcripts).toBe(sessionOne.transcripts);

		transport.emit(operationUpdated(2, "running"));
		const operationOne = client.getSnapshot();
		expect(operationOne.sessions).toBe(sessionTwo.sessions);
		expect(operationOne.operations).not.toBe(sessionTwo.operations);
		expect(operationOne.transcripts).toBe(sessionTwo.transcripts);

		transport.emit(operationUpdated(3, "completed"));
		const operationTwo = client.getSnapshot();
		expect(operationOne.operations.get("operation")?.status).toBe("running");
		expect(operationTwo.operations.get("operation")?.status).toBe("completed");
		expect(operationTwo.sessions).toBe(operationOne.sessions);
		expect(operationTwo.transcripts).toBe(operationOne.transcripts);

		transport.emit(transcriptCommitted(0, 1));
		const transcriptOne = client.getSnapshot();
		expect(transcriptOne.sessions).toBe(operationTwo.sessions);
		expect(transcriptOne.operations).toBe(operationTwo.operations);
		expect(transcriptOne.transcripts).not.toBe(operationTwo.transcripts);

		transport.emit(transcriptCommitted(1, 2));
		const transcriptTwo = client.getSnapshot();
		expect(transcriptOne.transcripts.get("/session")?.revision).toBe(1);
		expect(transcriptTwo.transcripts.get("/session")?.revision).toBe(2);
		expect(transcriptTwo.sessions).toBe(transcriptOne.sessions);
		expect(transcriptTwo.operations).toBe(transcriptOne.operations);

		transport.emit({ type: "session_removed", sessionPath: "/session" });
		const removed = client.getSnapshot();
		expect(removed.sessions).not.toBe(transcriptTwo.sessions);
		expect(removed.transcripts).not.toBe(transcriptTwo.transcripts);
		expect(removed.operations).toBe(transcriptTwo.operations);
		expect(removed.sessions.has("/session")).toBe(false);
		expect(removed.transcripts.has("/session")).toBe(false);
		expect(transcriptTwo.sessions.has("/session")).toBe(true);
		expect(transcriptTwo.transcripts.has("/session")).toBe(true);
		await client.close();
	});
});
