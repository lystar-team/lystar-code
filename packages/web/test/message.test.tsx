import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MessageResponse } from "../src/components/ai-elements/message.tsx";

describe("MessageResponse local resource links", () => {
	it("keeps project-relative file links clickable instead of marking them blocked", () => {
		const markup = renderToStaticMarkup(
			createElement(
				MessageResponse,
				{
					linkSafety: { enabled: true },
					onOpenPath: () => {},
				},
				"- [use-workbench.ts](packages/web/src/state/use-workbench.ts)",
			),
		);

		expect(markup).toContain("use-workbench.ts");
		expect(markup).toContain("<button");
		expect(markup).not.toContain("[blocked]");
	});
});
