import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ComposerSessionStats } from "../src/components/workbench/composer-session-stats.tsx";

describe("composer session stats", () => {
	it("shows four compact clickable metrics and the last completed output speed", () => {
		const html = renderToStaticMarkup(
			<ComposerSessionStats
				sessionId="session-1"
				revision={2}
				ready={false}
				connected
				phase="idle"
				lastOutputSpeed={{ outputTokens: 131, elapsedMs: 1_000 }}
			/>,
		);
		expect(html).toContain("aria-label=\"查看会话统计\"");
		expect(html).toContain("TPS 131 tok/s，查看详情");
		expect(html).toContain("缓存命中 —，查看详情");
		expect(html).toContain("输入 —，查看详情");
		expect(html).toContain("输出 —，查看详情");
	});

	it("does not present the previous completed speed as live TPS", () => {
		const html = renderToStaticMarkup(
			<ComposerSessionStats
				sessionId="session-1"
				ready={false}
				connected
				phase="turn"
				lastOutputSpeed={{ outputTokens: 131, elapsedMs: 1_000 }}
			/>,
		);
		expect(html).toContain("TPS 计算中，查看详情");
	});

});
