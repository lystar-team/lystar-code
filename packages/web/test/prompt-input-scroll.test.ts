import { describe, expect, it } from "vitest";
import { shouldFollowPromptInputCaret } from "../src/components/ai-elements/prompt-input.tsx";

describe("prompt input scrolling", () => {
	it("follows new input when the focused caret is at the end", () => {
		expect(shouldFollowPromptInputCaret(true, 24, 24, 24)).toBe(true);
	});

	it("does not force the scroll position while editing earlier text or while unfocused", () => {
		expect(shouldFollowPromptInputCaret(true, 12, 12, 24)).toBe(false);
		expect(shouldFollowPromptInputCaret(true, 12, 18, 24)).toBe(false);
		expect(shouldFollowPromptInputCaret(false, 24, 24, 24)).toBe(false);
	});
});
