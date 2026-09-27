import { afterEach, describe, expect, it, vi } from "vitest";
import { WebApi } from "../src/adapters/host-protocol/api.ts";

class FakeWebSocket {
	readonly listeners = new Map<string, Array<(event: { data?: string }) => void>>();
	readonly url: string;
	constructor(url: string) {
		this.url = url;
	}
	addEventListener(type: string, listener: (event: { data?: string }) => void): void {
		this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
	}
	emit(value: unknown): void {
		for (const listener of this.listeners.get("message") ?? []) listener({ data: JSON.stringify(value) });
	}
}

describe("Room WebSocket 通知", () => {
	afterEach(() => vi.unstubAllGlobals());

	it("接收 Room 变化与恢复通知，取消订阅后不再分发", () => {
		const storage = new Map<string, string>();
		vi.stubGlobal("localStorage", {
			getItem: (key: string) => storage.get(key) ?? null,
			setItem: (key: string, value: string) => storage.set(key, value),
		});
		vi.stubGlobal("location", { protocol: "http:", host: "127.0.0.1:2622" });
		vi.stubGlobal("WebSocket", FakeWebSocket);
		const api = new WebApi();
		const notifications: string[] = [];
		const unsubscribe = api.subscribeRoomUpdates((event) => notifications.push(event.type));
		const socket = api.connect(
			() => {},
			() => {},
		) as unknown as FakeWebSocket;
		socket.emit({ type: "connection_state", connected: false });
		socket.emit({
			type: "room_updated",
			projectId: "project",
			roomId: "room",
			latestSeq: 1,
			messagesChanged: true,
			tasksChanged: false,
			membersChanged: false,
		});
		socket.emit({ type: "connection_state", connected: true });
		expect(notifications).toEqual(["room_updated", "connection_state"]);
		unsubscribe();
		socket.emit({
			type: "room_updated",
			projectId: "project",
			roomId: "room",
			latestSeq: 2,
			messagesChanged: true,
			tasksChanged: false,
			membersChanged: false,
		});
		expect(notifications).toHaveLength(2);
	});
});
