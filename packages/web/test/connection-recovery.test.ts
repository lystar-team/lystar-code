import { describe, expect, it } from "vitest";
import {
	connectionPresentation,
	connectionStateAfterHostUpdate,
	connectionStateAfterSessionSubscription,
	offlineConnectionState,
	readyConnectionState,
	reconnectingConnectionState,
} from "../src/state/connection-recovery.ts";

describe("连接恢复状态", () => {
	it("浏览器离线时等待网络恢复", () => {
		expect(offlineConnectionState()).toEqual({
			networkOnline: false,
			connected: false,
			reconnecting: false,
			connectionError: "网络连接已断开，恢复网络后会自动重连",
		});
	});

	it("网络在线但连接中断时进入重连状态", () => {
		expect(reconnectingConnectionState()).toMatchObject({
			networkOnline: true,
			connected: false,
			reconnecting: true,
		});
	});

	it("主机恢复后等待当前会话完成同步", () => {
		const reconnecting = { ...reconnectingConnectionState(), sessionReady: false };
		expect(connectionStateAfterHostUpdate(reconnecting, true, true, true)).toMatchObject({
			connected: true,
			reconnecting: true,
		});
		expect(connectionStateAfterSessionSubscription({ ...reconnecting, connected: true }, true)).toMatchObject({
			connected: true,
			reconnecting: false,
			sessionReady: true,
		});
	});

	it("Host 不可用时订阅确认不会提前结束恢复状态", () => {
		const waitingForHost = {
			...connectionStateAfterHostUpdate(
				{ ...reconnectingConnectionState(), sessionReady: false },
				false,
				true,
				true,
			),
			sessionReady: false,
		};
		const subscribed = connectionStateAfterSessionSubscription(waitingForHost, true);
		expect(subscribed).toMatchObject({ connected: false, reconnecting: true, sessionReady: true });
		expect(connectionStateAfterHostUpdate(subscribed, true, true, true)).toMatchObject({
			connected: true,
			reconnecting: false,
		});
	});

	it("没有当前会话时主机恢复即完成连接", () => {
		expect(
			connectionStateAfterHostUpdate({ ...reconnectingConnectionState(), sessionReady: false }, true, false, true),
		).toMatchObject({
			connected: true,
			reconnecting: false,
		});
	});

	it("恢复期间提供阻断式加载文案", () => {
		expect(connectionPresentation(reconnectingConnectionState())).toMatchObject({
			label: "恢复连接中",
			title: "正在恢复连接",
			blocking: true,
		});
		expect(connectionPresentation(readyConnectionState(true))).toMatchObject({
			label: "已连接",
			blocking: false,
		});
	});
});
