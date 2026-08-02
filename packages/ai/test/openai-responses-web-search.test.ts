import type {
	ResponseCreateParamsStreaming,
	ResponseFunctionWebSearch,
	ResponseOutputMessage,
	ResponseStreamEvent,
} from "openai/resources/responses/responses.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stream as streamOpenAIResponses } from "../src/api/openai-responses.ts";
import { processResponsesStream } from "../src/api/openai-responses-shared.ts";
import type { AssistantMessage, Model } from "../src/types.ts";
import { AssistantMessageEventStream } from "../src/utils/event-stream.ts";

function createModel(supportsWebSearch: boolean): Model<"openai-responses"> {
	return {
		id: "gpt-5.6-luna",
		name: "GPT-5.6 Luna",
		api: "openai-responses",
		provider: "upstream",
		baseUrl: "https://example.com/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 272000,
		maxTokens: 16384,
		compat: { supportsWebSearch },
	};
}

function createOutput(model: Model<"openai-responses">): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "pending",
		timestamp: 0,
	};
}

async function capturePayload(model: Model<"openai-responses">): Promise<ResponseCreateParamsStreaming> {
	let payload: ResponseCreateParamsStreaming | undefined;
	vi.spyOn(globalThis, "fetch").mockResolvedValue(
		new Response("data: [DONE]\n\n", {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		}),
	);

	const response = streamOpenAIResponses(
		model,
		{
			messages: [{ role: "user", content: "Search the web", timestamp: 0 }],
			tools: [],
		},
		{
			apiKey: "test",
			reasoningEffort: "low",
			onPayload: (value) => {
				payload = value as ResponseCreateParamsStreaming;
			},
		},
	);
	for await (const event of response) {
		if (event.type === "done" || event.type === "error") break;
	}
	if (!payload) throw new Error("Expected an OpenAI Responses payload");
	return payload;
}

async function* createWebSearchEvents(): AsyncIterable<ResponseStreamEvent> {
	const webSearchCall: ResponseFunctionWebSearch = {
		type: "web_search_call",
		id: "ws_1",
		status: "completed",
		action: {
			type: "search",
			query: "OpenAI web search",
			queries: ["OpenAI web search"],
			sources: [
				{ type: "url", url: "https://developers.openai.com/api/docs/guides/tools-web-search" },
				{ type: "url", url: "https://platform.openai.com/docs/api-reference/responses" },
			],
		},
	};
	const message: ResponseOutputMessage = {
		type: "message",
		id: "msg_1",
		role: "assistant",
		status: "completed",
		content: [
			{
				type: "output_text",
				text: "Use the web_search tool.",
				annotations: [
					{
						type: "url_citation",
						start_index: 8,
						end_index: 18,
						title: "OpenAI Web Search",
						url: "https://developers.openai.com/api/docs/guides/tools-web-search",
					},
				],
			},
		],
	};
	const terminalMessage: ResponseOutputMessage = {
		...message,
		content: [{ type: "output_text", text: "Use the web_search tool.", annotations: [] }],
	};

	yield {
		type: "response.output_item.added",
		sequence_number: 0,
		output_index: 0,
		item: webSearchCall,
	};
	yield {
		type: "response.output_item.done",
		sequence_number: 1,
		output_index: 0,
		item: webSearchCall,
	};
	yield {
		type: "response.output_item.added",
		sequence_number: 2,
		output_index: 1,
		item: message,
	};
	yield {
		type: "response.output_item.done",
		sequence_number: 3,
		output_index: 1,
		item: message,
	};
	yield {
		type: "response.completed",
		sequence_number: 4,
		response: {
			id: "resp_1",
			status: "completed",
			output: [webSearchCall, terminalMessage],
		},
	} as unknown as ResponseStreamEvent;
}

describe("OpenAI Responses hosted web search", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("only exposes hosted web search when the model opts in", async () => {
		const enabled = await capturePayload(createModel(true));
		expect(enabled.tools).toContainEqual({ type: "web_search" });
		expect(enabled.include).toEqual(
			expect.arrayContaining(["reasoning.encrypted_content", "web_search_call.action.sources"]),
		);

		vi.restoreAllMocks();
		const disabled = await capturePayload(createModel(false));
		expect(disabled.tools).toBeUndefined();
		expect(disabled.include).not.toContain("web_search_call.action.sources");
	});

	it("returns deduplicated web search sources through normal text events", async () => {
		const model = createModel(true);
		const output = createOutput(model);
		const stream = new AssistantMessageEventStream();
		const push = vi.spyOn(stream, "push");

		await processResponsesStream(createWebSearchEvents(), output, stream, model);

		expect(output.stopReason).toBe("stop");
		expect(output.content).toEqual([
			expect.objectContaining({ type: "text", text: "Use the web_search tool." }),
			{
				type: "text",
				text: [
					"Sources:",
					"- OpenAI Web Search: <https://developers.openai.com/api/docs/guides/tools-web-search>",
					"- platform.openai.com: <https://platform.openai.com/docs/api-reference/responses>",
				].join("\n"),
			},
		]);
		expect(push).toHaveBeenCalledWith(
			expect.objectContaining({ type: "text_end", content: expect.stringContaining("OpenAI Web Search") }),
		);
	});
});
