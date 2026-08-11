import { Container, Spacer } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, test, vi } from "vitest";
import type { CompactionSummaryMessage } from "../src/core/messages.ts";
import { type CompactionEntry, sessionEntryToContextMessages } from "../src/core/session-manager.ts";
import { CompactionSummaryMessageComponent } from "../src/modes/interactive/components/compaction-summary-message.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

describe("InteractiveMode compaction events", () => {
	beforeAll(() => initTheme("dark"));

	test.each(["manual", "threshold", "overflow"] as const)(
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

	test("restores the working indicator when compaction continues the agent run", async () => {
		const setProgress = vi.fn();
		const setWorkingVisible = vi.fn();
		const rebuildChatFromMessages = vi.fn();
		const addMessageToChat = vi.fn();
		const fakeThis = {
			isInitialized: true,
			footer: { invalidate: vi.fn() },
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
