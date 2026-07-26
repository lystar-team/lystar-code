import { describe, expect, it } from "vitest";
import { buildBaseOptions } from "../src/api/simple-options.ts";
import type { AssistantMessage, Context, Model, Usage } from "../src/types.ts";
import { estimateContextTokens, estimateContextTokensUpperBound } from "../src/utils/estimate.ts";

function createUsage(totalTokens: number): Usage {
	return {
		input: totalTokens,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function createAssistant(timestamp: number, totalTokens: number): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "kept" }],
		api: "openai-responses",
		provider: "openai",
		model: "test-model",
		usage: createUsage(totalTokens),
		stopReason: "stop",
		timestamp,
	};
}

const model: Model<"openai-responses"> = {
	id: "test-model",
	name: "Test Model",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://api.openai.com/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 10_000,
	maxTokens: 8_000,
};

describe("context token estimation", () => {
	it("ignores stale assistant usage after a newer message is inserted before it", () => {
		const context: Context = {
			systemPrompt: "system",
			messages: [
				{ role: "user", content: "summary", timestamp: 200 },
				createAssistant(100, 9_500),
				{ role: "user", content: "x".repeat(4_000), timestamp: 300 },
			],
		};

		expect(estimateContextTokens(context)).toEqual({
			tokens: 1_005,
			usageTokens: 0,
			trailingTokens: 1_005,
			lastUsageIndex: null,
		});
		expect(buildBaseOptions(model, context).maxTokens).toBe(4_899);
	});

	it("uses assistant usage again after a response to the inserted context", () => {
		const context: Context = {
			messages: [
				{ role: "user", content: "summary", timestamp: 200 },
				createAssistant(100, 9_500),
				{ role: "user", content: "new prompt", timestamp: 300 },
				createAssistant(400, 2_000),
				{ role: "user", content: "tail", timestamp: 500 },
			],
		};

		expect(estimateContextTokens(context)).toEqual({
			tokens: 2_001,
			usageTokens: 2_000,
			trailingTokens: 1,
			lastUsageIndex: 3,
		});
	});

	it("estimates unseen UTF-8 content without counting every byte as a token", () => {
		const context: Context = {
			messages: [
				{ role: "user", content: "old", timestamp: 100 },
				createAssistant(200, 2_000),
				{ role: "user", content: "你".repeat(100), timestamp: 300 },
			],
		};

		expect(estimateContextTokensUpperBound(context)).toEqual({
			tokens: 2_100,
			usageTokens: 2_000,
			trailingTokens: 100,
			lastUsageIndex: 1,
		});
	});

	it("keeps a 215K provider anchor plus Chinese additions below a 272K window", () => {
		const context: Context = {
			systemPrompt: "系统提示".repeat(2_000),
			messages: [
				createAssistant(100, 215_000),
				{ role: "user", content: "新增中文内容".repeat(5_000), timestamp: 200 },
			],
			tools: [{ name: "read", description: "读取文件", parameters: { type: "object" } }],
		};

		const estimate = estimateContextTokensUpperBound(context);

		expect(estimate.usageTokens).toBe(215_000);
		expect(estimate.tokens).toBeLessThan(272_000);
		expect(estimate.tokens).toBeGreaterThan(240_000);
	});

	it("includes the system prompt and tool schema when no provider usage exists", () => {
		const context: Context = {
			systemPrompt: "系统",
			messages: [{ role: "user", content: "hello", timestamp: 100 }],
			tools: [{ name: "read", description: "读取", parameters: { type: "object" } }],
		};

		const estimate = estimateContextTokensUpperBound(context);
		expect(estimate.tokens).toBeGreaterThanOrEqual(11);
		expect(estimate.usageTokens).toBe(0);
		expect(estimate.lastUsageIndex).toBeNull();
	});
});
