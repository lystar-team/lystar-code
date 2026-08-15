import { readFileSync } from "node:fs";
import { join } from "node:path";
import { migrateSessionEntries, parseSessionEntries, type SessionEntry } from "../src/core/session-manager.ts";

export function loadLargeSessionEntries(): SessionEntry[] {
	const sessionPath = join(__dirname, "fixtures/large-session.jsonl");
	const content = readFileSync(sessionPath, "utf-8");
	const entries = parseSessionEntries(content);
	migrateSessionEntries(entries);
	return entries.filter((entry): entry is SessionEntry => entry.type !== "session");
}
