import { createHash } from "node:crypto";
import { join } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { AgentSessionEvent } from "./agent-session.ts";
import type { ToolActivitySnapshot } from "./tool-activity.ts";

export interface WebCompanionImage {
	data: string;
	mimeType: string;
}

export const WEB_COMPANION_PROTOCOL_VERSION = 2 as const;
export const WEB_COMPANION_LEGACY_PROTOCOL_VERSION = 1 as const;
export type WebCompanionProtocolVersion = 1 | 2;

export const WEB_COMPANION_CAPABILITIES = [
	"prompt",
	"steer",
	"follow_up",
	"clear_queue",
	"abort",
	"model",
	"thinking",
	"completion",
	"session_info",
	"session_tree",
	"session_tree_label",
	"session_tree_navigation",
	"session_settings",
	"session_rename",
	"session_compact",
	"session_export",
	"session_last_assistant_text",
	"session_bash",
	"session_fork",
	"session_import",
	"session_share",
	"session_reload",
	"subagents",
] as const;

export type WebCompanionCapability = (typeof WEB_COMPANION_CAPABILITIES)[number];

export const WEB_COMPANION_LEGACY_CAPABILITIES = [
	"prompt",
	"steer",
	"follow_up",
	"clear_queue",
	"abort",
	"model",
	"thinking",
	"completion",
] as const satisfies readonly WebCompanionCapability[];

export interface WebCompanionSnapshot {
	protocolVersion: WebCompanionProtocolVersion;
	id: string;
	path: string;
	cwd: string;
	name?: string;
	createdAt: number;
	updatedAt: number;
	phase: "idle" | "turn" | "compaction" | "retry";
	activity: "idle" | "running";
	model?: { provider: string; id: string };
	thinkingLevel: string;
	leafId: string | null;
	queuedSteerCount: number;
	queuedFollowUpCount: number;
	contextTokens?: number | null;
	contextWindow?: number;
	transcriptGeneration: string;
	transcriptRevision: number;
	toolActivityEpoch: string;
	toolActivityRevision: number;
	toolActivities: ToolActivitySnapshot[];
	capabilities: WebCompanionCapability[];
}

export interface WebCompanionSnapshotWire extends Omit<WebCompanionSnapshot, "protocolVersion" | "capabilities"> {
	protocolVersion?: number;
	capabilities?: WebCompanionCapability[];
}

export type WebCompanionCommand =
	| { type: "hello"; sessionPath: string; protocolVersion?: WebCompanionProtocolVersion }
	| {
			type: "request";
			requestId: string;
			command:
				| "prompt"
				| "steer"
				| "follow_up"
				| "clear_queue"
				| "abort"
				| "snapshot"
				| "set_model"
				| "set_thinking_level"
				| "cycle_model"
				| "cycle_thinking_level"
				| "get_completions"
				| "get_session_tree"
				| "get_session_info"
				| "list_fork_messages"
				| "set_entry_label"
				| "navigate_session_tree"
				| "list_settings"
				| "set_setting"
				| "compact"
				| "export_session"
				| "get_last_assistant_text"
				| "run_bash"
				| "fork_session"
				| "import_session"
				| "rename"
				| "reload_resources"
				| "list_subagents"
				| "read_subagent"
				| "abort_subagent"
				| "continue_subagent";
			text?: string;
			cursor?: number;
			images?: WebCompanionImage[];
			model?: { provider: string; id: string };
			level?: ThinkingLevel;
			direction?: "forward" | "backward";
			customInstructions?: string;
			outputPath?: string;
			position?: "before" | "at";
			inputPath?: string;
			cwdOverride?: string;
			name?: string;
			entryId?: string;
			summarize?: boolean;
			label?: string;
			id?: string;
			value?: boolean | number | string;
			bashCommand?: string;
			excludeFromContext?: boolean;
			agentId?: string;
	  };

export type WebCompanionServerMessage =
	| { type: "ready"; snapshot: WebCompanionSnapshotWire }
	| { type: "response"; requestId: string; ok: true; result?: unknown }
	| { type: "response"; requestId: string; ok: false; error: string }
	| { type: "bash_chunk"; requestId: string; chunk: string }
	| { type: "snapshot"; snapshot: WebCompanionSnapshotWire }
	| { type: "agent_event"; event: AgentSessionEvent }
	| {
			type: "entry_committed";
			items: unknown[];
			transcriptGeneration: string;
			fromRevision: number;
			transcriptRevision: number;
	  };

function endpointHash(agentDir: string, sessionPath: string): string {
	return createHash("sha256").update(`${agentDir}\0${sessionPath}`).digest("hex").slice(0, 32);
}

export function getWebCompanionEndpoint(agentDir: string, sessionPath: string): string {
	const suffix = endpointHash(agentDir, sessionPath);
	return process.platform === "win32"
		? `\\\\.\\pipe\\lystar-session-companion-${suffix}`
		: join(agentDir, "host", "companions", `${suffix}.sock`);
}
