import type { ExtensionContext } from "./extensions/types.ts";

export function roomSessionId(ctx: ExtensionContext): string {
	const task = ctx.sessionManager.getHeader()?.collaborationTask;
	return ctx.currentTurn?.rootOrigin === "room" && task?.parentSessionId
		? task.parentSessionId
		: ctx.sessionManager.getSessionId();
}
