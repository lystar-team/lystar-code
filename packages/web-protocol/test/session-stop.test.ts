import { describe, expect, it } from "vitest";
import { ClientMessageDecoder, encodeClientMessage } from "../src/framing.ts";

describe("stop_session request", () => {
	it("accepts a session ID without requiring the session owner's lease", () => {
		const message = {
			type: "request",
			id: "stop",
			request: { command: "stop_session", sessionId: "session-123" },
		} as const;
		expect(new ClientMessageDecoder().push(encodeClientMessage(message))).toEqual([message]);
	});

	it("rejects an empty session ID", () => {
		expect(() =>
			encodeClientMessage({ type: "request", id: "stop", request: { command: "stop_session", sessionId: "" } }),
		).toThrow();
	});
});
