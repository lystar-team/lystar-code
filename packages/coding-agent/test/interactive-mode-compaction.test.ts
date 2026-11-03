import type { Usage } from "@earendil-works/pi-ai";
import { Container, Spacer } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, test, vi } from "vitest";
import type { CompactionSummaryMessage } from "../src/core/messages.ts";
import { type CompactionEntry, type SessionEntry, sessionEntryToContextMessages } from "../src/core/session-manager.ts";
import { CompactionSummaryMessageComponent } from "../src/modes/interactive/components/compaction-summary-message.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

describe("InteractiveMode compaction events", () => {
	beforeAll(() => initTheme("dark"));

	test("uses the cache miss notice setting for compaction and branch summary costs", () => {
		const usage: Usage = {
			input: 10,
			output: 20,
			cacheRead: 30,
			cacheWrite: 40,
			totalTokens: 100,
			cost: { input: 0.01, output: 0.02, cacheRead: 0.03, cacheWrite: 0.065, total: 0.125 },
		};
		const addCompactionCostNotice = Reflect.get(InteractiveMode.prototype, "addCompactionCostNotice") as (
			this: { chatContainer: Container; settingsManager: { getShowCacheMissNotices(): boolean } },
			notice: {
				type: "compaction_cost";
				kind: "compaction" | "branch_summary";
				usage: Usage;
			},
		) => void;

		initTheme("dark");
		const enabled = {
			chatContainer: new Container(),
			settingsManager: { getShowCacheMissNotices: () => true },
		};
		addCompactionCostNotice.call(enabled, { type: "compaction_cost", kind: "compaction", usage });
		addCompactionCostNotice.call(enabled, {
			type: "compaction_cost",
			kind: "branch_summary",
			usage,
		});
		const output = stripAnsi(enabled.chatContainer.render(120).join("\n"));
		expect(output).toContain("Compaction: 100 tokens billed (~$0.13)");
		expect(output).toContain("Branch summary: 100 tokens billed (~$0.13)");

		const disabled = {
			chatContainer: new Container(),
			settingsManager: { getShowCacheMissNotices: () => false },
		};
		addCompactionCostNotice.call(disabled, { type: "compaction_cost", kind: "compaction", usage });
		expect(disabled.chatContainer.children).toHaveLength(0);
	});

	test("renders each compaction cost after its summary", () => {
		const currentUsage: Usage = {
			input: 10,
			output: 20,
			cacheRead: 30,
			cacheWrite: 40,
			totalTokens: 100,
			cost: { input: 0.01, output: 0.02, cacheRead: 0.03, cacheWrite: 0.04, total: 0.1 },
		};
		const previousUsage: Usage = {
			input: 1,
			output: 2,
			cacheRead: 3,
			cacheWrite: 4,
			totalTokens: 10,
			cost: { input: 0.001, output: 0.002, cacheRead: 0.003, cacheWrite: 0.004, total: 0.01 },
		};
		const entries: SessionEntry[] = [
			{
				type: "compaction",
				id: "current",
				parentId: "previous",
				timestamp: "2025-01-02T00:00:00Z",
				summary: "current summary",
				firstKeptEntryId: "kept",
				tokensBefore: 200,
				usage: currentUsage,
			},
			{
				type: "compaction",
				id: "previous",
				parentId: null,
				timestamp: "2025-01-01T00:00:00Z",
				summary: "previous summary",
				firstKeptEntryId: "kept",
				tokensBefore: 100,
				usage: previousUsage,
			},
		];
		const fakeThis = { renderSessionItems: vi.fn() };
		const renderSessionEntries = Reflect.get(InteractiveMode.prototype, "renderSessionEntries") as (
			this: typeof fakeThis,
			entries: SessionEntry[],
		) => void;

		renderSessionEntries.call(fakeThis, entries);

		expect(fakeThis.renderSessionItems).toHaveBeenCalledWith(
			[
				expect.objectContaining({ role: "compactionSummary", summary: "current summary" }),
				{ type: "compaction_cost", kind: "compaction", usage: currentUsage },
				expect.objectContaining({ role: "compactionSummary", summary: "previous summary" }),
				{ type: "compaction_cost", kind: "compaction", usage: previousUsage },
			],
			{},
			expect.any(Function),
			expect.any(Map),
		);
		const [items, , , messageMeta] = fakeThis.renderSessionItems.mock.calls[0] as [
			unknown[],
			unknown,
			unknown,
			Map<unknown, { id: string; timestamp: string }>,
		];
		expect(messageMeta.get(items[0])).toEqual({ id: "current", timestamp: "2025-01-02T00:00:00Z" });
		expect(messageMeta.get(items[2])).toEqual({ id: "previous", timestamp: "2025-01-01T00:00:00Z" });
	});

	test.each(["threshold"] as const)(
		"rebuilds consecutive %s compactions once per persisted session entry",
		async (reason) => {
			const chatContainer = new Container();
			const persistedMessages: CompactionSummaryMessage[] = [];
			const rebuildChatFromMessages = vi.fn(() => {
				chatContainer.clear();
				for (const message of persistedMessages) {
					chatContainer.addChild(new Spacer(1));
					chatContainer.addChild(new CompactionSummaryMessageComponent(message));
				}
			});
			const addMessageToChat = vi.fn((message: CompactionSummaryMessage) => {
				chatContainer.addChild(new Spacer(1));
				chatContainer.addChild(new CompactionSummaryMessageComponent(message));
			});
			const fakeThis = {
				isInitialized: true,
				footer: { invalidate: vi.fn() },
				programStatus: { handleEvent: vi.fn() },
				autoCompactionEscapeHandler: undefined as (() => void) | undefined,
				autoCompactionLoader: undefined,
				defaultEditor: {},
				statusContainer: { clear: vi.fn() },
				chatContainer,
				rebuildChatFromMessages,
				addMessageToChat,
				showError: vi.fn(),
				showStatus: vi.fn(),
				clearStatusIndicator: vi.fn(),
				flushCompactionQueue: vi.fn().mockResolvedValue(undefined),
				settingsManager: { getShowTerminalProgress: () => false },
				ui: { requestRender: vi.fn(), terminal: { setProgress: vi.fn() } },
			};

			const handleEvent = Reflect.get(InteractiveMode.prototype, "handleEvent") as (
				this: typeof fakeThis,
				event: {
					type: "compaction_end";
					reason: "manual" | "threshold" | "overflow";
					result: { tokensBefore: number; summary: string } | undefined;
					aborted: boolean;
					willRetry: boolean;
					errorMessage?: string;
				},
			) => Promise<void>;

			for (let index = 1; index <= 2; index++) {
				const entry: CompactionEntry = {
					type: "compaction",
					id: `compaction-${reason}-${index}`,
					parentId: `message-${index}`,
					timestamp: "2026-08-10T00:00:00.000Z",
					summary: `summary-${index}`,
					firstKeptEntryId: `message-${index}`,
					tokensBefore: 123,
				};
				const persistedMessage = sessionEntryToContextMessages(entry)[0];
				if (!persistedMessage || persistedMessage.role !== "compactionSummary") {
					throw new Error("Expected persisted compaction summary message");
				}
				persistedMessages.push(persistedMessage);

				await handleEvent.call(fakeThis, {
					type: "compaction_end",
					reason,
					result: {
						tokensBefore: 123,
						summary: `summary-${index}`,
					},
					aborted: false,
					willRetry: false,
				});

				expect(rebuildChatFromMessages).toHaveBeenCalledTimes(index);
				expect(
					chatContainer.children.filter((child) => child instanceof CompactionSummaryMessageComponent),
				).toHaveLength(index);
			}

			expect(addMessageToChat).not.toHaveBeenCalled();
			expect(fakeThis.flushCompactionQueue).toHaveBeenCalledTimes(2);
			expect(fakeThis.flushCompactionQueue).toHaveBeenLastCalledWith({ willRetry: false });
			expect(fakeThis.ui.requestRender).toHaveBeenCalledWith(true);
		},
	);

	test("renders retained entries before the latest compaction cost", () => {
		const previousUsage: Usage = {
			input: 1,
			output: 2,
			cacheRead: 3,
			cacheWrite: 4,
			totalTokens: 10,
			cost: { input: 0.001, output: 0.002, cacheRead: 0.003, cacheWrite: 0.004, total: 0.01 },
		};
		const latestUsage: Usage = {
			input: 10,
			output: 20,
			cacheRead: 30,
			cacheWrite: 40,
			totalTokens: 100,
			cost: { input: 0.01, output: 0.02, cacheRead: 0.03, cacheWrite: 0.04, total: 0.1 },
		};
		const entries: SessionEntry[] = [
			{
				type: "compaction",
				id: "previous",
				parentId: null,
				timestamp: "2025-01-01T00:00:00Z",
				summary: "previous summary",
				firstKeptEntryId: "kept",
				tokensBefore: 100,
				usage: previousUsage,
			},
			{
				type: "compaction",
				id: "latest",
				parentId: "previous",
				timestamp: "2025-01-02T00:00:00Z",
				summary: "latest summary",
				firstKeptEntryId: "kept",
				tokensBefore: 200,
				usage: latestUsage,
			},
		];
		const fakeThis = { renderer: undefined, renderSessionItems: vi.fn() };
		const renderSessionEntries = Reflect.get(InteractiveMode.prototype, "renderSessionEntries") as (
			this: typeof fakeThis,
			entries: SessionEntry[],
		) => void;

		renderSessionEntries.call(fakeThis, entries);

		const items = fakeThis.renderSessionItems.mock.calls[0]?.[0] as unknown[];
		expect(items).toEqual([
			expect.objectContaining({ role: "compactionSummary", summary: "previous summary" }),
			{ type: "compaction_cost", kind: "compaction", usage: previousUsage },
			expect.objectContaining({ role: "compactionSummary", summary: "latest summary" }),
			{ type: "compaction_cost", kind: "compaction", usage: latestUsage },
		]);
	});

	test("restores the working indicator when compaction continues the agent run", async () => {
		const setProgress = vi.fn();
		const setWorkingVisible = vi.fn();
		const rebuildChatFromMessages = vi.fn();
		const addMessageToChat = vi.fn();
		const fakeThis = {
			isInitialized: true,
			footer: { invalidate: vi.fn() },
			programStatus: { handleEvent: vi.fn() },
			autoCompactionEscapeHandler: undefined as (() => void) | undefined,
			defaultEditor: {},
			workingVisible: true,
			rebuildChatFromMessages,
			addMessageToChat,
			clearStatusIndicator: vi.fn(),
			setWorkingVisible,
			flushCompactionQueue: vi.fn().mockResolvedValue(undefined),
			settingsManager: { getShowTerminalProgress: () => true },
			ui: { requestRender: vi.fn(), terminal: { setProgress } },
		};

		const handleEvent = Reflect.get(InteractiveMode.prototype, "handleEvent") as (
			this: typeof fakeThis,
			event: {
				type: "compaction_end";
				reason: "threshold" | "overflow";
				result: undefined;
				aborted: false;
				willRetry: true;
				errorMessage?: string;
			},
		) => Promise<void>;

		await handleEvent.call(fakeThis, {
			type: "compaction_end",
			reason: "overflow",
			result: undefined,
			aborted: false,
			willRetry: true,
		});

		expect(fakeThis.clearStatusIndicator).toHaveBeenCalledWith("compaction");
		expect(setWorkingVisible).toHaveBeenCalledWith(true);
		expect(setProgress).not.toHaveBeenCalledWith(false);
		expect(rebuildChatFromMessages).not.toHaveBeenCalled();
		expect(addMessageToChat).not.toHaveBeenCalled();
		expect(fakeThis.flushCompactionQueue).toHaveBeenCalledWith({ willRetry: true });
		expect(fakeThis.ui.requestRender).toHaveBeenCalledWith(true);
	});

	test("updates the working state when the same agent run resumes after compaction", async () => {
		const fakeThis = {
			isInitialized: true,
			footer: { invalidate: vi.fn() },
			programStatus: { handleEvent: vi.fn() },
			activeStatusIndicator: undefined,
			workingVisible: true,
			showWorkingStatusIndicator: vi.fn(),
			clearStatusIndicator: vi.fn(),
			settingsManager: { getShowTerminalProgress: () => true },
			ui: { requestRender: vi.fn(), terminal: { setProgress: vi.fn() } },
		};
		const handleEvent = Reflect.get(InteractiveMode.prototype, "handleEvent") as (
			this: typeof fakeThis,
			event: { type: "turn_start" },
		) => Promise<void>;

		await handleEvent.call(fakeThis, { type: "turn_start" });

		expect(fakeThis.ui.terminal.setProgress).toHaveBeenCalledWith(true);
		expect(fakeThis.showWorkingStatusIndicator).toHaveBeenCalledTimes(1);
		expect(fakeThis.clearStatusIndicator).not.toHaveBeenCalled();
		expect(fakeThis.ui.requestRender).toHaveBeenCalledTimes(1);

		fakeThis.workingVisible = false;
		await handleEvent.call(fakeThis, { type: "turn_start" });

		expect(fakeThis.showWorkingStatusIndicator).toHaveBeenCalledTimes(1);
		expect(fakeThis.clearStatusIndicator).toHaveBeenCalledTimes(1);
		expect(fakeThis.ui.requestRender).toHaveBeenCalledTimes(2);
	});

	// Regression test for #9340.
	test("routes interactive response aborts through AgentSession", () => {
		const abort = vi.fn(async () => {});
		const ui = {
			clearAllQueues: () => ({ steering: [], followUp: [] }),
			updatePendingMessagesDisplay: vi.fn(),
			agent: { abort },
			session: { abort },
		};
		const restoreQueuedMessagesToEditor = Reflect.get(InteractiveMode.prototype, "restoreQueuedMessagesToEditor") as (
			this: typeof ui,
			options?: { abort?: boolean },
		) => number;

		restoreQueuedMessagesToEditor.call(ui, { abort: true });

		expect(abort).toHaveBeenCalledOnce();
	});

	test("preserves steering behavior when flushing into an active agent run", async () => {
		const fakeThis = {
			compactionQueuedMessages: [{ text: "change direction", mode: "steer" as const }],
			session: {
				clearQueue: vi.fn(),
				prompt: vi.fn().mockResolvedValue(undefined),
				steer: vi.fn().mockResolvedValue(undefined),
				followUp: vi.fn().mockResolvedValue(undefined),
			},
			isExtensionCommand: vi.fn().mockReturnValue(false),
			updatePendingMessagesDisplay: vi.fn(),
			showError: vi.fn(),
		};

		const flushCompactionQueue = Reflect.get(InteractiveMode.prototype, "flushCompactionQueue") as (
			this: typeof fakeThis,
			options?: { willRetry?: boolean },
		) => Promise<void>;

		await flushCompactionQueue.call(fakeThis, { willRetry: false });

		expect(fakeThis.session.prompt).toHaveBeenCalledWith("change direction", { streamingBehavior: "steer" });
		expect(fakeThis.compactionQueuedMessages).toEqual([]);
		expect(fakeThis.showError).not.toHaveBeenCalled();
	});
});
