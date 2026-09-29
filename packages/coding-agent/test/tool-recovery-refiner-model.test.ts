import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import { loadToolRecoveryConfig } from "../src/core/tool-recovery/config.ts";
import { createModelBackedToolRecoveryRefiner } from "../src/core/tool-recovery/refiner.ts";

describe("tool recovery refiner model", () => {
	it("reads the selected model and follows the current model when unset", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "lystar-tool-recovery-model-"));
		try {
			expect(loadToolRecoveryConfig(agentDir)).toEqual({ thinkingLevel: "low" });
			writeFileSync(join(agentDir, "lystar.json"), JSON.stringify({ toolRecovery: { model: "custom/gpt-6-sol" } }));
			expect(loadToolRecoveryConfig(agentDir)).toEqual({ model: "custom/gpt-6-sol", thinkingLevel: "low" });
			writeFileSync(
				join(agentDir, "lystar.json"),
				JSON.stringify({ toolRecovery: { model: "custom/gpt-6-sol", thinkingLevel: "high" } }),
			);
			expect(loadToolRecoveryConfig(agentDir)).toEqual({ model: "custom/gpt-6-sol", thinkingLevel: "high" });
		} finally {
			rmSync(agentDir, { recursive: true, force: true });
		}
	});

	it("passes a supported reasoning level rather than sending off to a reasoning model", async () => {
		const model = getModel("openai", "gpt-6-sol");
		expect(model).toBeDefined();
		let options: SimpleStreamOptions | undefined;
		let thinkingLevel: "low" | "high" = "low";
		const refiner = createModelBackedToolRecoveryRefiner({
			getRequestModel: () => ({ model, thinkingLevel }),
			complete: async (_model, _context, requestOptions) => {
				options = requestOptions;
				return { content: [{ type: "text", text: '{"type":"none"}' }] } as AssistantMessage;
			},
		});
		const input = { scopeHash: "scope", failures: [], relatedLessons: [], userCorrections: [] };
		await refiner(input);
		expect(options?.reasoning).toBe("low");
		thinkingLevel = "high";
		await refiner(input);
		expect(options?.reasoning).toBe("high");
	});
});
