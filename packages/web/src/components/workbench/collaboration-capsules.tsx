import { Check, CircleX, Clock3, LoaderCircle } from "lucide-react";
import type { WebSessionSummary } from "../../types";
import {
	collaborationAgentIconForSession,
	collaborationAgentType,
	collaborationAlias,
	collaborationStatus,
} from "./collaboration-session";
import { SessionWorkspaceActions } from "./session-workspaces";

function collaborationStatusIcon(session: WebSessionSummary) {
	switch (session.activity) {
		case "running":
			return LoaderCircle;
		case "waiting_for_input":
			return Clock3;
		case "completed":
			return Check;
		case "failed":
		case "aborted":
		case "interrupted":
			return CircleX;
		case "idle":
		default:
			return Clock3;
	}
}

function collaborationStatusClass(session: WebSessionSummary): string {
	switch (session.activity) {
		case "running":
			return "animate-spin text-muted-foreground";
		case "completed":
			return "text-emerald-600 dark:text-emerald-500";
		case "failed":
		case "aborted":
		case "interrupted":
			return "text-destructive";
		case "waiting_for_input":
		case "idle":
		default:
			return "text-muted-foreground";
	}
}

export function CollaborationCapsules({
	sessions,
	projectId,
	onOpenSession,
	onRefresh,
	onToast,
}: {
	sessions: WebSessionSummary[];
	projectId?: string;
	onOpenSession: (sessionId: string) => void;
	onRefresh: (projectId: string) => Promise<void>;
	onToast: (message: string) => void;
}) {
	const childSessions = sessions.filter(
		(session) => session.relation === "collaboration" && Boolean(session.parentId),
	);
	if (!childSessions.length) return null;

	return (
		<div aria-label="协作子会话" className="conversation-scroll mb-2 flex min-w-0 gap-2 overflow-x-auto pb-0.5 text-xs leading-4" role="list">
			{childSessions.map((session) => {
				const AgentIcon = collaborationAgentIconForSession(session);
				const StatusIcon = collaborationStatusIcon(session);
				const alias = collaborationAlias(session.id);
				const agentType = collaborationAgentType(session);
				const status = collaborationStatus(session);
				const task = session.firstMessage.trim() && session.firstMessage !== "未命名会话" ? session.firstMessage : undefined;
				return (
					<div className="flex max-w-[min(34rem,92vw)] shrink-0 items-center overflow-hidden rounded-full border border-border/70 bg-muted/20" key={session.id} role="listitem">
						<button
							aria-label={`打开协作子会话 ${alias}，${status}`}
							className="flex min-w-0 flex-1 items-center gap-1.5 px-2.5 py-1 text-left transition-colors hover:bg-muted/45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
							onClick={() => onOpenSession(session.id)}
							title={`${alias} · ${agentType}${task ? `：${task}` : ""}`}
							type="button"
						>
							<AgentIcon className="size-3 shrink-0 text-muted-foreground" aria-hidden="true" />
							<span className="shrink-0 font-medium text-foreground">{alias}</span>
							<span className="min-w-0 truncate text-muted-foreground">{agentType}</span>
							<StatusIcon className={`size-3 shrink-0 ${collaborationStatusClass(session)}`} aria-hidden="true" />
						</button>
						<SessionWorkspaceActions
							projectId={projectId}
							session={session}
							sessions={childSessions}
							onRefresh={onRefresh}
							onToast={onToast}
						/>
					</div>
				);
			})}
		</div>
	);
}
