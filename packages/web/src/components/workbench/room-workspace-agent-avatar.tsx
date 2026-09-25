import { Bot } from "lucide-react";
import type { WebRoomMember, WebSessionSummary } from "../../types";
import { AgentIdentityIcon } from "./collaboration-session";

export function AgentAvatar({ memberSession, member }: { memberSession?: WebSessionSummary; member?: WebRoomMember }) {
	return (
		<div className="mt-1 grid size-8 shrink-0 place-items-center rounded-full border border-border/70 bg-muted text-muted-foreground">
			{memberSession || member ? (
				<AgentIdentityIcon member={member} session={memberSession} className="size-4 object-contain" />
			) : (
				<Bot className="size-4" aria-hidden="true" />
			)}
		</div>
	);
}
