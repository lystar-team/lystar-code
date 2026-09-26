import { afterEach, describe, expect, it, vi } from "vitest";
import { webApi } from "../src/adapters/host-protocol/api.ts";
import { loadResourceImage } from "../src/components/ai-elements/resource-preview.tsx";

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe("resource image cache", () => {
	it("reuses session images after switching away and back", async () => {
		const read = vi.spyOn(webApi, "readImageContent").mockResolvedValue({
			contentRef: "ref-switch",
			mimeType: "image/png",
			byteLength: 3,
			data: "AAAA",
		});
		const first = { id: "ref-switch", sessionId: "session-switch", contentRef: "ref-switch" };
		expect(await loadResourceImage(first)).toBe("data:image/png;base64,AAAA");
		expect(await loadResourceImage(first)).toBe("data:image/png;base64,AAAA");
		expect(read).toHaveBeenCalledTimes(1);
	});

	it("reuses path images briefly but refreshes after the path cache expires", async () => {
		vi.useFakeTimers();
		const read = vi.spyOn(webApi, "projectFile").mockResolvedValue({
			kind: "image",
			mimeType: "image/png",
			data: "AQID",
		} as Awaited<ReturnType<typeof webApi.projectFile>>);
		const item = { id: "path-switch", projectId: "project-switch", path: "chart.png" };
		await loadResourceImage(item);
		await loadResourceImage(item);
		expect(read).toHaveBeenCalledTimes(1);
		vi.setSystemTime(Date.now() + 61_000);
		await loadResourceImage(item);
		expect(read).toHaveBeenCalledTimes(2);
	});

	it("evicts older images when the retained string budget is exceeded", async () => {
		const data = "A".repeat(9 * 1024 * 1024);
		const read = vi.spyOn(webApi, "readImageContent").mockImplementation(async (_sessionId, contentRef) => ({
			contentRef,
			mimeType: "image/png",
			byteLength: data.length,
			data,
		}));
		const first = { id: "large-1", sessionId: "session-large", contentRef: "large-1" };
		const second = { id: "large-2", sessionId: "session-large", contentRef: "large-2" };
		await loadResourceImage(first);
		await loadResourceImage(second);
		await loadResourceImage(second);
		expect(read).toHaveBeenCalledTimes(2);
		await loadResourceImage(first);
		expect(read).toHaveBeenCalledTimes(3);
	});
});
