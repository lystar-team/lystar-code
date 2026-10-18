const EXCERPT_LIMIT = 120;

export interface SettledTurnNotification {
	projectName: string;
	sessionName: string;
	sessionId: string;
	turnId: string;
	outcome: "completed" | "failed";
	text: string;
}

/** 通知正文与 Web Push 通道保持一致：失败时显示固定文案，其余显示回复摘录。 */
export function turnNotificationBody(outcome: "completed" | "failed", text: string): string {
	if (outcome === "failed") return "本轮处理失败";
	return Array.from(text.replace(/\s+/gu, " ").trim()).slice(0, EXCERPT_LIMIT).join("") || "回复已完成";
}

/**
 * 页面在后台时用本地通知提醒回合结束。已启用浏览器推送订阅时由 Web Push 投递，
 * 这里直接跳过，避免同一回合提醒两次；推送服务不可用（注册不到订阅）时仍能收到提醒。
 */
export async function notifySettledTurn(input: SettledTurnNotification): Promise<boolean> {
	if (document.visibilityState !== "hidden") return false;
	if (!("Notification" in window) || Notification.permission !== "granted") return false;
	if (!("serviceWorker" in navigator)) return false;
	const registration = await navigator.serviceWorker.ready;
	if ("pushManager" in registration && (await registration.pushManager.getSubscription())) return false;
	await registration.showNotification(`${input.projectName} - ${input.sessionName}`, {
		body: turnNotificationBody(input.outcome, input.text),
		tag: input.turnId,
		data: { sessionId: input.sessionId },
	});
	return true;
}
