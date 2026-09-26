import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import webPush, { type PushSubscription } from "web-push";

interface PushFile {
	version: 1;
	vapid: { publicKey: string; privateKey: string };
	subscriptions: PushSubscription[];
}

export interface TurnPushMessage {
	turnId: string;
	sessionId: string;
	projectName: string;
	sessionName: string;
	text: string;
	outcome: "completed" | "failed";
}

export function parsePushSubscription(value: unknown): PushSubscription {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("推送订阅格式无效");
	const input = value as Record<string, unknown>;
	const keys = input.keys;
	if (!keys || typeof keys !== "object" || Array.isArray(keys)) throw new Error("推送订阅缺少密钥");
	const publicKeys = keys as Record<string, unknown>;
	if (
		typeof input.endpoint !== "string" ||
		input.endpoint.length > 4096 ||
		typeof publicKeys.p256dh !== "string" ||
		!publicKeys.p256dh ||
		typeof publicKeys.auth !== "string" ||
		!publicKeys.auth
	)
		throw new Error("推送订阅格式无效");
	try {
		if (new URL(input.endpoint).protocol !== "https:") throw new Error("推送地址必须使用 HTTPS");
	} catch {
		throw new Error("推送地址必须是有效的 HTTPS 地址");
	}
	return { endpoint: input.endpoint, keys: { p256dh: publicKeys.p256dh, auth: publicKeys.auth } };
}

export class PushNotifications {
	private readonly path: string;
	private state?: PushFile;
	private writeQueue: Promise<void> = Promise.resolve();

	constructor(agentDir: string, serviceProfile?: string) {
		this.path = join(agentDir, "web", serviceProfile === "development" ? "push-development.json" : "push.json");
	}

	async load(): Promise<void> {
		try {
			const input = JSON.parse(await readFile(this.path, "utf8")) as PushFile;
			if (
				input.version !== 1 ||
				!input.vapid?.publicKey ||
				!input.vapid.privateKey ||
				!Array.isArray(input.subscriptions)
			)
				throw new Error("Web Push 配置无效");
			this.state = { ...input, subscriptions: input.subscriptions.map(parsePushSubscription) };
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			this.state = { version: 1, vapid: webPush.generateVAPIDKeys(), subscriptions: [] };
			await this.save();
		}
	}

	get publicKey(): string {
		if (!this.state) throw new Error("Web Push 尚未初始化");
		return this.state.vapid.publicKey;
	}

	get hasSubscriptions(): boolean {
		return Boolean(this.state?.subscriptions.length);
	}

	async subscribe(input: unknown): Promise<void> {
		const subscription = parsePushSubscription(input);
		const state = this.state;
		if (!state) throw new Error("Web Push 尚未初始化");
		state.subscriptions = [
			...state.subscriptions.filter((item) => item.endpoint !== subscription.endpoint),
			subscription,
		];
		await this.save();
	}

	async unsubscribe(endpoint: string): Promise<void> {
		const state = this.state;
		if (!state) throw new Error("Web Push 尚未初始化");
		state.subscriptions = state.subscriptions.filter((item) => item.endpoint !== endpoint);
		await this.save();
	}

	async notify(message: TurnPushMessage): Promise<void> {
		const state = this.state;
		if (!state) throw new Error("Web Push 尚未初始化");
		const payload = JSON.stringify(message);
		const expired: string[] = [];
		await Promise.all(
			state.subscriptions.map(async (subscription) => {
				try {
					await webPush.sendNotification(subscription, payload, {
						vapidDetails: { subject: "https://github.com/lystar-team/lystar-code", ...state.vapid },
						TTL: 86400,
						timeout: 5000,
					});
				} catch (error) {
					const status = (error as { statusCode?: number }).statusCode;
					if (status === 404 || status === 410) expired.push(subscription.endpoint);
					else console.warn("Web Push 发送失败", error);
				}
			}),
		);
		if (expired.length) {
			state.subscriptions = state.subscriptions.filter((item) => !expired.includes(item.endpoint));
			await this.save();
		}
	}

	private save(): Promise<void> {
		const state = this.state;
		if (!state) throw new Error("Web Push 尚未初始化");
		const content = JSON.stringify(state);
		const write = async () => {
			await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
			const temporaryPath = `${this.path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
			try {
				await writeFile(temporaryPath, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
				await rename(temporaryPath, this.path);
			} catch (error) {
				await unlink(temporaryPath).catch(() => {});
				throw error;
			}
		};
		this.writeQueue = this.writeQueue.catch(() => {}).then(write);
		return this.writeQueue;
	}
}
