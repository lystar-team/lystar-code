import { describe, expect, it } from "vitest";
import {
	FileEditState,
	SnapshotEditError,
	type PreparedSnapshotEdit,
	type SnapshotRangeEdit,
} from "../src/core/tools/file-edit-state.ts";

const path = "/repo/sample.txt";

function capture(state: FileEditState, content: string, startLine = 1, endLine = lineCount(content)) {
	return state.capture(path, content, startLine, endLine);
}

function lineCount(content: string): number {
	return content.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").split("\n").length;
}

function expectFailure(run: () => unknown, code: string): SnapshotEditError {
	let failure: unknown;
	try {
		run();
	} catch (error) {
		failure = error;
	}
	expect(failure).toBeInstanceOf(SnapshotEditError);
	expect(failure).toMatchObject({ code });
	return failure as SnapshotEditError;
}

function edit(startLine: number, endLine: number, newText: string, index?: number): SnapshotRangeEdit {
	return { startLine, endLine, newText, ...(index === undefined ? {} : { index }) };
}

function commit(state: FileEditState, prepared: PreparedSnapshotEdit): string {
	state.commit(prepared);
	return prepared.finalContent;
}

describe("FileEditState", () => {
	it("edits only the requested occurrence when source lines repeat", () => {
		const state = new FileEditState();
		const content = "repeat\nmiddle\nrepeat\n";
		const snapshot = capture(state, content);
		const prepared = state.prepare(path, content, {
			snapshot: snapshot.id,
			edits: [edit(3, 3, "changed")],
		});

		expect(prepared.finalContent).toBe("repeat\nmiddle\nchanged\n");
		expect(prepared.edits).toEqual([{ index: 0, startLine: 3, endLine: 3, status: "applied" }]);
	});

	it("rejects an unrecorded change made after the snapshot", () => {
		const state = new FileEditState();
		const snapshot = capture(state, "first\nsecond\nthird\n");
		const failure = expectFailure(
			() => state.prepare(path, "first\nexternal\nthird\n", { snapshot: snapshot.id, edits: [edit(3, 3, "updated")] }),
			"SOURCE_CHANGED",
		);

		expect(failure.issues[0]).toMatchObject({ editIndex: 0, startLine: 3, endLine: 3 });
	});

	it("relocates a stale range after a confirmed non-overlapping edit", () => {
		const state = new FileEditState();
		const original = "one\ntwo\nthree\n";
		const snapshot = capture(state, original);
		const first = state.prepare(path, original, { snapshot: snapshot.id, edits: [edit(1, 1, "ONE")] });
		const current = commit(state, first);
		const second = state.prepare(path, current, { snapshot: snapshot.id, edits: [edit(3, 3, "THREE")] });

		expect(second.finalContent).toBe("ONE\ntwo\nTHREE\n");
		expect(second.edits[0]).toMatchObject({ startLine: 3, status: "applied" });
	});

	it("recognizes a committed deletion after a later disjoint edit", () => {
		const state = new FileEditState();
		const original = "a\nb\nc\nd\n";
		const snapshot = capture(state, original);
		const deletion = state.prepare(path, original, { snapshot: snapshot.id, edits: [edit(2, 2, "")] });
		const afterDeletion = commit(state, deletion);
		const afterDeletionSnapshot = capture(state, afterDeletion);
		const laterEdit = state.prepare(path, afterDeletion, {
			snapshot: afterDeletionSnapshot.id,
			edits: [edit(1, 0, "prefix")],
		});
		const current = commit(state, laterEdit);
		const repeated = state.prepare(path, current, { snapshot: snapshot.id, edits: [edit(2, 2, "")] });

		expect(current).toBe("prefix\na\nc\nd\n");
		expect(repeated.applied).toBe(0);
		expect(repeated.alreadyApplied).toBe(1);
		expect(repeated.edits[0]).toMatchObject({ startLine: 3, endLine: 2, status: "already_applied" });
		expect(repeated.finalContent).toBe(current);
	});

	it("reports a modification receipt as stale after a later edit touches the same range", () => {
		const state = new FileEditState();
		const original = "a\nb\nc\n";
		const originalSnapshot = capture(state, original);
		const first = state.prepare(path, original, {
			snapshot: originalSnapshot.id,
			edits: [edit(2, 2, "B")],
		});
		const afterFirst = commit(state, first);
		const currentSnapshot = capture(state, afterFirst);
		const second = state.prepare(path, afterFirst, {
			snapshot: currentSnapshot.id,
			edits: [edit(2, 2, "C")],
		});
		const current = commit(state, second);

		expectFailure(
			() => state.prepare(path, current, { snapshot: originalSnapshot.id, edits: [edit(2, 2, "B")] }),
			"SOURCE_CHANGED",
		);
	});

	it("does not infer a deletion from absent text without a receipt", () => {
		const state = new FileEditState();
		const original = "a\nb\nc\n";
		const snapshot = capture(state, original);
		const failure = expectFailure(
			() => state.prepare(path, "a\nc\n", { snapshot: snapshot.id, edits: [edit(2, 2, "")] }),
			"SOURCE_CHANGED",
		);

		expect(failure.issues[0].message).toContain("unconfirmed");
	});

	it("keeps a valid batch item and resumes by correcting only the failed index", () => {
		const state = new FileEditState();
		const content = "a\nb\nc\n";
		const snapshot = capture(state, content);
		const failure = expectFailure(
			() => state.prepare(path, content, { snapshot: snapshot.id, edits: [edit(1, 1, "A"), edit(8, 8, "C")] }),
			"RANGE_OUTSIDE_SNAPSHOT",
		);
		expect(failure.plan).toBeTypeOf("string");
		expect(failure.attempt).toBe(1);

		const resumed = state.prepare(path, content, {
			plan: failure.plan,
			edits: [edit(3, 3, "C", 1)],
		});
		expect(resumed.finalContent).toBe("A\nb\nC\n");
		expect(resumed.applied).toBe(2);
	});

	it("rejects overlapping ranges as one atomic batch", () => {
		const state = new FileEditState();
		const content = "one\ntwo\nthree\n";
		const snapshot = capture(state, content);
		const failure = expectFailure(
			() => state.prepare(path, content, {
				snapshot: snapshot.id,
				edits: [edit(1, 2, "first"), edit(2, 3, "second")],
			}),
			"EDIT_OVERLAP",
		);

		expect(failure.issues).toHaveLength(1);
		expect(failure.issues[0].editIndex).toBe(1);
	});

	it("does not allow ranges outside a partial snapshot or EOF beyond its displayed range", () => {
		const state = new FileEditState();
		const content = "one\ntwo\nthree\nfour\nfive\n";
		const snapshot = capture(state, content, 2, 3);
		const outside = expectFailure(
			() => state.prepare(path, content, { snapshot: snapshot.id, edits: [edit(4, 4, "FOUR")] }),
			"RANGE_OUTSIDE_SNAPSHOT",
		);
		expect(outside.issues[0].editIndex).toBe(0);

		const eof = expectFailure(
			() => state.prepare(path, content, { snapshot: snapshot.id, edits: [edit(6, 5, "last")] }),
			"RANGE_OUTSIDE_SNAPSHOT",
		);
		expect(eof.issues[0].startLine).toBe(6);
	});

	it("uses the displayed line ending at a partial-read insertion boundary", () => {
		const state = new FileEditState();
		const content = "header\r\nshown\r\nunread\n";
		const snapshot = capture(state, content, 2, 2);
		const prepared = state.prepare(path, content, {
			snapshot: snapshot.id,
			edits: [edit(3, 2, "inserted")],
		});

		expect(prepared.finalContent).toBe("header\r\nshown\r\ninserted\r\nunread\n");
	});

	it("preserves BOM, CRLF and mixed endings outside the edited lines", () => {
		const state = new FileEditState();
		const content = "\uFEFFone\r\ntwo\nthree\r\nfour";
		const snapshot = capture(state, content);
		const prepared = state.prepare(path, content, {
			snapshot: snapshot.id,
			edits: [edit(2, 2, "TWO\nnext")],
		});

		expect(prepared.finalContent).toBe("\uFEFFone\r\nTWO\nnext\nthree\r\nfour");
		expect(prepared.baseContent).toBe("one\ntwo\nthree\nfour");
		expect(prepared.newContent).toBe("one\nTWO\nnext\nthree\nfour");
	});

	it("does not consume retry budget or cache a plan during preview", () => {
		const state = new FileEditState();
		const content = "one\ntwo\n";
		const snapshot = capture(state, content);
		const previewFailure = expectFailure(
			() => state.prepare(path, content, { snapshot: snapshot.id, edits: [edit(4, 4, "four")] }, true),
			"RANGE_OUTSIDE_SNAPSHOT",
		);
		expect(previewFailure.attempt).toBe(0);
		expect(previewFailure.plan).toBeTypeOf("string");

		const missingPlan = expectFailure(
			() => state.prepare(path, content, { plan: previewFailure.plan }),
			"PLAN_NOT_FOUND",
		);
		expect(missingPlan.attempt).toBe(1);
	});

	it("offers at most two recoveries for one unchanged file version without blocking valid input", () => {
		const state = new FileEditState();
		const content = "one\ntwo\n";
		const snapshot = capture(state, content);
		const initial = expectFailure(
			() => state.prepare(path, content, { snapshot: snapshot.id, edits: [edit(9, 9, "nine")] }),
			"RANGE_OUTSIDE_SNAPSHOT",
		);
		const second = expectFailure(
			() => {
				capture(state, content);
				state.prepare(path, content, { plan: initial.plan });
			},
			"RANGE_OUTSIDE_SNAPSHOT",
		);
		const third = expectFailure(
			() => {
				capture(state, content);
				state.prepare(path, content, { plan: second.plan });
			},
			"RANGE_OUTSIDE_SNAPSHOT",
		);
		expect([initial.attempt, second.attempt, third.attempt]).toEqual([1, 2, 3]);
		expect([initial.recoveryAllowed, second.recoveryAllowed, third.recoveryAllowed]).toEqual([true, true, false]);

		const corrected = state.prepare(path, content, {
			plan: third.plan,
			edits: [edit(2, 2, "TWO", 0)],
		});
		expect(corrected.finalContent).toBe("one\nTWO\n");
	});

	it("reuses matching snapshots and evicts old references without blocking new reads", () => {
		const state = new FileEditState();
		const oldest = capture(state, "version-0");
		expect(capture(state, "version-0").id).toBe(oldest.id);
		for (let version = 1; version <= 128; version++) capture(state, `version-${version}`);

		expect(() => state.getSnapshot(oldest.id, path)).toThrow(/SNAPSHOT_NOT_FOUND/);
		const expired = expectFailure(
			() => state.prepare(path, "version-0", { snapshot: oldest.id, edits: [edit(1, 1, "changed")] }),
			"SNAPSHOT_NOT_FOUND",
		);
		expect(expired.issues[0].message).toContain("new read");

		const current = "version-128";
		const currentSnapshot = capture(state, current);
		const prepared = state.prepare(path, current, {
			snapshot: currentSnapshot.id,
			edits: [edit(1, 1, "current")],
		});
		expect(prepared.finalContent).toBe("current");
	});

	it("evicts old plans so a new correction remains executable", () => {
		const state = new FileEditState();
		const content = "one\n";
		const snapshot = capture(state, content);
		const failures: SnapshotEditError[] = [];
		for (let index = 0; index < 65; index++) {
			failures.push(
				expectFailure(
					() => state.prepare(path, content, { snapshot: snapshot.id, edits: [edit(9, 9, `bad-${index}`)] }),
					"RANGE_OUTSIDE_SNAPSHOT",
				),
			);
		}

		expectFailure(() => state.prepare(path, content, { plan: failures[0].plan }), "PLAN_NOT_FOUND");
		const corrected = state.prepare(path, content, {
			plan: failures.at(-1)!.plan,
			edits: [edit(1, 1, "ONE", 0)],
		});
		expect(corrected.finalContent).toBe("ONE\n");
	});

	it("evicts old receipts and history while commits continue beyond cache limits", () => {
		const state = new FileEditState();
		let content = "seed";
		for (let index = 0; index < 520; index++) {
			const totalLines = lineCount(content);
			const snapshot = capture(state, content, totalLines, totalLines);
			const prepared = state.prepare(path, content, {
				snapshot: snapshot.id,
				edits: [edit(totalLines + 1, totalLines, `tail-${index}`)],
			});
			content = commit(state, prepared);
		}

		const totalLines = lineCount(content);
		const snapshot = capture(state, content, totalLines, totalLines);
		const prepared = state.prepare(path, content, {
			snapshot: snapshot.id,
			edits: [edit(totalLines + 1, totalLines, "still-works")],
		});
		expect(prepared.finalContent.endsWith("still-works")).toBe(true);
		expect(commit(state, prepared)).toBe(prepared.finalContent);
	});

	it("keeps insertions and deletions on line boundaries", () => {
		const state = new FileEditState();
		const content = "left\nright\n";
		const snapshot = capture(state, content);
		const inserted = state.prepare(path, content, {
			snapshot: snapshot.id,
			edits: [edit(2, 1, "middle")],
		});
		expect(inserted.finalContent).toBe("left\nmiddle\nright\n");

		const deletionState = new FileEditState();
		const deletionSnapshot = capture(deletionState, "left\nremove\nright\n");
		const deleted = deletionState.prepare(path, "left\nremove\nright\n", {
			snapshot: deletionSnapshot.id,
			edits: [edit(2, 2, "")],
		});
		expect(deleted.finalContent).toBe("left\nright\n");
	});

	it("counts terminal empty lines and uses the displayed EOF boundary", () => {
		const state = new FileEditState();
		const content = "one\ntwo\n";
		const snapshot = capture(state, content);
		expect(snapshot.totalLines).toBe(3);
		expect(snapshot.endLine).toBe(3);

		const inserted = state.prepare(path, content, {
			snapshot: snapshot.id,
			edits: [edit(4, 3, "three")],
		});
		expect(inserted.finalContent).toBe("one\ntwo\n\nthree");

		const emptyFile = capture(new FileEditState(), "");
		expect(emptyFile.totalLines).toBe(1);
		expect(emptyFile.startLine).toBe(1);
		expect(emptyFile.endLine).toBe(1);
	});

	it("allows an EOF insertion only from a snapshot that reaches EOF", () => {
		const state = new FileEditState();
		const content = "one\ntwo";
		const partial = capture(state, content, 1, 1);
		const failure = expectFailure(
			() => state.prepare(path, content, { snapshot: partial.id, edits: [edit(3, 2, "three")] }),
			"RANGE_OUTSIDE_SNAPSHOT",
		);
		expect(failure.issues[0].startLine).toBe(3);

		const eofSnapshot = capture(state, content, 2, 2);
		const inserted = state.prepare(path, content, {
			snapshot: eofSnapshot.id,
			edits: [edit(3, 2, "three")],
		});
		expect(inserted.finalContent).toBe("one\ntwo\nthree");
	});
	it("applies a newline-only change instead of treating it as unchanged", () => {
		const state = new FileEditState();
		const snapshot = capture(state, "last");
		const prepared = state.prepare(path, "last", { snapshot: snapshot.id, edits: [edit(1, 1, "last\n")] });
		expect(prepared.applied).toBe(1);
		expect(prepared.finalContent).toBe("last\n");
	});

	it("rejects duplicate corrections of one retained item", () => {
		const state = new FileEditState();
		const snapshot = capture(state, "one\ntwo\n");
		const initial = expectFailure(() => state.prepare(path, "one\ntwo\n", { snapshot: snapshot.id, edits: [edit(8, 8, "bad")] }), "RANGE_OUTSIDE_SNAPSHOT");
		expectFailure(() => state.prepare(path, "one\ntwo\n", { plan: initial.plan, edits: [edit(1, 1, "ONE", 0), edit(2, 2, "TWO", 0)] }), "DUPLICATE_INDEX");
	});

});
