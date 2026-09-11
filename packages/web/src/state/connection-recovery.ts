export interface ConnectionRecoveryState {
	networkOnline: boolean;
	connected: boolean;
	reconnecting: boolean;
	connectionError: string;
}

export interface ConnectionPresentation {
	label: string;
	title: string;
	description: string;
	tone: "connected" | "reconnecting" | "offline";
	blocking: boolean;
}

const OFFLINE_MESSAGE = "网络连接已断开，恢复网络后会自动重连";
const RECONNECTING_MESSAGE = "连接已断开，正在恢复";

export function offlineConnectionState(): ConnectionRecoveryState {
	return {
		networkOnline: false,
		connected: false,
		reconnecting: false,
		connectionError: OFFLINE_MESSAGE,
	};
}

export function reconnectingConnectionState(message = RECONNECTING_MESSAGE): ConnectionRecoveryState {
	return {
		networkOnline: true,
		connected: false,
		reconnecting: true,
		connectionError: message,
	};
}

export function connectionStateAfterHostUpdate(
	current: ConnectionRecoveryState & { sessionReady: boolean },
	hostConnected: boolean,
	hasSession: boolean,
	networkOnline: boolean,
	message?: string,
): ConnectionRecoveryState {
	if (!networkOnline) return offlineConnectionState();
	if (!hostConnected) return reconnectingConnectionState(message);
	return {
		networkOnline: true,
		connected: true,
		reconnecting: hasSession && !current.sessionReady,
		connectionError: "",
	};
}

export function connectionStateAfterSessionSubscription(
	current: ConnectionRecoveryState,
	networkOnline: boolean,
): ConnectionRecoveryState & { sessionReady: boolean } {
	if (!networkOnline) return { ...offlineConnectionState(), sessionReady: false };
	if (!current.connected) return { ...current, networkOnline: true, sessionReady: true };
	return { ...readyConnectionState(true), sessionReady: true };
}

export function readyConnectionState(networkOnline: boolean): ConnectionRecoveryState {
	return networkOnline
		? { networkOnline: true, connected: true, reconnecting: false, connectionError: "" }
		: offlineConnectionState();
}

export function connectionPresentation(state: ConnectionRecoveryState): ConnectionPresentation {
	if (!state.networkOnline) {
		return {
			label: "离线",
			title: "网络连接已断开",
			description: "网络恢复后会自动重新连接",
			tone: "offline",
			blocking: true,
		};
	}
	if (state.reconnecting) {
		return {
			label: "恢复连接中",
			title: "正在恢复连接",
			description: "正在同步项目与会话，请稍候",
			tone: "reconnecting",
			blocking: true,
		};
	}
	if (state.connected) {
		return {
			label: "已连接",
			title: "已连接",
			description: "",
			tone: "connected",
			blocking: false,
		};
	}
	return {
		label: "未连接",
		title: "连接已断开",
		description: "连接恢复后会继续同步",
		tone: "offline",
		blocking: Boolean(state.connectionError),
	};
}
