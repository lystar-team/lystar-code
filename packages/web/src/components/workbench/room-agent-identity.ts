import { collaborationAlias, DEFAULT_ROOM_AGENT_ALIASES } from "@lystar/code-web-protocol";
import type { WebRoomMember } from "../../types";

const ROOM_NICKNAME_POOL_KEY = "lystar-room-nickname-pool";

export const DEFAULT_ROOM_NICKNAMES = DEFAULT_ROOM_AGENT_ALIASES;

function normalizeNicknames(values: readonly string[]): string[] {
	return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

export function readRoomNicknamePool(): string[] {
	if (typeof window === "undefined") return [...DEFAULT_ROOM_NICKNAMES];
	const stored = window.localStorage.getItem(ROOM_NICKNAME_POOL_KEY);
	if (stored === null) return [...DEFAULT_ROOM_NICKNAMES];
	try {
		const value: unknown = JSON.parse(stored);
		if (Array.isArray(value)) return normalizeNicknames(value.filter((item): item is string => typeof item === "string"));
	} catch {
		// 使用内置昵称库，避免本地配置损坏阻断 Room。
	}
	return [...DEFAULT_ROOM_NICKNAMES];
}

export function saveRoomNicknamePool(values: readonly string[]): string[] {
	const nicknames = normalizeNicknames(values);
	if (typeof window !== "undefined") {
		window.localStorage.setItem(ROOM_NICKNAME_POOL_KEY, JSON.stringify(nicknames));
		window.dispatchEvent(new CustomEvent("room-nickname-pool-changed"));
	}
	return nicknames;
}

export function allocateRoomNickname(
	members: readonly Pick<WebRoomMember, "nickname" | "sessionId">[],
	pool: readonly string[],
): string | undefined {
	const used = new Set(
		members.map((member) => member.nickname?.trim() || collaborationAlias(member.sessionId)).filter(Boolean),
	);
	return pool.find((nickname) => !used.has(nickname));
}
