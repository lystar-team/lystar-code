import { describe, expect, it } from "vitest";
import {
	hasPromptTokenCandidates,
	hasPromptTokens,
	promptTokenParts,
	promptTokenRanges,
} from "../src/components/ai-elements/prompt-token.tsx";

describe("prompt token validation", () => {
	it("does not style ordinary @ text or unknown references", () => {
		const text = "联系 user@example.com，查看 @missing 和 $[missing]";
		const parts = promptTokenParts(text, new Set(["@src/app.ts", "$[shuorenhua]", "@[ui-design]"]));

		expect(hasPromptTokenCandidates(text)).toBe(true);
		expect(hasPromptTokens(text, new Set(["@src/app.ts", "$[shuorenhua]", "@[ui-design]"]))).toBe(false);
		expect(parts.filter((part) => part.kind)).toEqual([]);
		expect(promptTokenRanges(text, new Set(["@src/app.ts", "$[shuorenhua]", "@[ui-design]"]))).toEqual([]);
	});

	it("styles only complete file and Skill references", () => {
		const validTokens = new Set(["@src/app.ts", "@[ui-design]", "$[shuorenhua]"]);
		const parts = promptTokenParts("请查看 @src/app.ts、@[ui-design] 和 $[shuorenhua]", validTokens);

		expect(parts.filter((part) => part.kind)).toEqual([
			expect.objectContaining({ text: "src/app.ts", kind: "file" }),
			expect.objectContaining({ text: "ui-design", kind: "skill" }),
			expect.objectContaining({ text: "shuorenhua", kind: "skill" }),
		]);
		expect(promptTokenRanges("请查看 @src/app.ts、@[ui-design] 和 $[shuorenhua]", validTokens)).toEqual([
			{ start: 4, end: 15 },
			{ start: 16, end: 28 },
			{ start: 31, end: 44 },
		]);
	});

	it("does not match an @ token inside an email address", () => {
		const validTokens = new Set(["@example.com", "@src/app.ts"]);
		const parts = promptTokenParts("邮箱 user@example.com，(@src/app.ts)", validTokens);

		expect(parts.filter((part) => part.kind)).toEqual([
			expect.objectContaining({ text: "src/app.ts", kind: "file" }),
		]);
	});
});
