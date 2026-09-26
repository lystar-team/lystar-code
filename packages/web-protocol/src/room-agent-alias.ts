export const DEFAULT_ROOM_AGENT_ALIASES = [
	"霜叶",
	"海盐",
	"纸鸢",
	"星野",
	"青岚",
	"松墨",
	"云砚",
	"川柏",
	"月白",
	"南枝",
	"远山",
	"清和",
] as const;

export function collaborationAlias(sessionId: string): string {
	let hash = 2166136261;
	for (const character of sessionId) {
		hash ^= character.codePointAt(0) ?? 0;
		hash = Math.imul(hash, 16777619);
	}
	return DEFAULT_ROOM_AGENT_ALIASES[Math.abs(hash) % DEFAULT_ROOM_AGENT_ALIASES.length]!;
}
