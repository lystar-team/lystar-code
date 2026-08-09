import type {
	ResponseCreateParamsStreaming,
	ResponseFunctionWebSearch,
	ResponseOutputMessage,
	ResponseStreamEvent,
} from "openai/resources/responses/responses.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type OpenAIResponsesOptions, stream as streamOpenAIResponses } from "../src/api/openai-responses.ts";
import { convertResponsesMessages, processResponsesStream } from "../src/api/openai-responses-shared.ts";
import type { AssistantMessage, Model } from "../src/types.ts";
import { AssistantMessageEventStream } from "../src/utils/event-stream.ts";

function createModel(supportsWebSearch: boolean): Model<"openai-responses"> {
	return {
		id: "gpt-5.6-sol",
		name: "GPT-5.6 Sol",
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

async function capturePayload(
	model: Model<"openai-responses">,
	options: Partial<OpenAIResponsesOptions> = {},
): Promise<ResponseCreateParamsStreaming> {
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
			...options,
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
		item: { type: "web_search_call", id: "ws_1", status: "in_progress" } as ResponseFunctionWebSearch,
	};
	yield {
		type: "response.web_search_call.in_progress",
		sequence_number: 1,
		output_index: 0,
		item_id: "ws_1",
	};
	yield {
		type: "response.web_search_call.searching",
		sequence_number: 2,
		output_index: 0,
		item_id: "ws_1",
	};
	yield {
		type: "response.web_search_call.completed",
		sequence_number: 3,
		output_index: 0,
		item_id: "ws_1",
	};
	yield {
		type: "response.output_item.done",
		sequence_number: 4,
		output_index: 0,
		item: webSearchCall,
	};
	yield {
		type: "response.output_item.added",
		sequence_number: 5,
		output_index: 1,
		item: message,
	};
	yield {
		type: "response.output_item.done",
		sequence_number: 6,
		output_index: 1,
		item: message,
	};
	yield {
		type: "response.completed",
		sequence_number: 7,
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

	it("only exposes hosted web search on the current opted-in model", async () => {
		const enabled = await capturePayload(createModel(true));
		expect(enabled.model).toBe("gpt-5.6-sol");
		expect(enabled.tools).toContainEqual({ type: "web_search" });
		expect(enabled.include).toEqual(
			expect.arrayContaining(["reasoning.encrypted_content", "web_search_call.action.sources"]),
		);

		vi.restoreAllMocks();
		const disabled = await capturePayload(createModel(false));
		expect(disabled.tools).toBeUndefined();
		expect(disabled.include).not.toContain("web_search_call.action.sources");
		expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledTimes(1);
	});

	it("supports request-level search controls without allowing sampling overrides to remove the tool", async () => {
		const payload = await capturePayload(createModel(true), {
			webSearch: {
				searchContextSize: "high",
				allowedDomains: ["OpenAI.com", "https://invalid.example", "openai.com"],
				userLocation: { country: "US", timezone: "America/New_York" },
			},
			samplingParams: { tools: [] },
		});

		expect(payload.tools).toContainEqual({
			type: "web_search",
			search_context_size: "high",
			filters: { allowed_domains: ["openai.com"] },
			user_location: {
				type: "approximate",
				city: undefined,
				region: undefined,
				country: "US",
				timezone: "America/New_York",
			},
		});

		vi.restoreAllMocks();
		const disabledForRequest = await capturePayload(createModel(true), { webSearch: false });
		expect(disabledForRequest.tools).toBeUndefined();
	});

	it("keeps web search calls, stream status, citations, and sources structured", async () => {
		const model = createModel(true);
		const output = createOutput(model);
		const stream = new AssistantMessageEventStream();
		const push = vi.spyOn(stream, "push");

		await processResponsesStream(createWebSearchEvents(), output, stream, model);

		expect(output.stopReason).toBe("stop");
		expect(output.content).toEqual([
			{
				type: "webSearchCall",
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
			},
			expect.objectContaining({
				type: "text",
				text: "Use the web_search tool.",
				annotations: [
					{
						type: "url_citation",
						startIndex: 8,
						endIndex: 18,
						title: "OpenAI Web Search",
						url: "https://developers.openai.com/api/docs/guides/tools-web-search",
					},
				],
			}),
		]);
		expect(push.mock.calls.map(([event]) => event.type)).toEqual(
			expect.arrayContaining(["websearch_start", "websearch_update", "websearch_end", "text_start", "text_end"]),
		);
		expect(output.content.some((content) => content.type === "text" && content.text.startsWith("Sources:"))).toBe(
			false,
		);
	});

	it("ends an in-flight web search as failed when the provider stream fails", async () => {
		const model = createModel(true);
		const output = createOutput(model);
		const stream = new AssistantMessageEventStream();
		const push = vi.spyOn(stream, "push");
		const webSearchCall: ResponseFunctionWebSearch = {
			type: "web_search_call",
			id: "ws_failed",
			status: "in_progress",
			action: { type: "search", query: "breaking news", queries: ["breaking news"], sources: [] },
		};
		async function* events(): AsyncIterable<ResponseStreamEvent> {
			yield { type: "response.output_item.added", sequence_number: 0, output_index: 0, item: webSearchCall };
			yield {
				type: "error",
				sequence_number: 1,
				code: "search_failed",
				message: "Search unavailable",
				param: null,
			} as ResponseStreamEvent;
		}

		await expect(processResponsesStream(events(), output, stream, model)).rejects.toThrow("Search unavailable");
		expect(output.content).toContainEqual(expect.objectContaining({ id: "ws_failed", status: "failed" }));
		expect(push.mock.calls.map(([event]) => event.type)).toEqual(
			expect.arrayContaining(["websearch_start", "websearch_end"]),
		);
	});

	it("replays same-model web search calls and URL citations", async () => {
		const model = createModel(true);
		const assistant = createOutput(model);
		assistant.stopReason = "stop";
		assistant.content = [
			{
				type: "webSearchCall",
				id: "ws_1",
				status: "completed",
				action: {
					type: "search",
					query: "OpenAI web search",
					sources: [{ type: "url", url: "https://developers.openai.com/api/docs/guides/tools-web-search" }],
				},
			},
			{
				type: "text",
				text: "Use the web_search tool.",
				textSignature: "msg_1",
				annotations: [
					{
						type: "url_citation",
						startIndex: 8,
						endIndex: 18,
						title: "OpenAI Web Search",
						url: "https://developers.openai.com/api/docs/guides/tools-web-search",
					},
				],
			},
		];

		const input = convertResponsesMessages(model, { messages: [assistant] }, new Set(["upstream"]));
		expect(input).toContainEqual(expect.objectContaining({ type: "web_search_call", id: "ws_1" }));
		expect(input).toContainEqual(
			expect.objectContaining({
				type: "message",
				content: [
					expect.objectContaining({
						type: "output_text",
						annotations: [expect.objectContaining({ type: "url_citation", start_index: 8, end_index: 18 })],
					}),
				],
			}),
		);

		const otherModel = { ...model, id: "gpt-5.6-other" };
		const crossModelInput = convertResponsesMessages(otherModel, { messages: [assistant] }, new Set(["upstream"]));
		expect(crossModelInput.some((item) => typeof item === "object" && item.type === "web_search_call")).toBe(false);
	});
});
