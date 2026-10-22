import { createHash } from "node:crypto";
import type { Context } from "@deepseek-ai/cordis";
import { createSystemMessage, type MessageSource } from "@deepseek-ai/dsh-llm";
import {
	appendPluginRecord,
	pluginRecordOf,
	Session,
	type SessionEvent,
	type SessionId,
} from "@deepseek-ai/dsh-session";
import type { JsonObject, JsonValue, Message } from "@earendil-works/pi-ai";
import { toHarnessMessage } from "./model-gateway.ts";

export const DSH_TOOL_PREFIX = "dsh__";

export interface HistoryEntry {
	message: Message;
	/** Native turns already exist in the live DSH log; retain their Pi summary when starting a new branch. */
	native: boolean;
	source?: MessageSource;
}

declare module "@deepseek-ai/dsh-session" {
	interface PluginRecordMap {
		"plugin:lystar/pi-history": { hashes: string[] };
		"plugin:lystar/pi-history-turn": { turn: number };
	}
}

/** A live Pi tool call enters DSH history when its results are available. */
export function readyHistory(entries: readonly HistoryEntry[]): readonly HistoryEntry[] {
	const pending = new Set<string>();
	let ready = 0;
	for (let index = 0; index < entries.length; index++) {
		const message = entries[index].message;
		if (message.role === "assistant") {
			for (const block of message.content) if (block.type === "toolCall") pending.add(block.id);
		} else if (message.role === "toolResult") pending.delete(message.toolCallId);
		if (!pending.size) ready = index + 1;
	}
	return entries.slice(0, ready);
}

export function historyHashes(entries: readonly HistoryEntry[]): string[] {
	return entries.map((entry) => createHash("sha256").update(JSON.stringify(entry)).digest("hex"));
}

export function storedHistory(session: Session): string[] | undefined {
	const events = session.snapshotEvents();
	for (let index = events.length - 1; index >= 0; index--) {
		const record = pluginRecordOf(events[index]);
		if (record?.type !== "plugin:lystar/pi-history") continue;
		const data = record.data;
		if (
			!data ||
			typeof data !== "object" ||
			Array.isArray(data) ||
			!("hashes" in data) ||
			!Array.isArray(data.hashes) ||
			!data.hashes.every((hash) => typeof hash === "string")
		)
			throw new Error("Invalid LYStar history import metadata in DSH session");
		return data.hashes;
	}
	return undefined;
}

export function importedTurns(session: Session): Set<number> {
	const turns = new Set<number>();
	for (const event of session.snapshotEvents()) {
		const record = pluginRecordOf(event);
		if (record?.type !== "plugin:lystar/pi-history-turn") continue;
		const data = record.data;
		if (
			!data ||
			typeof data !== "object" ||
			Array.isArray(data) ||
			!("turn" in data) ||
			typeof data.turn !== "number" ||
			!Number.isSafeInteger(data.turn) ||
			data.turn < 1
		)
			throw new Error("Invalid LYStar imported turn metadata in DSH session");
		turns.add(data.turn);
	}
	return turns;
}

function isObject(value: JsonValue | undefined): value is JsonObject {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nativeToolName(name: string): string {
	return name.startsWith(DSH_TOOL_PREFIX) ? name.slice(DSH_TOOL_PREFIX.length) : name;
}

export async function importHistory(
	context: Context,
	session: Session,
	entries: readonly HistoryEntry[],
	options: { skipNative: boolean; systemPrompt?: string; times?: Map<number, number>; beforeCommit?: () => void },
): Promise<boolean> {
	const converted = [];
	for (const entry of entries) {
		if (options.skipNative && entry.native) continue;
		const source = entry.message;
		const message =
			source.role === "assistant"
				? {
						...source,
						content: source.content.map((block) =>
							block.type === "toolCall" ? { ...block, name: nativeToolName(block.name) } : block,
						),
					}
				: source.role === "toolResult"
					? { ...source, toolName: nativeToolName(source.toolName) }
					: source;
		const convertedMessage = await toHarnessMessage(context, message);
		converted.push({
			source,
			message:
				convertedMessage.role === "user" && entry.source
					? { ...convertedMessage, source: entry.source }
					: convertedMessage,
		});
	}
	// 导入消息补齐 V4 生命周期和 system 首节点。宿主未提供提示词时首节点为空，
	// 后续步骤由原版 DSH 提示词服务更新；SDK 可以只提供历史消息。
	const head = session.surface.nodes.length ? undefined : createSystemMessage(options.systemPrompt ?? "");
	const framed = !!head || converted.some(({ message }) => message.role !== "user");
	const turn = (session.snapshotEvents().findLast((event) => event.type === "turn/start")?.data.turn ?? 0) + 1;
	const data = { turn, step: 1 };
	options.beforeCommit?.();
	if (framed) {
		appendPluginRecord(session, "plugin:lystar/pi-history-turn", { turn });
		session.append("turn/start", { turn });
		session.append("step/start", data);
	}
	if (head) session.append("system/message", { ...data, message: head }, { surfaceOp: "append" });
	for (const { source, message } of converted) {
		let event: SessionEvent;
		switch (message.role) {
			case "system":
				event = session.append("system/message", { ...data, message }, { surfaceOp: "append" });
				break;
			case "developer":
				event = session.append("developer/message", { ...data, message }, { surfaceOp: "append" });
				break;
			case "user":
				event = session.append("user/message", message, { surfaceOp: "append" });
				break;
			case "assistant": {
				const usage =
					source.role === "assistant"
						? {
								inputTokens: source.usage.input,
								outputTokens: source.usage.output,
								totalTokens: source.usage.totalTokens,
								cacheReadTokens: source.usage.cacheRead,
								cacheWriteTokens: source.usage.cacheWrite,
							}
						: undefined;
				event = session.append(
					"assistant/message",
					{ ...data, message, stream: [], ...(usage ? { usage } : {}) },
					{ surfaceOp: "append" },
				);
				for (const block of message.content) {
					if (block.type === "tool-call") {
						const call = session.append("tool/call", {
							...data,
							callId: block.id,
							name: block.name,
							arguments: block.arguments,
						});
						options.times?.set(call.seq, source.timestamp);
					}
				}
				break;
			}
			case "tool": {
				const details = source.role === "toolResult" ? source.details : undefined;
				const envelope = isObject(details) ? details.dsh : undefined;
				const native = isObject(envelope) ? envelope : undefined;
				const error = native?.error;
				let failure: Extract<SessionEvent, { type: "tool/result" }>["data"]["error"];
				if (error !== undefined) {
					if (
						!isObject(error) ||
						typeof error.name !== "string" ||
						typeof error.code !== "string" ||
						(error.reason !== undefined && typeof error.reason !== "string")
					)
						throw new Error("Invalid DSH tool failure metadata in Pi history");
					failure = {
						name: error.name,
						code: error.code,
						...(error.reason === undefined ? {} : { reason: error.reason }),
					};
				}
				event = session.append(
					"tool/result",
					{
						...data,
						message,
						...(native?.meta === undefined
							? {}
							: {
									meta: JSON.parse(JSON.stringify(native.meta)) as Extract<
										SessionEvent,
										{ type: "tool/result" }
									>["data"]["meta"],
								}),
						...(failure ? { error: failure } : {}),
					},
					{ surfaceOp: "append" },
				);
				break;
			}
		}
		options.times?.set(event.seq, source.timestamp);
	}
	if (framed) {
		session.append("step/end", data);
		session.append("turn/end", { turn, reason: { kind: "completed" } });
	}
	return framed;
}

export async function historySeed(
	context: Context,
	id: SessionId,
	entries: readonly HistoryEntry[],
	systemPrompt?: string,
): Promise<readonly SessionEvent[]> {
	const session = Session.create(id);
	const times = new Map<number, number>();
	await importHistory(context, session, entries, { skipNative: false, systemPrompt, times });
	appendPluginRecord(session, "plugin:lystar/pi-history", { hashes: historyHashes(entries) });
	return session.snapshotEvents().map((event) => ({ ...event, time: times.get(event.seq) ?? event.time }));
}
