import type { AssistantMessage, Usage } from "@earendil-works/pi-ai/compat";
import { estimateTextTokens } from "@earendil-works/pi-ai/utils/estimate";
import type { AgentSessionEvent } from "./agent-session.ts";
import { estimateProjectedContextTokens } from "./compaction/compaction.ts";
import type { SessionEntry, SessionManager } from "./session-manager.ts";
import { addUsageToTotals, createUsageTotals } from "./usage-totals.ts";

export interface SessionUsage {
	tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
	outputSpeed?: { outputTokens: number; elapsedMs: number; streaming?: boolean };
	estimatedInput?: boolean;
	estimatedOutput: boolean;
}

/** 全日志用量只累计新增条目；当前回复是可替换样本，不作为增量重复相加。 */
export class SessionUsageTracker {
	private manager?: SessionManager;
	private entryCount = 0;
	private lastEntry?: SessionEntry;
	private lastAssistant?: AssistantMessage;
	private totals = createUsageTotals();
	private speedTokens = 0;
	private speedMs = 0;
	private live?: {
		message: AssistantMessage;
		parts: string[];
		estimatedTokens: number;
		estimatedInput?: number;
		firstTokenAt?: number;
		sampledAt: number;
		finished: boolean;
	};

	update(event: AgentSessionEvent, now = performance.now()): boolean {
		if (event.type === "message_start" && event.message.role === "assistant") {
			this.live = { message: event.message, parts: [], estimatedTokens: 0, sampledAt: now, finished: false };
			return true;
		}
		if ((event.type === "message_update" || event.type === "message_end") && event.message.role === "assistant") {
			const live = this.live ?? {
				message: event.message,
				parts: [],
				estimatedTokens: 0,
				sampledAt: now,
				finished: false,
			};
			this.live = live;
			live.message = event.message;
			if (event.type === "message_end") {
				live.finished = true;
				return true;
			}
			const delta = event.assistantMessageEvent;
			if (
				(delta.type === "text_delta" || delta.type === "thinking_delta" || delta.type === "toolcall_delta") &&
				delta.delta.length > 0
			) {
				live.parts.push(delta.delta);
				const firstToken = live.firstTokenAt === undefined;
				live.firstTokenAt ??= now;
				if (!firstToken && now - live.sampledAt < 250) return false;
			} else if (now - live.sampledAt < 250) return false;
			live.sampledAt = now;
			live.estimatedTokens = estimateTextTokens(live.parts.join(""));
			return true;
		}
		return event.type === "entry_appended";
	}

	snapshot(manager: SessionManager, now = performance.now()): SessionUsage {
		const count = manager.getEntryCount();
		if (
			manager !== this.manager ||
			count < this.entryCount ||
			(this.lastEntry && manager.getEntry(this.lastEntry.id) !== this.lastEntry)
		) {
			if (this.manager) this.live = undefined;
			this.manager = manager;
			this.entryCount = 0;
			this.lastEntry = undefined;
			this.lastAssistant = undefined;
			this.totals = createUsageTotals();
			this.speedTokens = 0;
			this.speedMs = 0;
		}
		if (count !== this.entryCount) {
			const entries = manager.getEntries();
			for (let index = this.entryCount; index < entries.length; index++) {
				const entry = entries[index];
				let usage: Usage | undefined;
				if (entry.type === "usage" || entry.type === "compaction" || entry.type === "branch_summary")
					usage = entry.usage;
				if (entry.type === "message" && (entry.message.role === "assistant" || entry.message.role === "toolResult"))
					usage = entry.message.usage;
				if (usage) addUsageToTotals(this.totals, usage);
				if (entry.type === "message" && entry.message.role === "assistant") {
					if (
						this.live &&
						entry.message.timestamp === this.live.message.timestamp &&
						entry.message.provider === this.live.message.provider &&
						entry.message.model === this.live.message.model
					)
						this.live = undefined;
					this.lastAssistant = entry.message;
					const duration = entry.message.decodeDurationMs;
					if (
						duration &&
						entry.message.usage.output > 0 &&
						entry.message.stopReason !== "error" &&
						entry.message.stopReason !== "aborted"
					) {
						this.speedTokens += entry.message.usage.output;
						this.speedMs += duration;
					}
				}
			}
			this.entryCount = entries.length;
			this.lastEntry = entries.at(-1);
		}
		const totals = { ...this.totals };
		let outputTokens = this.speedTokens;
		let elapsedMs = this.speedMs;
		let streaming = false;
		let estimatedInput = false;
		let estimatedOutput = false;
		const live = this.live;
		if (
			live &&
			!(
				this.lastAssistant?.timestamp === live.message.timestamp &&
				this.lastAssistant.provider === live.message.provider &&
				this.lastAssistant.model === live.message.model
			)
		) {
			addUsageToTotals(totals, live.message.usage);
			if (!live.finished) {
				const usage = live.message.usage;
				if (usage.input + usage.cacheRead + usage.cacheWrite === 0) {
					live.estimatedInput ??= estimateProjectedContextTokens(
						manager.buildSessionProjection(),
						manager.getBranch(),
					).tokens;
					totals.input += live.estimatedInput;
					estimatedInput = live.estimatedInput > 0;
				}
				if (live.estimatedTokens > usage.output) {
					totals.output += live.estimatedTokens - usage.output;
					estimatedOutput = true;
				}
				if (live.firstTokenAt !== undefined) {
					outputTokens += Math.max(usage.output, live.estimatedTokens);
					elapsedMs += Math.max(1, Math.round(now - live.firstTokenAt));
					streaming = true;
				}
			}
			const duration = live.message.decodeDurationMs;
			if (
				live.finished &&
				duration &&
				live.message.usage.output > 0 &&
				live.message.stopReason !== "error" &&
				live.message.stopReason !== "aborted"
			) {
				outputTokens += live.message.usage.output;
				elapsedMs += duration;
			}
		}
		const { input, output, cacheRead, cacheWrite } = totals;
		return {
			tokens: { input, output, cacheRead, cacheWrite, total: input + output + cacheRead + cacheWrite },
			...(elapsedMs > 0
				? { outputSpeed: { outputTokens, elapsedMs, ...(streaming ? { streaming: true } : {}) } }
				: {}),
			...(estimatedInput ? { estimatedInput: true } : {}),
			estimatedOutput,
		};
	}
}
