import type { Component } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../src/core/session-manager.ts";
import type { TranscriptPage, TranscriptSource } from "../src/modes/interactive/session-transcript-source.ts";
import { SessionOpenCoordinator, type SessionOpenCoordinatorOptions } from "../src/session-open-coordinator.ts";

class FakeRenderer {
	readonly children: Component[] = [];
	startCalls = 0;
	stopCalls = 0;
	requestRenderCalls = 0;
	clearOnShrink = false;

	addChild(component: Component): void {
		this.children.push(component);
	}

	requestRender(): void {
		this.requestRenderCalls++;
	}

	start(): void {
		this.startCalls++;
	}

	stop(): void {
		this.stopCalls++;
	}

	setClearOnShrink(enabled: boolean): void {
		this.clearOnShrink = enabled;
	}
}

function createMessage(id: string, role: "user" | "assistant", content: string): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: "2025-01-01T00:00:00Z",
		message:
			role === "user"
				? { role, content, timestamp: 1 }
				: {
						role,
						content: [{ type: "text", text: content }],
						api: "openai-responses",
						provider: "openai",
						model: "test",
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						stopReason: "stop",
						timestamp: 1,
					},
	};
}

function createOptions(renderer: FakeRenderer, transcriptSource: TranscriptSource): SessionOpenCoordinatorOptions {
	return {
		sessionFile: "/tmp/session.jsonl",
		tuiMode: "fullscreen",
		showHardwareCursor: false,
		clearOnShrink: true,
		mouse: false,
		transcriptSource,
		createRenderer: () => renderer,
	};
}

describe("SessionOpenCoordinator", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("starts the shell before the tail is ready, then renders the tail preview", async () => {
		const renderer = new FakeRenderer();
		const page: TranscriptPage = { entries: [createMessage("u1", "user", "继续这个任务")], hasMore: false };
		const transcriptSource: TranscriptSource = {
			readTail: vi.fn(async () => page),
			readPrevious: vi.fn(),
			reset: vi.fn(),
		};

		const coordinator = SessionOpenCoordinator.start(createOptions(renderer, transcriptSource));

		expect(renderer.startCalls).toBe(1);
		expect(renderer.clearOnShrink).toBe(true);
		expect(renderer.children[0]?.render(80).join("\n")).toContain("正在读取最近记录");
		await vi.waitFor(() => expect(renderer.requestRenderCalls).toBe(1));
		expect(transcriptSource.readTail).toHaveBeenCalledWith({ leafId: null, limit: 20 });
		expect(renderer.children[1]?.render(80).join("\n")).toContain("你：继续这个任务");

		coordinator.stop();
		expect(renderer.stopCalls).toBe(1);
	});

	it("stops once and ignores a tail that resolves after cancellation", async () => {
		const renderer = new FakeRenderer();
		let resolvePage: ((page: TranscriptPage) => void) | undefined;
		const transcriptSource: TranscriptSource = {
			readTail: vi.fn(
				() =>
					new Promise<TranscriptPage>((resolve) => {
						resolvePage = resolve;
					}),
			),
			readPrevious: vi.fn(),
			reset: vi.fn(),
		};
		const coordinator = SessionOpenCoordinator.start(createOptions(renderer, transcriptSource));

		await vi.waitFor(() => expect(resolvePage).toBeDefined());
		coordinator.stop();
		coordinator.stop();
		resolvePage?.({ entries: [createMessage("a1", "assistant", "完成")], hasMore: false });
		await Promise.resolve();

		expect(renderer.stopCalls).toBe(1);
		expect(renderer.requestRenderCalls).toBe(0);
	});
});
