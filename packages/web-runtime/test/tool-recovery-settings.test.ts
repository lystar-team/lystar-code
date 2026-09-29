import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadToolRecoverySettings, saveToolRecoverySettings } from "../src/tool-recovery-settings.ts";

describe("tool recovery settings", () => {
	it("saves the model without changing other LYStar settings", async () => {
		const agentDir = await mkdtemp(join(tmpdir(), "lystar-tool-recovery-settings-"));
		const path = join(agentDir, "lystar.json");
		try {
			await writeFile(
				path,
				JSON.stringify({ sessionName: { thinkingLevel: "low" }, toolRecovery: { enabled: true } }),
			);
			expect(await loadToolRecoverySettings(agentDir)).toEqual({ thinkingLevel: "low" });
			expect(
				await saveToolRecoverySettings(agentDir, {
					model: "custom/gpt-6-sol",
					thinkingLevel: "high",
				}),
			).toEqual({ model: "custom/gpt-6-sol", thinkingLevel: "high" });
			expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
				sessionName: { thinkingLevel: "low" },
				toolRecovery: { enabled: true, model: "custom/gpt-6-sol", thinkingLevel: "high" },
			});
			await expect(saveToolRecoverySettings(agentDir, { model: "invalid", thinkingLevel: "low" })).rejects.toThrow(
				"错题本模型标识无效",
			);
			await expect(saveToolRecoverySettings(agentDir, { thinkingLevel: "invalid" })).rejects.toThrow(
				"不支持的错题本思考强度",
			);
			expect(await saveToolRecoverySettings(agentDir, { thinkingLevel: "off" })).toEqual({ thinkingLevel: "off" });
			expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
				sessionName: { thinkingLevel: "low" },
				toolRecovery: { enabled: true, thinkingLevel: "off" },
			});
		} finally {
			await rm(agentDir, { recursive: true, force: true });
		}
	});
});
