import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { VirtualizedSessionList } from "../src/components/workbench/virtualized-session-list.tsx";

describe("virtualized session list", () => {
	it("长会话列表首次渲染只挂载有限行，保留首行内容和会话间隔", () => {
		const html = renderToStaticMarkup(createElement(VirtualizedSessionList<string>, {
			items: Array.from({ length: 5000 }, (_, index) => "会话-" + index),
			getKey: (item) => item,
			renderItem: (item) => createElement("button", null, item),
			scrollRef: { current: null },
		}));
		expect(html.match(/data-virtual-list-row/g)).toHaveLength(24);
		expect(html).toContain("会话-0</button>");
		expect(html).not.toContain("会话-24</button>");
		expect(html).toContain("translateY(34px)");
	});
});
