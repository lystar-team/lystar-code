import { describe, expect, it } from "vitest";
import { renderMarkdown } from "../src/markdown.tsx";

describe("renderMarkdown", () => {
	it("renders nested links, project resources, and removes unsafe targets", () => {
		const html = renderMarkdown(
			"[**官网**](https://example.com) [源码](src/app.ts:12) ![截图](assets/view.png) [危险](javascript:alert(1))",
		);

		expect(html).toContain('<a href="https://example.com/" rel="noreferrer noopener"><strong>官网</strong></a>');
		expect(html).toContain('data-resource-target="src/app.ts:12"');
		expect(html).toContain('data-resource-target="assets/view.png" data-resource-image="true"');
		expect(html).toContain("危险");
		expect(html).not.toContain("javascript:");
	});
});
