import { useEffect, useState } from "react";
import { webApi } from "../adapters/host-protocol/api.ts";

type PushStatus = "loading" | "off" | "on" | "blocked" | "unsupported";

function applicationServerKey(value: string): Uint8Array<ArrayBuffer> {
	const encoded = value.replace(/-/gu, "+").replace(/_/gu, "/");
	const decoded = atob(encoded.padEnd(Math.ceil(encoded.length / 4) * 4, "="));
	return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
}

export function pushErrorMessage(reason: unknown): string {
	const message = reason instanceof Error ? reason.message : String(reason);
	if (/Registration failed - push service error/iu.test(message)) {
		return "浏览器推送服务注册失败，通知权限已允许，但还不能接收后台通知。如果使用安卓 Chrome，请检查 Google Play 服务和网络连接，再重试。";
	}
	return message;
}

export function usePushNotifications() {
	const [status, setStatus] = useState<PushStatus>("loading");
	const [error, setError] = useState<string>();
	const [busy, setBusy] = useState(false);

	useEffect(() => {
		if (!window.isSecureContext || !("Notification" in window) || !("serviceWorker" in navigator) || !("PushManager" in window)) {
			setStatus("unsupported");
			return;
		}
		let active = true;
		void navigator.serviceWorker.ready.then((registration) => registration.pushManager.getSubscription())
			.then((subscription) => {
				if (active) setStatus(Notification.permission === "denied" ? "blocked" : subscription ? "on" : "off");
			})
			.catch((reason: unknown) => {
				if (active) {
					setStatus("unsupported");
					setError(reason instanceof Error ? reason.message : String(reason));
				}
			});
		return () => { active = false; };
	}, []);

	const enable = async () => {
		setBusy(true);
		setError(undefined);
		try {
			const permission = await Notification.requestPermission();
			if (permission !== "granted") {
				setStatus(permission === "denied" ? "blocked" : "off");
				return;
			}
			const registration = await navigator.serviceWorker.ready;
			const { publicKey } = await webApi.request<{ publicKey: string }>("/api/push");
			const previous = await registration.pushManager.getSubscription();
			const subscription = previous ?? await registration.pushManager.subscribe({
				userVisibleOnly: true,
				applicationServerKey: applicationServerKey(publicKey),
			});
			try {
				await webApi.request("/api/push", {
					method: "POST",
					body: JSON.stringify({ subscription: subscription.toJSON() }),
				});
			} catch (reason) {
				if (!previous) await subscription.unsubscribe();
				throw reason;
			}
			setStatus("on");
		} catch (reason) {
			setError(pushErrorMessage(reason));
		} finally {
			setBusy(false);
		}
	};

	const disable = async () => {
		setBusy(true);
		setError(undefined);
		try {
			const registration = await navigator.serviceWorker.ready;
			const subscription = await registration.pushManager.getSubscription();
			if (subscription) {
				await webApi.request("/api/push", {
					method: "DELETE",
					body: JSON.stringify({ endpoint: subscription.endpoint }),
				});
				await subscription.unsubscribe();
			}
			setStatus("off");
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		} finally {
			setBusy(false);
		}
	};

	return { status, error, busy, enable, disable };
}
