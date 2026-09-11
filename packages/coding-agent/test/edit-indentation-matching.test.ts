import { describe, expect, it } from "vitest";
import { applyEditsToNormalizedContent as applyHarnessEdits } from "../../agent/src/harness/tools/edit-diff.ts";
import { applyEditsToNormalizedContent as applyCodingEdits } from "../src/core/tools/edit-diff.ts";

for (const [name, apply] of [
	["coding-agent", applyCodingEdits],
	["harness", applyHarnessEdits],
] as const) {
	describe(`${name} explicit indentation matching`, () => {
		it.each(["", "header\n"])("distinguishes the two installer success lines after %j", (prefix) => {
			const source = `${prefix}                print_success "已下载 $name。"\n                return\n            fi\n        elif wget --tries=1; then\n            print_success "已下载 $name。"\n            return\n`;
			const edits = [
				{
					oldText: '                print_success "已下载 $name。"',
					newText: `                print_success "已下载 \${name}。"`,
				},
				{
					oldText: '            print_success "已下载 $name。"',
					newText: `            print_success "已下载 \${name}。"`,
				},
			];
			const expected = source.replaceAll("$name", `\${name}`);
			expect(apply(source, edits, "scripts/install.sh").newContent).toBe(expected);
			expect(apply(source, [...edits].reverse(), "scripts/install.sh").newContent).toBe(expected);
		});

		it("changes only the explicitly indented target, even beyond the candidate display limit", () => {
			const prefix = "        call();\n".repeat(8);
			expect(
				apply(`${prefix}    call();\n`, [{ oldText: "    call();", newText: "    target();" }], "memory.txt")
					.newContent,
			).toBe(`${prefix}    target();\n`);
		});

		it("preserves tab indentation and multiline trailing-whitespace tolerance", () => {
			const source = "\t\tcall();   \n\t\treturn;  \n\tcall();  \n\treturn; \n";
			expect(
				apply(source, [{ oldText: "\tcall();\n\treturn;\n", newText: "\ttarget();\n\treturn;\n" }], "memory.txt")
					.newContent,
			).toBe("\t\tcall();   \n\t\treturn;  \n\ttarget();\n\treturn;\n");
		});

		it("rejects genuinely duplicate indentation rather than picking a position", () => {
			expect(() =>
				apply(
					"        call();\n    call();\n    call();\n",
					[{ oldText: "    call();", newText: "    target();" }],
					"memory.txt",
				),
			).toThrow("Found 2 occurrences");
		});

		it("keeps non-indented snippets ambiguous across different nesting levels", () => {
			expect(() =>
				apply("        call();\n    call();\n", [{ oldText: "call();", newText: "target();" }], "memory.txt"),
			).toThrow("Found 2 occurrences");
		});

		it("does not suppress genuine inline candidates", () => {
			expect(() =>
				apply(
					"label    call();\n    call();\n",
					[{ oldText: "    call();", newText: "    target();" }],
					"memory.txt",
				),
			).toThrow("Found 2 occurrences");
		});

		it("does not prefer an inline candidate when no full indentation matches", () => {
			expect(() =>
				apply(
					"        call();\nlabel    call();\n",
					[{ oldText: "    call();", newText: "    target();" }],
					"memory.txt",
				),
			).toThrow("Found 2 occurrences");
		});

		it("retains substring matching when no stronger indentation match exists", () => {
			expect(
				apply("        call();\n", [{ oldText: "    call();", newText: "    target();" }], "memory.txt").newContent,
			).toBe("        target();\n");
			expect(() =>
				apply(
					"        call();\n            call();\n",
					[{ oldText: "    call();", newText: "    target();" }],
					"memory.txt",
				),
			).toThrow("Found 2 occurrences");
		});

		it("keeps whitespace-only overlapping matches ambiguous", () => {
			expect(() => apply("        call();\n", [{ oldText: "    ", newText: "\t" }], "memory.txt")).toThrow(
				"Found 5 occurrences",
			);
		});
	});
}
