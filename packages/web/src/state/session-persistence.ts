type StorageLike = Pick<Storage, "getItem" | "setItem">;

export interface SavedSessionSelection {
	projectId: string;
	sessionId: string;
}

const LAST_SESSION_KEY = "lystar.web.last-session.v1";

function browserStorage(): StorageLike | undefined {
	if (typeof window === "undefined") return undefined;
	try {
		return window.localStorage;
	} catch {
		return undefined;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function readLastSession(storage: StorageLike | undefined = browserStorage()): SavedSessionSelection | undefined {
	if (!storage) return undefined;
	try {
		const value: unknown = JSON.parse(storage.getItem(LAST_SESSION_KEY) ?? "null");
		if (!isRecord(value) || typeof value.projectId !== "string" || typeof value.sessionId !== "string") return undefined;
		if (!value.projectId || !value.sessionId) return undefined;
		return { projectId: value.projectId, sessionId: value.sessionId };
	} catch {
		return undefined;
	}
}

export function saveLastSession(
	projectId: string,
	sessionId: string,
	storage: StorageLike | undefined = browserStorage(),
): void {
	if (!storage || !projectId || !sessionId) return;
	try {
		storage.setItem(LAST_SESSION_KEY, JSON.stringify({ projectId, sessionId } satisfies SavedSessionSelection));
	} catch {
		// 本地存储不可用时不影响会话使用。
	}
}
