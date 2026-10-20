import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { WebSocket } from "ws";
import type { RuntimeProtocolClient, SessionResultState, SessionSummary } from "@lystar/code-web-protocol";
import { WebGatewayServer, scopedRuntimeClientId } from "../src/server.ts";
import type { WebGatewayConfig } from "../src/config.ts";

interface Snapshot {
	type: "bootstrap" | "workspace_updated";
	workspaceRevision: number;
	projects: Array<{ id: string; name: string; pinned?: boolean; sessionsLoaded?: boolean; sessions: Array<{ id: string; result?: SessionResultState }> }>;
	projectGroups: Array<{ id: string; name: string; projectIds: string[] }>;
}
interface WorkspaceUpdate extends Snapshot {
	type: "workspace_updated";
	projectIds: string[];
	sessionSummaries: Array<{ projectId: string; sessions: Snapshot["projects"][number]["sessions"] }>;
}
const snapshots = new WeakMap<WebSocket, Snapshot>();
interface TestContext { client?: RuntimeProtocolClient }
interface Internals {
	server: Server;
	contexts: Map<string, TestContext>;
	createContext(id: string): TestContext;
}

function waitForSnapshot(socket: WebSocket, predicate: (snapshot: Snapshot) => boolean): Promise<Snapshot> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => { socket.off("message", onMessage); reject(new Error("等待工作区快照超时")); }, 5000);
		const onMessage = () => {
			const value = snapshots.get(socket);
			if (!value || !predicate(value)) return;
			clearTimeout(timer);
			socket.off("message", onMessage);
			resolve(value);
		};
		socket.on("message", onMessage);
	});
}

async function gateway(root: string, profile: string, sessionListDelay = 0) {
	const config: WebGatewayConfig = {
		host: "127.0.0.1", port: 0, token: "workspace-test",
		staticDir: root, runtimeEndpoint: join(root, "unused.sock"), runtimePort: 0,
		agentDir: root, serviceProfile: profile, manageRuntime: false,
	};
	const server = new WebGatewayServer(config);
	const internals = server as unknown as Internals;
	const contextId = scopedRuntimeClientId(profile, "workspace-test-client");
	const context = internals.createContext(contextId);
	context.client = {
		getSnapshot: () => ({ connected: true, operations: new Map(), hello: { capabilities: [] } }),
		request: async (request: { command: string; cwd?: string }) => {
			if (request.command === "get_snapshot") return { sessions: [], operations: [] };
			const sessions = server.registry.list().find((project) => project.cwd === request.cwd)?.recentSessions ?? [];
			if (request.command === "list_project_sessions") {
				if (sessionListDelay) await new Promise((resolve) => setTimeout(resolve, sessionListDelay));
				return { sessions, rooms: [] };
			}
			if (request.command === "list_sessions") return sessions;
			if (request.command === "room_project_list") return [];
			throw new Error(`非预期的 Runtime 请求：${request.command}`);
		},
		close: async () => {},
	} as unknown as RuntimeProtocolClient;
	internals.contexts.set(contextId, context);
	await server.listen();
	const address = internals.server.address();
	if (!address || typeof address === "string") throw new Error("Gateway 未监听端口");
	const origin = `http://127.0.0.1:${address.port}`;
	const connect = () => {
		const socket = new WebSocket(`${origin.replace("http", "ws")}/ws?token=workspace-test&clientId=workspace-test-client`, { origin });
		socket.on("message", (raw: Buffer) => {
			const message = JSON.parse(String(raw)) as WorkspaceUpdate | { type: "bootstrap"; data: Omit<Snapshot, "type"> };
			if (message.type === "bootstrap") {
				snapshots.set(socket, { type: "bootstrap", ...message.data });
			} else if (message.type === "workspace_updated") {
				const previous = snapshots.get(socket);
				const byId = new Map(previous?.projects.map((project) => [project.id, project]));
				for (const project of message.projects) byId.set(project.id, project);
				for (const update of message.sessionSummaries) {
					const project = byId.get(update.projectId);
					if (!project) continue;
					const sessions = new Map(update.sessions.map((session) => [session.id, session]));
					byId.set(project.id, { ...project, sessions: project.sessions.map((session) => sessions.get(session.id) ?? session) });
				}
				snapshots.set(socket, { ...message, projects: message.projectIds.flatMap((id) => {
					const project = byId.get(id);
					return project ? [project] : [];
				}) });
			}
		});
		const initial = waitForSnapshot(socket, (snapshot) => snapshot.type === "bootstrap");
		return { socket, initial };
	};
	return { server, origin, connect };
}

test("两个 Gateway 的独立 WebSocket 同步项目、分组和已读，离线端重连补齐", { timeout: 15_000 }, async (t) => {
	const root = await mkdtemp(join(tmpdir(), "lystar-workspace-sync-"));
	await mkdir(join(root, "web"));
	await writeFile(join(root, "web", "projects.json"), JSON.stringify({ projects: [], migration: { tauriImported: true } }));
	const production = await gateway(root, "production");
	const development = await gateway(root, "development");
	const desktop = production.connect();
	const phone = development.connect();
	let restored: ReturnType<typeof production.connect> | undefined;
	t.after(async () => {
		desktop.socket.terminate(); phone.socket.terminate(); restored?.socket.terminate();
		await production.server.close(); await development.server.close();
		await rm(root, { recursive: true, force: true });
	});
	const [first, second] = await Promise.all([desktop.initial, phone.initial]);
	assert.equal(first.workspaceRevision, second.workspaceRevision);
	assert.deepEqual(first.projects, second.projects);
	const desktopAdded = waitForSnapshot(desktop.socket, (snapshot) => snapshot.projects.some((project) => project.id === "parent") && snapshot.projectGroups.length === 1);
	const phoneAdded = waitForSnapshot(phone.socket, (snapshot) => snapshot.projects.some((project) => project.id === "parent") && snapshot.projectGroups.length === 1);
	await production.server.registry.add({ id: "parent", cwd: root, name: "父项目" });
	const group = await production.server.projectGroups.create("项目组");
	await production.server.projectGroups.assignProject("parent", group.id);
	const updatedAt = Date.now() + 1000;
	const session: SessionSummary = { id: "s", path: join(root, "s.jsonl"), cwd: root, createdAt: 1, updatedAt, firstMessage: "任务", messageCount: 1, activity: "completed", writeAccess: "available" };
	await production.server.registry.setRecentSessions("parent", [session]);
	const [a, b] = await Promise.all([desktopAdded, phoneAdded]);
	assert.equal(a.workspaceRevision, b.workspaceRevision);
	assert.deepEqual(a.projects, b.projects);
	assert.deepEqual(a.projectGroups, b.projectGroups);
	const desktopRead = waitForSnapshot(desktop.socket, (snapshot) => snapshot.projects[0]?.sessions[0]?.result?.readRevision === 1);
	const phoneRead = waitForSnapshot(phone.socket, (snapshot) => snapshot.projects[0]?.sessions[0]?.result?.readRevision === 1);
	const response = await fetch(`${development.origin}/api/sessions/s/read`, {
		method: "POST", headers: { Authorization: "Bearer workspace-test", "Content-Type": "application/json", "X-LYStar-Client-Id": "workspace-test-client" }, body: JSON.stringify({ revision: 1 }),
	});
	assert.equal(response.status, 200);
	const [readA, readB] = await Promise.all([desktopRead, phoneRead]);
	assert.deepEqual(readA.projects, readB.projects);
	phone.socket.terminate();
	await production.server.registry.update("parent", { name: "离线期间改名", pinned: true });
	restored = development.connect();
	const recovered = await restored.initial;
	assert.equal(recovered.projects[0]?.name, "离线期间改名");
	assert.equal(recovered.projects[0]?.pinned, true);
	assert.equal(recovered.projects[0]?.sessions[0]?.result?.readRevision, 1);
	assert.deepEqual(recovered.projectGroups[0]?.projectIds, ["parent"]);
});


test("工作区版本推送不中断尚未完成的会话索引队列", { timeout: 10_000 }, async (t) => {
	const root = await mkdtemp(join(tmpdir(), "lystar-workspace-index-"));
	await mkdir(join(root, "web"));
	await writeFile(join(root, "web", "projects.json"), JSON.stringify({ projects: [], migration: { tauriImported: true } }));
	const instance = await gateway(root, "development", 350);
	for (let index = 0; index < 8; index++) {
		const cwd = join(root, String(index));
		await mkdir(cwd);
		await instance.server.registry.add({ id: String(index), cwd });
	}
	const browser = instance.connect();
	t.after(async () => { browser.socket.terminate(); await instance.server.close(); await rm(root, { recursive: true, force: true }); });
	const allIndexed = waitForSnapshot(browser.socket, (snapshot) => snapshot.projects.length === 8 && snapshot.projects.every((project) => project.sessionsLoaded));
	await browser.initial;
	await allIndexed;
	assert.equal(instance.server.registry.list().filter((project) => project.sessionsIndexed).length, 8);
});
