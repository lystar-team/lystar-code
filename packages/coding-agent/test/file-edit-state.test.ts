import { describe, expect, it } from "vitest";
import { applyEditsToContent, EditMatchError } from "../src/core/tools/edit-diff.ts";

const path = "/repo/sample.txt";

function expectFailure(run: () => unknown, code: string): EditMatchError {
	try {
		run();
	} catch (error) {
		expect(error).toBeInstanceOf(EditMatchError);
		const failure = error as EditMatchError;
		expect(failure.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code })]));
		return failure;
	}
	throw new Error(`Expected ${code}`);
}

describe("stateless file edits", () => {
	it("edits only the requested occurrence when source lines repeat", () => {
		const result = applyEditsToContent("same\nmiddle\nsame\n", [{ oldText: "middle\nsame", newText: "middle\nchanged" }], path);
		expect(result.finalContent).toBe("same\nmiddle\nchanged\n");
		expect(result.edits).toMatchObject([{ index: 0, startLine: 2, endLine: 3, status: "applied" }]);
	});

	it("accepts an unrecorded change outside the exact target", () => {
		const result = applyEditsToContent("first\nexternal\nthird\n", [{ oldText: "third", newText: "updated" }], path);
		expect(result.finalContent).toBe("first\nexternal\nupdated\n");
	});

	it("locates the same source text after a non-overlapping insertion", () => {
		const original = "one\ntwo\nthree\n";
		const first = applyEditsToContent(original, [{ oldText: "one", newText: "prefix\nONE" }], path);
		const second = applyEditsToContent(first.finalContent, [{ oldText: "three", newText: "THREE" }], path);
		expect(second.finalContent).toBe("prefix\nONE\ntwo\nTHREE\n");
		expect(second.edits[0]).toMatchObject({ startLine: 4, endLine: 4 });
	});

	it("does not replay a committed deletion after a later disjoint edit", () => {
		const deletion = applyEditsToContent("a\nb\nc\n", [{ oldText: "b\n", newText: "" }], path);
		const later = applyEditsToContent(deletion.finalContent, [{ oldText: "a", newText: "prefix\na" }], path);
		expectFailure(() => applyEditsToContent(later.finalContent, [{ oldText: "b\n", newText: "" }], path), "MATCH_NOT_FOUND");
		expect(later.finalContent).toBe("prefix\na\nc\n");
	});

	it("rejects an old source value after a later edit touches the same target", () => {
		const first = applyEditsToContent("a\nb\nc\n", [{ oldText: "b", newText: "B" }], path);
		const second = applyEditsToContent(first.finalContent, [{ oldText: "B", newText: "C" }], path);
		expectFailure(() => applyEditsToContent(second.finalContent, [{ oldText: "b", newText: "B" }], path), "MATCH_NOT_FOUND");
		expect(second.finalContent).toBe("a\nC\nc\n");
	});

	it("does not infer a deletion from absent source text", () => {
		expectFailure(() => applyEditsToContent("a\nc\n", [{ oldText: "b\n", newText: "" }], path), "MATCH_NOT_FOUND");
	});

	it("revalidates the complete corrected batch without retaining a plan", () => {
		const content = "a\nb\nc\n";
		expectFailure(() => applyEditsToContent(content, [{ oldText: "a", newText: "A" }, { oldText: "missing", newText: "C" }], path), "MATCH_NOT_FOUND");
		const corrected = applyEditsToContent(content, [{ oldText: "a", newText: "A" }, { oldText: "c", newText: "C" }], path);
		expect(corrected.finalContent).toBe("A\nb\nC\n");
		expect(corrected.applied).toBe(2);
	});

	it("rejects overlapping source intervals as one atomic batch", () => {
		expectFailure(() => applyEditsToContent("a\nb\nc\n", [{ oldText: "a\nb", newText: "first" }, { oldText: "b\nc", newText: "second" }], path), "EDIT_OVERLAP");
	});

	it("requires existing source anchors instead of unverified range coordinates", () => {
		const content = "one\ntwo\nthree\nfour\n";
		expectFailure(() => applyEditsToContent(content, [{ oldText: "missing", newText: "FOUR" }], path), "MATCH_NOT_FOUND");
		expectFailure(() => applyEditsToContent(content, [{ oldText: "", newText: "last" }], path), "EMPTY_OLD_TEXT");
	});

	it("uses the local line ending at an anchored insertion boundary", () => {
		const result = applyEditsToContent("one\ntwo\r\nthree\n", [{ oldText: "two\n", newText: "two\ninserted\n" }], path);
		expect(result.finalContent).toBe("one\ntwo\r\ninserted\r\nthree\n");
	});

	it("preserves BOM, CRLF and mixed endings outside the edited interval", () => {
		const result = applyEditsToContent("\uFEFFone\r\ntwo\r\nthree\nfour\r\n", [{ oldText: "two", newText: "TWO\nnext" }], path);
		expect(result.finalContent).toBe("\uFEFFone\r\nTWO\r\nnext\r\nthree\nfour\r\n");
		expect(result.edits).toEqual([{ index: 0, startLine: 2, endLine: 2, status: "applied" }]);
	});

	it("does not consume state or change subsequent results during preview", () => {
		const content = "one\ntwo\n";
		for (let index = 0; index < 3; index++) expectFailure(() => applyEditsToContent(content, [{ oldText: "missing", newText: "four" }], path), "MATCH_NOT_FOUND");
		const first = applyEditsToContent(content, [{ oldText: "two", newText: "TWO" }], path);
		const second = applyEditsToContent(content, [{ oldText: "two", newText: "TWO" }], path);
		expect(first).toEqual(second);
		expect(content).toBe("one\ntwo\n");
	});

	it("does not let previous failures block a valid correction", () => {
		const content = "one\ntwo\n";
		for (let index = 0; index < 3; index++) expectFailure(() => applyEditsToContent(content, [{ oldText: "nine", newText: "NINE" }], path), "MATCH_NOT_FOUND");
		expect(applyEditsToContent(content, [{ oldText: "two", newText: "TWO" }], path).finalContent).toBe("one\nTWO\n");
	});

	it("does not depend on references to earlier reads or cache eviction", () => {
		for (let index = 0; index < 300; index++) {
			const content = `version-${index}`;
			expect(applyEditsToContent(content, [{ oldText: content, newText: "current" }], path).finalContent).toBe("current");
		}
		expectFailure(() => applyEditsToContent("version-300", [{ oldText: "version-0", newText: "stale" }], path), "MATCH_NOT_FOUND");
	});

	it("keeps valid corrections executable after many rejected batches", () => {
		const content = "one\ntwo\n";
		for (let index = 0; index < 100; index++) expectFailure(() => applyEditsToContent(content, [{ oldText: `missing-${index}`, newText: "bad" }], path), "MATCH_NOT_FOUND");
		expect(applyEditsToContent(content, [{ oldText: "one", newText: "ONE" }], path).finalContent).toBe("ONE\ntwo\n");
	});

	it("keeps editing after many earlier operations without storing receipts or history", () => {
		let content = "head\n";
		for (let index = 0; index < 300; index++) {
			const oldText = index === 0 ? "head\n" : `tail-${index - 1}\n`;
			content = applyEditsToContent(content, [{ oldText, newText: `${oldText}tail-${index}\n` }], path).finalContent;
		}
		expect(applyEditsToContent(content, [{ oldText: "tail-299\n", newText: "tail-299\nstill-works\n" }], path).finalContent).toBe(`${content}still-works\n`);
	});

	it("keeps anchored insertions and deletions on line boundaries", () => {
		const inserted = applyEditsToContent("first\nlast\n", [{ oldText: "first\n", newText: "first\nmiddle\n" }], path);
		expect(inserted.finalContent).toBe("first\nmiddle\nlast\n");
		const deleted = applyEditsToContent(inserted.finalContent, [{ oldText: "middle\n", newText: "" }], path);
		expect(deleted.finalContent).toBe("first\nlast\n");
	});

	it("uses explicit EOF source text including terminal empty lines", () => {
		const content = "one\ntwo\n\n";
		const result = applyEditsToContent(content, [{ oldText: "two\n\n", newText: "two\n\nthree\n" }], path);
		expect(result.finalContent).toBe("one\ntwo\n\nthree\n");
		expect(result.edits[0]).toMatchObject({ startLine: 2, endLine: 3 });
	});

	it("requires the current EOF anchor rather than a remembered file boundary", () => {
		const content = "one\ntwo\n";
		expectFailure(() => applyEditsToContent(content, [{ oldText: "three\n", newText: "three\nfour\n" }], path), "MATCH_NOT_FOUND");
		expect(applyEditsToContent(content, [{ oldText: "two\n", newText: "two\nthree\n" }], path).finalContent).toBe("one\ntwo\nthree\n");
	});

	it("applies a newline-only change instead of treating it as unchanged", () => {
		const result = applyEditsToContent("last", [{ oldText: "last", newText: "last\n" }], path);
		expect(result.applied).toBe(1);
		expect(result.finalContent).toBe("last\n");
	});

	it("rejects duplicate corrections of one source interval", () => {
		expectFailure(() => applyEditsToContent("one\ntwo\n", [{ oldText: "one", newText: "ONE" }, { oldText: "one", newText: "other" }], path), "EDIT_OVERLAP");
	});
});
