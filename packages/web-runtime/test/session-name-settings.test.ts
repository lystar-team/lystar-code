import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { saveProductBranding } from "../src/product-branding.ts";
import { loadSessionNameSettings, saveSessionNameSettings } from "../src/session-name-settings.ts";

describe("session name settings", () => {
	it("loads the existing low default and updates only sessionName fields", async () => {
		const agentDir = await mkdtemp(join(tmpdir(), "lystar-session-name-settings-"));
		const path = join(agentDir, "lystar.json");
		try {
			await writeFile(
				path,
				JSON.stringify({
					altScreen: false,
					branding: { name: "LYStar Code" },
					sessionName: { model: "upstream/old-model", custom: "keep" },
				}),
			);
			expect(await loadSessionNameSettings(agentDir)).toEqual({
				model: "upstream/old-model",
				thinkingLevel: "low",
			});

			expect(
				await saveSessionNameSettings(agentDir, {
					model: "upstream/gpt-5.6-luna",
					thinkingLevel: "medium",
				}),
			).toEqual({ model: "upstream/gpt-5.6-luna", thinkingLevel: "medium" });
			expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
				altScreen: false,
				branding: { name: "LYStar Code" },
				sessionName: {
					model: "upstream/gpt-5.6-luna",
					custom: "keep",
					thinkingLevel: "medium",
				},
			});

			expect(await saveSessionNameSettings(agentDir, { thinkingLevel: "off" })).toEqual({ thinkingLevel: "off" });
			expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
				altScreen: false,
				branding: { name: "LYStar Code" },
				sessionName: { custom: "keep", thinkingLevel: "off" },
			});
		} finally {
			await rm(agentDir, { recursive: true, force: true });
		}
	});

	it("serializes branding and session name writes to the shared config", async () => {
		const agentDir = await mkdtemp(join(tmpdir(), "lystar-shared-config-settings-"));
		const path = join(agentDir, "lystar.json");
		try {
			await writeFile(path, JSON.stringify({ altScreen: true }));
			await Promise.all([
				saveProductBranding(agentDir, { name: "工作台" }),
				saveSessionNameSettings(agentDir, {
					model: "upstream/gpt-5.6-luna",
					thinkingLevel: "high",
				}),
			]);

			expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
				altScreen: true,
				branding: { name: "工作台" },
				sessionName: { model: "upstream/gpt-5.6-luna", thinkingLevel: "high" },
			});
		} finally {
			await rm(agentDir, { recursive: true, force: true });
		}
	});

	it("rejects unsupported thinking levels without changing the config", async () => {
		const agentDir = await mkdtemp(join(tmpdir(), "lystar-session-name-invalid-"));
		const path = join(agentDir, "lystar.json");
		try {
			const original = JSON.stringify({ sessionName: { model: "upstream/gpt-5.6-luna", thinkingLevel: "low" } });
			await writeFile(path, original);
			await expect(
				saveSessionNameSettings(agentDir, { model: "upstream/other", thinkingLevel: "invalid" }),
			).rejects.toThrow("不支持的会话标题思考强度");
			expect(await readFile(path, "utf8")).toBe(original);
		} finally {
			await rm(agentDir, { recursive: true, force: true });
		}
	});
});
