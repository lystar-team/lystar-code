import type { OperationSnapshot, SessionActivity } from "./schemas.ts";

export type SessionResultActivity = Extract<SessionActivity, "completed" | "failed" | "aborted" | "interrupted">;

export interface SessionResultState {
	sessionId: string;
	revision: number;
	readRevision: number;
	updatedAt: number;
	activity: SessionResultActivity;
	viewedAt?: number;
	version: number;
}

export function isSessionResultActivity(activity: string): activity is SessionResultActivity {
	return activity === "completed" || activity === "failed" || activity === "aborted" || activity === "interrupted";
}

export function isSessionResultOperation(operation: Pick<OperationSnapshot, "type">): boolean {
	// 排队确认和配置写入不代表本轮执行产生了结果。
	return operation.type === "prompt" || operation.type === "compact" || operation.type === "run_bash";
}
