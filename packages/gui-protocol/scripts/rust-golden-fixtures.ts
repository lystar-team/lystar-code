import type { ClientMessage, ServerMessage } from "../src/index.ts";

export const clientGoldenFixtures: Record<string, ClientMessage> = {
	"client-hello": { type: "hello", version: 1, clientInstanceId: "rust-spike-client" },
	"client-read-transcript": {
		type: "request",
		id: "request-read-transcript",
		request: { command: "read_transcript", sessionPath: "/tmp/session.jsonl", limit: 20 },
	},
	"client-ui-response": { type: "ui_response", id: "ui-response", confirmed: false },
};

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
		id: "response-error",
		ok: false,
		error: { code: "locked", message: "session is locked", retryable: true, details: { owner: null } },
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
};
