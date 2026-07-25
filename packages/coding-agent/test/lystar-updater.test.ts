import { describe, expect, it, vi } from "vitest";
import { runLystarInstaller } from "../src/utils/lystar-updater.ts";

describe("LYStar updater", () => {
	it("rejects invalid release repository metadata before downloading", async () => {
		const fetchMock = vi.fn();
		await expect(runLystarInstaller("not-a-repository", [], { fetch: fetchMock })).rejects.toThrow(
			"无效的 LYStar release repository",
		);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("reports installer download failures", async () => {
		const fetchMock = vi.fn(async () => new Response("missing", { status: 404 }));
		await expect(runLystarInstaller("lystar/releases", [], { fetch: fetchMock })).rejects.toThrow(
			"下载安装器失败：HTTP 404",
		);
	});
});
