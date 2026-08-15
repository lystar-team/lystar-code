import type { ClientMessage, JsonValue, ServerMessage } from "../src/index.ts";

export const clientGoldenFixtures: Record<string, ClientMessage> = {
	"client-hello": { type: "hello", version: 1, clientInstanceId: "rust-spike-client" },
	"client-read-transcript": {
		type: "request",
		id: "request-read-transcript",
		request: { command: "read_transcript", sessionPath: "/tmp/session.jsonl", limit: 20 },
	},
	"client-search-transcript": {
		type: "request",
		id: "request-search-transcript",
		request: { command: "search_transcript", sessionPath: "/tmp/session.jsonl", query: "needle", limit: 20 },
	},
	"client-ui-response-missing": { type: "ui_response", id: "ui-response-missing", confirmed: false },
	"client-ui-response-null": { type: "ui_response", id: "ui-response-null", value: null },
	"client-ui-response-value": { type: "ui_response", id: "ui-response-value", value: { accepted: true } },
};

const operation = (progress: JsonValue | undefined, result: JsonValue | undefined) => ({
	operationId: "operation-1",
	clientInstanceId: "client-1",
	clientRequestId: "request-1",
	sessionPath: "/tmp/session.jsonl",
	type: "prompt",
	status: "running" as const,
	acceptedAt: 0,
	updatedAt: 1,
	payloadHash: "payload-1",
	...(progress === undefined ? {} : { progress }),
	...(result === undefined ? {} : { result }),
});

export const serverGoldenFixtures: Record<string, ServerMessage> = {
	"server-hello": {
		type: "hello",
		version: 1,
		productVersion: "rust-spike",
		protocolVersion: 1,
		serverInstanceId: "node-host",
		hostInstanceId: "node-host",
		hostStartedAt: 0,
		capabilities: ["session-paging"],
	},
	"server-response-ok": {
		type: "response",
		id: "response-ok",
		ok: true,
		result: { nested: [null, { number: 1, value: "deep" }] },
	},
	"server-response-error": {
		type: "response",
		id: "response-error-value",
		ok: false,
		error: { code: "locked", message: "session is locked", retryable: true, details: { owner: null } },
	},
	"server-response-error-null": {
		type: "response",
		id: "response-error-null",
		ok: false,
		error: { code: "locked", message: "session is locked", details: null },
	},
	"server-response-error-missing": {
		type: "response",
		id: "response-error-missing",
		ok: false,
		error: { code: "locked", message: "session is locked" },
	},
	"server-event-transcript": {
		type: "event",
		event: {
			type: "transcript_committed",
			sessionPath: "/tmp/session.jsonl",
			transcriptGeneration: "generation-1",
			fromRevision: 0,
			toRevision: 1,
			items: [
				{
					entryId: "entry-1",
					parentId: null,
					timestamp: "2026-08-15T00:00:00.000Z",
					kind: "message",
					payload: { role: "assistant", content: ["hello", null] },
				},
			],
		},
	},
	"server-event-ui-request": {
		type: "event",
		event: {
			type: "ui_request",
			id: "ui-request",
			operationId: "operation-1",
			kind: "confirm",
			title: "Confirm",
			payload: { choices: [true, null] },
			timeoutMs: 1000,
		},
	},
	"server-event-operation-missing": {
		type: "event",
		event: { type: "operation_updated", operation: operation(undefined, undefined) },
	},
	"server-event-operation-null": {
		type: "event",
		event: { type: "operation_updated", operation: operation(null, null) },
	},
	"server-event-operation-value": {
		type: "event",
		event: { type: "operation_updated", operation: operation({ step: 1 }, { done: true }) },
	},
};
