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

function fakeClient(handler: RequestHandler) {
	const request = vi.fn(async <T>(message: RequestMessage): Promise<T> => handler(message) as Promise<T>);
	const close = vi.fn(async () => {});
	const snapshot = { connected: true, sessions: new Map(), hello: { capabilities: [] } };
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
		);
		expect(candidate.close).toHaveBeenCalledOnce();
	});
});
