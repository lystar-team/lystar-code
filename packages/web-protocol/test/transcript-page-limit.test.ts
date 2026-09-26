import { Check } from "typebox/value";
import { describe, expect, it } from "vitest";
import { CommandSchema, MAX_TRANSCRIPT_PAGE_SIZE } from "../src/schemas.ts";

describe("transcript page size", () => {
	it("accepts 400 items and rejects a larger request", () => {
		expect(MAX_TRANSCRIPT_PAGE_SIZE).toBe(400);
		expect(Check(CommandSchema, { command: "read_transcript", sessionPath: "/session.jsonl", limit: 400 })).toBe(
			true,
		);
		expect(Check(CommandSchema, { command: "read_transcript", sessionPath: "/session.jsonl", limit: 401 })).toBe(
			false,
		);
	});
});
