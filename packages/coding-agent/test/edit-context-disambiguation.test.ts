import { describe, expect, it } from "vitest";
import { applyEditsToNormalizedContent as applyHarnessEdits } from "../../agent/src/harness/tools/edit-diff.ts";
import { applyEditsToNormalizedContent, EditMatchError } from "../src/core/tools/edit-diff.ts";
import { createEditRecoveryEvidence } from "../src/core/tools/edit-recovery.ts";

for (const [name, apply] of [
	["coding-agent", applyEditsToNormalizedContent],
	["harness", applyHarnessEdits],
] as const) {
	describe(`${name} Unicode matching with indentation`, () => {
		it.each([
			["log(“x”);", 'log("x");'],
			["log(ｘ);", "log(x);"],
			["log(ﬀ);", "log(ff);"],
		])("uses explicit indentation while normalizing %s", (originalLine, oldLine) => {
			const original = `header\n        ${originalLine}\n    ${originalLine}   \nfooter\n`;
			expect(apply(original, [{ oldText: `    ${oldLine}`, newText: "    done();" }], "memory.txt").newContent).toBe(
				`header\n        ${originalLine}\n    done();   \nfooter\n`,
			);
		});

		it("preserves tab indentation and disjoint batch replacements", () => {
			const original = "\t\tlog(“x”);\n\tlog(“x”);\n";
			expect(
				apply(
					original,
					[
						{ oldText: '\t\tlog("x");', newText: "\t\tfirst();" },
						{ oldText: '\tlog("x");', newText: "\tsecond();" },
					],
					"memory.txt",
				).newContent,
			).toBe("\t\tfirst();\n\tsecond();\n");
		});

		it("keeps identical normalized candidates ambiguous", () => {
			expect(() =>
				apply(
					"    log(“x”);\n    log(”x”);\n",
					[{ oldText: '    log("x");', newText: "    done();" }],
					"memory.txt",
				),
			).toThrow("Found 2 occurrences");
		});

		it("does not infer indentation that the arguments did not provide", () => {
			expect(() =>
				apply("        log(“x”);\n    log(“x”);\n", [{ oldText: 'log("x");', newText: "done();" }], "memory.txt"),
			).toThrow("Found 2 occurrences");
		});

		it("retains unique whitespace-tolerant fallback and grapheme boundaries", () => {
			expect(
				apply("\tlog(“x”);\n", [{ oldText: '    log("x");', newText: "    done();" }], "memory.txt").newContent,
			).toBe("    done();\n");
			expect(() => apply("    ﬀ\n", [{ oldText: "    f", newText: "    x" }], "memory.txt")).toThrow(
				"Could not find",
			);
		});
	});
}

function evidenceFor(content: string, oldText: string, maxBytes = 12 * 1024) {
	const edits = [{ oldText, newText: "replacement" }];
	try {
		applyEditsToNormalizedContent(content, edits, "memory.txt");
	} catch (error) {
		if (!(error instanceof EditMatchError)) throw error;
		return createEditRecoveryEvidence(content, edits, error.issues, maxBytes);
	}
	throw new Error("Expected an ambiguous fixture");
}

const method =
	"\tasync preflight(context) {\n\t\tconst circuit = this.circuits.get(context.key);\n\t\tif (!circuit) return;";

function controller(name: string, padding = 6, nearLabel = "shared context") {
	return [
		`class ${name} {`,
		...Array(padding).fill("\t// shared context"),
		`\t// ${nearLabel}`,
		method,
		...Array(padding).fill("\t// shared context"),
		"}",
	].join("\n");
}

describe("distinguishing edit recovery context", () => {
	it("reaches the enclosing distinction for the repeated preflight pattern", () => {
		const source = `${controller("Assist")}\n\n${controller("Auto")}\n`;
		const result = evidenceFor(source, method);
		expect(result.text).toContain("class Assist {");
		expect(result.text).toContain("class Auto {");
		expect(result.lineCount).toBeLessThanOrEqual(200);
		expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(12 * 1024);
		expect(result.candidateLines).toHaveLength(2);
		expect(() =>
			applyEditsToNormalizedContent(source, [{ oldText: method, newText: "replacement" }], "memory.txt"),
		).toThrow("Found 2 occurrences");
	});

	it("continues distinguishing the remaining pair after one candidate separates", () => {
		const source = `${controller("First", 6, "same pair")}\n${controller("Second", 6, "same pair")}\n${controller("Third", 6, "separate")}`;
		const result = evidenceFor(source, method);
		expect(result.text).toContain("class First {");
		expect(result.text).toContain("class Second {");
		expect(result.text).toContain("// separate");
	});

	it("leaves already distinct context at the existing size", () => {
		const result = evidenceFor(`${controller("First", 6, "first")}\n${controller("Second", 6, "second")}`, method);
		expect(result.lineCount).toBe(18);
		expect(result.text).not.toContain("class First");
		expect(result.text).not.toContain("class Second");
	});

	it("stops at the line budget and points to further reading instead of choosing", () => {
		const source = `${controller("First", 150)}\n${controller("Second", 150)}`;
		const result = evidenceFor(source, method);
		expect(result.lineCount).toBeLessThanOrEqual(200);
		expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(12 * 1024);
		expect(result.text).toContain("候选上下文仍相同");
		expect(result.text).toMatch(/read offset=\d+ limit=\d+/);
		expect(result.text).not.toContain("class First");
	});

	it("bounds expansion by bytes for Unicode context", () => {
		const source = `${controller("First", 30)}\n${controller("Second", 30)}`.replaceAll(
			"shared context",
			"重复上下文".repeat(20),
		);
		const result = evidenceFor(source, method, 3000);
		expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(3000);
		expect(result.lineCount).toBeLessThanOrEqual(200);
		expect(result.text).toContain("候选上下文仍相同");
		expect(result.text).not.toContain("\uFFFD");
		expect(result.candidateLines).toHaveLength(2);
	});
});
