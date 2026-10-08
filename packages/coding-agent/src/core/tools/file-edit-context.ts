import { resolve } from "node:path";
import type { ExtensionContext } from "../extensions/types.ts";
import { FileEditState, type FileSnapshot } from "./file-edit-state.ts";

const sessionStates = new WeakMap<ExtensionContext["sessionManager"], { sessionId: string; state: FileEditState }>();
const detachedStates = new Map<string, FileEditState>();
const MAX_DETACHED_STATES = 32;

/** 同一会话的 read/edit 共用状态；SDK 可显式提供独立状态。 */
export function getFileEditState(cwd: string, context?: ExtensionContext, provided?: FileEditState): FileEditState {
	if (provided) return provided;
	const manager = context?.sessionManager;
	if (manager) {
		const sessionId = manager.getSessionId();
		const existing = sessionStates.get(manager);
		if (existing?.sessionId === sessionId) return existing.state;
		const state = new FileEditState();
		sessionStates.set(manager, { sessionId, state });
		return state;
	}
	const key = resolve(cwd);
	const existing = detachedStates.get(key);
	if (existing) {
		detachedStates.delete(key);
		detachedStates.set(key, existing);
		return existing;
	}
	const state = new FileEditState();
	detachedStates.set(key, state);
	if (detachedStates.size > MAX_DETACHED_STATES) detachedStates.delete(detachedStates.keys().next().value!);
	return state;
}

/** 行号只属于展示；实际替换原文始终取自读取快照。 */
export function formatFileSnapshot(state: FileEditState, snapshot: FileSnapshot, lines: readonly string[]): string {
	return `${state.describeSnapshot(snapshot)}\n${lines.map((line, index) => `${snapshot.startLine + index}| ${line}`).join("\n")}`;
}
