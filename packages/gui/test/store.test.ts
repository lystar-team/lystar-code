import type { GuiProtocolClient } from "@lystar/code-gui-protocol";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	saveDesktopState: vi.fn(),
}));

vi.mock("../src/desktop-state.ts", async () => {
	const actual = await vi.importActual<typeof import("../src/desktop-state.ts")>("../src/desktop-state.ts");
	return {
		...actual,
		loadDesktopState: vi.fn(async () => ({ version: 1, connections: [], projects: [] })),
		saveDesktopState: mocks.saveDesktopState,
	};
});

class MemoryStorage {
	private readonly values = new Map<string, string>();
	getItem(key: string): string | null {
		return this.values.get(key) ?? null;
	}
	setItem(key: string, value: string): void {
		this.values.set(key, value);
	}
	removeItem(key: string): void {
		this.values.delete(key);
	}
	clear(): void {
		this.values.clear();
	}
}

interface RequestMessage {
	command: string;
	[key: string]: unknown;
}

type RequestHandler = (message: RequestMessage) => unknown | Promise<unknown>;

function fakeClient(handler: RequestHandler, capabilities: string[] = []) {
	const request = vi.fn(async <T>(message: RequestMessage): Promise<T> => handler(message) as Promise<T>);
	const close = vi.fn(async () => {});
	const snapshot = { connected: true, sessions: new Map(), hello: { capabilities } };
	const client = {
		clientInstanceId: crypto.randomUUID(),
		request,
		close,
		getSnapshot: () => snapshot,
		subscribe: () => () => {},
		onEvent: () => () => {},
	} as unknown as GuiProtocolClient;
	return { client, request, close };
}

function session(path: string, cwd: string) {
	return {
		path,
		cwd,
		id: path,
		createdAt: 1,
		updatedAt: 2,
		messageCount: 1,
		firstMessage: "Session",
		model: { provider: "faux", id: "faux" },
		thinkingLevel: "off",
		transcriptRevision: 1,
		transcriptGeneration: "generation",
	};
}

function lease(path: string) {
	return {
		leaseId: `lease:${path}`,
		leaseGeneration: 1,
		sessionPath: path,
		clientInstanceId: "test",
		createdAt: 1,
		updatedAt: 1,
	};
}

let GuiAppStore: typeof import("../src/store.ts").GuiAppStore;

beforeAll(async () => {
	vi.stubGlobal("localStorage", new MemoryStorage());
	vi.stubGlobal("window", { setTimeout, clearTimeout, open: vi.fn() });
	vi.stubGlobal("document", { documentElement: { dataset: {} }, title: "" });
	({ GuiAppStore } = await import("../src/store.ts"));
});

beforeEach(() => {
	mocks.saveDesktopState.mockReset();
	mocks.saveDesktopState.mockResolvedValue(undefined);
});

describe("project open transaction", () => {
	it("keeps the current workspace and lease when the candidate project cannot list sessions", async () => {
		const store = new GuiAppStore();
		const old = fakeClient(async () => undefined);
		const candidate = fakeClient(async (message) => {
			if (message.command === "list_sessions") throw new Error("remote directory is unavailable");
			throw new Error(`unexpected command: ${message.command}`);
		});
		const currentSession = session("/old/session.jsonl", "/old");
		Object.assign(store, {
			projects: [
				{ id: "old", name: "Old", cwd: "/old", connectionId: "local" },
				{ id: "remote", name: "Remote", cwd: "/missing", connectionId: "ssh-1" },
			],
			currentProjectId: "old",
			lastProjectId: "old",
			currentCwd: "/old",
			activeConnectionId: "local",
			client: old.client,
			clientSnapshot: old.client.getSnapshot(),
			sessions: [currentSession],
			selectedSessionPath: currentSession.path,
			selectedSession: currentSession,
			lease: lease(currentSession.path),
			transcript: [{ entryId: "old-entry" }],
			createHostConnection: async () => ({
				connectionId: "ssh-1",
				client: candidate.client,
				initial: { sessions: [], operations: [], pendingUiRequests: [] },
			}),
		});
		(store as unknown as { publish(): void }).publish();

		await expect(store.selectProject("remote")).rejects.toThrow("remote directory is unavailable");
		const snapshot = store.getSnapshot();
		expect(snapshot).toMatchObject({
			currentProjectId: "old",
			currentCwd: "/old",
			selectedSessionPath: currentSession.path,
		});
		expect(snapshot.transcript).toEqual([{ entryId: "old-entry" }]);
		expect(snapshot.projectOpenFailures.remote).toMatchObject({ stage: "sessions" });
		expect(old.request).not.toHaveBeenCalledWith(expect.objectContaining({ command: "release_session" }));
		expect(candidate.close).toHaveBeenCalledOnce();
		expect(mocks.saveDesktopState).not.toHaveBeenCalled();
	});

	it("does not commit or release the old lease when persisting the prepared project fails", async () => {
		mocks.saveDesktopState.mockRejectedValueOnce(new Error("desktop state is read-only"));
		const store = new GuiAppStore();
		const old = fakeClient(async () => undefined);
		const targetSession = session("/remote/session.jsonl", "/remote");
		const targetLease = lease(targetSession.path);
		const candidate = fakeClient(async (message) => {
			if (message.command === "list_sessions") return [targetSession];
			if (message.command === "acquire_session") return { lease: targetLease, snapshot: targetSession };
			if (message.command === "read_transcript")
				return {
					items: [],
					previousCursor: undefined,
					transcriptGeneration: "generation",
					hasMorePrevious: false,
				};
			if (message.command === "release_session") return {};
			throw new Error(`unexpected command: ${message.command}`);
		});
		const currentSession = session("/old/session.jsonl", "/old");
		Object.assign(store, {
			projects: [
				{ id: "old", name: "Old", cwd: "/old", connectionId: "local" },
				{ id: "remote", name: "Remote", cwd: "/remote", connectionId: "ssh-1" },
			],
			currentProjectId: "old",
			lastProjectId: "old",
			currentCwd: "/old",
			activeConnectionId: "local",
			client: old.client,
			clientSnapshot: old.client.getSnapshot(),
			sessions: [currentSession],
			selectedSessionPath: currentSession.path,
			selectedSession: currentSession,
			lease: lease(currentSession.path),
			transcript: [{ entryId: "old-entry" }],
			createHostConnection: async () => ({
				connectionId: "ssh-1",
				client: candidate.client,
				initial: { sessions: [], operations: [], pendingUiRequests: [] },
			}),
		});
		(store as unknown as { publish(): void }).publish();

		await expect(store.selectProject("remote")).rejects.toThrow("desktop state is read-only");
		expect(store.getSnapshot()).toMatchObject({
			currentProjectId: "old",
			currentCwd: "/old",
			selectedSessionPath: currentSession.path,
		});
		expect(old.request).not.toHaveBeenCalledWith(expect.objectContaining({ command: "release_session" }));
		expect(candidate.request).toHaveBeenCalledWith(
			expect.objectContaining({ command: "release_session", sessionPath: targetSession.path }),
			expect.objectContaining({ timeoutMs: 20_000 }),
		);
		expect(candidate.close).toHaveBeenCalledOnce();
	});
});

describe("settings Host lifecycle", () => {
	it("deduplicates one Host load and exposes Host and project AGENTS without opening another connection", async () => {
		let releaseInstructions = () => {};
		const instructionsReady = new Promise<void>((resolve) => {
			releaseInstructions = resolve;
		});
		const hostInstruction = {
			path: "/agent/AGENTS.md",
			fileName: "AGENTS.md",
			exists: true,
			active: true,
			editable: true,
			content: "host instructions",
			contentHash: "host-hash",
		};
		const projectInstruction = {
			...hostInstruction,
			path: "/project/AGENTS.md",
			content: "project instructions",
			contentHash: "project-hash",
		};
		const remote = fakeClient(
			async (message) => {
				if (message.command === "list_host_instructions") {
					await instructionsReady;
					return [hostInstruction];
				}
				if (message.command === "list_project_instructions") return [projectInstruction];
				throw new Error(`unexpected command: ${message.command}`);
			},
			["host-instructions", "project-instructions"],
		);
		const createHostConnection = vi.fn(async () => ({
			connectionId: "ssh-1",
			client: remote.client,
			initial: { sessions: [], operations: [], pendingUiRequests: [] },
		}));
		const store = new GuiAppStore();
		Object.assign(store, {
			connections: [{ id: "ssh-1", name: "Remote", target: "remote", mode: "alias" }],
			projects: [{ id: "project", name: "Project", cwd: "/project", connectionId: "ssh-1" }],
			createHostConnection,
		});

		const first = store.selectSettingsHost("ssh-1");
		const second = store.selectSettingsHost("ssh-1");
		expect(second).toBe(first);
		expect(createHostConnection).toHaveBeenCalledOnce();
		releaseInstructions();
		await first;
		await store.selectSettingsHost("ssh-1");

		expect(createHostConnection).toHaveBeenCalledOnce();
		expect(store.getSnapshot()).toMatchObject({
			settingsHostId: "ssh-1",
			settingsHostConnected: true,
			settingsHostLoading: false,
			hostInstructions: [hostInstruction],
			projectInstructions: [projectInstruction],
		});
		expect(remote.close).not.toHaveBeenCalled();
	});

	it("closes a superseded Host candidate instead of leaking it", async () => {
		let releaseFirst = () => {};
		const firstReady = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		const firstClient = fakeClient(async () => []);
		const secondClient = fakeClient(async () => []);
		const store = new GuiAppStore();
		Object.assign(store, {
			connections: [
				{ id: "ssh-1", name: "First", target: "first", mode: "alias" },
				{ id: "ssh-2", name: "Second", target: "second", mode: "alias" },
			],
			createHostConnection: vi.fn(async (connectionId: string) => {
				if (connectionId === "ssh-1") {
					await firstReady;
					return {
						connectionId,
						client: firstClient.client,
						initial: { sessions: [], operations: [], pendingUiRequests: [] },
					};
				}
				return {
					connectionId,
					client: secondClient.client,
					initial: { sessions: [], operations: [], pendingUiRequests: [] },
				};
			}),
		});

		const first = store.selectSettingsHost("ssh-1");
		await store.selectSettingsHost("ssh-2");
		releaseFirst();
		await first;

		expect(firstClient.close).toHaveBeenCalledOnce();
		expect(secondClient.close).not.toHaveBeenCalled();
		expect(store.getSnapshot()).toMatchObject({ settingsHostId: "ssh-2", settingsHostConnected: true });
	});
});
