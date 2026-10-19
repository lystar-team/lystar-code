import { useCallback, useEffect, useRef } from "react";
import { webApi } from "../adapters/host-protocol/api.ts";
import { recordBrowserDiagnostic } from "../lib/browser-diagnostics.ts";
import type { GatewayEvent } from "../types.ts";
import { offlineConnectionState, reconnectDelayMs, reconnectingConnectionState } from "./connection-recovery.ts";
import { browserNetworkOnline } from "./workbench-state.ts";
import type { WorkbenchState } from "./workbench-types.ts";

type Ref<T> = { current: T };
type Recovery = { socket: WebSocket; sessionId: string; startedAt: number; acknowledged: boolean };
const FOREGROUND_CHECK_TIMEOUT_MS = 1_500;
const CONNECTION_OPEN_TIMEOUT_MS = 10_000;

interface WorkbenchConnectionContext {
	state: WorkbenchState;
	stateRef: Ref<WorkbenchState>;
	mountedRef: Ref<boolean>;
	socketRef: Ref<WebSocket | undefined>;
	reconnectAttemptRef: Ref<number>;
	bootstrapLoadedRef: Ref<boolean>;
	initializeRef: Ref<() => Promise<void>>;
	updateState: (update: (current: WorkbenchState) => WorkbenchState) => WorkbenchState;
	handleEvent: (event: GatewayEvent) => void;
	restoreSelectedSessionSubscription: (sessionId: string) => void;
	settleSessionSubscriptionWaiters: (result: "closed") => void;
}

export function useWorkbenchConnection({
	state, stateRef, mountedRef, socketRef, reconnectAttemptRef, bootstrapLoadedRef, initializeRef,
	updateState, handleEvent, restoreSelectedSessionSubscription, settleSessionSubscriptionWaiters,
}: WorkbenchConnectionContext) {
	const generationRef = useRef(0);
	const retryTimerRef = useRef<number>();
	const checkTimerRef = useRef<number>();
	const openTimerRef = useRef<number>();
	const recoveryRef = useRef<Recovery>();
	const resumeRef = useRef<() => void>(() => {});
	const connectRef = useRef<() => void>(() => {});

	const clearTimers = useCallback(() => {
		for (const timer of [retryTimerRef, checkTimerRef, openTimerRef]) {
			if (timer.current !== undefined) window.clearTimeout(timer.current);
			timer.current = undefined;
		}
	}, []);

	const disconnectStream = useCallback(() => {
		generationRef.current++;
		clearTimers();
		recoveryRef.current = undefined;
		settleSessionSubscriptionWaiters("closed");
		const socket = socketRef.current;
		socketRef.current = undefined;
		if (socket && socket.readyState !== WebSocket.CLOSED) socket.close();
	}, [clearTimers, settleSessionSubscriptionWaiters, socketRef]);

	const scheduleReconnect = useCallback(() => {
		if (retryTimerRef.current !== undefined || !mountedRef.current || !webApi.hasToken() ||
			!browserNetworkOnline() || document.visibilityState === "hidden") return;
		const attempt = reconnectAttemptRef.current++;
		const delayMs = reconnectDelayMs(attempt);
		recordBrowserDiagnostic("connection.retry", { attempt: attempt + 1, delayMs });
		retryTimerRef.current = window.setTimeout(() => {
			retryTimerRef.current = undefined;
			resumeRef.current();
		}, delayMs);
	}, [mountedRef, reconnectAttemptRef]);

	const connectStream = useCallback(() => {
		const recovery = recoveryRef.current;
		disconnectStream();
		if (!browserNetworkOnline()) {
			updateState((current) => ({
				...current, ...offlineConnectionState(), lease: undefined,
				readOnly: Boolean(current.sessionId), sessionReady: false,
			}));
			return;
		}
		const generation = generationRef.current;
		recordBrowserDiagnostic("connection.opening", { generation, sessionId: stateRef.current.sessionId });
		updateState((current) => ({
			...current, ...reconnectingConnectionState(),
			...(current.sessionId ? { sessionReady: false } : {}),
		}));
		const socket = webApi.connect((event) => {
			if (generationRef.current !== generation || socketRef.current !== socket) return;
			const recovery = recoveryRef.current;
			if (recovery?.socket === socket && event.type === "session_subscription" && event.sessionId === recovery.sessionId) {
				if (checkTimerRef.current !== undefined) window.clearTimeout(checkTimerRef.current);
				checkTimerRef.current = undefined;
				recovery.acknowledged = true;
				recordBrowserDiagnostic("connection.foreground.ack", {
					sessionId: event.sessionId, gap: event.gap, elapsedMs: performance.now() - recovery.startedAt,
				});
			}
			handleEvent(event);
		}, (event) => {
			if (generationRef.current !== generation || socketRef.current !== socket) return;
			const interruptedRecovery = recoveryRef.current;
			disconnectStream();
			recoveryRef.current = interruptedRecovery;
			if (!mountedRef.current) return;
			const online = browserNetworkOnline();
			recordBrowserDiagnostic("connection.closed", { generation, code: event.code });
			updateState((current) => ({
				...current, ...(online ? reconnectingConnectionState("Web Host 连接已断开，正在重连") : offlineConnectionState()),
				lease: undefined, readOnly: Boolean(current.sessionId), sessionReady: false,
			}));
			if (online) scheduleReconnect();
		});
		socketRef.current = socket;
		if (recovery && recovery.sessionId === stateRef.current.sessionId)
			recoveryRef.current = { ...recovery, socket, acknowledged: false };
		const onOpen = () => {
			if (generationRef.current !== generation || socketRef.current !== socket) return;
			if (openTimerRef.current !== undefined) window.clearTimeout(openTimerRef.current);
			openTimerRef.current = undefined;
			const { currentProjectId, sessionId } = stateRef.current;
			if (currentProjectId) webApi.subscribeProject(socket, currentProjectId);
			if (sessionId) restoreSelectedSessionSubscription(sessionId);
		};
		socket.addEventListener("open", onOpen, { once: true });
		if (socket.readyState === WebSocket.OPEN) onOpen();
		else openTimerRef.current = window.setTimeout(() => {
			openTimerRef.current = undefined;
			if (socketRef.current !== socket) return;
			recordBrowserDiagnostic("connection.open.timeout", { generation });
			disconnectStream();
			if (mountedRef.current) scheduleReconnect();
		}, CONNECTION_OPEN_TIMEOUT_MS);
	}, [disconnectStream, handleEvent, mountedRef, restoreSelectedSessionSubscription, scheduleReconnect, socketRef, stateRef, updateState]);
	connectRef.current = connectStream;

	const resumeConnection = useCallback(() => {
		if (!mountedRef.current || !webApi.hasToken() || !browserNetworkOnline() || document.visibilityState === "hidden") return;
		if (retryTimerRef.current !== undefined) window.clearTimeout(retryTimerRef.current);
		retryTimerRef.current = undefined;
		const socket = socketRef.current;
		if (socket?.readyState === WebSocket.OPEN) {
			const { sessionId } = stateRef.current;
			// 无会话时也用新连接获取完整工作区；有会话时复用现有序号进行核对。
			if (!sessionId) {
				connectRef.current();
				return;
			}
			if (recoveryRef.current?.socket === socket && recoveryRef.current.sessionId === sessionId) return;
			if (checkTimerRef.current !== undefined) window.clearTimeout(checkTimerRef.current);
			const recovery: Recovery = { socket, sessionId, startedAt: performance.now(), acknowledged: false };
			recoveryRef.current = recovery;
			recordBrowserDiagnostic("connection.foreground.started", { sessionId, sessionReady: stateRef.current.sessionReady });
			checkTimerRef.current = window.setTimeout(() => {
				checkTimerRef.current = undefined;
				if (recoveryRef.current !== recovery || socketRef.current !== socket) return;
				if (stateRef.current.sessionId !== sessionId) {
					recoveryRef.current = undefined;
					return;
				}
				recordBrowserDiagnostic("connection.foreground.timeout", { sessionId, elapsedMs: performance.now() - recovery.startedAt });
				connectRef.current();
			}, FOREGROUND_CHECK_TIMEOUT_MS);
			restoreSelectedSessionSubscription(sessionId);
			return;
		}
		// 连接中的 socket 由唯一的建立超时负责；前台事件不再重复创建连接。
		if (socket?.readyState === WebSocket.CONNECTING) return;
		if (bootstrapLoadedRef.current) connectRef.current();
		else void initializeRef.current();
	}, [bootstrapLoadedRef, initializeRef, mountedRef, restoreSelectedSessionSubscription, socketRef, stateRef]);
	resumeRef.current = resumeConnection;

	useEffect(() => {
		const recovery = recoveryRef.current;
		if (!recovery?.acknowledged || !state.connected || state.reconnecting || !state.sessionReady || state.sessionId !== recovery.sessionId) return;
		const frame = window.requestAnimationFrame(() => {
			if (recoveryRef.current !== recovery || socketRef.current !== recovery.socket || !stateRef.current.sessionReady) return;
			recordBrowserDiagnostic("connection.foreground.ready", { sessionId: recovery.sessionId, elapsedMs: performance.now() - recovery.startedAt });
			recoveryRef.current = undefined;
		});
		return () => window.cancelAnimationFrame(frame);
	}, [state, socketRef, stateRef]);

	useEffect(() => {
		const onOffline = () => {
			disconnectStream();
			updateState((current) => ({
				...current, ...offlineConnectionState(), lease: undefined,
				readOnly: Boolean(current.sessionId), sessionReady: false,
			}));
		};
		const onOnline = () => {
			if (!webApi.hasToken()) {
				updateState((current) => ({ ...current, networkOnline: true }));
				return;
			}
			updateState((current) => ({
				...current, ...reconnectingConnectionState(), lease: undefined,
				readOnly: Boolean(current.sessionId), sessionReady: false,
			}));
			resumeRef.current();
		};
		window.addEventListener("offline", onOffline);
		window.addEventListener("online", onOnline);
		return () => {
			window.removeEventListener("offline", onOffline);
			window.removeEventListener("online", onOnline);
		};
	}, [disconnectStream, updateState]);

	return { connectStream, disconnectStream, resumeConnection, scheduleReconnect };
}
