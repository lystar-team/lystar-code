import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "../src/core/extensions/index.ts";
import { createSessionNameExtension } from "../src/extensions/session-name/index.ts";

type Handler = (event: unknown, ctx: ExtensionContext) => Promise<void> | void;

type TestState = {
	sessionId: string;
	sessionFile?: string;
	name?: string;
	entries: Array<{ type: "message"; message: { role: "user" | "assistant"; content: string } }>;
};

const activeModel = {
	provider: "upstream",
	api: "openai-responses",
	id: "gpt-5.6-luna",
	name: "GPT 5.6 Luna",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 32_000,
	maxTokens: 4_096,
} as Model<Api>;

function assistantResponse(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: activeModel.api,
		provider: activeModel.provider,
		model: activeModel.id,
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function createExtensionTest(agentDir?: string) {
	const state: TestState = {
		sessionId: "session-1",
		sessionFile: "/tmp/session-1.jsonl",
		entries: [],
	};
	const handlers = new Map<string, Handler>();
	const setSessionName = vi.fn((name: string) => {
		state.name = name;
	});

	const pi = {
		on(event: string, handler: Handler) {
			handlers.set(event, handler);
		},
		setSessionName,
	} as unknown as ExtensionAPI;
	createSessionNameExtension(agentDir)(pi);

	const modelRegistry = {
		find: vi.fn((provider: string, modelId: string) =>
			provider === activeModel.provider && modelId === activeModel.id ? activeModel : undefined,
		),
		getApiKeyAndHeaders: vi.fn(async () => ({ ok: true as const, apiKey: "test-key" })),
		complete: vi.fn(async () => assistantResponse("默认标题")),
	};
	const context = {
		model: activeModel,
		modelRegistry,
		sessionManager: {
			getSessionId: () => state.sessionId,
			getSessionFile: () => state.sessionFile,
			getSessionName: () => state.name,
			getEntries: () => state.entries,
			getBranch: () => state.entries,
		},
	} as unknown as ExtensionContext;

	return { state, handlers, context, modelRegistry, setSessionName };
}

async function emit(
	handlers: Map<string, Handler>,
	event: string,
	payload: unknown,
	context: ExtensionContext,
): Promise<void> {
	await handlers.get(event)?.(payload, context);
}

async function flushAsyncWork(): Promise<void> {
	await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe("session name extension", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const tempDir of tempDirs.splice(0)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("uses the configured model and low reasoning to name a new session", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "pi-session-name-"));
		tempDirs.push(agentDir);
		writeFileSync(join(agentDir, "lystar.json"), JSON.stringify({ sessionName: { model: "upstream/gpt-5.6-luna" } }));

		const test = createExtensionTest(agentDir);
		await emit(test.handlers, "session_start", { type: "session_start", reason: "startup" }, test.context);
		test.state.entries.push({ type: "message", message: { role: "user", content: "修复会话自动命名" } });
		await emit(test.handlers, "agent_settled", { type: "agent_settled" }, test.context);
		await flushAsyncWork();

		expect(test.modelRegistry.find).toHaveBeenCalledWith("upstream", "gpt-5.6-luna");
		expect(test.modelRegistry.complete).toHaveBeenCalledWith(
			activeModel,
			expect.objectContaining({
				messages: [expect.objectContaining({ content: [{ type: "text", text: "修复会话自动命名" }] })],
			}),
			expect.objectContaining({ reasoning: "low", maxTokens: 64, sessionId: "session-1" }),
		);
		expect(test.setSessionName).toHaveBeenCalledWith("默认标题");
	});

	it("does not let a failed naming request affect the session", async () => {
		const test = createExtensionTest();
		test.modelRegistry.complete.mockRejectedValueOnce(new Error("provider unavailable"));
		await emit(test.handlers, "session_start", { type: "session_start", reason: "startup" }, test.context);
		test.state.entries.push({ type: "message", message: { role: "user", content: "保留会话" } });
		await emit(test.handlers, "agent_settled", { type: "agent_settled" }, test.context);
		await flushAsyncWork();

		expect(test.setSessionName).not.toHaveBeenCalled();
	});

	it("skips resumed, forked, in-memory, named, and existing sessions", async () => {
		const cases: Array<{
			reason: "startup" | "resume" | "fork";
			sessionFile?: string;
			name?: string;
			withMessage?: boolean;
		}> = [
			{ reason: "resume" },
			{ reason: "fork" },
			{ reason: "startup", sessionFile: undefined },
			{ reason: "startup", name: "手动名称" },
			{ reason: "startup", withMessage: true },
		];

		for (const testCase of cases) {
			const test = createExtensionTest();
			test.state.sessionFile = testCase.sessionFile ?? test.state.sessionFile;
			test.state.name = testCase.name;
			if (testCase.withMessage) {
				test.state.entries.push({ type: "message", message: { role: "user", content: "已有历史" } });
			}
			await emit(test.handlers, "session_start", { type: "session_start", reason: testCase.reason }, test.context);
			await emit(test.handlers, "agent_settled", { type: "agent_settled" }, test.context);
			await flushAsyncWork();
			expect(test.modelRegistry.complete).not.toHaveBeenCalled();
		}
	});

	it("does not overwrite a name changed while the request is pending", async () => {
		const test = createExtensionTest();
		let resolveComplete: ((response: AssistantMessage) => void) | undefined;
		test.modelRegistry.complete.mockImplementationOnce(
			() =>
				new Promise<AssistantMessage>((resolve) => {
					resolveComplete = resolve;
				}),
		);
		await emit(test.handlers, "session_start", { type: "session_start", reason: "startup" }, test.context);
		test.state.entries.push({ type: "message", message: { role: "user", content: "不要覆盖手动名称" } });
		await emit(test.handlers, "agent_settled", { type: "agent_settled" }, test.context);
		await emit(
			test.handlers,
			"session_info_changed",
			{ type: "session_info_changed", name: undefined },
			test.context,
		);
		resolveComplete?.(assistantResponse("自动标题"));
		await flushAsyncWork();

		expect(test.setSessionName).not.toHaveBeenCalled();
	});
});
