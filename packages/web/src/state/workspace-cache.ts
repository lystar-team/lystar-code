import type { ProjectGroup, WebProject } from "../types.ts";

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const WORKSPACE_CACHE_KEY = "lystar.web.workspace-cache.v1";
const WORKSPACE_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const WORKSPACE_CACHE_MAX_BYTES = 2 * 1024 * 1024;
const WORKSPACE_CACHE_SAVE_DELAY_MS = 2_000;

export interface CachedWorkspace {
	workspaceRevision: number;
	projects: WebProject[];
	projectGroups: ProjectGroup[];
}

interface StoredWorkspace extends CachedWorkspace {
	savedAt: number;
}

let lastSavedRevision: number | undefined;
let pendingSave: number | undefined;

function browserStorage(): StorageLike | undefined {
	if (typeof window === "undefined") return undefined;
	try {
		return window.localStorage;
	} catch {
		return undefined;
	}
}

function isStoredWorkspace(value: unknown): value is StoredWorkspace {
	if (!value || typeof value !== "object") return false;
	const stored = value as Partial<StoredWorkspace>;
	return (
		typeof stored.savedAt === "number" &&
		typeof stored.workspaceRevision === "number" &&
		Array.isArray(stored.projects) &&
		Array.isArray(stored.projectGroups)
	);
}

/** 读取上次同步的工作区快照，用于先渲染再联网校准；过期或损坏时丢弃。 */
export function readCachedWorkspace(
	storage: StorageLike | undefined = browserStorage(),
	now = Date.now(),
): CachedWorkspace | undefined {
	if (!storage) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(storage.getItem(WORKSPACE_CACHE_KEY) ?? "null");
	} catch {
		parsed = undefined;
	}
	if (!isStoredWorkspace(parsed) || now - parsed.savedAt > WORKSPACE_CACHE_MAX_AGE_MS) {
		clearCachedWorkspace(storage);
		return undefined;
	}
	return {
		workspaceRevision: parsed.workspaceRevision,
		projects: parsed.projects,
		projectGroups: parsed.projectGroups,
	};
}

export function clearCachedWorkspace(storage: StorageLike | undefined = browserStorage()): void {
	lastSavedRevision = undefined;
	if (pendingSave !== undefined && typeof window !== "undefined") {
		window.clearTimeout(pendingSave);
		pendingSave = undefined;
	}
	if (!storage) return;
	try {
		storage.removeItem(WORKSPACE_CACHE_KEY);
	} catch {
		// 本地存储不可用时不影响会话使用。
	}
}

/** 空闲时写入快照，避免在恢复连接的关键路径上阻塞主线程。 */
export function scheduleCachedWorkspaceSave(snapshot: CachedWorkspace): void {
	if (typeof window === "undefined" || snapshot.workspaceRevision === lastSavedRevision) return;
	if (pendingSave !== undefined) window.clearTimeout(pendingSave);
	pendingSave = window.setTimeout(() => {
		pendingSave = undefined;
		const storage = browserStorage();
		if (!storage) return;
		let payload: string;
		try {
			payload = JSON.stringify({ savedAt: Date.now(), ...snapshot } satisfies StoredWorkspace);
		} catch {
			return;
		}
		if (payload.length > WORKSPACE_CACHE_MAX_BYTES) return;
		try {
			storage.setItem(WORKSPACE_CACHE_KEY, payload);
			lastSavedRevision = snapshot.workspaceRevision;
		} catch {
			// 配额不足时保留内置行为，不阻断同步。
		}
	}, WORKSPACE_CACHE_SAVE_DELAY_MS);
}
