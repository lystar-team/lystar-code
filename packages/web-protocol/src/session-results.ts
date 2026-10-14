import type { SessionActivity } from "./schemas.ts";

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
