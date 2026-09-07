import { describe, expect, it } from "vitest";
import { getCodeHighlightCacheStats, highlightCode, subscribeToCodeHighlight } from "../src/lib/code-highlighter.ts";

function waitForHighlight(code: string, language: "json" | "typescript"): Promise<void> {
	return new Promise((resolve) => {
		const result = highlightCode(code, language, () => resolve());
		if (result) resolve();
	});
}

async function waitForIdle(): Promise<void> {
	for (let attempt = 0; attempt < 200; attempt++) {
		if (getCodeHighlightCacheStats().inFlight === 0) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`高亮任务未在预期时间内结束：${JSON.stringify(getCodeHighlightCacheStats())}`);
}

describe("code highlighter cache", () => {
	it("bounds 2,000 distinct code versions and clears in-flight listeners", async () => {
		for (let batch = 0; batch < 20; batch++) {
			await Promise.all(
				Array.from({ length: 100 }, (_, index) => {
					const id = batch * 100 + index;
					return waitForHighlight(`const value_${id}: number = ${id};\nexport default value_${id};`, "typescript");
				}),
			);
		}
		await waitForIdle();

		const stats = getCodeHighlightCacheStats();
		expect(stats.entries).toBeLessThanOrEqual(stats.maxEntries);
		expect(stats.bytes).toBeLessThanOrEqual(stats.maxBytes);
		expect(stats.inFlight).toBe(0);
		expect(stats.listeners).toBe(0);
	});

	it("removes an unsubscribed listener before async completion", async () => {
		let calls = 0;
		const unsubscribe = subscribeToCodeHighlight('{"listener_unsubscribe":true}', "json", () => {
			calls += 1;
		});
		unsubscribe();
		await waitForIdle();

		expect(calls).toBe(0);
		expect(getCodeHighlightCacheStats().listeners).toBe(0);
	});
});
