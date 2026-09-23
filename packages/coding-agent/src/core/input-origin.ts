export type AgentInputChannel = "interactive" | "rpc";
export type AgentRootOrigin = "user" | "room";
export type AgentRoomMessageKind = "task" | "message" | "question" | "answer" | "status" | "result" | "system";

export type AgentInputOrigin =
	| {
			type: "user";
			channel: AgentInputChannel;
	  }
	| {
			type: "room";
			roomId: string;
			messageId: string;
			seq: number;
			kind: AgentRoomMessageKind;
			senderSessionId: string;
			taskId?: string;
	  }
	| {
			type: "extension";
			extensionId: string;
			purpose: string;
			parentTurnId: string;
			rootOrigin: AgentRootOrigin;
	  };

export interface AgentCapabilityLease {
	allowedTools: readonly string[];
	readRoots?: readonly string[];
	writeRoots?: readonly string[];
	shell?: "disabled" | "sandboxed";
}

export interface AgentTurnContext {
	turnId: string;
	inputId: string;
	origin: AgentInputOrigin;
	rootOrigin: AgentRootOrigin;
}

export interface AgentTurnResult extends AgentTurnContext {
	outcome: "completed" | "failed" | "aborted";
	finalText?: string;
}

export function rootOriginOf(origin: AgentInputOrigin): AgentRootOrigin {
	return origin.type === "room" ? "room" : origin.type === "extension" ? origin.rootOrigin : "user";
}
