import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import type { Server as HttpServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ServerEvent } from "@lystar/code-web-protocol";
import webPush, { type PushSubscription } from "web-push";
import { PushNotifications, type TurnPushMessage } from "../src/push-notifications.ts";
import { WebGatewayServer } from "../src/server.ts";

const subscription = {
	endpoint: "https://push.example.test/subscription-1",
	keys: { p256dh: "public-key", auth: "secret" },
};

test("Web Push 密钥和订阅在服务重启后保留，退订后不再发送", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "lystar-web-push-"));
	try {
		const first = new PushNotifications(agentDir);
		await first.load();
		await first.subscribe(subscription);
		assert.equal(first.hasSubscriptions, true);
		const second = new PushNotifications(agentDir);
		await second.load();
		assert.equal(second.publicKey, first.publicKey);
		assert.equal(second.hasSubscriptions, true);
		const development = new PushNotifications(agentDir, "development");
		await development.load();
		assert.notEqual(development.publicKey, second.publicKey);
		assert.equal(development.hasSubscriptions, false);
		await second.unsubscribe(subscription.endpoint);
		assert.equal(second.hasSubscriptions, false);
		assert.equal(
			(JSON.parse(await readFile(join(agentDir, "web", "push.json"), "utf8")) as { subscriptions: unknown[] })
				.subscriptions.length,
			0,
		);
	} finally {
		await rm(agentDir, { recursive: true, force: true });
	}
});

test("Web Push 发送回合内容，移除已失效的订阅", async (t) => {
	const agentDir = await mkdtemp(join(tmpdir(), "lystar-web-push-"));
	try {
		const push = new PushNotifications(agentDir);
		await push.load();
		await push.subscribe(subscription);
		let received: TurnPushMessage | undefined;
		t.mock.method(
			webPush,
			"sendNotification",
			async (_subscription: PushSubscription, payload?: string | Buffer | null) => {
				received = JSON.parse(String(payload)) as TurnPushMessage;
				throw { statusCode: 410 };
			},
		);
		await push.notify({
			turnId: "turn-1",
			sessionId: "session-1",
			projectName: "项目甲",
			sessionName: "修复登录",
			text: "回复摘录",
			outcome: "completed",
		});
		assert.equal(received?.text, "回复摘录");
		assert.equal(push.hasSubscriptions, false);
	} finally {
		await rm(agentDir, { recursive: true, force: true });
	}
});

test("Web Push 订阅拒绝非 HTTPS 地址", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "lystar-web-push-"));
	try {
		const push = new PushNotifications(agentDir);
		await push.load();
		await assert.rejects(push.subscribe({ ...subscription, endpoint: "http://localhost/notify" }), /HTTPS/);
	} finally {
		await rm(agentDir, { recursive: true, force: true });
	}
});

test("Gateway 保存浏览器订阅，重启后恢复推送监听，退订后移除", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "lystar-web-push-"));
	const config = {
		host: "127.0.0.1",
		port: 0,
		agentDir,
		runtimeEndpoint: join(agentDir, "runtime.sock"),
		token: "push-test-token",
		allowedHosts: ["127.0.0.1"],
		staticDir: agentDir,
		manageRuntime: false,
	};
	try {
		const first = new WebGatewayServer(config);
		const firstInternal = first as unknown as {
			server: HttpServer;
			getClient: (context: object) => Promise<unknown>;
			pushContext?: { sockets: Set<unknown> };
		};
		firstInternal.getClient = async () => ({});
		try {
			await first.listen();
			const address = firstInternal.server.address();
			assert.ok(address && typeof address !== "string");
			const baseUrl = `http://127.0.0.1:${address.port}/api/push`;
			const headers = {
				Authorization: "Bearer push-test-token",
				"X-LYStar-Client-Id": "push-test-client",
				"Content-Type": "application/json",
			};
			const invalid = await fetch(baseUrl, {
				method: "POST",
				headers,
				body: JSON.stringify({ subscription: { ...subscription, endpoint: "http://localhost" } }),
			});
			assert.equal(invalid.status, 400);
			const subscribed = await fetch(baseUrl, { method: "POST", headers, body: JSON.stringify({ subscription }) });
			assert.equal(subscribed.status, 200);
			assert.equal(firstInternal.pushContext?.sockets.size, 0);
		} finally {
			await first.close();
		}

		const restarted = new WebGatewayServer(config);
		const secondInternal = restarted as unknown as {
			server: HttpServer;
			getClient: (context: object) => Promise<unknown>;
			pushContext?: { sockets: Set<unknown> };
		};
		let restoredConnections = 0;
		secondInternal.getClient = async () => {
			restoredConnections += 1;
			return {};
		};
		try {
			await restarted.listen();
			assert.equal(restoredConnections, 1);
			assert.equal(secondInternal.pushContext?.sockets.size, 0);
			const address = secondInternal.server.address();
			assert.ok(address && typeof address !== "string");
			const response = await fetch(`http://127.0.0.1:${address.port}/api/push`, {
				method: "DELETE",
				headers: {
					Authorization: "Bearer push-test-token",
					"X-LYStar-Client-Id": "push-test-client",
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ endpoint: subscription.endpoint }),
			});
			assert.equal(response.status, 200);
			assert.equal(
				(JSON.parse(await readFile(join(agentDir, "web", "push.json"), "utf8")) as { subscriptions: unknown[] })
					.subscriptions.length,
				0,
			);
		} finally {
			await restarted.close();
		}
	} finally {
		await rm(agentDir, { recursive: true, force: true });
	}
});

test("Gateway 无页面连接时仍发送包含项目、会话、回复摘录的通知", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "lystar-web-push-"));
	const server = new WebGatewayServer({
		host: "127.0.0.1",
		port: 0,
		agentDir,
		runtimeEndpoint: join(agentDir, "runtime.sock"),
		token: "push-test-token",
		allowedHosts: ["127.0.0.1"],
		staticDir: agentDir,
		manageRuntime: false,
	});
	try {
		await server.listen();
		const internal = server as unknown as {
			server: HttpServer;
			pushNotifications: PushNotifications;
			pushContext: object;
			createContext(id: string): object;
			handleHostEvent(context: object, event: ServerEvent): void;
		};
		const address = internal.server.address();
		assert.ok(address && typeof address !== "string");
		const baseUrl = `http://127.0.0.1:${address.port}`;
		const headers = {
			Authorization: "Bearer push-test-token",
			"X-LYStar-Client-Id": "push-test-client",
			"Content-Type": "application/json",
		};
		const keyResponse = await fetch(`${baseUrl}/api/push`, { headers });
		assert.equal(keyResponse.status, 200);
		assert.equal(
			((await keyResponse.json()) as { publicKey: string }).publicKey,
			internal.pushNotifications.publicKey,
		);
		const unauthenticated = await fetch(`${baseUrl}/api/push`);
		assert.equal(unauthenticated.status, 401);

		const projectDir = await mkdtemp(join(tmpdir(), "lystar-web-project-"));
		try {
			await server.registry.add({ id: "project-1", cwd: projectDir, name: "项目甲" });
			const messages: TurnPushMessage[] = [];
			internal.pushNotifications.notify = async (message) => {
				messages.push(message);
			};
			internal.pushContext = internal.createContext("push-test-listener");
			const settled: Extract<ServerEvent, { type: "turn_settled" }> = {
				type: "turn_settled",
				sessionPath: join(agentDir, "session.jsonl"),
				sessionId: "session-1",
				cwd: projectDir,
				sessionName: "修复登录",
				turnId: "turn-1",
				outcome: "completed",
				text: "登录表单已经修复。\n可以开始验证。",
			};
			internal.handleHostEvent(internal.pushContext, settled);
			internal.handleHostEvent(internal.pushContext, { ...settled, turnId: "turn-2", outcome: "aborted" });
			await new Promise((resolve) => setImmediate(resolve));
			assert.deepEqual(messages, [
				{
					turnId: "turn-1",
					sessionId: "session-1",
					projectName: "项目甲",
					sessionName: "修复登录",
					text: "登录表单已经修复。 可以开始验证。",
					outcome: "completed",
				},
			]);
		} finally {
			await rm(projectDir, { recursive: true, force: true });
		}
	} finally {
		await server.close();
		await rm(agentDir, { recursive: true, force: true });
	}
});
