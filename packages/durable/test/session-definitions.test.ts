import { defineDoc } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";

type State = { value: number };
const initial = (): State => ({ value: 0 });

const SessionDoc = defineDoc<State>({ kind: "t.session", version: 1, scope: "session", initial });

describe("document definitions", () => {
	it("validates persisted version semantics", () => {
		expect(() => defineDoc<State>({ kind: "k", version: 0, scope: "session", initial })).toThrow("positive integer");
		expect(() => defineDoc<State>({ kind: "k", version: 1.5, scope: "session", initial })).toThrow(
			"positive integer",
		);
		expect(defineDoc<State>({ kind: "", version: 1, scope: "session", initial }).definition.kind).toBe("");
		expect(SessionDoc.definition.kind).toBe("t.session");
	});
});
