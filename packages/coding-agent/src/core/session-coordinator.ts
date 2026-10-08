import type {
	SessionCollaborationResult,
	SessionCollaborationTask,
	SessionOutcome,
	SessionWorkspaceMode,
	SessionWorkspaceSnapshot,
} from "./session-manager.ts";
import type { SessionRoomApi } from "./session-room.ts";

export type SessionSendMode = "auto" | "steer" | "follow_up";
export type SessionStopReason = "user_requested" | "task_cancelled";
export type SessionCoordinatorOutcome = SessionOutcome;
export type SessionCoordinatorTask = SessionCollaborationTask;
export type SessionCoordinatorResult = SessionCollaborationResult & { sessionId: string };

export interface SessionCoordinatorProfile {
	id: string;
	name: string;
	description: string;
	scope: "builtin" | "user" | "project";
	icon?: string;
}

export interface SessionCoordinatorSummary {
	id: string;
	name?: string;
	cwd: string;
	parentId?: string;
	profileId?: string;
	profileName?: string;
	profileIcon?: string;
	activity: "idle" | "running" | "waiting_for_input" | "completed" | "failed" | "aborted" | "interrupted";
	messageCount: number;
	firstMessage: string;
	workspace?: SessionWorkspaceSnapshot;
	taskId?: string;
	taskDescription?: string;
	result?: SessionCoordinatorResult;
	stopReason?: SessionStopReason;
	stopNote?: string;
}

export interface SessionWaitProgress {
	state: "waiting" | "completed" | "needs_input";
	elapsedMs: number;
	sessions: SessionCoordinatorSummary[];
}

export interface SessionCoordinatorCreateInput {
	cwd: string;
	parentSessionFile: string;
	parentSessionId?: string;
	profileId?: string;
	task?: string;
	workspaceMode?: SessionWorkspaceMode;
}

export interface SessionCoordinatorCreateResult {
	session: SessionCoordinatorSummary;
	accepted: boolean;
	taskId?: string;
}

export interface SessionCoordinator {
	room: SessionRoomApi;
	create(input: SessionCoordinatorCreateInput): Promise<SessionCoordinatorCreateResult>;
	send(input: {
		cwd: string;
		sessionId: string;
		text: string;
		mode?: SessionSendMode;
		onProgress?: (session: SessionCoordinatorSummary) => void;
	}): Promise<SessionCoordinatorSummary>;
	wait(input: {
		cwd: string;
		sessionIds: string[];
		signal?: AbortSignal;
		onProgress?: (progress: SessionWaitProgress) => void;
	}): Promise<SessionCoordinatorSummary[]>;
	list(input: { cwd: string; parentSessionId?: string }): Promise<SessionCoordinatorSummary[]>;
	profiles(input: { cwd: string }): Promise<SessionCoordinatorProfile[]>;
	stop(input: {
		cwd: string;
		sessionId: string;
		callerSessionId?: string;
		reason?: SessionStopReason;
		note?: string;
		onProgress?: (session: SessionCoordinatorSummary) => void;
	}): Promise<SessionCoordinatorSummary>;
	accept?(input: { cwd: string; sessionId: string; callerSessionId?: string }): Promise<SessionCollaborationResult>;
	workspaces?(input: { cwd: string; action: "preview" | "cleanup"; sessionIds?: string[] }): Promise<{
		workspaces: Array<{
			sessionId: string;
			sessionPath: string;
			workspace: SessionWorkspaceSnapshot;
			canRelease: boolean;
			reason?: string;
			result?: SessionCollaborationResult;
		}>;
		released?: string[];
	}>;
}
