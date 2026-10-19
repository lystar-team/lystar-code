import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ComposerSessionStats } from "../src/components/workbench/composer-session-stats.tsx";

describe("composer session stats", () => {
	it("shows four compact clickable metrics and the completed session average", () => {
		const html = renderToStaticMarkup(
			<ComposerSessionStats
				usage={{
					tokens: { input: 10, output: 131, cacheRead: 30, cacheWrite: 0, total: 171 },
					outputSpeed: { outputTokens: 131, elapsedMs: 1_000 },
					estimatedOutput: false,
				}}
			/>,
		);
		expect(html).toContain("aria-label=\"查看会话统计\"");
		expect(html).toContain("平均 TPS 131 tok/s，查看详情");
		expect(html).toContain("缓存命中 75%，查看详情");
		expect(html).toContain("输入 40，查看详情");
		expect(html).toContain("输出 131，查看详情");
	});

	it("keeps the completed session average during streamed output", () => {
		const html = renderToStaticMarkup(
			<ComposerSessionStats
				usage={{
					tokens: { input: 10, output: 181, cacheRead: 30, cacheWrite: 0, total: 221 },
					outputSpeed: { outputTokens: 131, elapsedMs: 1_000 },
					estimatedOutput: true,
				}}
			/>,
		);
		expect(html).toContain("平均 TPS 131 tok/s，查看详情");
	});

});
